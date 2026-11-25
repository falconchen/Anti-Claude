/**
 * Anti-Claude — core/update-blocker.mjs
 * Zero-dependency macOS Squirrel.Mac (ShipIt) update cache blocker for Google Antigravity Desktop.
 *
 * Design:
 * - Never touches `/Applications/Antigravity.app` (preserves Google Developer ID code signature).
 * - Blocks auto-updates on macOS by terminating Antigravity's ShipIt helper, clearing staged packages in
 *   `~/Library/Caches/com.google.antigravity.ShipIt`, and locking the directory read-only (`0555`) + `uchg`.
 * - Fully reversible: disabling the toggle or uninstalling Anti-Claude removes `uchg` and restores `0755`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SHIPIT_CACHE_SUBPATH = path.join('Library', 'Caches', 'com.google.antigravity.ShipIt');

export function getShipItCacheDir(homeDir = os.homedir()) {
  return path.join(path.resolve(String(homeDir || os.homedir())), SHIPIT_CACHE_SUBPATH);
}

/**
 * Strictly match only Antigravity's Squirrel.Mac ShipIt helper processes
 * (never VS Code, Cursor, Slack, or other Electron apps).
 */
export function isAntigravityShipItCommand(cmd) {
  const s = String(cmd || '');
  if (!/\bShipIt\b/i.test(s)) return false;
  return /com\.google\.antigravity\.ShipIt/i.test(s) || /Antigravity\.app/i.test(s);
}

