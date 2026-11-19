#!/usr/bin/env node
/**
 * Anti-Claude — core/daemon.mjs
 * Self-contained, zero-dependency CDP runtime & SQLite metrics daemon for Google Antigravity Desktop (Node.js >= 22).
 *
 * Modes:
 *   node core/daemon.mjs [--user-dir <dir>]          Continuous background daemon (2.5s heartbeat + instant hot-reload)
 *   node core/daemon.mjs --once [--user-dir <dir>]   Single injection pass then exit 0
 *   node core/daemon.mjs --verify-once               Inject & verify DOM styles on live Antigravity window, print JSON
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();

/* Optional built-in node:sqlite (Node >= 22.5 / unflagged in >= 22.13) */
let DatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync } = req('node:sqlite'));
} catch {}

/* CLI arguments */
const argv = process.argv.slice(2);
const VERIFY_ONCE = argv.includes('--verify-once');
const RUN_ONCE = VERIFY_ONCE || argv.includes('--once');
const NO_CDP_BOOTSTRAP = process.env.ANTI_CLAUDE_NO_CDP_BOOTSTRAP === '1';

function resolveArgValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

const STATE_DIR = path.join(HOME, '.gemini', 'antigravity', 'anti-claude');
const USER_DIR = path.resolve(
  resolveArgValue('--user-dir') || process.env.ANTI_CLAUDE_USER_DIR || path.join(STATE_DIR, 'user')
);
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const CORE_BASE_CSS_FILE = path.join(__dirname, 'base.css');
const CORE_I18N_FILE = path.join(__dirname, 'i18n.json');
const CORE_RUNTIME_FILE = path.join(__dirname, 'runtime.js');
const PKG_FILE = path.join(REPO_ROOT, 'package.json');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;

