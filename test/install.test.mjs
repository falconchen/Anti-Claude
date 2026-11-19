/**
 * Installer regression tests. Zero dependencies: `node --test test/`
 * Every test runs install.mjs against a throw-away HOME with a fake upstream core.
 * Network, launchd, CDP and font copying are disabled through env switches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'install.mjs');

function makeHome({ withAllUserFiles = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ux-test-'));
  const agy = path.join(home, '.gemini', 'antigravity');
  const tp = path.join(agy, 'theme-patch');
  fs.mkdirSync(path.join(tp, 'user'), { recursive: true });
  fs.mkdirSync(path.join(tp, 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(tp, 'install.mjs'),
    "console.log('[daemon] reinject ok');\nconst ok = process.env.FAKE_VERIFY_OK === '1';\nconsole.log(JSON.stringify({ ok, themeStyle: ok, live: { reachable: ok } }, null, 2));\n"
  );
  fs.writeFileSync(path.join(tp, 'core', 'manifest.json'), JSON.stringify({ version: '5.3.0' }));
  const u = (f, c) => fs.writeFileSync(path.join(tp, 'user', f), c);
  u('custom.css', '/* my original css */\n');
  u('config.json', JSON.stringify({ enabled: true, modules: { i18n: true } }, null, 2));
  if (withAllUserFiles) {
    u('custom.js', '/* my original js */\n');
    u('i18n.override.json', '{"Hello":"你好"}\n');
  }
  fs.writeFileSync(path.join(agy, 'antigravity_state.pbtxt'), 'foo: 1\nproduct_skin: PRODUCT_SKIN_NON_TECHNICAL\n');
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ userSettings: { verboseConversationSteps: false, other: 1 } }));
  fs.writeFileSync(path.join(home, '.gemini', 'AGENTS.md'), '# my rules\n');
  return {
    home,
    user: (f) => path.join(tp, 'user', f),
    read: (rel) => fs.readFileSync(path.join(home, rel), 'utf8'),
    readUser: (f) => fs.readFileSync(path.join(tp, 'user', f), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(home, rel)),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

function parseTrailingJson(s) {
  const starts = s.startsWith('{') ? [0] : [];
  for (let i = s.indexOf('\n{'); i !== -1; i = s.indexOf('\n{', i + 1)) starts.push(i + 1);
  for (let j = starts.length - 1; j >= 0; j--) {
    try {
      return JSON.parse(s.slice(starts[j]).trim());
    } catch {}
  }
  return null;
}

function run(h, args, env = {}) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: h.home,
      CLAUDE_UX_NO_NETWORK: '1',
      CLAUDE_UX_NO_LAUNCHD: '1',
      CLAUDE_UX_NO_CDP: '1',
      CLAUDE_UX_NO_FONTS: '1',
      FAKE_VERIFY_OK: '1',
      ...env
    }
  });
  return { status: r.status, out: parseTrailingJson(r.stdout || ''), stdout: r.stdout, stderr: r.stderr };
}

