#!/usr/bin/env node
/**
 * Anti-Claude — install.mjs
 * Zero-dependency CLI installer, step-stream unlocker, auto-updater, doctor & uninstaller (Node.js >= 22)
 *
 * Commands:
 *   node install.mjs install [--cli] [--cli-only] [--no-cli] [--no-cli-statusline] [--no-auto-update] [--no-step-unlock] [--no-agents-rule] [--overwrite-local]
 *   node install.mjs sync-upgrade [--force] [--overwrite-local]
 *   node install.mjs auto-update-on | auto-update-off
 *   node install.mjs doctor
 *   node install.mjs sync-fonts
 *   node install.mjs uninstall          Idempotent: a second run is a no-op
 *
 * State lives in ~/.gemini/antigravity/anti-claude/ (outside the upstream user/ dir;
 * legacy ~/.gemini/antigravity/claude-ux/ installs are migrated automatically):
 *   install-state.json   ownership of every file / setting this tool changed + sync timestamps
 *   backup/              pre-install originals of user/ files
 *   base/                last deployed template copies (3-way merge base, local-edit detection)
 *   incoming/            new template versions held back because the user edited the live file
 *
 * Exit codes: 0 = ok / partial (see "status"), 1 = failed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME = os.homedir();
const GEMINI_DIR = path.join(HOME, '.gemini');
const AGY_DIR = path.join(GEMINI_DIR, 'antigravity');
const THEME_PATCH_DIR = path.join(AGY_DIR, 'theme-patch');
const THEME_USER_DIR = path.join(THEME_PATCH_DIR, 'user');
const AGY_STATE_PBTXT = path.join(AGY_DIR, 'antigravity_state.pbtxt');
const AGY_CONFIG_JSON = path.join(GEMINI_DIR, 'config', 'config.json');
const AGENTS_MD = path.join(GEMINI_DIR, 'AGENTS.md');
const AGY_CLI_DIR = path.join(GEMINI_DIR, 'antigravity-cli');
const AGY_CLI_SETTINGS_JSON = path.join(AGY_CLI_DIR, 'settings.json');
const AGY_CLI_STATUSLINE_NAME = 'anti-claude-statusline.mjs';
const AGY_CLI_STATUSLINE_FILE = path.join(AGY_CLI_DIR, AGY_CLI_STATUSLINE_NAME);

const STATE_DIR = path.join(AGY_DIR, 'anti-claude');
const STATE_FILE = path.join(STATE_DIR, 'install-state.json');
const BACKUP_DIR = path.join(STATE_DIR, 'backup');
const BASE_DIR = path.join(STATE_DIR, 'base');
const INCOMING_DIR = path.join(STATE_DIR, 'incoming');
const LOCAL_SAVE_DIR = path.join(STATE_DIR, 'local-saves');
const SYNC_LOG_FILE = path.join(STATE_DIR, 'auto-sync.log');
const LAUNCHD_LOG_FILE = path.join(STATE_DIR, 'launchd.log');

/* Legacy locations (v1 & pre-rename claude-ux), migrated automatically on first run */
const LEGACY_V2_STATE_DIR = path.join(AGY_DIR, 'claude-ux');
const LEGACY_V2_STATE_FILE = path.join(LEGACY_V2_STATE_DIR, 'install-state.json');
const LEGACY_BACKUP_DIR = path.join(THEME_USER_DIR, '.backup-before-claude-ux');
const LEGACY_SYNC_STATE_FILE = path.join(THEME_USER_DIR, '.claude-ux-sync-state.json');
const LEGACY_SYNC_LOG_FILE = path.join(THEME_USER_DIR, 'auto-sync.log');

const AUTOSYNC_LABEL = 'com.antigravity.anti-claude.autosync';
const AUTOSYNC_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${AUTOSYNC_LABEL}.plist`);
const LEGACY_AUTOSYNC_LABEL = 'com.antigravity.claude-ux.autosync';
const LEGACY_AUTOSYNC_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LEGACY_AUTOSYNC_LABEL}.plist`);
const THEME_DAEMON_LABEL = 'com.antigravity.theme';
const DAEMON_WRAPPER_FILE = path.join(AGY_DIR, 'scripts', 'antigravity-font-daemon.mjs');
const AG2_SYNC_SCRIPT = path.join(AGY_DIR, 'scripts', 'sync-antigravity-2.mjs');

const UPSTREAM_REPO = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
/* Verified upstream commit (v5.4.2). Bump deliberately after testing; override with ANTI_CLAUDE_UPSTREAM_REF=HEAD at your own risk. */
const UPSTREAM_REF = process.env.ANTI_CLAUDE_UPSTREAM_REF || process.env.CLAUDE_UX_UPSTREAM_REF || '6b3783d2a5104e863084adfffea1d61f95838ead';
const SELF_REPO = 'https://github.com/hongqi7/Anti-Claude.git';
const RULE_BEGIN = '<!-- BEGIN anti-claude -->';
const RULE_END = '<!-- END anti-claude -->';
const LEGACY_RULE_BEGIN = '<!-- BEGIN antigravity-claude-ux -->';
const LEGACY_RULE_END = '<!-- END antigravity-claude-ux -->';
const LEGACY_HEADING = '## 执行过程同步（Claude 式边做边汇报）';
const USER_LAYER_FILES = ['config.json', 'custom.css', 'custom.js', 'i18n.override.json'];
const STUB_CONTENT = { 'custom.css': '/* user/custom.css */\n', 'custom.js': '/* user/custom.js */\n' };

const REMOTE_CHECK_INTERVAL_MS = 11 * 3600 * 1000; // < launchd StartInterval (12h)
const NO_NETWORK = process.env.ANTI_CLAUDE_NO_NETWORK === '1' || process.env.CLAUDE_UX_NO_NETWORK === '1';
const NO_LAUNCHD = process.env.ANTI_CLAUDE_NO_LAUNCHD === '1' || process.env.CLAUDE_UX_NO_LAUNCHD === '1';
const NO_CDP = process.env.ANTI_CLAUDE_NO_CDP === '1' || process.env.CLAUDE_UX_NO_CDP === '1';
const NO_FONTS = process.env.ANTI_CLAUDE_NO_FONTS === '1' || process.env.CLAUDE_UX_NO_FONTS === '1';
const NO_CLI = process.env.ANTI_CLAUDE_NO_CLI === '1' || process.env.CLAUDE_UX_NO_CLI === '1';
const CDP_TIMEOUT_MS = Number(process.env.ANTI_CLAUDE_CDP_TIMEOUT_MS || process.env.CLAUDE_UX_CDP_TIMEOUT_MS) || 5000;
const STATE_SCHEMA = 2;

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

