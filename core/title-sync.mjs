import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let BuiltinDatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync: BuiltinDatabaseSync } = req('node:sqlite'));
} catch {}

export const UUID_PBTXT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pbtxt$/i;
const TITLE_FIELD_RE = /\btitle\s*:\s*"((?:\\.|[^"\\])*)"/;
export const MAX_TITLE_LENGTH = 200;

/**
 * Unescape a Protobuf Text Format string body (without outer quotes),
 * including standard escapes, hex (\xHH), and octal UTF-8 byte sequences (\344\270\255).
 */
export function unescapePbtxtString(escaped) {
  const s = String(escaped ?? '');
  const bytes = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (/[0-7]/.test(next)) {
        let oct = next;
        let adv = 2;
        while (adv < 4 && i + adv < s.length && /[0-7]/.test(s[i + adv])) {
          oct += s[i + adv];
          adv += 1;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += adv;
        continue;
      }
      if (next === 'x' && i + 3 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
        bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      const simple = { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t' };
      const mapped = Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
      for (const b of Buffer.from(mapped, 'utf8')) bytes.push(b);
      i += 2;
      continue;
    }
    for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
    i += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

export function normalizeSyncedTitle(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!cleaned || cleaned.length > MAX_TITLE_LENGTH) return null;
  return cleaned;
}

export function parsePbtxtTitle(content) {
  if (typeof content !== 'string' || !content) return null;
  const m = content.match(TITLE_FIELD_RE);
  if (!m) return null;
  return normalizeSyncedTitle(unescapePbtxtString(m[1]));
}

export function extractConversationIdFromFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const base = path.basename(filename);
  const m = base.match(UUID_PBTXT_RE);
  return m ? m[1].toLowerCase() : null;
}

export function readPbtxtTitle(filePath, readFileFn = fs.readFileSync) {
  try {
    const content = readFileFn(filePath, 'utf8');
    return parsePbtxtTitle(content);
  } catch {
    return null;
  }
}

/**
 * Preflight guard before triggering Antigravity's native `updateConversationAnnotations` RPC.
 * Calling native annotation updates forces language_server to reload `conversations/<id>.db`:
 * - If `trajectory_metadata_blob` is empty (0 bytes) or missing, language_server clears `project_id` and `workspace_uris`.
 * - If the conversation is a legacy `.pb` file without a `.db`, native recalculation can demote it into `outside-of-project`.
 * Skipping unsafe conversations prevents detaching chats from their owning project.
 */
export function checkConversationSafeForNativeSync(
  conversationId,
  conversationsDir,
  { existsFn = fs.existsSync, DatabaseSyncClass = BuiltinDatabaseSync } = {}
) {
  if (!conversationsDir) return { safe: true, reason: 'no_conversations_dir' };
  const convDbPath = path.join(conversationsDir, `${conversationId}.db`);
  let dbExists = false;
  try {
    dbExists = Boolean(existsFn(convDbPath));
  } catch {
    return { safe: false, reason: 'conv_db_stat_error' };
  }
  if (!dbExists) {
    const legacyPbPath = path.join(conversationsDir, `${conversationId}.pb`);
    let pbExists = false;
    try {
      pbExists = Boolean(existsFn(legacyPbPath));
    } catch {}
    return { safe: false, reason: pbExists ? 'legacy_pb_format' : 'missing_conv_db' };
  }
  if (!DatabaseSyncClass) return { safe: false, reason: 'sqlite_unavailable' };

  let db = null;
  try {
    db = new DatabaseSyncClass(convDbPath, { readOnly: true, timeout: 50 });
    const row = db.prepare('SELECT MAX(length(data)) AS max_len FROM trajectory_metadata_blob').get();
    const maxLen = Number(row?.max_len ?? 0);
    if (!Number.isFinite(maxLen) || maxLen <= 0) {
      return { safe: false, reason: 'empty_trajectory_metadata' };
    }
    return { safe: true, reason: 'ok' };
  } catch {
    return { safe: false, reason: 'conv_db_unreadable' };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function setBounded(map, key, val, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Watches an Antigravity `annotations/` directory for external `<uuid>.pbtxt` title updates
 * (e.g. MCP batch renames on idle conversations), debounces bursts, suppresses self-echoes,
 * and delivers normalized `{ id, title }` batches to the daemon for live native RPC sync.
 */
export class TitleSyncWatcher {
  constructor({
    annotationsDir,
    conversationsDir = '',
    onBatch,
    onSkippedUnsafe = null,
    debounceMs = 180,
    dedupWindowMs = 3000,
    maxBatchSize = 100,
    maxHistoryEntries = 512,
    watchFn = fs.watch,
    existsFn = fs.existsSync,
    readFileFn = fs.readFileSync,
    safetyCheckFn = checkConversationSafeForNativeSync,
    nowFn = () => Date.now()
  } = {}) {
    this.annotationsDir = annotationsDir ? path.resolve(annotationsDir) : '';
    this.conversationsDir = conversationsDir ? path.resolve(conversationsDir) : '';
    this.onBatch = typeof onBatch === 'function' ? onBatch : () => {};
    this.onSkippedUnsafe = typeof onSkippedUnsafe === 'function' ? onSkippedUnsafe : null;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.dedupWindowMs = Math.max(0, Number(dedupWindowMs) || 0);
    this.maxBatchSize = Math.max(1, Math.floor(Number(maxBatchSize) || 100));
    this.maxHistoryEntries = Math.max(16, Math.floor(Number(maxHistoryEntries) || 512));
    this.watchFn = watchFn;
    this.existsFn = existsFn;
    this.readFileFn = readFileFn;
    this.safetyCheckFn = typeof safetyCheckFn === 'function' ? safetyCheckFn : () => ({ safe: true, reason: 'ok' });
    this.nowFn = nowFn;

    this.watcher = null;
    this.flushTimer = null;
    this.pendingIds = new Set();
    this.lastDispatched = new Map();
    this.running = false;
  }

  start() {
    if (this.watcher) return true;
    if (!this.annotationsDir) return false;
    try {
      if (!this.existsFn(this.annotationsDir)) return false;
    } catch {
      return false;
    }
    try {
      const w = this.watchFn(this.annotationsDir, (_eventType, filename) => {
        this.handleFsEvent(typeof filename === 'string' ? filename : String(filename || ''));
      });
      w?.on?.('error', () => {
        this.stop();
      });
      w?.unref?.();
      this.watcher = w;
      this.running = true;
      return true;
    } catch {
      this.watcher = null;
      this.running = false;
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingIds.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
  }

  handleFsEvent(filename) {
    const id = extractConversationIdFromFilename(filename);
    if (!id) return;
    this.pendingIds.add(id);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.debounceMs === 0) {
      this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingIds.size === 0) return [];

    const allIds = Array.from(this.pendingIds);
    const slice = allIds.slice(0, this.maxBatchSize);
    for (const id of slice) this.pendingIds.delete(id);

    const now = this.nowFn();
    const batch = [];
    const skippedUnsafe = [];
    for (const id of slice) {
      const filePath = path.join(this.annotationsDir, `${id}.pbtxt`);
      const title = readPbtxtTitle(filePath, this.readFileFn);
      if (!title) continue;
      const prev = this.lastDispatched.get(id);
      if (prev && prev.title === title && now - prev.at < this.dedupWindowMs) {
        continue;
      }
      if (this.conversationsDir) {
        const safety = this.safetyCheckFn(id, this.conversationsDir);
        if (!safety || safety.safe !== true) {
          skippedUnsafe.push({ id, reason: safety?.reason || 'unsafe' });
          continue;
        }
      }
      setBounded(this.lastDispatched, id, { title, at: now }, this.maxHistoryEntries);
      batch.push({ id, title });
    }

    if (skippedUnsafe.length > 0 && this.onSkippedUnsafe) {
      try {
        this.onSkippedUnsafe(skippedUnsafe);
      } catch {}
    }

    if (this.pendingIds.size > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, Math.max(20, this.debounceMs));
      this.flushTimer.unref?.();
    }

    if (batch.length > 0) {
      try {
        const res = this.onBatch(batch);
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch {}
    }
    return batch;
  }

  forget(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      if (typeof id === 'string') this.lastDispatched.delete(id.toLowerCase());
    }
  }
}