export function listAntigravityShipItPids({
  platform = process.platform,
  execFileSyncFn = execFileSync
} = {}) {
  if (platform !== 'darwin') return [];
  try {
    const out = String(
      execFileSyncFn('ps', ['-axww', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 2500,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      }) || ''
    );
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (isAntigravityShipItCommand(m[2])) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

export function killAntigravityShipItProcesses({
  platform = process.platform,
  execFileSyncFn = execFileSync,
  killFn = process.kill
} = {}) {
  if (platform !== 'darwin') return [];
  const pids = listAntigravityShipItPids({ platform, execFileSyncFn });
  const killed = [];
  for (const pid of pids) {
    try {
      killFn(pid, 'SIGKILL');
      killed.push(pid);
    } catch {}
  }
  return killed;
}

function readMacImmutableFlag(targetPath, execFileSyncFn = execFileSync) {
  try {
    const flags = String(
      execFileSyncFn('/usr/bin/stat', ['-f', '%Sf', targetPath], {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore']
      }) || ''
    ).trim();
    return /(?:^|,)uchg(?:,|$)/.test(flags);
  } catch {
    return false;
  }
}

function countDirectoryEntries(dirPath, fsMod = fs) {
  try {
    return fsMod.readdirSync(dirPath).length;
  } catch {
    return 0;
  }
}

export function inspectAntigravityUpdateBlock({
  homeDir = os.homedir(),
  platform = process.platform,
  execFileSyncFn = execFileSync,
  fsMod = fs
} = {}) {
  if (platform !== 'darwin') {
    return {
      ok: true,
      supported: false,
      platform,
      exists: false,
      isSymlink: false,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      stagedEntries: 0,
      cacheDir: ''
    };
  }

  const cacheDir = getShipItCacheDir(homeDir);
  let lst = null;
  try {
    lst = fsMod.lstatSync(cacheDir);
  } catch {
    return {
      ok: true,
      supported: true,
      platform,
      exists: false,
      isSymlink: false,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      stagedEntries: 0,
      cacheDir
    };
  }

  if (lst.isSymbolicLink()) {
    return {
      ok: true,
      supported: true,
      platform,
      exists: true,
      isSymlink: true,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      stagedEntries: 0,
      cacheDir
    };
  }

  const isDir = lst.isDirectory();
  const readOnly = (lst.mode & 0o222) === 0;
  const immutable = readMacImmutableFlag(cacheDir, execFileSyncFn);
  const locked = Boolean(isDir && immutable && readOnly);
  const partiallyLocked = Boolean(isDir && !locked && (immutable || readOnly));
  const stagedEntries = isDir ? countDirectoryEntries(cacheDir, fsMod) : 0;

  return {
    ok: true,
    supported: true,
    platform,
    exists: true,
    isSymlink: false,
    locked,
    partiallyLocked,
    immutable,
    readOnly,
    stagedEntries,
    cacheDir
  };
}

function clearDirectoryUnlock(cacheDir, execFileSyncFn, fsMod) {
  try {
    execFileSyncFn('/usr/bin/chflags', ['-R', 'nouchg', cacheDir], {
      stdio: 'pipe',
      timeout: 5000
    });
  } catch {}
  try {
    execFileSyncFn('/bin/chmod', ['-R', 'u+rwx', cacheDir], {
      stdio: 'pipe',
      timeout: 5000
    });
  } catch {
    try {
      fsMod.chmodSync(cacheDir, 0o755);
    } catch {}
  }
}

export function applyAntigravityUpdateBlock(
  enabled,
  {
    homeDir = os.homedir(),
    platform = process.platform,
    execFileSyncFn = execFileSync,
    killFn = process.kill,
    fsMod = fs,
    killProcesses = true
  } = {}
) {
  const wantLocked = Boolean(enabled);
  if (platform !== 'darwin') {
    return {
      ok: !wantLocked,
      supported: false,
      platform,
      enabled: false,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      exists: false,
      stagedEntries: 0,
      cacheDir: '',
      ...(wantLocked ? { error: 'unsupported_platform' } : { skipped: 'unsupported_platform' })
    };
  }

  const cacheDir = getShipItCacheDir(homeDir);
  const cachesParent = path.dirname(cacheDir);

  let lst = null;
  try {
    lst = fsMod.lstatSync(cacheDir);
  } catch {}

  if (lst && lst.isSymbolicLink()) {
    return {
      ok: false,
      supported: true,
      platform,
      enabled: wantLocked,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      exists: true,
      isSymlink: true,
      stagedEntries: 0,
      cacheDir,
      error: 'refuse_symlink_cache_dir'
    };
  }

  if (wantLocked) {
    const killedPids = killProcesses
      ? killAntigravityShipItProcesses({ platform, execFileSyncFn, killFn })
      : [];
    let clearedEntries = 0;

    try {
      fsMod.mkdirSync(cachesParent, { recursive: true });
      if (lst) {
        clearDirectoryUnlock(cacheDir, execFileSyncFn, fsMod);
        if (lst.isDirectory()) {
          const entries = fsMod.readdirSync(cacheDir);
          clearedEntries = entries.length;
          for (const entry of entries) {
            fsMod.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
          }
        } else {
          fsMod.rmSync(cacheDir, { force: true });
          fsMod.mkdirSync(cacheDir, { recursive: true });
        }
      } else {
        fsMod.mkdirSync(cacheDir, { recursive: true });
      }

      fsMod.chmodSync(cacheDir, 0o555);
      execFileSyncFn('/usr/bin/chflags', ['uchg', cacheDir], {
        stdio: 'pipe',
        timeout: 5000
      });
    } catch (err) {
      const afterErr = inspectAntigravityUpdateBlock({ homeDir, platform, execFileSyncFn, fsMod });
      return {
        ...afterErr,
        ok: false,
        enabled: wantLocked,
        clearedEntries,
        killedPids,
        error: String(err?.stderr || err?.message || err).trim() || 'lock_failed'
      };
    }

    const after = inspectAntigravityUpdateBlock({ homeDir, platform, execFileSyncFn, fsMod });
    return {
      ...after,
      ok: Boolean(after.locked),
      enabled: wantLocked,
      clearedEntries,
      killedPids,
      ...(after.locked ? {} : { error: 'lock_verification_failed' })
    };
  }

  /* Unlock & restore normal Squirrel.Mac update capability */
  if (!lst) {
    return {
      ok: true,
      supported: true,
      platform,
      enabled: false,
      exists: false,
      isSymlink: false,
      locked: false,
      partiallyLocked: false,
      immutable: false,
      readOnly: false,
      stagedEntries: 0,
      cacheDir
    };
  }

  try {
    execFileSyncFn('/usr/bin/chflags', ['-R', 'nouchg', cacheDir], {
      stdio: 'pipe',
      timeout: 5000
    });
    fsMod.chmodSync(cacheDir, 0o755);
  } catch (err) {
    const afterErr = inspectAntigravityUpdateBlock({ homeDir, platform, execFileSyncFn, fsMod });
    return {
      ...afterErr,
      ok: false,
      enabled: false,
      error: String(err?.stderr || err?.message || err).trim() || 'unlock_failed'
    };
  }

  const after = inspectAntigravityUpdateBlock({ homeDir, platform, execFileSyncFn, fsMod });
  const unlocked = !after.locked && !after.immutable && !after.readOnly;
  return {
    ...after,
    ok: unlocked,
    enabled: false,
    ...(unlocked ? {} : { error: 'unlock_verification_failed' })
  };
}