function writeJsonAtomic(p, obj) {
  writeFileAtomic(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function sha256Text(t) {
  return t === null || t === undefined ? '' : crypto.createHash('sha256').update(t).digest('hex');
}

function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * 3-way JSON merge: base = template we deployed last time, local = live file, remote = new template.
 * User changes (local vs base) always win; template changes the user did not touch are applied.
 */
export function threeWayMergeJson(base, local, remote) {
  if (deepEqual(local, base)) return clone(remote);
  if (deepEqual(remote, base)) return clone(local);
  if (!isPlainObject(base) || !isPlainObject(local) || !isPlainObject(remote)) return clone(local);
  const out = {};
  const keys = [...new Set([...Object.keys(remote), ...Object.keys(local)])];
  for (const k of keys) {
    const inB = Object.prototype.hasOwnProperty.call(base, k);
    const inL = Object.prototype.hasOwnProperty.call(local, k);
    const inR = Object.prototype.hasOwnProperty.call(remote, k);
    if (inB && !inL) continue; // user deleted the key: respect it
    if (inB && !inR) {
      if (inL && !deepEqual(local[k], base[k])) out[k] = clone(local[k]); // template dropped it, user customised it
      continue;
    }
    if (!inB) {
      if (inL && inR) out[k] = threeWayMergeJson({}, local[k], remote[k]);
      else out[k] = clone(inL ? local[k] : remote[k]);
      continue;
    }
    out[k] = threeWayMergeJson(base[k], local[k], remote[k]);
  }
  return out;
}

/** Parse the last top-level JSON object printed to stdout (upstream prints daemon logs before its JSON). */
export function parseTrailingJson(text) {
  if (!text) return null;
  const s = String(text);
  const starts = [];
  if (s.startsWith('{')) starts.push(0);
  for (let i = s.indexOf('\n{'); i !== -1; i = s.indexOf('\n{', i + 1)) starts.push(i + 1);
  for (let j = starts.length - 1; j >= 0; j--) {
    try {
      return JSON.parse(s.slice(starts[j]).trim());
    } catch {}
  }
  return null;
}

export function compareSemver(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function shouldCheckRemote(sync, { now = Date.now(), force = false, appChanged = false } = {}) {
  if (force || appChanged) return true;
  const last = Number(sync && sync.lastRemoteCheckAt) || 0;
  return now - last >= REMOTE_CHECK_INTERVAL_MS;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function appendSyncLog(msg) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}`;
    const prev = readTextSafe(SYNC_LOG_FILE);
    const lines = prev ? prev.trim().split('\n').slice(-199) : [];
    lines.push(line);
    writeFileAtomic(SYNC_LOG_FILE, `${lines.join('\n')}\n`);
  } catch {}
}

function finalize(report, { critical = [], warnings = [] } = {}) {
  const status = critical.length ? 'failed' : warnings.length ? 'partial' : 'ok';
  const out = Object.assign({ ok: status === 'ok', status }, report);
  if (critical.length) out.errors = critical;
  if (warnings.length) out.warnings = warnings;
  console.log(JSON.stringify(out, null, 2));
  if (status === 'failed') process.exitCode = 1;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Environment probes                                                         */
/* -------------------------------------------------------------------------- */

function getAntigravityAppFingerprint() {
  if (process.platform === 'darwin') {
    const plist = '/Applications/Antigravity.app/Contents/Info.plist';
    const asar = '/Applications/Antigravity.app/Contents/Resources/app.asar';
    let version = 'unknown';
    try {
      version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {}
    let asarSig = 'missing';
    let changedAtMs = 0;
    try {
      const st = fs.statSync(asar);
      changedAtMs = Math.max(st.mtimeMs, st.ctimeMs);
      asarSig = `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {}
    return { version, asarSig, changedAtMs, sig: `${version}|${asarSig}` };
  }
  return { version: 'unknown', asarSig: 'unknown', changedAtMs: 0, sig: process.platform };
}

function getDevToolsPortFile() {
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  return path.join(HOME, '.config', 'Antigravity', 'DevToolsActivePort');
}

function getUserFontsDir() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Fonts');
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    return path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
  }
  return path.join(HOME, '.local', 'share', 'fonts');
}

function checkFontsInstalled() {
  const dir = getUserFontsDir();
  try {
    const files = fs.readdirSync(dir);
    return {
      dir,
      hasAnthropicSans: files.some((f) => /AnthropicSans/i.test(f)),
      hasAnthropicSerif: files.some((f) => /AnthropicSerif/i.test(f))
    };
  } catch {
    return { dir, hasAnthropicSans: false, hasAnthropicSerif: false };
  }
}

function syncFontsFromLocalClaudeApp() {
  if (process.platform !== 'darwin') return { synced: false, reason: 'not_macos' };
  const claudeFontsDir = '/Applications/Claude.app/Contents/Resources/fonts';
  if (!fs.existsSync(claudeFontsDir)) return { synced: false, reason: 'claude_app_not_installed' };
  const destDir = getUserFontsDir();
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(claudeFontsDir)) {
    if (/^Anthropic.*\.(ttf|otf)$/i.test(name)) {
      const dst = path.join(destDir, name);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(path.join(claudeFontsDir, name), dst);
        copied.push(name);
      }
    }
  }
  return { synced: true, copied, note: 'Fonts are copied from your own local Claude.app for personal use only.' };
}