test('install then uninstall restores files, settings and AGENTS.md exactly', () => {
  const h = makeHome();
  try {
    const before = {
      css: h.readUser('custom.css'),
      js: h.readUser('custom.js'),
      cfg: h.readUser('config.json'),
      i18n: h.readUser('i18n.override.json'),
      pbtxt: h.read('.gemini/antigravity/antigravity_state.pbtxt'),
      agents: h.read('.gemini/AGENTS.md')
    };
    const inst = run(h, ['install']);
    assert.equal(inst.status, 0, inst.stderr);
    assert.equal(inst.out.status, 'ok', JSON.stringify(inst.out));
    assert.match(h.readUser('custom.js'), /ag-claude-todo-card/);
    assert.match(h.read('.gemini/antigravity/antigravity_state.pbtxt'), /PRODUCT_SKIN_DEVELOPER/);
    assert.equal(JSON.parse(h.read('.gemini/config/config.json')).userSettings.verboseConversationSteps, true);
    assert.match(h.read('.gemini/AGENTS.md'), /BEGIN antigravity-claude-ux/);
    assert.match(h.read('.gemini/AGENTS.md'), /Execution Progress Sync/);
    assert.match(h.read('.gemini/AGENTS.md'), /same language the user is speaking/);

    const un = run(h, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.equal(h.readUser('custom.css'), before.css);
    assert.equal(h.readUser('custom.js'), before.js);
    assert.equal(h.readUser('config.json'), before.cfg);
    assert.equal(h.readUser('i18n.override.json'), before.i18n);
    assert.equal(h.read('.gemini/antigravity/antigravity_state.pbtxt'), before.pbtxt);
    const cfg = JSON.parse(h.read('.gemini/config/config.json'));
    assert.equal(cfg.userSettings.verboseConversationSteps, false);
    assert.equal(cfg.userSettings.other, 1);
    assert.equal(h.read('.gemini/AGENTS.md'), before.agents);
    assert.equal(h.exists('.gemini/antigravity/claude-ux'), false);
  } finally {
    h.cleanup();
  }
});

test('second uninstall is a no-op and never blanks restored files', () => {
  const h = makeHome();
  try {
    run(h, ['install']);
    run(h, ['uninstall']);
    const css = h.readUser('custom.css');
    const js = h.readUser('custom.js');
    const again = run(h, ['uninstall']);
    assert.equal(again.status, 0);
    assert.equal(again.out.noop, true);
    assert.equal(h.readUser('custom.css'), css);
    assert.equal(h.readUser('custom.js'), js);
  } finally {
    h.cleanup();
  }
});

test('files that did not exist before install are removed on uninstall', () => {
  const h = makeHome({ withAllUserFiles: false });
  try {
    run(h, ['install']);
    assert.ok(fs.existsSync(h.user('custom.js')));
    run(h, ['uninstall']);
    assert.equal(fs.existsSync(h.user('custom.js')), false);
    assert.equal(fs.existsSync(h.user('i18n.override.json')), false);
    assert.equal(h.readUser('custom.css'), '/* my original css */\n');
  } finally {
    h.cleanup();
  }
});

test('sync keeps user edits: JSON overrides survive, edited CSS is not overwritten', () => {
  const h = makeHome();
  try {
    run(h, ['install']);
    const cfg = JSON.parse(h.readUser('config.json'));
    assert.equal(cfg.modules.i18n, false, 'default config keeps English UI (i18n: false)');
    cfg.modules.i18n = true;
    cfg.contextLimit = 999;
    fs.writeFileSync(h.user('config.json'), JSON.stringify(cfg, null, 2));
    fs.appendFileSync(h.user('custom.css'), '\n/* my tweak */\n');

    const s = run(h, ['sync-upgrade', '--force']);
    assert.equal(s.status, 0, s.stderr);
    const after = JSON.parse(h.readUser('config.json'));
    assert.equal(after.modules.i18n, true);
    assert.equal(after.contextLimit, 999);
    assert.match(h.readUser('custom.css'), /my tweak/);

    /* explicit overwrite saves the local copy first */
    const o = run(h, ['sync-upgrade', '--overwrite-local']);
    assert.equal(o.status, 0);
    assert.doesNotMatch(h.readUser('custom.css'), /my tweak/);
    const saves = fs.readdirSync(path.join(h.home, '.gemini/antigravity/claude-ux/local-saves'));
    assert.ok(saves.some((f) => f.endsWith('custom.css')));
  } finally {
    h.cleanup();
  }
});

test('uninstall keeps post-install edits in a saved copy', () => {
  const h = makeHome();
  try {
    run(h, ['install']);
    fs.appendFileSync(h.user('custom.css'), '\n/* edited after install */\n');
    const un = run(h, ['uninstall']);
    assert.equal(un.out.files.savedLocalEdits.length, 1);
    assert.match(fs.readFileSync(un.out.files.savedLocalEdits[0], 'utf8'), /edited after install/);
    assert.equal(h.readUser('custom.css'), '/* my original css */\n');
  } finally {
    h.cleanup();
  }
});

test('background sync does not re-add a removed AGENTS.md rule or re-force step settings', () => {
  const h = makeHome();
  try {
    run(h, ['install']);
    fs.writeFileSync(path.join(h.home, '.gemini/AGENTS.md'), '# my rules\n');
    fs.writeFileSync(path.join(h.home, '.gemini/antigravity/antigravity_state.pbtxt'), 'product_skin: PRODUCT_SKIN_NON_TECHNICAL\n');
    const s = run(h, ['sync-upgrade']);
    assert.equal(s.out.ruleStatus, 'absent_respected');
    assert.doesNotMatch(h.read('.gemini/AGENTS.md'), /antigravity-claude-ux/);
    assert.match(h.read('.gemini/antigravity/antigravity_state.pbtxt'), /NON_TECHNICAL/);
  } finally {
    h.cleanup();
  }
});

test('upstream verify ok:false is reported as partial, not success', () => {
  const h = makeHome();
  try {
    const r = run(h, ['install'], { FAKE_VERIFY_OK: '0' });
    assert.equal(r.status, 0);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.status, 'partial');
    assert.equal(r.out.verify.ok, false);
    assert.ok(r.out.warnings.some((w) => /verify/.test(w)));
  } finally {
    h.cleanup();
  }
});