/* Hermetic unit-test shortcut for `--verify-once` */
if (VERIFY_ONCE && (process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '1' || process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '0')) {
  const ok = process.env.ANTI_CLAUDE_FAKE_VERIFY_OK === '1';
  console.log(
    JSON.stringify(
      {
        ok,
        fake: true,
        userDir: USER_DIR,
        themeStyle: { present: ok, length: ok ? 1024 : 0 },
        customStyle: { present: ok, length: ok ? 4096 : 0 },
        live: { reachable: ok, port: ok ? 9222 : null, targets: ok ? 1 : 0 }
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

/* -------------------------------------------------------------------------- */
/* 1. Single-Instance PID Management                                          */
/* -------------------------------------------------------------------------- */

function claimPidFile() {
  if (RUN_ONCE) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (fs.existsSync(PID_FILE)) {
      const prevPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (prevPid > 0 && prevPid !== process.pid) {
        try {
          process.kill(prevPid, 'SIGTERM');
        } catch {}
      }
    }
    fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
  } catch {}
}

function checkPidOwnership() {
  if (RUN_ONCE) return;
  try {
    if (!fs.existsSync(PID_FILE)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
      return;
    }
    const owner = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (owner > 0 && owner !== process.pid) {
      try {
        process.kill(owner, 0);
        /* A newer daemon took over PID_FILE; exit cleanly */
        for (const [, entry] of attachedTargets.entries()) {
          try {
            entry.ws.close();
          } catch {}
        }
        process.exit(0);
      } catch {
        fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
      }
    }
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* 2. Cross-Platform Endpoint Discovery & macOS 2.33+ Cold-Boot Bootstrap     */
/* -------------------------------------------------------------------------- */

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(os.release()) || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  } catch {
    return false;
  }
}

function isUncPath(p) {
  const s = String(p || '');
  return s.startsWith('\\\\') || s.startsWith('//') || s.startsWith('/mnt/');
}

function discoverEndpoints() {
  const endpoints = [];
  const defaultConvDir = path.join(HOME, '.gemini', 'antigravity', 'conversations');

  if (process.platform === 'darwin') {
    endpoints.push({
      channel: 'darwin',
      portFile: path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    endpoints.push({
      channel: 'win32',
      portFile: path.join(appData, 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
  } else {
    endpoints.push({
      channel: 'linux',
      portFile: path.join(HOME, '.config', 'Antigravity', 'DevToolsActivePort'),
      fallbackPort: 9222,
      conversationsDir: defaultConvDir
    });
    if (isWsl()) {
      try {
        const usersDir = '/mnt/c/Users';
        if (fs.existsSync(usersDir)) {
          for (const u of fs.readdirSync(usersDir)) {
            if (/^(Public|Default|Default User|All Users)$/i.test(u)) continue;
            const winPort = path.join(usersDir, u, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort');
            if (fs.existsSync(path.dirname(winPort))) {
              const winConv = path.join(usersDir, u, '.gemini', 'antigravity', 'conversations');
              endpoints.push({
                channel: `wsl:${u}`,
                portFile: winPort,
                fallbackPort: 9222,
                conversationsDir: fs.existsSync(winConv) ? winConv : defaultConvDir
              });
            }
          }
        }
      } catch {}
    }
  }
  return endpoints;
}

function readPort(portFile) {
  try {
    if (!portFile || !fs.existsSync(portFile)) return 0;
    const first = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
    const p = parseInt(first, 10);
    return p > 0 && p < 65536 ? p : 0;
  } catch {
    return 0;
  }
}

function hasRecentConversationWalActivity(conversationsDir, withinMs = 15000) {
  try {
    if (!fs.existsSync(conversationsDir)) return false;
    const now = Date.now();
    for (const name of fs.readdirSync(conversationsDir)) {
      if (!name.endsWith('.db-wal')) continue;
      const st = fs.statSync(path.join(conversationsDir, name), { throwIfNoEntry: false });
      if (st && st.size > 0 && now - st.mtimeMs < withinMs) return true;
    }
  } catch {}
  return false;
}

/**
 * Antigravity 2.33.0+ stopped appending `--remote-debugging-port=0` by default in C++.
 * Modifying `/Applications/Antigravity.app` breaks Google's Developer ID code signature
 * and blocks Squirrel.Mac auto-updates. Instead, when a brand-new cold launch (`<= 25s` old)
 * starts without `--remote-debugging-port`, gracefully relaunch it with `--args --remote-debugging-port=0`.
 */
function startMacCdpBootstrap() {
  if (process.platform !== 'darwin' || RUN_ONCE || NO_CDP_BOOTSTRAP) return;
  const portFile = path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  const convDir = path.join(HOME, '.gemini', 'antigravity', 'conversations');
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
    if (busy || fs.existsSync(portFile) || Date.now() - lastRelaunchAt < 60000) return;
    busy = true;
    execFile('ps', ['-axo', 'pid=,etime=,command='], { timeout: 2500 }, (err, stdout) => {
      if (err || !stdout) {
        busy = false;
        return;
      }
      let targetPid = 0;
      let targetAge = Infinity;
      for (const line of String(stdout).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
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
      if (!targetPid || targetAge > 25 || hasRecentConversationWalActivity(convDir, 15000)) {
        busy = false;
        return;
      }
      lastRelaunchAt = Date.now();
      console.log(`[Anti-Claude Daemon] Relaunching fresh Antigravity (PID ${targetPid}, age=${targetAge}s) with --remote-debugging-port=0`);
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

/* -------------------------------------------------------------------------- */
/* 3. Config & Bundle Hot-Reload Compiler                                     */
/* -------------------------------------------------------------------------- */

function statSig(p) {
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    return st ? `${st.size}:${Math.floor(st.mtimeMs)}` : 'missing';
  } catch {
    return 'missing';
  }
}

function readTextOrEmpty(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function readJsonOrFallback(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

let lastBundleFilesSig = '';
let cachedRuntimeTemplate = '';
let cachedBootPayloadBase = null;
let cachedBundleHash = '';
let cachedVersion = '2.4.0';
let activeConfig = {
  enabled: true,
  contextLimit: 256000,
  contextLimitOverride: 0,
  modules: {},
  endpoints: []
};

function rebuildBundleIfNeeded() {
  const userConfigFile = path.join(USER_DIR, 'config.json');
  const userCssFile = path.join(USER_DIR, 'custom.css');
  const userJsFile = path.join(USER_DIR, 'custom.js');
  const userI18nFile = path.join(USER_DIR, 'i18n.override.json');

  const filesSig = [
    statSig(PKG_FILE),
    statSig(CORE_BASE_CSS_FILE),
    statSig(CORE_I18N_FILE),
    statSig(CORE_RUNTIME_FILE),
    statSig(userConfigFile),
    statSig(userCssFile),
    statSig(userJsFile),
    statSig(userI18nFile)
  ].join('|');

  const endpoints = discoverEndpoints();
  activeConfig.endpoints = endpoints;

  if (filesSig === lastBundleFilesSig && cachedBootPayloadBase) {
    return false;
  }
  lastBundleFilesSig = filesSig;

  const pkg = readJsonOrFallback(PKG_FILE, {});
  cachedVersion = pkg?.version ? `anti-claude-${pkg.version}` : 'anti-claude-2.4.0';

  const rawCfg = readJsonOrFallback(userConfigFile, {});
  const enabled = rawCfg?.enabled !== false;
  const modules = Object.assign(
    {
      i18n: false,
      metrics: true,
      zoomShortcuts: true,
      customCss: true,
      customJs: true
    },
    rawCfg?.modules || {}
  );
  const themeVars = rawCfg?.themeVars && typeof rawCfg.themeVars === 'object' ? rawCfg.themeVars : {};
  const darkThemeVars = rawCfg?.darkThemeVars && typeof rawCfg.darkThemeVars === 'object' ? rawCfg.darkThemeVars : {};

  const coreDict = readJsonOrFallback(CORE_I18N_FILE, {});
  const overrideDict = readJsonOrFallback(userI18nFile, {});
  const mergedDict = Object.assign({}, coreDict, overrideDict);
  delete mergedDict._comment;

  const baseCss = readTextOrEmpty(CORE_BASE_CSS_FILE);
  const customCss = readTextOrEmpty(userCssFile);
  const customJs = readTextOrEmpty(userJsFile);
  cachedRuntimeTemplate = readTextOrEmpty(CORE_RUNTIME_FILE);

  activeConfig = {
    enabled,
    contextLimit: Number(rawCfg?.contextLimit) > 0 ? Number(rawCfg.contextLimit) : 256000,
    contextLimitOverride: Number(rawCfg?.contextLimitOverride) > 0 ? Number(rawCfg.contextLimitOverride) : 0,
    modules,
    endpoints
  };

  cachedBootPayloadBase = {
    version: cachedVersion,
    platform: process.platform,
    enabled,
    config: rawCfg || {},
    modules,
    themeVars,
    darkThemeVars,
    cssText: baseCss,
    customCss,
    customJs,
    dict: mergedDict
  };

  cachedBundleHash = crypto
    .createHash('sha1')
    .update(JSON.stringify(cachedBootPayloadBase))
    .update(cachedRuntimeTemplate)
    .digest('hex')
    .slice(0, 12);

  return true;
}

function buildRuntimeScript(hostThemeMode = null) {
  if (!cachedRuntimeTemplate || !cachedBootPayloadBase) return '';
  const payload = hostThemeMode
    ? Object.assign({}, cachedBootPayloadBase, { hostThemeMode })
    : cachedBootPayloadBase;
  return cachedRuntimeTemplate.replace('(__AG_BOOT_PAYLOAD__);', () => `(${JSON.stringify(payload)});`);
}

/* -------------------------------------------------------------------------- */
/* 4. Read-Only SQLite & Protobuf Conversation Metrics Engine                 */
/* -------------------------------------------------------------------------- */

function parseProto(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf || []);
  const out = new Map();
  let pos = 0;
  const len = bytes.length;

  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (pos < len) {
      const b = bytes[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) {
        while (pos < len && (bytes[pos++] & 0x80) !== 0) {}
        return result;
      }
    }
    return result;
  };

  while (pos < len) {
    const tag = readVarint();
    if (!tag) break;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      out.set(fieldNo, readVarint());
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      out.set(fieldNo, bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

function readUtf8(val) {
  if (!(val instanceof Uint8Array)) return '';
  return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('utf8');
}

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function formatContextCeiling(tokens) {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

function getDbStatByPath(dbPath) {
  try {
    const st = fs.statSync(dbPath, { throwIfNoEntry: false });
    if (!st) return null;
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const walSig = wst ? `${wst.size}:${Math.floor(wst.mtimeMs)}` : '0:0';
    return {
      dbPath,
      mtimeMs: Math.max(st.mtimeMs, wst ? wst.mtimeMs : 0),
      sig: `${st.size}:${Math.floor(st.mtimeMs)}|${walSig}`
    };
  } catch {
    return null;
  }
}

let tmpSeq = 0;
function withReadOnlyDb(dbPath, timeoutMs, fn) {
  if (!isUncPath(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
    try {
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  tmpSeq = (tmpSeq + 1) % 100000;
  const tmpBase = path.join(os.tmpdir(), `ac-wsl-sqlite-${process.pid}-${Date.now()}-${tmpSeq}.db`);
  let tmpDb = null;
  try {
    fs.copyFileSync(dbPath, tmpBase);
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      try {
        fs.copyFileSync(walPath, `${tmpBase}-wal`);
      } catch {}
    }
    tmpDb = new DatabaseSync(tmpBase, { readOnly: true, timeout: timeoutMs });
    return fn(tmpDb);
  } finally {
    try {
      tmpDb?.close();
    } catch {}
    for (const sfx of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(`${tmpBase}${sfx}`, { force: true });
      } catch {}
    }
  }
}

function parseGenMetadataRow(r) {
  const top = parseProto(r.data);
  const chatRaw = top.get(1);
  const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map();
  const usageRaw = chat.get(4);
  const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map();
  const chatStartRaw = chat.get(9);
  const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map();
  const ctxWinRaw = chatStart.get(10);
  const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map();
  const maxCtx = ctxWin.get(4) || 0;
  const ttftRaw = chat.get(11);
  const ttftMap = ttftRaw instanceof Uint8Array ? parseProto(ttftRaw) : new Map();
  const streamRaw = chat.get(12);
  const streamMap = streamRaw instanceof Uint8Array ? parseProto(streamRaw) : new Map();

  const inTok = usage.get(2) || 0;
  const outTok = usage.get(3) || 0;
  const cacheRead = usage.get(5) || 0;
  const thinkTok = usage.get(9) || 0;
  const respTok = usage.get(10) || 0;
  const ttft = (ttftMap.get(1) || 0) + (ttftMap.get(2) || 0) / 1e9;
  const stream = (streamMap.get(1) || 0) + (streamMap.get(2) || 0) / 1e9;

  return {
    idx: r.idx,
    inTok,
    outTok,
    cacheRead,
    ctx: inTok + cacheRead,
    maxCtx,
    thinkTok,
    respTok,
    ttft,
    stream,
    totDur: ttft + stream
  };
}

const lineageCacheByDir = new Map();
const childScalarCache = new Map();
const metricsPayloadCache = new Map();

function setBounded(map, key, val, max = 128) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function getDescendantIds(cascadeId, conversationsDir) {
  if (!DatabaseSync || !conversationsDir) return [];
  let dirState = lineageCacheByDir.get(conversationsDir);
  if (!dirState) {
    dirState = { dirMtimeMs: -1, nodes: new Map() };
    lineageCacheByDir.set(conversationsDir, dirState);
  }
  const st = fs.statSync(conversationsDir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];

  if (st.mtimeMs !== dirState.dirMtimeMs) {
    let entries = [];
    try {
      entries = fs.readdirSync(conversationsDir);
    } catch {
      return [];
    }
    const seen = new Set();
    let opens = 0;
    for (const name of entries) {
      const m = name.match(DB_FILE_RE);
      if (!m) continue;
      const uuid = m[1];
      seen.add(uuid);
      const existing = dirState.nodes.get(uuid);
      if (existing?.hasMeta) continue;
      const dbPath = path.join(conversationsDir, name);
      const info = getDbStatByPath(dbPath);
      if (!info || (existing && existing.sig === info.sig)) continue;
      if (opens >= 20) continue;
      opens += 1;
      try {
        const metaRes = withReadOnlyDb(dbPath, 20, (db) => {
          const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
          if (!row?.data) return { hasMeta: false, parentId: '', rootId: '' };
          const meta = parseProto(row.data);
          return {
            hasMeta: true,
            parentId: readUtf8(meta.get(5)).trim(),
            rootId: readUtf8(meta.get(6)).trim()
          };
        });
        dirState.nodes.set(uuid, { ...metaRes, sig: info.sig });
      } catch {
        dirState.nodes.set(uuid, { hasMeta: false, parentId: '', rootId: '', sig: info.sig });
      }
    }
    for (const id of Array.from(dirState.nodes.keys())) {
      if (!seen.has(id)) dirState.nodes.delete(id);
    }
    if (opens < 20) dirState.dirMtimeMs = st.mtimeMs;
  }

  const byParent = new Map();
  const direct = new Set();
  for (const [uuid, node] of dirState.nodes.entries()) {
    if (node.parentId) {
      let s = byParent.get(node.parentId);
      if (!s) {
        s = new Set();
        byParent.set(node.parentId, s);
      }
      s.add(uuid);
    }
    if (node.rootId === cascadeId && uuid !== cascadeId) direct.add(uuid);
  }
  const pSet = byParent.get(cascadeId);
  if (pSet) for (const id of pSet) if (id !== cascadeId) direct.add(id);

  const queue = Array.from(direct);
  const visited = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const next = byParent.get(queue[i]);
    if (!next) continue;
    for (const id of next) {
      if (id !== cascadeId && !visited.has(id)) {
        visited.add(id);
        queue.push(id);
      }
    }
  }
  return queue.sort();
}

function readChildMetrics(childId, conversationsDir) {
  const dbPath = path.join(conversationsDir, `${childId}.db`);
  const info = getDbStatByPath(dbPath);
  if (!info) return null;
  const cached = childScalarCache.get(dbPath);
  if (cached && cached.sig === info.sig) return cached;
  try {
    const entry = withReadOnlyDb(dbPath, 30, (db) => {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      let calls = 0;
      let totalIn = 0;
      let totalCache = 0;
      let totalOut = 0;
      for (let i = 0; i < rows.length; i++) {
        const p = parseGenMetadataRow(rows[i]);
        if (p.ctx > 0 || p.outTok > 0) {
          calls += 1;
          totalIn += p.inTok;
          totalCache += p.cacheRead;
          totalOut += p.outTok;
        }
      }
      return { sig: info.sig, hasData: calls > 0, calls, totalIn, totalCache, totalOut };
    });
    setBounded(childScalarCache, dbPath, entry, 256);
    return entry;
  } catch {
    return cached || null;
  }
}

function parseConversationMetrics(cascadeId, conversationsDir) {
  if (!DatabaseSync || !cascadeId || !UUID_RE.test(cascadeId) || !conversationsDir) return null;
  const dbPath = path.join(conversationsDir, `${cascadeId}.db`);
  const statInfo = getDbStatByPath(dbPath);
  if (!statInfo) return { cascadeId, hasData: false };

  const descendantIds = getDescendantIds(cascadeId, conversationsDir);
  const childSigParts = [];
  for (const cid of descendantIds) {
    const cs = getDbStatByPath(path.join(conversationsDir, `${cid}.db`));
    childSigParts.push(`${cid}=${cs ? cs.sig : '0'}`);
  }
  const compositeSig = `${statInfo.sig}|c:${childSigParts.join(',')}|lim:${activeConfig.contextLimitOverride || activeConfig.contextLimit}`;

  const cached = metricsPayloadCache.get(dbPath);
  if (cached && cached.sig === compositeSig) return cached.payload;

  try {
    const dbRes = withReadOnlyDb(dbPath, 150, (db) => {
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      if (!rows.length) return { empty: true };
      const userStat = db
        .prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS lastIdx FROM steps WHERE step_type = 14')
        .get();
      const lastUserIdx = userStat?.lastIdx ?? -1;
      const userStepsCount = userStat?.cnt ?? 0;
      const turnStat = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 15 AND idx > ?').get(lastUserIdx);
      const rawTurnSteps = turnStat?.cnt ?? 0;
      return { empty: false, rows, userStepsCount, rawTurnSteps };
    });

    if (dbRes.empty) {
      const emptyPayload = { cascadeId, hasData: false, sig: compositeSig };
      setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload: emptyPayload }, 64);
      return emptyPayload;
    }

    const valid = [];
    let totalIn = 0;
    let totalCache = 0;
    let totalOut = 0;
    let totalThink = 0;
    let totalResp = 0;
    for (const r of dbRes.rows) {
      const p = parseGenMetadataRow(r);
      totalIn += p.inTok;
      totalCache += p.cacheRead;
      totalOut += p.outTok;
      totalThink += p.thinkTok;
      totalResp += p.respTok;
      if (p.ctx > 0 || p.outTok > 0) valid.push(p);
    }

    if (!valid.length) {
      const emptyPayload = { cascadeId, hasData: false, sig: compositeSig };
      setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload: emptyPayload }, 64);
      return emptyPayload;
    }

    let childCount = 0;
    let childCalls = 0;
    let childIn = 0;
    let childCache = 0;
    let childOut = 0;
    for (const cid of descendantIds) {
      const cm = readChildMetrics(cid, conversationsDir);
      if (!cm?.hasData) continue;
      childCount += 1;
      childCalls += cm.calls;
      childIn += cm.totalIn;
      childCache += cm.totalCache;
      childOut += cm.totalOut;
    }

    const turnSlice = dbRes.rawTurnSteps > 0 ? valid.slice(-dbRes.rawTurnSteps) : [];
    const turnSteps = turnSlice.length;
    let turnOut = 0;
    let turnThink = 0;
    let turnResp = 0;
    let turnDur = 0;
    for (const s of turnSlice) {
      turnOut += s.outTok;
      turnThink += s.thinkTok;
      turnResp += s.respTok;
      turnDur += s.totDur;
    }

    const last = valid[valid.length - 1];
    const contextLimitTokens =
      activeConfig.contextLimitOverride > 0
        ? activeConfig.contextLimitOverride
        : last.maxCtx > 0
          ? last.maxCtx
          : activeConfig.contextLimit || 256000;
    const limitStr = formatContextCeiling(contextLimitTokens);

    const rawStreamTps = last.stream >= 0.5 ? last.outTok / last.stream : 0;
    const e2eTps = last.totDur > 0 ? last.outTok / last.totDur : 0;
    const streamRatio = last.totDur > 0 ? last.stream / last.totDur : 0;
    const useStream =
      rawStreamTps > 0 &&
      rawStreamTps <= 600 &&
      (streamRatio >= 0.15 || (last.stream >= 2.0 && rawStreamTps <= 250));
    const displayTps = useStream ? rawStreamTps : e2eTps;
    const ctxPct = Math.round((last.ctx / contextLimitTokens) * 100);
    const ctxClass = ctxPct >= 90 ? 'ag-ctx-crit' : ctxPct >= 75 ? 'ag-ctx-warn' : 'ag-ctx-ok';
    const lastCacheRate = last.ctx > 0 ? ((last.cacheRead / last.ctx) * 100).toFixed(1) : '0.0';
    const sessionCacheRate = totalIn + totalCache > 0 ? ((totalCache / (totalIn + totalCache)) * 100).toFixed(1) : '0.0';
    const remainCtx = Math.max(0, contextLimitTokens - last.ctx);

    const subInlineHtml =
      childCount > 0 ? `<span class="ag-sep">·</span><span class="ag-sub-badge">+${childCount} sub</span>` : '';
    const inlineHtml = [
      `<span>${Math.round(displayTps)} tok/s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>${useStream ? 'TTFT' : 'Hold'} ${last.ttft.toFixed(1)}s</span>`,
      `<span class="ag-sep">·</span>`,
      `<span>Ctx ${fmtTok(last.ctx)}/${limitStr} <span class="${ctxClass}">(${ctxPct}%)</span></span>`,
      `<span class="ag-sep">·</span>`,
      `<span>Out ${fmtTok(last.outTok)}</span>`,
      subInlineHtml
    ].join('');

    const turnRowHtml =
      turnSteps > 1
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (${turnSteps}步)</span><span class="ag-tt-val">输出 ${fmtNum(turnOut)} (思考 ${fmtNum(turnThink)} + 响应 ${fmtNum(turnResp)}) | 耗时 ${turnDur.toFixed(1)}s</span></div>`
        : '';
    const subRowHtml =
      childCount > 0
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">子 Agent (${childCount})</span><span class="ag-tt-val">${childCalls} 次 · 新增 ${fmtTok(childIn)} + 缓存 ${fmtTok(childCache)} · 输出 ${fmtTok(childOut)}</span></div>`
        : '';
    const combinedOut = totalOut + childOut;
    const outputRowHtml =
      childCount > 0
        ? `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(combinedOut)} (主 ${fmtTok(totalOut)} + 子 ${fmtTok(childOut)})</span></div>`
        : `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 ${fmtTok(totalOut)} (思考链 ${fmtTok(totalThink)} + 正文/工具 ${fmtTok(totalResp)})</span></div>`;

    const tooltipHtml = [
      `<div class="ag-tt-hdr">本轮最新调用 (Gen #${last.idx + 1})</div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${useStream ? `流式 ${rawStreamTps.toFixed(1)} tok/s | ` : ''}端到端（含等待） ${e2eTps.toFixed(1)} tok/s</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">${useStream ? `TTFT ${last.ttft.toFixed(2)}s | 流式 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s` : `等待 ${last.ttft.toFixed(2)}s | 刷出 ${last.stream.toFixed(2)}s | 总计 ${last.totDur.toFixed(2)}s`}</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">${fmtNum(last.ctx)} (新增 ${fmtNum(last.inTok)} + 缓存 ${fmtNum(last.cacheRead)}, ${lastCacheRate}%)</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">${fmtNum(last.outTok)} (思考链 ${fmtNum(last.thinkTok)} + 正文/工具 ${fmtNum(last.respTok)})</span></div>`,
      turnRowHtml,
      `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${dbRes.userStepsCount} 轮提问 / ${valid.length} 次有效调用)</div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${fmtTok(last.ctx)} / ${limitStr} (${ctxPct}%) · 距压缩余 ${fmtTok(remainCtx)}</span></div>`,
      `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 ${fmtTok(totalIn)} + 缓存读取 ${fmtTok(totalCache)} (命中率 ${sessionCacheRate}%)</span></div>`,
      subRowHtml,
      outputRowHtml
    ].join('');

    const payload = { cascadeId, hasData: true, sig: compositeSig, inlineHtml, tooltipHtml };
    setBounded(metricsPayloadCache, dbPath, { sig: compositeSig, payload }, 64);
    return payload;
  } catch {
    return { cascadeId, transientError: true, cachedPayload: cached?.payload || null };
  }
}

/* -------------------------------------------------------------------------- */
/* 5. CDP Target Discovery, Host Verification & Session Attachment            */
/* -------------------------------------------------------------------------- */

const attachedTargets = new Map();
const skippedNonHostTargets = new Map();
const targetThemeModes = new Map();
const fallbackBackoffUntil = new Map();

function isAllowedOrigin(rawUrl) {
  const s = String(rawUrl || '');
  if (!s || s === 'about:blank') return false;
  if (s.startsWith('plugin://swarm--') || s.startsWith('vscode-file://') || s.startsWith('file://')) return true;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

function getOriginKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(rawUrl || '');
  }
}

async function fetchTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const HOST_IDENTITY_PROBE_EXPR = `(function () {
  if (location.protocol === 'plugin:' && /^swarm--/i.test(location.hostname || '')) return 'swarm';
  if (/^plugin:\\/\\/swarm--/i.test(location.href || '')) return 'swarm';
  if (location.protocol === 'vscode-file:') return 'host';
  if (window.__APP_CONFIG__ && window.__APP_CONFIG__.productName === 'antigravity') return 'host';
  if (window.electronNative && (typeof window.electronNative.getZoomLevel === 'function' || typeof window.electronNative.setTitleBarOverlay === 'function')) return 'host';
  if (document.querySelector && document.querySelector('link[href*="/jetbox.css"], body[data-agy-theme], body[data-newux-theme], [id="antigravity.agentSidePanelInputBox"]')) return 'host';
  if (document.readyState === 'loading') return 'loading';
  return 'non_host';
})()`;

function resolveParentHostTheme(page) {
  if (page.parentId && targetThemeModes.has(page.parentId)) {
    return targetThemeModes.get(page.parentId);
  }
  for (const [, mode] of targetThemeModes.entries()) {
    if (mode === 'dark' || mode === 'light') return mode;
  }
  return null;
}

async function attachTarget(page, endpoint) {
  const wsUrl = String(page.webSocketDebuggerUrl || '').replace(/^ws:\/\/localhost:/i, 'ws://127.0.0.1:');
  if (!wsUrl) return;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return;
  }

  let nextId = 1;
  let closed = false;
  const pending = new Map();

  const failAll = (reason) => {
    closed = true;
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  };

  const send = (method, params = {}, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error('ws_not_open'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
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

  const entry = {
    id: page.id,
    type: page.type,
    url: page.url,
    parentId: page.parentId || null,
    endpoint,
    ws,
    send,
    hostConfirmed: false,
    newDocScriptId: null,
    injectedBundleHash: '',
    watchedCascadeId: '',
    lastMetricsSig: '',
    updateTargetUrl(nextUrl) {
      entry.url = nextUrl;
      const m = String(nextUrl || '').match(/\/c\/([0-9a-f-]{36})/i);
      if (m && m[1] !== entry.watchedCascadeId) {
        entry.watchedCascadeId = m[1];
        entry.lastMetricsSig = '';
      }
    }
  };

  entry.updateTargetUrl(page.url);

  const pushMetricsToTarget = async (cascadeId, force = false) => {
    if (!activeConfig.enabled || activeConfig.modules.metrics === false || page.type === 'iframe') return;
    const cid = cascadeId || entry.watchedCascadeId;
    if (!cid || !UUID_RE.test(cid)) return;
    const payload = parseConversationMetrics(cid, entry.endpoint.conversationsDir);
    if (!payload) return;
    if (payload.transientError) {
      if (force && payload.cachedPayload) {
        await send('Runtime.evaluate', {
          expression: `window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload.cachedPayload)})`,
          returnByValue: false
        }).catch(() => {});
      }
      return;
    }
    if (!force && payload.sig && payload.sig === entry.lastMetricsSig) return;
    entry.lastMetricsSig = payload.sig || '';
    await send('Runtime.evaluate', {
      expression: `window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload)})`,
      returnByValue: false
    }).catch(() => {});
  };

  entry.syncMetricsForSession = async (force = false) => {
    if (!entry.hostConfirmed || page.type === 'iframe' || !activeConfig.enabled) return;
    if (!entry.watchedCascadeId) {
      const r = await send('Runtime.evaluate', {
        expression: 'window.__ag_watched_cascade_id || ""',
        returnByValue: true
      }).catch(() => null);
      const cid = r?.result?.result?.value;
      if (cid && UUID_RE.test(cid)) entry.watchedCascadeId = cid;
    }
    if (entry.watchedCascadeId) {
      await pushMetricsToTarget(entry.watchedCascadeId, force);
    }
  };

  entry.updateNewDocScript = async () => {
    if (!entry.hostConfirmed) return;
    if (entry.newDocScriptId) {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.newDocScriptId }).catch(() => {});
      entry.newDocScriptId = null;
    }
    if (!activeConfig.enabled) return;
    const hostMode = page.type === 'iframe' ? resolveParentHostTheme(page) : null;
    const scriptSource = buildRuntimeScript(hostMode);
    if (!scriptSource) return;
    const res = await send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource }).catch(() => null);
    entry.newDocScriptId = res?.result?.identifier || null;
  };

  entry.injectNow = async () => {
    if (!entry.hostConfirmed) return;
    const hostMode = page.type === 'iframe' ? resolveParentHostTheme(page) : null;
    const scriptSource = buildRuntimeScript(hostMode);
    if (!scriptSource) return;
    const evalRes = await send('Runtime.evaluate', {
      expression: scriptSource,
      returnByValue: true
    }).catch(() => null);
    entry.injectedBundleHash = cachedBundleHash;
    const resolvedMode = evalRes?.result?.result?.value;
    if (page.type === 'page' && (resolvedMode === 'dark' || resolvedMode === 'light')) {
      targetThemeModes.set(page.id, resolvedMode);
    }
  };

  entry.checkAndInject = async (force = false) => {
    if (!entry.hostConfirmed) return;
    if (force || entry.injectedBundleHash !== cachedBundleHash) {
      await entry.injectNow();
      return;
    }
    if (!activeConfig.enabled) return;
    const probe = await send('Runtime.evaluate', {
      expression: 'Boolean(document.getElementById("ag-custom-fonts"))',
      returnByValue: true
    }).catch(() => null);
    if (probe?.result?.result?.value === false) {
      await entry.injectNow();
    }
  };

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    if (!entry.hostConfirmed) return;
    if (msg.method === 'Runtime.bindingCalled') {
      const { name, payload } = msg.params || {};
      if (name === '__agRequestMetrics' && payload && UUID_RE.test(payload)) {
        entry.watchedCascadeId = payload;
        entry.lastMetricsSig = '';
        pushMetricsToTarget(payload, true).catch(() => {});
      } else if (name === '__agSyncHostThemeMode' && (payload === 'dark' || payload === 'light')) {
        targetThemeModes.set(page.id, payload);
        for (const [, other] of attachedTargets.entries()) {
          if (other.type === 'iframe' && other.hostConfirmed) {
            other
              .send('Runtime.evaluate', {
                expression: `window.__ag_set_host_theme_mode && window.__ag_set_host_theme_mode(${JSON.stringify(payload)})`,
                returnByValue: false
              })
              .catch(() => {});
          }
        }
      }
    } else if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) {
      entry.updateTargetUrl(msg.params?.frame?.url || entry.url);
      setTimeout(() => {
        entry.checkAndInject(false).catch(() => {});
        entry.syncMetricsForSession(true).catch(() => {});
      }, 60);
    }
  });

  ws.addEventListener('close', () => {
    failAll('ws_closed');
    attachedTargets.delete(page.id);
    targetThemeModes.delete(page.id);
  });
  ws.addEventListener('error', () => failAll('ws_error'));

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws_open_timeout')), 2000);
      ws.addEventListener('open', () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener('close', () => (clearTimeout(t), reject(new Error('ws_closed'))), { once: true });
      ws.addEventListener('error', () => (clearTimeout(t), reject(new Error('ws_error'))), { once: true });
    });

    await send('Runtime.enable');

    /* Verify this target is actually an Antigravity host window or swarm plugin (never inject into localhost user web apps) */
    let probeKind = 'non_host';
    for (let attempt = 0; attempt < 3; attempt++) {
      const probeRes = await send('Runtime.evaluate', {
        expression: HOST_IDENTITY_PROBE_EXPR,
        returnByValue: true
      });
      probeKind = probeRes?.result?.result?.value || 'non_host';
      if (probeKind !== 'loading') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    if (probeKind !== 'host' && probeKind !== 'swarm') {
      skippedNonHostTargets.set(page.id, { origin: getOriginKey(page.url) });
      try {
        ws.close();
      } catch {}
      return;
    }

    entry.hostConfirmed = true;
    attachedTargets.set(page.id, entry);

    await send('Page.enable').catch(() => {});
    if (page.type === 'page') {
      await send('Runtime.addBinding', { name: '__agRequestMetrics' }).catch(() => {});
      await send('Runtime.addBinding', { name: '__agSyncHostThemeMode' }).catch(() => {});
    }

    await entry.updateNewDocScript();
    await entry.injectNow();
    await entry.syncMetricsForSession(true);
  } catch {
    attachedTargets.delete(page.id);
    try {
      ws.close();
    } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Main Sync Loop & --verify-once Probe                                    */
/* -------------------------------------------------------------------------- */

let isSyncing = false;
let syncTickCount = 0;
let lastReachablePort = 0;

async function sync() {
  checkPidOwnership();
  if (isSyncing) return;
  isSyncing = true;
  syncTickCount = (syncTickCount + 1) % 6000;
  try {
    const bundleChanged = rebuildBundleIfNeeded();
    if (!activeConfig.enabled) targetThemeModes.clear();
    const shouldHeartbeatCheck = bundleChanged || syncTickCount % 6 === 1;

    const activeTargetIds = new Set();
    const seenRawTargetIds = new Set();
    const pendingPages = [];
    const pendingIframes = [];
    const probedPorts = new Set();
    const nowMs = Date.now();

    for (const endpoint of activeConfig.endpoints) {
      const port = readPort(endpoint.portFile);
      let targets = [];
      let usedPort = 0;
      if (port && !probedPorts.has(port)) {
        probedPorts.add(port);
        targets = await fetchTargets(port);
        if (targets.length > 0) usedPort = port;
      }
      if (
        targets.length === 0 &&
        endpoint.fallbackPort &&
        !probedPorts.has(endpoint.fallbackPort) &&
        (RUN_ONCE || nowMs >= (fallbackBackoffUntil.get(endpoint.fallbackPort) || 0))
      ) {
        probedPorts.add(endpoint.fallbackPort);
        targets = await fetchTargets(endpoint.fallbackPort);
        if (targets.length === 0) {
          fallbackBackoffUntil.set(endpoint.fallbackPort, nowMs + 10000);
        } else {
          fallbackBackoffUntil.delete(endpoint.fallbackPort);
          usedPort = endpoint.fallbackPort;
        }
      }
      if (targets.length === 0) continue;
      lastReachablePort = usedPort;

      for (const t of targets) {
        if (!t?.id) continue;
        seenRawTargetIds.add(t.id);
        const skipped = skippedNonHostTargets.get(t.id);
        if (skipped && (!isAllowedOrigin(t.url) || getOriginKey(t.url) !== skipped.origin)) {
          skippedNonHostTargets.delete(t.id);
        }
      }

      const candidates = targets.filter(
        (t) =>
          (t.type === 'page' || (t.type === 'iframe' && String(t.url || '').startsWith('plugin://swarm--'))) &&
          t.webSocketDebuggerUrl &&
          !String(t.url || '').startsWith('devtools://') &&
          isAllowedOrigin(t.url) &&
          !String(t.title || '').includes('Launchpad') &&
          skippedNonHostTargets.get(t.id)?.origin !== getOriginKey(t.url)
      );

      for (const page of candidates) {
        activeTargetIds.add(page.id);
        if (page.type === 'iframe') pendingIframes.push({ page, endpoint });
        else pendingPages.push({ page, endpoint });
      }
    }

    const syncBatch = async (items) => {
      const attaches = [];
      for (const { page, endpoint } of items) {
        if (!attachedTargets.has(page.id)) {
          attaches.push(attachTarget(page, endpoint));
        } else {
          const entry = attachedTargets.get(page.id);
          entry.endpoint = endpoint;
          entry.parentId = page.parentId || entry.parentId || null;
          entry.updateTargetUrl(page.url);
          if (entry.hostConfirmed) {
            if (bundleChanged) await entry.updateNewDocScript();
            if (shouldHeartbeatCheck) await entry.checkAndInject(bundleChanged);
            await entry.syncMetricsForSession(bundleChanged);
          }
        }
      }
      if (attaches.length > 0) await Promise.allSettled(attaches);
    };

    await syncBatch(pendingPages);
    await syncBatch(pendingIframes);

    for (const [id, entry] of attachedTargets.entries()) {
      if (!activeTargetIds.has(id)) {
        try {
          entry.ws.close();
        } catch {}
        attachedTargets.delete(id);
        targetThemeModes.delete(id);
      }
    }
    if (seenRawTargetIds.size > 0) {
      for (const id of skippedNonHostTargets.keys()) {
        if (!seenRawTargetIds.has(id)) skippedNonHostTargets.delete(id);
      }
    }
  } finally {
    isSyncing = false;
  }
}

async function runVerifyOnce() {
  await sync();
  let themeStyle = { present: false, length: 0 };
  let customStyle = { present: false, length: 0 };
  let hostPages = 0;

  for (const [, entry] of attachedTargets.entries()) {
    if (!entry.hostConfirmed || entry.type !== 'page') continue;
    hostPages += 1;
    const r = await entry
      .send('Runtime.evaluate', {
        expression: `(function () {
          const s1 = document.getElementById('ag-custom-fonts');
          const s2 = document.getElementById('antigravity-user-custom-style');
          return {
            themeStyle: { present: Boolean(s1), length: s1 ? (s1.textContent || '').length : 0 },
            customStyle: { present: Boolean(s2), length: s2 ? (s2.textContent || '').length : 0 }
          };
        })()`,
        returnByValue: true
      })
      .catch(() => null);
    const val = r?.result?.result?.value;
    if (val?.themeStyle?.present) themeStyle = val.themeStyle;
    if (val?.customStyle?.present) customStyle = val.customStyle;
  }

  for (const [, entry] of attachedTargets.entries()) {
    try {
      entry.ws.close();
    } catch {}
  }

  const reachable = hostPages > 0;
  const ok =
    reachable &&
    (!activeConfig.enabled ||
      (themeStyle.present && (!activeConfig.modules.customCss || customStyle.present)));

  console.log(
    JSON.stringify(
      {
        ok,
        version: cachedVersion,
        userDir: USER_DIR,
        themeStyle,
        customStyle,
        live: {
          reachable,
          port: lastReachablePort || null,
          targets: hostPages
        }
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

claimPidFile();
startMacCdpBootstrap();

if (VERIFY_ONCE) {
  await runVerifyOnce();
} else if (RUN_ONCE) {
  await sync();
  for (const [, entry] of attachedTargets.entries()) {
    try {
      entry.ws.close();
    } catch {}
  }
  process.exit(0);
} else {
  rebuildBundleIfNeeded();
  console.log(`[Anti-Claude Daemon] Started (${cachedVersion}) | userDir=${USER_DIR} | sqlite=${Boolean(DatabaseSync)}`);
  await sync();
  setInterval(sync, 2500);
}