function findAgyCliBinary() {
  if (NO_CLI) return null;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, ['agy'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}
  const fallbacks =
    process.platform === 'win32'
      ? [path.join(HOME, '.local', 'bin', 'agy.exe')]
      : [path.join(HOME, '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectAntigravityCli() {
  const configDirExists = fs.existsSync(AGY_CLI_DIR);
  const settingsExists = fs.existsSync(AGY_CLI_SETTINGS_JSON);
  const binary = findAgyCliBinary();
  let version = null;
  if (binary) {
    try {
      version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {}
  }
  const settings = settingsExists ? readJsonSafe(AGY_CLI_SETTINGS_JSON, null) : null;
  const statusLineInstalled = fs.existsSync(AGY_CLI_STATUSLINE_FILE);
  const statusLineEnabled = Boolean(
    settings?.statusLine?.enabled === true &&
      String(settings?.statusLine?.command || '').includes(AGY_CLI_STATUSLINE_NAME)
  );
  return {
    detected: Boolean(binary || configDirExists),
    binary,
    version,
    configDir: AGY_CLI_DIR,
    configDirExists,
    settingsExists,
    statusLineInstalled,
    statusLineEnabled
  };
}

/** Prefer a version-independent node path so `brew upgrade node` does not break the LaunchAgent. */
export function stableNodePath(execPath = process.execPath) {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  let realExec = execPath;
  try {
    realExec = fs.realpathSync(execPath);
  } catch {}
  for (const c of candidates) {
    try {
      if (fs.realpathSync(c) === realExec) return c;
    } catch {}
  }
  if (/\/Cellar\/node(@[\d.]+)?\//.test(execPath)) {
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  return execPath;
}

/* -------------------------------------------------------------------------- */
/* State (ownership manifest)                                                 */
/* -------------------------------------------------------------------------- */

function newState() {
  return {
    schema: STATE_SCHEMA,
    installedAt: Date.now(),
    repoUrl: SELF_REPO,
    options: { desktop: true, cli: false, cliStatusLine: true, stepUnlock: true, agentsRule: true, autoUpdate: true },
    files: {},
    cli: {},
    settings: {},
    agentsRule: { inserted: false },
    sync: {}
  };
}

function migrateLegacyState() {
  const hasLegacyBackup = fs.existsSync(LEGACY_BACKUP_DIR);
  const legacySync = readJsonSafe(LEGACY_SYNC_STATE_FILE, null);
  if (!hasLegacyBackup && !legacySync) return null;
  const state = newState();
  state.migratedFrom = 'v1';
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  for (const f of USER_LAYER_FILES) {
    const legacyBak = path.join(LEGACY_BACKUP_DIR, f);
    const live = path.join(THEME_USER_DIR, f);
    const hasBak = hasLegacyBackup && fs.existsSync(legacyBak);
    if (hasBak) fs.copyFileSync(legacyBak, path.join(BACKUP_DIR, f));
    if (fs.existsSync(live)) {
      /* v1 deployed whatever is live now; treat it as the merge base */
      fs.copyFileSync(live, path.join(BASE_DIR, f));
      state.files[f] = { existedBefore: hasBak ? true : null, deployedSha: sha256File(live) };
    }
  }
  /* v1 did not record previous settings: unknown -> never auto-revert */
  state.settings = { legacyUnknown: true };
  if (legacySync) {
    state.installedAt = Number(legacySync.lastSyncAt) || state.installedAt;
    state.sync = {
      appVersion: legacySync.appVersion,
      appSig: legacySync.appSig,
      lastAppliedAt: legacySync.lastSyncAt,
      lastRemoteCheckAt: 0
    };
  }
  const agentsRaw = readTextSafe(AGENTS_MD) || '';
  state.agentsRule.inserted = agentsRaw.includes(RULE_BEGIN) || agentsRaw.includes(LEGACY_RULE_BEGIN);
  state.options.autoUpdate = fs.existsSync(AUTOSYNC_PLIST) || fs.existsSync(LEGACY_AUTOSYNC_PLIST);
  saveState(state);
  fs.rmSync(LEGACY_BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(LEGACY_SYNC_STATE_FILE, { force: true });
  return state;
}

function migrateLegacyV2State() {
  const legacyState = readJsonSafe(LEGACY_V2_STATE_FILE, null);
  if (!legacyState || legacyState.schema !== STATE_SCHEMA) return null;
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(path.dirname(STATE_DIR), { recursive: true });
    try {
      fs.renameSync(LEGACY_V2_STATE_DIR, STATE_DIR);
    } catch {
      fs.cpSync(LEGACY_V2_STATE_DIR, STATE_DIR, { recursive: true });
      fs.rmSync(LEGACY_V2_STATE_DIR, { recursive: true, force: true });
    }
  } else {
    fs.cpSync(LEGACY_V2_STATE_DIR, STATE_DIR, { recursive: true, force: false });
    fs.rmSync(LEGACY_V2_STATE_DIR, { recursive: true, force: true });
  }
  legacyState.migratedFrom = legacyState.migratedFrom || 'claude-ux';
  legacyState.repoUrl = SELF_REPO;
  saveState(legacyState);
  return legacyState;
}

function loadState() {
  const st = readJsonSafe(STATE_FILE, null);
  if (st && st.schema === STATE_SCHEMA) return st;
  return migrateLegacyV2State() || migrateLegacyState();
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

/* -------------------------------------------------------------------------- */
/* Source validation & repos                                                  */
/* -------------------------------------------------------------------------- */

function validateSourceRoot(root = __dirname) {
  const problems = [];
  for (const rel of ['install.mjs', 'user/custom.js', 'cli/statusline.mjs']) {
    try {
      execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${rel}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  for (const rel of ['user/config.json', 'user/i18n.override.json']) {
    if (readJsonSafe(path.join(root, rel), undefined) === undefined) problems.push(`${rel}: invalid JSON`);
  }
  if (!fs.existsSync(path.join(root, 'rules', 'claude-execution-sync.md'))) problems.push('rules/claude-execution-sync.md missing');
  return { ok: problems.length === 0, problems };
}

function cloneUpstreamAtRef(tmpDir, quiet) {
  const stdio = quiet ? 'pipe' : 'inherit';
  if (UPSTREAM_REF === 'HEAD') {
    execFileSync('git', ['clone', '--depth', '1', UPSTREAM_REPO, tmpDir], { stdio, timeout: 30000 });
    return;
  }
  execFileSync('git', ['init', '-q', tmpDir], { stdio, timeout: 10000 });
  execFileSync('git', ['-C', tmpDir, 'fetch', '--depth', '1', '--quiet', UPSTREAM_REPO, UPSTREAM_REF], { stdio, timeout: 30000 });
  execFileSync('git', ['-C', tmpDir, 'checkout', '-q', 'FETCH_HEAD'], { stdio, timeout: 10000 });
}

/**
 * Install the upstream core if missing; with `upgrade`, move it to the pinned ref only when the pinned
 * manifest version is newer than the local one (never downgrades a manually upgraded core).
 */
function ensureUpstreamCore({ upgrade = false } = {}) {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  const localInstalled = fs.existsSync(upstreamEntry);
  if (localInstalled && (!upgrade || NO_NETWORK)) return { installed: true, upgraded: false };
  if (!localInstalled && NO_NETWORK) throw new Error('upstream core missing and CLAUDE_UX_NO_NETWORK=1');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chuanban-base-'));
  try {
    cloneUpstreamAtRef(tmpDir, localInstalled);
    const remoteVer = readJsonSafe(path.join(tmpDir, 'core', 'manifest.json'), {})?.version;
    const localVer = readJsonSafe(path.join(THEME_PATCH_DIR, 'core', 'manifest.json'), {})?.version;
    if (localInstalled && compareSemver(remoteVer, localVer) <= 0) {
      return { installed: true, upgraded: false, upToDate: true, localVersion: localVer, pinnedVersion: remoteVer };
    }
    execFileSync(process.execPath, [path.join(tmpDir, 'install.mjs'), 'install'], {
      stdio: localInstalled ? 'pipe' : 'inherit',
      timeout: 60000
    });
    return { installed: true, upgraded: localInstalled, freshInstall: !localInstalled, ref: UPSTREAM_REF, version: remoteVer };
  } catch (err) {
    if (localInstalled) return { installed: true, upgraded: false, error: String(err?.message || err).split('\n')[0] };
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pullSelfRepoIfGit() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return { pulled: false, reason: 'not_git_checkout' };
  try {
    const head = () => execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const beforeHead = head();
    execFileSync('git', ['-C', __dirname, 'pull', '--ff-only', '--quiet'], { stdio: 'pipe', timeout: 20000 });
    const afterHead = head();
    return { pulled: true, updated: beforeHead !== afterHead, beforeHead, afterHead };
  } catch (err) {
    return { pulled: false, error: String(err?.stderr || err?.message || err).split('\n')[0] };
  }
}

/* -------------------------------------------------------------------------- */
/* Live CDP (with per-request deadline and close/error handling)              */
/* -------------------------------------------------------------------------- */

export async function withCdpPage(fn, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
  if (NO_CDP) return { ok: false, reason: 'cdp_disabled', appRunning: false };
  const raw = readTextSafe(getDevToolsPortFile());
  if (!raw) return { ok: false, reason: 'app_not_running', appRunning: false };
  const [port] = raw.trim().split(/\r?\n/);
  if (!port) return { ok: false, reason: 'empty_port' };

  let ws;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = await res.json();
    const target = list.find((x) => x.type === 'page' && String(x.url).includes('127.0.0.1:'));
    if (!target || !target.webSocketDebuggerUrl) return { ok: false, reason: 'main_page_not_found' };

    ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let closedReason = null;
    const failAll = (reason) => {
      closedReason = closedReason || reason;
      for (const [, p] of pending) p.reject(new Error(reason));
      pending.clear();
    };
    ws.addEventListener('message', (ev) => {
      let d;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = pending.get(d.id);
      if (p) {
        pending.delete(d.id);
        p.resolve(d);
      }
    });
    ws.addEventListener('close', () => failAll('ws_closed'));
    ws.addEventListener('error', () => failAll('ws_error'));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws_open_timeout')), 2500);
      ws.addEventListener('open', () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener('close', () => (clearTimeout(t), reject(new Error('ws_closed'))), { once: true });
      ws.addEventListener('error', () => (clearTimeout(t), reject(new Error('ws_error'))), { once: true });
    });

    let nextId = 1;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (closedReason) return reject(new Error(closedReason));
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('cdp_timeout'));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e))
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    return await fn(send);
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    try {
      ws?.close();
    } catch {}
  }
}

/** Read (and optionally set) Antigravity preference values through the live React pref store. */
export async function cdpPrefs(setMap) {
  const keys = ['project4kMode', 'verboseConversationSteps'];
  const pageFn = async function (keys, setMap) {
    let prefStore = null;
    for (const el of document.querySelectorAll('#root *')) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!key) continue;
      for (let f = el[key]; f && !prefStore; f = f.return) {
        for (let d = f.dependencies?.firstContext; d; d = d.next) {
          const v = d.memoizedValue;
          if (v && typeof v.getState === 'function') {
            const st = v.getState();
            if (st && typeof st.setPrefValue === 'function' && typeof st.getPrefValue === 'function') {
              prefStore = v;
              break;
            }
          }
        }
      }
      if (prefStore) break;
    }
    if (!prefStore) return { found: false };
    const read = () => Object.fromEntries(keys.map((k) => [k, prefStore.getState().getPrefValue(k)]));
    const before = read();
    if (setMap) {
      for (const [k, v] of Object.entries(setMap)) await prefStore.getState().setPrefValue(k, v);
    }
    return { found: true, before, after: read() };
  };
  return withCdpPage(async (send) => {
    const r = await send('Runtime.evaluate', {
      expression: `(${pageFn.toString()})(${JSON.stringify(keys)}, ${JSON.stringify(setMap || null)})`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.error) return { ok: false, reason: `cdp_error: ${r.error.message || JSON.stringify(r.error)}` };
    if (r.result?.exceptionDetails) {
      const ex = r.result.exceptionDetails;
      return { ok: false, reason: `eval_exception: ${ex.exception?.description || ex.text || 'unknown'}` };
    }
    const v = r.result?.result?.value;
    if (!v || !v.found) return { ok: false, reason: 'pref_store_not_found' };
    const applied = !setMap || Object.entries(setMap).every(([k, val]) => v.after[k] === val);
    return { ok: applied, reason: applied ? undefined : 'pref_not_applied', before: v.before, after: v.after };
  });
}

/* -------------------------------------------------------------------------- */
/* Step-stream settings (recorded for rollback)                               */
/* -------------------------------------------------------------------------- */

async function applyStepUnlock(state) {
  const settings = (state.settings = state.settings || {});
  const live = await cdpPrefs({ project4kMode: 1, verboseConversationSteps: true });
  if (live.before && !settings.live) settings.live = { captured: true, before: live.before };

  const actions = [];
  if (fs.existsSync(AGY_STATE_PBTXT)) {
    const content = fs.readFileSync(AGY_STATE_PBTXT, 'utf8');
    if (/product_skin:\s*PRODUCT_SKIN_NON_TECHNICAL/.test(content)) {
      writeFileAtomic(AGY_STATE_PBTXT, content.replace(/product_skin:\s*PRODUCT_SKIN_NON_TECHNICAL/g, 'product_skin: PRODUCT_SKIN_DEVELOPER'));
      settings.pbtxt = { changed: true, before: 'PRODUCT_SKIN_NON_TECHNICAL' };
      actions.push('pbtxt_developer_skin');
    } else if (!settings.pbtxt) {
      settings.pbtxt = { changed: false };
    }
  }
  if (fs.existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON, null);
    if (cfg) {
      cfg.userSettings = cfg.userSettings || {};
      if (cfg.userSettings.verboseConversationSteps !== true) {
        if (!settings.verbose?.changed) {
          settings.verbose = {
            changed: true,
            hadKey: Object.prototype.hasOwnProperty.call(cfg.userSettings, 'verboseConversationSteps'),
            before: cfg.userSettings.verboseConversationSteps
          };
        }
        cfg.userSettings.verboseConversationSteps = true;
        writeJsonAtomic(AGY_CONFIG_JSON, cfg);
        actions.push('config_json_verbose_steps');
      } else if (!settings.verbose) {
        settings.verbose = { changed: false };
      }
    }
  }
  return { live, fileActions: actions };
}

async function revertStepUnlock(state) {
  const settings = state.settings || {};
  const out = { live: null, files: [] };
  const recorded = Boolean(settings.live?.captured || settings.pbtxt?.changed || settings.verbose?.changed);
  if (settings.legacyUnknown && !recorded) {
    out.note = 'installed by v1, previous settings unknown: step settings left as-is';
    return out;
  }
  const liveBefore = settings.live?.captured ? settings.live.before : null;
  const restoreLive = {};
  if (liveBefore) {
    for (const [k, v] of Object.entries(liveBefore)) {
      if (v !== undefined && v !== null) restoreLive[k] = v;
    }
  }
  if (Object.keys(restoreLive).length) out.live = await cdpPrefs(restoreLive);

  if (settings.pbtxt?.changed && fs.existsSync(AGY_STATE_PBTXT)) {
    const content = fs.readFileSync(AGY_STATE_PBTXT, 'utf8');
    if (/product_skin:\s*PRODUCT_SKIN_DEVELOPER/.test(content)) {
      writeFileAtomic(AGY_STATE_PBTXT, content.replace(/product_skin:\s*PRODUCT_SKIN_DEVELOPER/g, `product_skin: ${settings.pbtxt.before}`));
      out.files.push('pbtxt_restored');
    }
  }
  if (settings.verbose?.changed && fs.existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON, null);
    if (cfg?.userSettings && cfg.userSettings.verboseConversationSteps === true) {
      if (settings.verbose.hadKey) cfg.userSettings.verboseConversationSteps = settings.verbose.before;
      else delete cfg.userSettings.verboseConversationSteps;
      writeJsonAtomic(AGY_CONFIG_JSON, cfg);
      out.files.push('verbose_restored');
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* AGENTS.md rule                                                             */
/* -------------------------------------------------------------------------- */

function findMarkedRuleSpan(text) {
  for (const [bTag, eTag] of [
    [RULE_BEGIN, RULE_END],
    [LEGACY_RULE_BEGIN, LEGACY_RULE_END]
  ]) {
    const begin = text.indexOf(bTag);
    const end = begin !== -1 ? text.indexOf(eTag, begin) : -1;
    if (begin !== -1 && end > begin) return { begin, end: end + eTag.length };
  }
  return null;
}

function injectAgentsMdRule(state, { allowInsert }) {
  const ruleBlock = fs.readFileSync(path.join(__dirname, 'rules', 'claude-execution-sync.md'), 'utf8').trim();
  const existing = readTextSafe(AGENTS_MD) || '';
  const span = findMarkedRuleSpan(existing);
  if (span) {
    const next = existing.slice(0, span.begin) + ruleBlock + existing.slice(span.end);
    if (next !== existing) writeFileAtomic(AGENTS_MD, next);
    return next !== existing ? 'updated_marked_block' : 'unchanged';
  }
  if (existing.includes(LEGACY_HEADING)) return 'already_present_unmarked';
  if (!allowInsert) return 'absent_respected'; // user removed it: background sync never re-adds
  const sep = existing.trim() ? '\n\n---\n\n' : '';
  writeFileAtomic(AGENTS_MD, `${ruleBlock}${sep}${existing}`);
  state.agentsRule = { inserted: true };
  return 'prepended_rule_block';
}

function removeAgentsMdRule() {
  const existing = readTextSafe(AGENTS_MD);
  if (!existing) return false;
  const span = findMarkedRuleSpan(existing);
  if (!span) return false;
  let tail = existing.slice(span.end);
  tail = tail.replace(/^\s*(?:---\s*)?/, '');
  const head = existing.slice(0, span.begin);
  writeFileAtomic(AGENTS_MD, (head + tail).replace(/^\s+/, ''));
  return true;
}

/* -------------------------------------------------------------------------- */
/* User layer deploy / restore                                                */
/* -------------------------------------------------------------------------- */

function deployFile(f, text, state) {
  writeFileAtomic(path.join(THEME_USER_DIR, f), text);
  writeFileAtomic(path.join(BASE_DIR, f), text);
  state.files[f].deployedSha = sha256Text(text);
  fs.rmSync(path.join(INCOMING_DIR, f), { force: true });
}

function installUserLayer(state, { sourceRoot = __dirname, overwriteLocal = false } = {}) {
  fs.mkdirSync(THEME_USER_DIR, { recursive: true });
  const result = { created: [], updated: [], merged: [], conflicts: [], unchanged: [] };
  for (const f of USER_LAYER_FILES) {
    const src = path.join(sourceRoot, 'user', f);
    const srcText = readTextSafe(src);
    if (srcText === null) continue;
    const dst = path.join(THEME_USER_DIR, f);
    const localText = readTextSafe(dst);
    let entry = state.files[f];

    if (!entry) {
      if (localText !== null) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(BACKUP_DIR, f), localText, 'utf8');
      }
      entry = state.files[f] = { existedBefore: localText !== null, deployedSha: '' };
      deployFile(f, srcText, state);
      result.created.push(f);
      continue;
    }
    if (localText === null) {
      deployFile(f, srcText, state);
      result.updated.push(f);
      continue;
    }
    if (localText === srcText) {
      if (readTextSafe(path.join(BASE_DIR, f)) !== srcText) deployFile(f, srcText, state);
      result.unchanged.push(f);
      continue;
    }
    const baseText = readTextSafe(path.join(BASE_DIR, f));
    const localUntouched = baseText !== null ? localText === baseText : sha256Text(localText) === entry.deployedSha;
    if (localUntouched) {
      deployFile(f, srcText, state);
      result.updated.push(f);
      continue;
    }
    if (overwriteLocal) {
      writeFileAtomic(path.join(LOCAL_SAVE_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${f}`), localText);
      deployFile(f, srcText, state);
      result.updated.push(`${f} (local edits saved to local-saves/)`);
      continue;
    }
    if (f.endsWith('.json') && baseText !== null) {
      try {
        const merged = threeWayMergeJson(JSON.parse(baseText), JSON.parse(localText), JSON.parse(srcText));
        const mergedText = `${JSON.stringify(merged, null, 2)}\n`;
        if (mergedText !== localText) writeFileAtomic(dst, mergedText);
        writeFileAtomic(path.join(BASE_DIR, f), srcText); // base tracks the template, local keeps user overrides
        entry.deployedSha = sha256Text(mergedText);
        result.merged.push(f);
        continue;
      } catch {}
    }
    if (baseText === srcText) {
      result.unchanged.push(`${f} (local edits kept)`);
      continue;
    }
    writeFileAtomic(path.join(INCOMING_DIR, f), srcText);
    result.conflicts.push(f);
  }
  return result;
}

function restoreUserLayer(state) {
  const out = { restored: [], removed: [], stubbed: [], kept: [], savedLocalEdits: [] };
  const saveDir = path.join(AGY_DIR, `anti-claude-uninstall-saved-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const f of USER_LAYER_FILES) {
    const entry = state.files?.[f];
    if (!entry) continue;
    const dst = path.join(THEME_USER_DIR, f);
    const cur = readTextSafe(dst);
    const base = readTextSafe(path.join(BASE_DIR, f));
    if (cur !== null && base !== null && cur !== base) {
      fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(path.join(saveDir, f), cur, 'utf8');
      out.savedLocalEdits.push(path.join(saveDir, f));
    }
    const bak = path.join(BACKUP_DIR, f);
    if (entry.existedBefore === true && fs.existsSync(bak)) {
      fs.copyFileSync(bak, dst);
      out.restored.push(f);
    } else if (entry.existedBefore === false) {
      fs.rmSync(dst, { force: true });
      out.removed.push(f);
    } else if (STUB_CONTENT[f]) {
      writeFileAtomic(dst, STUB_CONTENT[f]);
      out.stubbed.push(f);
    } else {
      out.kept.push(f);
    }
  }
  return out;
}

function runUpstreamVerify() {
  const upstreamEntry = path.join(THEME_PATCH_DIR, 'install.mjs');
  if (!fs.existsSync(upstreamEntry)) return { ok: false, reason: 'upstream_missing' };
  let stdout = '';
  let exitStatus = 0;
  try {
    stdout = execFileSync(process.execPath, [upstreamEntry, 'verify'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    stdout = String(err?.stdout || '');
    exitStatus = typeof err?.status === 'number' ? err.status : -1;
    if (!stdout) return { ok: false, exitStatus, reason: String(err?.message || err).split('\n')[0] };
  }
  const parsed = parseTrailingJson(stdout);
  if (!parsed) return { ok: false, exitStatus, reason: 'verify_output_unparseable' };
  const ok = exitStatus === 0 && parsed.ok === true;
  return {
    ok,
    exitStatus,
    themeStyle: parsed.themeStyle ?? null,
    reachable: parsed.live?.reachable ?? null,
    reason: ok ? undefined : parsed.live?.reachable === false ? 'app_not_running_or_unreachable' : 'verify_reported_not_ok'
  };
}

/* -------------------------------------------------------------------------- */
/* macOS LaunchAgent & Antigravity 2.33+ CDP Bootstrap Wrapper                */
/* -------------------------------------------------------------------------- */

/**
 * Antigravity 2.33.0+ stopped appending `--remote-debugging-port=0` by default in C++,
 * and modifying `/Applications/Antigravity.app` breaks Google's Developer ID signature
 * (Gatekeeper + Squirrel.Mac auto-updates). Instead, wrap `antigravity-font-daemon.mjs`
 * with a zero-overhead check: when `DevToolsActivePort` is missing and a freshly launched
 * (`<= 25s` old) `/Applications/Antigravity.app` main process is running without
 * `--remote-debugging-port`, gracefully relaunch it with `--args --remote-debugging-port=0`.
 * Long-running sessions (`> 25s`) are never interrupted.
 */
function ensureMacCdpBootstrapWrapper() {
  if (process.platform !== 'darwin') return { skipped: 'not_darwin' };
  const coreDaemonPath = path.join(THEME_PATCH_DIR, 'core', 'daemon.mjs');
  if (!fs.existsSync(coreDaemonPath)) return { skipped: 'core_daemon_missing' };
  const coreUrl = `file://${coreDaemonPath}`;
  const wrapperSrc = `#!/usr/bin/env node
// Auto-generated wrapper -> ${coreDaemonPath} (with Antigravity 2.33.0+ CDP bootstrap)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

if (process.platform === 'darwin' && !process.argv.includes('--once')) {
  const portFile = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  const mainBin = '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
  let busy = false;
  let lastRelaunchAt = 0;

  const parseEtimeSec = (raw) => {
    const s = String(raw || '').trim();
    let days = 0;
    let rest = s;
    if (s.includes('-')) {
      const [d, r] = s.split('-', 2);
      days = parseInt(d, 10) || 0;
      rest = r;
    }
    const parts = rest.split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
    return Infinity;
  };

  const checkFreshLaunch = () => {
    if (busy || fs.existsSync(portFile) || Date.now() - lastRelaunchAt < 25000) return;
    busy = true;
    execFile('ps', ['-axo', 'pid=,etime=,command='], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout) {
        busy = false;
        return;
      }
      let targetPid = 0;
      let targetAge = Infinity;
      for (const line of String(stdout).split('\\n')) {
        const m = line.trim().match(/^(\\d+)\\s+(\\S+)\\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const age = parseEtimeSec(m[2]);
        const cmd = m[3];
        if ((cmd === mainBin || cmd.startsWith(mainBin + ' ')) && !cmd.includes('--remote-debugging-port')) {
          targetPid = pid;
          targetAge = age;
          break;
        }
      }
      if (!targetPid || targetAge > 25) {
        busy = false;
        return;
      }
      lastRelaunchAt = Date.now();
      console.log(\`[CDP-Bootstrap] Relaunching fresh Antigravity (PID \${targetPid}, age=\${targetAge}s) with --remote-debugging-port=0\`);
      try {
        process.kill(targetPid, 'SIGTERM');
      } catch {
        busy = false;
        return;
      }
      const deadline = Date.now() + 4500;
      const waitExit = () => {
        let alive = false;
        try {
          process.kill(targetPid, 0);
          alive = true;
        } catch {}
        if (alive && Date.now() < deadline) {
          setTimeout(waitExit, 120);
          return;
        }
        execFile('/usr/bin/open', ['-a', '/Applications/Antigravity.app', '--args', '--remote-debugging-port=0'], () => {
          busy = false;
        });
      };
      setTimeout(waitExit, 150);
    });
  };

  setInterval(checkFreshLaunch, 1200).unref();
  checkFreshLaunch();
}

await import(${JSON.stringify(coreUrl)});
`;
  const prev = readTextSafe(DAEMON_WRAPPER_FILE);
  if (prev === wrapperSrc) return { ok: true, updated: false };
  writeFileAtomic(DAEMON_WRAPPER_FILE, wrapperSrc);
  try {
    fs.chmodSync(DAEMON_WRAPPER_FILE, 0o755);
  } catch {}
  if (!NO_LAUNCHD) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${THEME_DAEMON_LABEL}`], { stdio: 'ignore' });
    } catch {}
  }
  return { ok: true, updated: true };
}

function restorePlainDaemonWrapper() {
  if (process.platform !== 'darwin') return { skipped: 'not_darwin' };
  const coreDaemonPath = path.join(THEME_PATCH_DIR, 'core', 'daemon.mjs');
  if (!fs.existsSync(DAEMON_WRAPPER_FILE) || !fs.existsSync(coreDaemonPath)) return { restored: false };
  const plain = `#!/usr/bin/env node\n// Auto-generated wrapper -> ${coreDaemonPath}\nawait import(${JSON.stringify(`file://${coreDaemonPath}`)});\n`;
  writeFileAtomic(DAEMON_WRAPPER_FILE, plain);
  if (!NO_LAUNCHD) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${THEME_DAEMON_LABEL}`], { stdio: 'ignore' });
    } catch {}
  }
  return { restored: true };
}

function syncAntigravity2IfInstalled() {
  if (process.platform !== 'darwin' || NO_LAUNCHD) return { skipped: true };
  if (!fs.existsSync('/Applications/Antigravity 2.app') || !fs.existsSync(AG2_SYNC_SCRIPT)) {
    return { skipped: 'not_present' };
  }
  try {
    execFileSync(process.execPath, [AG2_SYNC_SCRIPT], { stdio: 'pipe', timeout: 90000 });
    return { ok: true, synced: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).split('\n')[0] };
  }
}

function enableMacAutoUpdateAgent() {
  if (process.platform !== 'darwin') return { ok: false, reason: 'macos_launchd_only' };
  if (NO_LAUNCHD) return { ok: false, reason: 'launchd_disabled' };
  const tmpRoot = fs.realpathSync(os.tmpdir());
  if (fs.realpathSync(__dirname).startsWith(tmpRoot)) {
    return { ok: false, reason: 'repo_in_temp_dir: clone to a permanent path (e.g. ~/Developer) before enabling auto-update' };
  }
  fs.mkdirSync(path.dirname(AUTOSYNC_PLIST), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const nodePath = stableNodePath();
  const envPath = Array.from(
    new Set(['/opt/homebrew/bin', '/usr/local/bin', path.dirname(nodePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
  ).join(':');
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(path.join(__dirname, 'install.mjs'))}</string>
    <string>sync-upgrade</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(envPath)}</string>
  </dict>
  <key>WatchPaths</key>
  <array>
    <string>/Applications/Antigravity.app/Contents/Info.plist</string>
    <string>/Applications/Antigravity.app/Contents/Resources/app.asar</string>
  </array>
  <key>StartInterval</key>
  <integer>43200</integer>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LAUNCHD_LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LAUNCHD_LOG_FILE)}</string>
</dict>
</plist>
`;
  writeFileAtomic(AUTOSYNC_PLIST, plistXml);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  if (fs.existsSync(LEGACY_AUTOSYNC_PLIST)) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}`, LEGACY_AUTOSYNC_PLIST], { stdio: 'ignore' });
    } catch {}
    fs.rmSync(LEGACY_AUTOSYNC_PLIST, { force: true });
  }
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, AUTOSYNC_PLIST], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, AUTOSYNC_PLIST], { stdio: 'pipe' });
  } catch (err) {
    return { ok: false, reason: `launchctl_bootstrap_failed: ${String(err?.stderr || err?.message).trim()}`, plist: AUTOSYNC_PLIST };
  }
  return { ok: true, label: AUTOSYNC_LABEL, plist: AUTOSYNC_PLIST, node: nodePath };
}

function disableMacAutoUpdateAgent() {
  if (process.platform !== 'darwin') return { removed: false };
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  let removed = false;
  for (const plist of [AUTOSYNC_PLIST, LEGACY_AUTOSYNC_PLIST]) {
    if (!fs.existsSync(plist)) continue;
    if (!NO_LAUNCHD) {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'ignore' });
      } catch {}
    }
    fs.rmSync(plist, { force: true });
    removed = true;
  }
  return removed ? { removed: true, label: AUTOSYNC_LABEL } : { removed: false };
}

function inspectAutoUpdateAgent() {
  const activePlist = fs.existsSync(AUTOSYNC_PLIST) ? AUTOSYNC_PLIST : fs.existsSync(LEGACY_AUTOSYNC_PLIST) ? LEGACY_AUTOSYNC_PLIST : null;
  const xml = activePlist ? readTextSafe(activePlist) : null;
  if (!xml) return { installed: false };
  const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>\s*<string>([^<]+)<\/string>/);
  const nodePath = m ? m[1].replace(/&amp;/g, '&') : null;
  const scriptPath = m ? m[2].replace(/&amp;/g, '&') : null;
  return {
    installed: true,
    legacyPlist: activePlist === LEGACY_AUTOSYNC_PLIST,
    nodePath,
    nodeExists: Boolean(nodePath && fs.existsSync(nodePath)),
    nodeVersionPinned: Boolean(nodePath && /\/Cellar\/|\/\.nvm\/versions\//.test(nodePath)),
    scriptPath,
    scriptExists: Boolean(scriptPath && fs.existsSync(scriptPath))
  };
}

/* -------------------------------------------------------------------------- */
/* Antigravity CLI (agy) layer deploy / restore                               */
/* -------------------------------------------------------------------------- */

export function buildCliStatusLineCommand(nodePath = stableNodePath(), scriptPath = AGY_CLI_STATUSLINE_FILE) {
  return `"${nodePath}" "${scriptPath}"`;
}

function deployCliStatusLineScript(text, state) {
  writeFileAtomic(AGY_CLI_STATUSLINE_FILE, text);
  try {
    fs.chmodSync(AGY_CLI_STATUSLINE_FILE, 0o755);
  } catch {}
  writeFileAtomic(path.join(BASE_DIR, AGY_CLI_STATUSLINE_NAME), text);
  state.cli.statusLineScript.deployedSha = sha256Text(text);
  fs.rmSync(path.join(INCOMING_DIR, AGY_CLI_STATUSLINE_NAME), { force: true });
}

function installCliLayer(state, { sourceRoot = __dirname, overwriteLocal = false, allowSettingsEnable = true } = {}) {
  state.cli = state.cli || {};
  if (state.options.cliStatusLine === false) {
    return { skipped: 'disabled_by_option' };
  }
  const srcPath = path.join(sourceRoot, 'cli', 'statusline.mjs');
  const srcText = readTextSafe(srcPath);
  if (srcText === null) {
    return { error: 'cli_statusline_source_missing' };
  }

  fs.mkdirSync(AGY_CLI_DIR, { recursive: true });
  const localText = readTextSafe(AGY_CLI_STATUSLINE_FILE);
  let scriptAction = 'unchanged';
  let conflict = false;

  if (!state.cli.statusLineScript) {
    if (localText !== null) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(BACKUP_DIR, AGY_CLI_STATUSLINE_NAME), localText, 'utf8');
    }
    state.cli.statusLineScript = { existedBefore: localText !== null, deployedSha: '' };
    deployCliStatusLineScript(srcText, state);
    scriptAction = 'created';
  } else if (localText === null) {
    deployCliStatusLineScript(srcText, state);
    scriptAction = 'updated';
  } else if (localText === srcText) {
    if (readTextSafe(path.join(BASE_DIR, AGY_CLI_STATUSLINE_NAME)) !== srcText) {
      deployCliStatusLineScript(srcText, state);
    }
    scriptAction = 'unchanged';
  } else {
    const baseText = readTextSafe(path.join(BASE_DIR, AGY_CLI_STATUSLINE_NAME));
    const localUntouched =
      baseText !== null ? localText === baseText : sha256Text(localText) === state.cli.statusLineScript.deployedSha;
    if (localUntouched) {
      deployCliStatusLineScript(srcText, state);
      scriptAction = 'updated';
    } else if (overwriteLocal) {
      writeFileAtomic(
        path.join(LOCAL_SAVE_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${AGY_CLI_STATUSLINE_NAME}`),
        localText
      );
      deployCliStatusLineScript(srcText, state);
      scriptAction = 'overwritten';
    } else if (baseText === srcText) {
      scriptAction = 'unchanged (local edits kept)';
    } else {
      writeFileAtomic(path.join(INCOMING_DIR, AGY_CLI_STATUSLINE_NAME), srcText);
      scriptAction = 'conflict';
      conflict = true;
    }
  }

  const cmd = buildCliStatusLineCommand();
  const settingsExisted = fs.existsSync(AGY_CLI_SETTINGS_JSON);
  let cfg = {};
  if (settingsExisted) {
    const parsed = readJsonSafe(AGY_CLI_SETTINGS_JSON, null);
    if (!isPlainObject(parsed)) {
      return { script: scriptAction, conflict, settings: { error: 'invalid_json', path: AGY_CLI_SETTINGS_JSON } };
    }
    cfg = parsed;
  }

  const currentStatusLine = cfg.statusLine;
  const isOurs = String(currentStatusLine?.command || '').includes(AGY_CLI_STATUSLINE_NAME);
  let settingsAction = 'unchanged';

  if (allowSettingsEnable) {
    if (!state.cli.settings) {
      state.cli.settings = {
        existedBefore: settingsExisted,
        changed: true,
        hadStatusLine: Object.prototype.hasOwnProperty.call(cfg, 'statusLine'),
        beforeStatusLine: clone(cfg.statusLine),
        deployedCommand: cmd
      };
    } else {
      state.cli.settings.changed = true;
      state.cli.settings.deployedCommand = cmd;
    }
    const desired = { type: 'command', command: cmd, enabled: true };
    if (!deepEqual(cfg.statusLine, desired)) {
      cfg.statusLine = desired;
      writeJsonAtomic(AGY_CLI_SETTINGS_JSON, cfg);
      settingsAction = settingsExisted ? 'updated' : 'created';
    }
  } else if (isOurs && currentStatusLine?.enabled === true && currentStatusLine.command !== cmd) {
    cfg.statusLine = Object.assign({}, currentStatusLine, { command: cmd });
    writeJsonAtomic(AGY_CLI_SETTINGS_JSON, cfg);
    if (state.cli.settings) state.cli.settings.deployedCommand = cmd;
    settingsAction = 'command_refreshed';
  } else if (!isOurs) {
    settingsAction = 'user_override_respected';
  }

  return {
    script: scriptAction,
    scriptPath: AGY_CLI_STATUSLINE_FILE,
    conflict,
    settings: { action: settingsAction, path: AGY_CLI_SETTINGS_JSON }
  };
}

function restoreCliLayer(state) {
  const out = { script: 'not_managed', settings: 'not_managed', savedLocalEdits: [] };
  const cliState = state?.cli;
  if (!cliState || (!cliState.statusLineScript && !cliState.settings)) return out;

  if (cliState.settings?.changed && fs.existsSync(AGY_CLI_SETTINGS_JSON)) {
    const cfg = readJsonSafe(AGY_CLI_SETTINGS_JSON, null);
    if (isPlainObject(cfg)) {
      const currentCmd = String(cfg.statusLine?.command || '');
      if (currentCmd.includes(AGY_CLI_STATUSLINE_NAME)) {
        if (cliState.settings.hadStatusLine) {
          cfg.statusLine = clone(cliState.settings.beforeStatusLine);
          writeJsonAtomic(AGY_CLI_SETTINGS_JSON, cfg);
          out.settings = 'restored';
        } else {
          delete cfg.statusLine;
          if (cliState.settings.existedBefore === false && Object.keys(cfg).length === 0) {
            fs.rmSync(AGY_CLI_SETTINGS_JSON, { force: true });
            out.settings = 'removed';
          } else {
            writeJsonAtomic(AGY_CLI_SETTINGS_JSON, cfg);
            out.settings = 'statusline_removed';
          }
        }
      } else {
        out.settings = 'user_override_kept';
      }
    }
  }

  const scriptEntry = cliState.statusLineScript;
  if (scriptEntry) {
    const cur = readTextSafe(AGY_CLI_STATUSLINE_FILE);
    const base = readTextSafe(path.join(BASE_DIR, AGY_CLI_STATUSLINE_NAME));
    if (cur !== null && base !== null && cur !== base) {
      const saveDir = path.join(AGY_DIR, `anti-claude-uninstall-saved-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(saveDir, { recursive: true });
      const savedPath = path.join(saveDir, AGY_CLI_STATUSLINE_NAME);
      fs.writeFileSync(savedPath, cur, 'utf8');
      out.savedLocalEdits.push(savedPath);
    }
    const bak = path.join(BACKUP_DIR, AGY_CLI_STATUSLINE_NAME);
    if (scriptEntry.existedBefore === true && fs.existsSync(bak)) {
      fs.copyFileSync(bak, AGY_CLI_STATUSLINE_FILE);
      out.script = 'restored';
    } else if (scriptEntry.existedBefore === false) {
      fs.rmSync(AGY_CLI_STATUSLINE_FILE, { force: true });
      out.script = 'removed';
    } else {
      out.script = 'kept';
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

async function cmdDoctor() {
  const state = readJsonSafe(STATE_FILE, null);
  const pbtxt = readTextSafe(AGY_STATE_PBTXT) || '';
  const cfg = readJsonSafe(AGY_CONFIG_JSON, null);
  const agentsRaw = readTextSafe(AGENTS_MD) || '';
  const incoming = fs.existsSync(INCOMING_DIR) ? fs.readdirSync(INCOMING_DIR) : [];
  const agent = inspectAutoUpdateAgent();
  const antigravityCli = detectAntigravityCli();
  const mode = state
    ? state.options?.desktop === false
      ? 'cli-only'
      : state.options?.cli
        ? 'desktop+cli'
        : 'desktop'
    : null;
  const warnings = [];
  if (agent.installed && !agent.nodeExists) warnings.push('auto-update LaunchAgent points to a missing node binary: run auto-update-on again');
  if (agent.installed && !agent.scriptExists) warnings.push('auto-update LaunchAgent points to a missing install.mjs');
  if (incoming.length) warnings.push(`template updates held back because of local edits: ${incoming.join(', ')} (see ${INCOMING_DIR})`);
  if (!state && (fs.existsSync(LEGACY_V2_STATE_FILE) || fs.existsSync(LEGACY_BACKUP_DIR))) {
    warnings.push('legacy claude-ux install detected: run `install` once to migrate the install state to anti-claude');
  }
  if (agent.legacyPlist) warnings.push('legacy claude-ux LaunchAgent detected: run `install` or `auto-update-on` to migrate to com.antigravity.anti-claude.autosync');
  return finalize(
    {
      platform: process.platform,
      node: process.version,
      mode,
      antigravityAppVersion: getAntigravityAppFingerprint().version,
      antigravityCli,
      baseThemePatchInstalled: fs.existsSync(path.join(THEME_PATCH_DIR, 'install.mjs')),
      baseThemePatchVersion: readJsonSafe(path.join(THEME_PATCH_DIR, 'core', 'manifest.json'), {})?.version || null,
      pinnedUpstreamRef: UPSTREAM_REF,
      installState: state ? { installedAt: state.installedAt, options: state.options, files: Object.keys(state.files || {}) } : null,
      userLayerInstalled: (readTextSafe(path.join(THEME_USER_DIR, 'custom.js')) || '').includes('ag-claude-todo-card'),
      autoUpdate: agent,
      lastSync: state?.sync || null,
      fonts: checkFontsInstalled(),
      developerStepSkinUnlocked: pbtxt.includes('PRODUCT_SKIN_DEVELOPER'),
      verboseConversationSteps: cfg?.userSettings?.verboseConversationSteps ?? null,
      agentsRuleConfigured: agentsRaw.includes(RULE_BEGIN) || agentsRaw.includes(LEGACY_RULE_BEGIN) || agentsRaw.includes(LEGACY_HEADING)
    },
    { warnings }
  );
}

async function cmdInstall(flags) {
  const critical = [];
  const warnings = [];
  const validation = validateSourceRoot();
  if (!validation.ok) {
    return finalize({ validation }, { critical: ['source validation failed, nothing deployed'] });
  }

  const cliOnly = flags.has('--cli-only');
  const explicitCli = flags.has('--cli') || cliOnly;
  const noCli = flags.has('--no-cli') || (NO_CLI && !explicitCli);
  const antigravityCli = detectAntigravityCli();

  const state = loadState() || newState();
  state.options.desktop = !cliOnly;
  state.options.cli = !noCli && (explicitCli || antigravityCli.detected);
  if (flags.has('--no-cli-statusline')) state.options.cliStatusLine = false;
  else if (flags.has('--cli-statusline') || state.options.cliStatusLine === undefined) state.options.cliStatusLine = true;
  if (flags.has('--no-step-unlock') || cliOnly) state.options.stepUnlock = false;
  if (flags.has('--no-agents-rule')) state.options.agentsRule = false;
  if (flags.has('--no-auto-update') || cliOnly) state.options.autoUpdate = false;
  else if (flags.has('--auto-update')) state.options.autoUpdate = true;

  if (cliOnly) {
    const cliLayer = installCliLayer(state, { overwriteLocal: flags.has('--overwrite-local'), allowSettingsEnable: true });
    if (cliLayer.error) critical.push(`cli layer deploy failed: ${cliLayer.error}`);
    if (cliLayer.settings?.error) warnings.push(`cli settings (${cliLayer.settings.path}): ${cliLayer.settings.error}`);
    if (cliLayer.conflict) {
      warnings.push(`local edits kept, new version saved to ${INCOMING_DIR}: ${AGY_CLI_STATUSLINE_NAME} (use --overwrite-local to replace)`);
    }
    const ruleStatus = state.options.agentsRule ? injectAgentsMdRule(state, { allowInsert: true }) : 'disabled_by_option';
    state.sync = Object.assign({}, state.sync, { cliVersion: antigravityCli.version, lastAppliedAt: Date.now() });
    saveState(state);
    return finalize({ mode: 'cli-only', antigravityCli: detectAntigravityCli(), cliLayer, ruleStatus }, { critical, warnings });
  }

  let base;
  try {
    base = ensureUpstreamCore({ upgrade: false });
  } catch (err) {
    return finalize({}, { critical: [`upstream core install failed: ${String(err?.message || err).split('\n')[0]}`] });
  }

  const fontsBefore = checkFontsInstalled();
  const fontSync = fontsBefore.hasAnthropicSans || NO_FONTS ? null : syncFontsFromLocalClaudeApp();

  let layer;
  try {
    layer = installUserLayer(state, { overwriteLocal: flags.has('--overwrite-local') });
  } catch (err) {
    saveState(state);
    return finalize({}, { critical: [`user layer deploy failed: ${err?.message || err}`] });
  }
  if (layer.conflicts.length) warnings.push(`local edits kept, new versions saved to ${INCOMING_DIR}: ${layer.conflicts.join(', ')} (use --overwrite-local to replace)`);
  saveState(state);

  let stepUnlock = { skipped: 'disabled_by_option' };
  if (state.options.stepUnlock) {
    stepUnlock = await applyStepUnlock(state);
    if (!stepUnlock.live.ok && stepUnlock.live.appRunning !== false) warnings.push(`live step unlock: ${stepUnlock.live.reason}`);
  }
  const ruleStatus = state.options.agentsRule ? injectAgentsMdRule(state, { allowInsert: true }) : 'disabled_by_option';
  const cdpBootstrap = ensureMacCdpBootstrapWrapper();

  let cliLayer = { skipped: noCli ? 'disabled_by_option' : 'agy_cli_not_detected' };
  if (state.options.cli) {
    cliLayer = installCliLayer(state, { overwriteLocal: flags.has('--overwrite-local'), allowSettingsEnable: true });
    if (cliLayer.error) warnings.push(`cli layer: ${cliLayer.error}`);
    if (cliLayer.settings?.error) warnings.push(`cli settings (${cliLayer.settings.path}): ${cliLayer.settings.error}`);
    if (cliLayer.conflict) {
      warnings.push(`local edits kept, new version saved to ${INCOMING_DIR}: ${AGY_CLI_STATUSLINE_NAME} (use --overwrite-local to replace)`);
    }
  }

  const verify = runUpstreamVerify();
  if (!verify.ok) warnings.push(`upstream verify: ${verify.reason}`);

  const fp = getAntigravityAppFingerprint();
  state.sync = Object.assign({}, state.sync, { appVersion: fp.version, appSig: fp.sig, cliVersion: antigravityCli.version, lastAppliedAt: Date.now() });
  saveState(state);

  let autoUpdate = { skipped: true };
  if (state.options.autoUpdate && process.platform === 'darwin') {
    autoUpdate = enableMacAutoUpdateAgent();
    if (!autoUpdate.ok && autoUpdate.reason !== 'launchd_disabled') warnings.push(`auto-update: ${autoUpdate.reason}`);
  } else if (!state.options.autoUpdate) {
    autoUpdate = disableMacAutoUpdateAgent();
  }

  return finalize(
    {
      mode: state.options.cli ? 'desktop+cli' : 'desktop',
      antigravityVersion: fp.version,
      antigravityCli: detectAntigravityCli(),
      base,
      fontSync,
      userLayer: layer,
      cliLayer,
      stepUnlock,
      ruleStatus,
      cdpBootstrap,
      autoUpdate,
      verify
    },
    { critical, warnings }
  );
}

async function cmdSyncUpgrade(flags) {
  const force = flags.has('--force');
  const afterPull = flags.has('--after-pull');
  const state = loadState();
  if (!state) return finalize({ noop: true, reason: 'not_installed' });

  const isDesktop = state.options?.desktop !== false;
  const fp = isDesktop ? getAntigravityAppFingerprint() : { version: 'none', sig: 'cli-only', changedAtMs: 0 };
  if (isDesktop && fp.changedAtMs > 0 && Date.now() - fp.changedAtMs < 12000) {
    await new Promise((r) => setTimeout(r, 4500)); // let a freshly updated app finish its cold start
  }
  const warnings = [];
  const appChanged = isDesktop && state.sync?.appSig !== fp.sig;
  const now = Date.now();

  let selfPull = { skipped: true };
  let core = { skipped: true };
  if (!afterPull && !NO_NETWORK && shouldCheckRemote(state.sync, { now, force, appChanged })) {
    state.sync = Object.assign({}, state.sync, { lastRemoteCheckAt: now });
    selfPull = pullSelfRepoIfGit();
    if (selfPull.error) warnings.push(`self pull: ${selfPull.error}`);
    if (selfPull.updated) {
      const v = validateSourceRoot();
      if (!v.ok) {
        saveState(state);
        return finalize({ selfPull, validation: v }, { critical: ['pulled code failed validation; live files left untouched'] });
      }
      state.sync.lastRemoteCheckOk = true;
      saveState(state);
      /* re-exec so the freshly pulled installer logic applies to this run */
      const args = [path.join(__dirname, 'install.mjs'), 'sync-upgrade', '--after-pull', ...[...flags].filter((f) => f !== '--after-pull')];
      try {
        execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 180000 });
      } catch (err) {
        process.exitCode = typeof err?.status === 'number' ? err.status : 1;
      }
      return null;
    }
    if (isDesktop) {
      core = ensureUpstreamCore({ upgrade: true });
      if (core.error) warnings.push(`upstream core: ${core.error}`);
    }
    state.sync.lastRemoteCheckOk = !selfPull.error && !core.error;
  }

  const validation = validateSourceRoot();
  if (!validation.ok) {
    saveState(state);
    return finalize({ validation }, { critical: ['source validation failed; live files left untouched'] });
  }

  let cliLayer = { skipped: 'disabled_by_option' };
  if (state.options?.cli) {
    cliLayer = installCliLayer(state, { overwriteLocal: flags.has('--overwrite-local'), allowSettingsEnable: false });
    if (cliLayer.error) warnings.push(`cli layer: ${cliLayer.error}`);
    if (cliLayer.settings?.error) warnings.push(`cli settings (${cliLayer.settings.path}): ${cliLayer.settings.error}`);
    if (cliLayer.conflict) warnings.push(`local edits kept, new version in ${INCOMING_DIR}: ${AGY_CLI_STATUSLINE_NAME}`);
  }

  const ruleStatus = state.options.agentsRule ? injectAgentsMdRule(state, { allowInsert: false }) : 'disabled_by_option';

  if (!isDesktop) {
    const antigravityCli = detectAntigravityCli();
    state.sync = Object.assign({}, state.sync, { cliVersion: antigravityCli.version, lastAppliedAt: now });
    saveState(state);
    const summary = `sync-upgrade | mode=cli-only | agyCli=${antigravityCli.version || 'unknown'} | remoteChecked=${!selfPull.skipped} | cliScript=${cliLayer.script || 'skipped'}`;
    appendSyncLog(summary);
    return finalize({ mode: 'cli-only', summary, selfPull, cliLayer, ruleStatus }, { warnings });
  }

  const layer = installUserLayer(state, { overwriteLocal: flags.has('--overwrite-local') });
  if (layer.conflicts.length) warnings.push(`local edits kept, new versions in ${INCOMING_DIR}: ${layer.conflicts.join(', ')}`);

  /* Only re-assert step settings after an app update (which may reset them); a user's later choice is respected otherwise. */
  let stepUnlock = { skipped: appChanged ? 'disabled_by_option' : 'app_unchanged' };
  if (appChanged && state.options.stepUnlock) stepUnlock = await applyStepUnlock(state);
  const cdpBootstrap = ensureMacCdpBootstrapWrapper();
  if (state.options.autoUpdate && process.platform === 'darwin' && !NO_LAUNCHD && fs.existsSync(LEGACY_AUTOSYNC_PLIST)) {
    enableMacAutoUpdateAgent();
  }
  const ag2Sync = appChanged ? syncAntigravity2IfInstalled() : { skipped: 'app_unchanged' };
  if (ag2Sync.error) warnings.push(`antigravity-2 sync: ${ag2Sync.error}`);

  let verify = { skipped: true };
  const changed = layer.created.length + layer.updated.length + layer.merged.length > 0;
  if (force || appChanged || core.upgraded || changed) {
    verify = runUpstreamVerify();
    if (!verify.ok) warnings.push(`upstream verify: ${verify.reason}`);
  }

  state.sync = Object.assign({}, state.sync, { appVersion: fp.version, appSig: fp.sig, lastAppliedAt: now });
  saveState(state);
  const summary = `sync-upgrade | agy=${fp.version} | appChanged=${appChanged} | remoteChecked=${!selfPull.skipped} | coreUpgraded=${Boolean(core.upgraded)} | updated=${layer.updated.length + layer.merged.length} | conflicts=${layer.conflicts.length}`;
  appendSyncLog(summary);
  return finalize({ summary, selfPull, core, userLayer: layer, cliLayer, stepUnlock, ruleStatus, cdpBootstrap, ag2Sync, verify }, { warnings });
}

async function cmdUninstall() {
  const state = loadState();
  if (!state) {
    const autoUpdateRemoved = disableMacAutoUpdateAgent();
    const wrapperRestored = restorePlainDaemonWrapper();
    return finalize({ noop: true, reason: 'not_installed', autoUpdateRemoved, wrapperRestored });
  }
  const warnings = [];
  const isDesktop = state.options?.desktop !== false || Object.keys(state.files || {}).length > 0;
  const autoUpdateRemoved = disableMacAutoUpdateAgent();
  const wrapperRestored = isDesktop ? restorePlainDaemonWrapper() : { restored: false };
  const settings = isDesktop ? await revertStepUnlock(state) : { skipped: 'cli_only' };
  if (settings.live && !settings.live.ok && settings.live.appRunning !== false) warnings.push(`live settings revert: ${settings.live.reason}`);
  const files = isDesktop ? restoreUserLayer(state) : { restored: [], removed: [], stubbed: [], kept: [], savedLocalEdits: [] };
  if (files.savedLocalEdits.length) warnings.push(`your post-install edits were saved: ${files.savedLocalEdits.join(', ')}`);
  const cli = restoreCliLayer(state);
  if (cli.savedLocalEdits.length) warnings.push(`your post-install CLI edits were saved: ${cli.savedLocalEdits.join(', ')}`);
  const ruleRemoved = removeAgentsMdRule();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.rmSync(LEGACY_V2_STATE_DIR, { recursive: true, force: true });
  fs.rmSync(LEGACY_SYNC_LOG_FILE, { force: true });
  const verify = isDesktop ? runUpstreamVerify() : { skipped: 'cli_only' };
  return finalize({ autoUpdateRemoved, wrapperRestored, settings, files, cli, ruleRemoved, verify }, { warnings });
}

async function main(argv) {
  const sub = argv[0] || 'doctor';
  const flags = new Set(argv.slice(1));
  if (sub === 'install') return cmdInstall(flags);
  if (sub === 'sync-upgrade') return cmdSyncUpgrade(flags);
  if (sub === 'auto-update-on') {
    const state = loadState();
    if (state) {
      state.options.autoUpdate = true;
      saveState(state);
    }
    return console.log(JSON.stringify(enableMacAutoUpdateAgent(), null, 2));
  }
  if (sub === 'auto-update-off') {
    const state = loadState();
    if (state) {
      state.options.autoUpdate = false;
      saveState(state);
    }
    return console.log(JSON.stringify(disableMacAutoUpdateAgent(), null, 2));
  }
  if (sub === 'uninstall') return cmdUninstall();
  if (sub === 'sync-fonts') return console.log(JSON.stringify(syncFontsFromLocalClaudeApp(), null, 2));
  return cmdDoctor();
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    finalize({}, { critical: [String(err?.stack || err)] });
  }
}
