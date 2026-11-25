/**
 * Unit tests for core/update-blocker.mjs (macOS Squirrel.Mac ShipIt cache blocker).
 * Uses throw-away HOME directories under os.tmpdir() so the host's real ShipIt cache is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHIPIT_CACHE_SUBPATH,
  applyAntigravityUpdateBlock,
  getShipItCacheDir,
  inspectAntigravityUpdateBlock,
  isAntigravityShipItCommand,
  killAntigravityShipItProcesses
} from '../core/update-blocker.mjs';

const isMac = process.platform === 'darwin';

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-claude-update-block-'));
  return {
    home,
    cacheDir: getShipItCacheDir(home),
    cleanup: () => {
      try {
        applyAntigravityUpdateBlock(false, { homeDir: home, killProcesses: false });
      } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

test('isAntigravityShipItCommand matches only Antigravity ShipIt helpers', () => {
  assert.equal(
    isAntigravityShipItCommand(
      '/Applications/Antigravity.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt com.google.antigravity.ShipIt'
    ),
    true
  );
  assert.equal(
    isAntigravityShipItCommand('/Users/demo/Library/Caches/com.google.antigravity.ShipIt/ShipIt'),
    true
  );
  assert.equal(
    isAntigravityShipItCommand(
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.microsoft.VSCode.ShipIt'
    ),
    false
  );
  assert.equal(
    isAntigravityShipItCommand('/Applications/Cursor.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt'),
    false
  );
  assert.equal(isAntigravityShipItCommand('/Applications/Antigravity.app/Contents/MacOS/Antigravity'), false);
});

test('killAntigravityShipItProcesses only signals matching Antigravity ShipIt PIDs', () => {
  const killed = [];
  const fakePs = [
    '  101 /Applications/Visual Studio Code.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.microsoft.VSCode.ShipIt',
    '  202 /Applications/Antigravity.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.google.antigravity.ShipIt',
    `  ${process.pid} /Applications/Antigravity.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.google.antigravity.ShipIt`,
    '  303 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0'
  ].join('\n');

  const res = killAntigravityShipItProcesses({
    platform: 'darwin',
    execFileSyncFn: () => fakePs,
    killFn: (pid, sig) => killed.push({ pid, sig })
  });
  assert.deepEqual(res, [202]);
  assert.deepEqual(killed, [{ pid: 202, sig: 'SIGKILL' }]);
});

test('non-macOS platforms report unsupported cleanly without mutating disk', () => {
  const status = inspectAntigravityUpdateBlock({ homeDir: '/tmp/unused', platform: 'linux' });
  assert.equal(status.ok, true);
  assert.equal(status.supported, false);
  assert.equal(status.locked, false);

  const onRes = applyAntigravityUpdateBlock(true, { homeDir: '/tmp/unused', platform: 'win32', killProcesses: false });
  assert.equal(onRes.ok, false);
  assert.equal(onRes.supported, false);
  assert.equal(onRes.error, 'unsupported_platform');

  const offRes = applyAntigravityUpdateBlock(false, { homeDir: '/tmp/unused', platform: 'linux', killProcesses: false });
  assert.equal(offRes.ok, true);
  assert.equal(offRes.supported, false);
  assert.equal(offRes.skipped, 'unsupported_platform');
});

test('macOS lock clears staged updates, sets read-only + uchg, is idempotent, and cleanly unlocks', { skip: !isMac }, () => {
  const h = makeTempHome();
  try {
    assert.equal(h.cacheDir, path.join(h.home, SHIPIT_CACHE_SUBPATH));

    /* Prepare staged update payload */
    const stagedDir = path.join(h.cacheDir, 'update.abcdef');
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'Antigravity.zip'), 'staged-bytes', 'utf8');
    fs.writeFileSync(path.join(h.cacheDir, 'ShipIt_stdout.log'), 'log', 'utf8');

    const before = inspectAntigravityUpdateBlock({ homeDir: h.home });
    assert.equal(before.supported, true);
    assert.equal(before.locked, false);
    assert.equal(before.stagedEntries, 2);

    /* Enable lock */
    const locked = applyAntigravityUpdateBlock(true, { homeDir: h.home, killProcesses: false });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    assert.equal(locked.locked, true);
    assert.equal(locked.immutable, true);
    assert.equal(locked.readOnly, true);
    assert.equal(locked.clearedEntries, 2);
    assert.equal(locked.stagedEntries, 0);

    /* Writing into locked directory must fail */
    assert.throws(() => fs.writeFileSync(path.join(h.cacheDir, 'probe.txt'), 'nope'));

    /* Re-applying lock is idempotent */
    const relocked = applyAntigravityUpdateBlock(true, { homeDir: h.home, killProcesses: false });
    assert.equal(relocked.ok, true);
    assert.equal(relocked.locked, true);

    /* Disable lock restores writable directory */
    const unlocked = applyAntigravityUpdateBlock(false, { homeDir: h.home, killProcesses: false });
    assert.equal(unlocked.ok, true, JSON.stringify(unlocked));
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.immutable, false);
    assert.equal(unlocked.readOnly, false);

    /* Directory is writable again */
    fs.writeFileSync(path.join(h.cacheDir, 'after-unlock.txt'), 'ok', 'utf8');
    assert.equal(fs.readFileSync(path.join(h.cacheDir, 'after-unlock.txt'), 'utf8'), 'ok');
  } finally {
    h.cleanup();
  }
});

test('refuses to follow or mutate a symlink ShipIt cache directory', { skip: !isMac }, () => {
  const h = makeTempHome();
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-claude-symlink-target-'));
  try {
    fs.writeFileSync(path.join(externalDir, 'keep.txt'), 'precious', 'utf8');
    fs.mkdirSync(path.dirname(h.cacheDir), { recursive: true });
    fs.symlinkSync(externalDir, h.cacheDir);

    const status = inspectAntigravityUpdateBlock({ homeDir: h.home });
    assert.equal(status.isSymlink, true);
    assert.equal(status.locked, false);

    const res = applyAntigravityUpdateBlock(true, { homeDir: h.home, killProcesses: false });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'refuse_symlink_cache_dir');
    assert.equal(fs.readFileSync(path.join(externalDir, 'keep.txt'), 'utf8'), 'precious');
  } finally {
    h.cleanup();
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});
