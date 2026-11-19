/**
 * Antigravity CLI (agy) statusline & installer integration tests.
 * Zero dependencies: `node --test test/cli.test.mjs`
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
const STATUSLINE = path.join(REPO, 'cli', 'statusline.mjs');

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

function makeCliHome({ withSettings = true, settingsContent = null, withDesktop = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-claude-cli-test-'));
  const cliDir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(cliDir, { recursive: true });
  if (withSettings) {
    const data = settingsContent ?? {
      model: 'Gemini 4 Neon',
      statusLine: { type: 'command', command: 'model tokens', enabled: false },
      toolPermission: 'always-proceed'
    };
    fs.writeFileSync(path.join(cliDir, 'settings.json'), JSON.stringify(data, null, 2));
  }
  fs.writeFileSync(path.join(home, '.gemini', 'AGENTS.md'), '# my rules\n');

  if (withDesktop) {
    const agy = path.join(home, '.gemini', 'antigravity');
    fs.mkdirSync(agy, { recursive: true });
    fs.writeFileSync(path.join(agy, 'antigravity_state.pbtxt'), 'product_skin: PRODUCT_SKIN_NON_TECHNICAL\n');
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ userSettings: { verboseConversationSteps: false } }));
  }

  return {
    home,
    cliDir,
    read: (rel) => fs.readFileSync(path.join(home, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(home, rel)),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

function run(h, args, env = {}) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: h.home,
      ANTI_CLAUDE_NO_NETWORK: '1',
      ANTI_CLAUDE_NO_LAUNCHD: '1',
      ANTI_CLAUDE_NO_CDP: '1',
      ANTI_CLAUDE_NO_FONTS: '1',
      ANTI_CLAUDE_NO_CLI: '1',
      ...env
    }
  });
  return { status: r.status, out: parseTrailingJson(r.stdout || ''), stdout: r.stdout, stderr: r.stderr };
}

test('statusline formats full telemetry payload and adapts to narrow terminals', async () => {
  const { formatStatusLine, stripAnsi } = await import(STATUSLINE);
  const payload = {
    model: { display_name: 'Gemini 4 Neon' },
    context_window: { used_percentage: 38, context_window_size: 256000 },
    vcs: { branch: 'main', dirty: true },
    workspace: { current_dir: '/Users/dev/Anti-Claude' },
    agent_state: 'working',
    terminal_width: 120
  };

  const full = formatStatusLine(payload, { noColor: true });
  assert.equal(full, 'Gemini 4 Neon · ▓▓▓░░░░░ 38% · main* · Anti-Claude · ● Working');

  const idle = formatStatusLine({ ...payload, agent_state: 'idle' }, { noColor: true });
  assert.doesNotMatch(idle, /Idle|Working/);

  const coloredHigh = formatStatusLine({ ...payload, context_window: { used_percentage: 90 } }, { noColor: false });
  assert.match(coloredHigh, /\x1b\[31m/); // red threshold >= 85%

  const narrow = formatStatusLine({ ...payload, terminal_width: 34 }, { noColor: true });
  assert.ok(stripAnsi(narrow).length <= 32, `narrow line too wide: ${narrow}`);
  assert.match(narrow, /Gemini 4 Neon/);
  assert.match(narrow, /38%/);
});

test('statusline CLI process handles valid JSON and ignores malformed stdin cleanly', () => {
  const ok = spawnSync(process.execPath, [STATUSLINE], {
    encoding: 'utf8',
    input: JSON.stringify({
      model: { display_name: 'Gemini 4 Neon' },
      context_window: { used_percentage: 25 },
      vcs: { branch: 'feat/cli', dirty: false },
      agent_state: 'thinking'
    }),
    env: { ...process.env, NO_COLOR: '1' }
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'Gemini 4 Neon · ▓▓░░░░░░ 25% · feat/cli · ● Thinking');

  const bad = spawnSync(process.execPath, [STATUSLINE], {
    encoding: 'utf8',
    input: '{not valid json',
    env: { ...process.env, NO_COLOR: '1' }
  });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('--cli-only installs without Desktop app, configures statusLine + AGENTS.md, and rolls back cleanly', () => {
  const h = makeCliHome({ withSettings: true, withDesktop: false });
  try {
    const beforeSettings = h.read('.gemini/antigravity-cli/settings.json');
    const beforeAgents = h.read('.gemini/AGENTS.md');

    const inst = run(h, ['install', '--cli-only']);
    assert.equal(inst.status, 0, inst.stderr);
    assert.equal(inst.out.status, 'ok', JSON.stringify(inst.out));
    assert.equal(inst.out.mode, 'cli-only');
    assert.equal(h.exists('.gemini/antigravity-cli/anti-claude-statusline.mjs'), true);
    assert.equal(h.exists('.gemini/antigravity/theme-patch'), false, 'desktop theme-patch not touched in --cli-only');

    const settings = JSON.parse(h.read('.gemini/antigravity-cli/settings.json'));
    assert.equal(settings.model, 'Gemini 4 Neon', 'unrelated settings preserved');
    assert.equal(settings.toolPermission, 'always-proceed', 'unrelated settings preserved');
    assert.equal(settings.statusLine.enabled, true);
    assert.match(settings.statusLine.command, /anti-claude-statusline\.mjs/);
    assert.match(h.read('.gemini/AGENTS.md'), /BEGIN anti-claude/);

    const doc = run(h, ['doctor']);
    assert.equal(doc.status, 0);
    assert.equal(doc.out.mode, 'cli-only');
    assert.equal(doc.out.antigravityCli.statusLineInstalled, true);
    assert.equal(doc.out.antigravityCli.statusLineEnabled, true);

    const sync = run(h, ['sync-upgrade']);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(sync.out.mode, 'cli-only');

    const un = run(h, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.deepEqual(JSON.parse(h.read('.gemini/antigravity-cli/settings.json')), JSON.parse(beforeSettings));
    assert.equal(h.exists('.gemini/antigravity-cli/anti-claude-statusline.mjs'), false);
    assert.equal(h.read('.gemini/AGENTS.md'), beforeAgents);
    assert.equal(h.exists('.gemini/antigravity/anti-claude'), false);

    const un2 = run(h, ['uninstall']);
    assert.equal(un2.status, 0);
    assert.equal(un2.out.noop, true);
  } finally {
    h.cleanup();
  }
});

test('--cli-only removes settings.json on uninstall if it did not exist before install', () => {
  const h = makeCliHome({ withSettings: false, withDesktop: false });
  try {
    const inst = run(h, ['install', '--cli-only']);
    assert.equal(inst.status, 0, inst.stderr);
    assert.equal(h.exists('.gemini/antigravity-cli/settings.json'), true);

    const un = run(h, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.equal(h.exists('.gemini/antigravity-cli/settings.json'), false);
    assert.equal(h.exists('.gemini/antigravity-cli/anti-claude-statusline.mjs'), false);
  } finally {
    h.cleanup();
  }
});

test('desktop+cli install supports --cli and --no-cli, and respects user statusLine overrides', () => {
  const h = makeCliHome({ withSettings: true, withDesktop: true });
  try {
    const noCli = run(h, ['install', '--no-cli']);
    assert.equal(noCli.status, 0, noCli.stderr);
    assert.equal(noCli.out.mode, 'desktop');
    assert.equal(h.exists('.gemini/antigravity-cli/anti-claude-statusline.mjs'), false);

    const withCli = run(h, ['install', '--cli']);
    assert.equal(withCli.status, 0, withCli.stderr);
    assert.equal(withCli.out.mode, 'desktop+cli');
    assert.equal(h.exists('.gemini/antigravity-cli/anti-claude-statusline.mjs'), true);

    /* User switches to their own custom statusLine; sync-upgrade and uninstall must respect it */
    const customSettings = JSON.parse(h.read('.gemini/antigravity-cli/settings.json'));
    customSettings.statusLine = { type: 'command', command: '/usr/local/bin/my-statusline.sh', enabled: true };
    fs.writeFileSync(path.join(h.cliDir, 'settings.json'), JSON.stringify(customSettings, null, 2));

    const sync = run(h, ['sync-upgrade']);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(sync.out.cliLayer.settings.action, 'user_override_respected');
    assert.equal(JSON.parse(h.read('.gemini/antigravity-cli/settings.json')).statusLine.command, '/usr/local/bin/my-statusline.sh');

    const un = run(h, ['uninstall']);
    assert.equal(un.status, 0, un.stderr);
    assert.equal(un.out.cli.settings, 'user_override_kept');
    assert.equal(JSON.parse(h.read('.gemini/antigravity-cli/settings.json')).statusLine.command, '/usr/local/bin/my-statusline.sh');
  } finally {
    h.cleanup();
  }
});