test('v1 installs are migrated and can then be uninstalled cleanly', () => {
  const h = makeHome();
  try {
    /* simulate the v1 layout: legacy backup dir + deployed files + settings already flipped by v1 */
    fs.writeFileSync(path.join(h.home, '.gemini/antigravity/antigravity_state.pbtxt'), 'product_skin: PRODUCT_SKIN_DEVELOPER\n');
    fs.writeFileSync(path.join(h.home, '.gemini/config/config.json'), JSON.stringify({ userSettings: { verboseConversationSteps: true } }));
    const legacy = path.join(path.dirname(h.user('x')), '.backup-before-claude-ux');
    fs.mkdirSync(legacy);
    for (const f of ['custom.css', 'custom.js', 'config.json', 'i18n.override.json']) {
      fs.copyFileSync(h.user(f), path.join(legacy, f));
      fs.copyFileSync(path.join(REPO, 'user', f), h.user(f));
    }
    const s = run(h, ['sync-upgrade']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(fs.existsSync(legacy), false);
    const un = run(h, ['uninstall']);
    assert.equal(un.status, 0);
    assert.equal(h.readUser('custom.css'), '/* my original css */\n');
    assert.equal(h.readUser('custom.js'), '/* my original js */\n');
    /* v1 never recorded previous settings, so they are left alone */
    assert.match(un.out.settings.note, /v1/);
  } finally {
    h.cleanup();
  }
});

test('pure helpers: scheduling, 3-way merge, trailing JSON, semver', async () => {
  const m = await import(INSTALL);
  /* 12-hour runs over 96 hours: every run after the first must check the remote again */
  let now = 1_700_000_000_000;
  const sync = {};
  let checks = 0;
  for (let i = 0; i < 9; i++) {
    if (m.shouldCheckRemote(sync, { now })) {
      checks++;
      sync.lastRemoteCheckAt = now;
    }
    sync.lastAppliedAt = now;
    now += 12 * 3600 * 1000;
  }
  assert.equal(checks, 9);

  const base = { modules: { i18n: true, a: 1 }, preset: 'x' };
  const local = { modules: { i18n: false, a: 1 }, preset: 'x', mine: true };
  const remote = { modules: { i18n: true, a: 2, b: 3 }, preset: 'y' };
  assert.deepEqual(m.threeWayMergeJson(base, local, remote), { modules: { i18n: false, a: 2, b: 3 }, preset: 'y', mine: true });

  assert.deepEqual(m.parseTrailingJson('[daemon] hi\n{"x":1}\nnoise? no\n{\n  "ok": false\n}\n'), { ok: false });
  assert.ok(m.compareSemver('5.4.0', '5.3.9') > 0);
  assert.equal(m.compareSemver('5.3.0', '5.3.0'), 0);
});
