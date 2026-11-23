import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let BuiltinDatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync: BuiltinDatabaseSync } = req('node:sqlite'));
} catch {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_PROJECT_IDS = new Set(['outside-of-project', 'default-cli-project']);

/* -------------------------------------------------------------------------- */
/* Zero-dependency lossless Protobuf Wire helpers                             */
/* -------------------------------------------------------------------------- */

export function encodeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

export function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift < 64n) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, nextOffset: pos };
    shift += 7n;
  }
  return null;
}

export function parseProtoFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === 0n) throw new Error(`invalid_protobuf_tag:${start}`);
    pos = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber <= 0) throw new Error(`invalid_field_number:${fieldNumber}`);
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) throw new Error(`truncated_varint:${fieldNumber}`);
      pos = v.nextOffset;
      fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) throw new Error(`truncated_fixed64:${fieldNumber}`);
      pos += 8;
      fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
    } else if (wireType === 2) {
      const l = readVarint(buf, pos);
      if (!l) throw new Error(`truncated_length:${fieldNumber}`);
      pos = l.nextOffset;
      const len = Number(l.value);
      if (len < 0 || pos + len > buf.length) throw new Error(`truncated_bytes:${fieldNumber}`);
      const payload = buf.subarray(pos, pos + len);
      pos += len;
      fields.push({ fieldNumber, wireType, payload, raw: buf.subarray(start, pos) });
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) throw new Error(`truncated_fixed32:${fieldNumber}`);
      pos += 4;
      fields.push({ fieldNumber, wireType, raw: buf.subarray(start, pos) });
    } else {
      throw new Error(`unsupported_wire_type:${wireType}`);
    }
  }
  return fields;
}

export function validateWireFormat(buf) {
  try {
    parseProtoFields(buf);
    return true;
  } catch {
    return false;
  }
}

export function makeVarintField(fieldNumber, value) {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 0n);
  return Buffer.concat([tag, encodeVarint(value)]);
}

export function makeBytesField(fieldNumber, payload) {
  const tag = encodeVarint((BigInt(fieldNumber) << 3n) | 2n);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

export function makeStringField(fieldNumber, text) {
  return makeBytesField(fieldNumber, Buffer.from(String(text || ''), 'utf8'));
}

export function makeTimestampField(fieldNumber, date = new Date()) {
  const ms = date.getTime();
  const sec = BigInt(Math.floor(ms / 1000));
  const nanos = BigInt((ms % 1000) * 1_000_000);
  const parts = [makeVarintField(1, sec)];
  if (nanos > 0n) parts.push(makeVarintField(2, nanos));
  return makeBytesField(fieldNumber, Buffer.concat(parts));
}

export function decodeFileUriName(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return '';
  let pathname = raw;
  if (raw.startsWith('file://')) {
    try {
      pathname = decodeURIComponent(new URL(raw).pathname);
    } catch {
      pathname = raw.replace(/^file:\/\//, '');
    }
  }
  const clean = pathname.replace(/\/+$/, '');
  return path.basename(clean) || clean;
}

export function buildWorkspaceInfoProto(workspaceUri) {
  const uri = String(workspaceUri || '').trim();
  if (!uri) return Buffer.alloc(0);
  const name = decodeFileUriName(uri);
  const parts = [
    makeStringField(1, uri),
    makeStringField(2, uri)
  ];
  if (name) parts.push(makeStringField(4, name));
  return Buffer.concat(parts);
}

/**
 * Losslessly patch or build TrajectoryMetadata (conv.db `trajectory_metadata_blob` and `raw_summary` field 17).
 * Sets field 1 (WorkspaceInfo repeated), field 7 (workspaceUri), and field 18 (projectId),
 * while preserving all existing and unknown fields.
 */
export function patchTrajectoryMetadataProject(
  existingBuf,
  { conversationId, projectId, workspaceUris = [], nowDate = new Date() }
) {
  const buf = Buffer.isBuffer(existingBuf) ? existingBuf : Buffer.from(existingBuf || []);
  const cleanUris = (Array.isArray(workspaceUris) ? workspaceUris : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  const wsChunks = cleanUris.map((u) => makeBytesField(1, buildWorkspaceInfoProto(u)));
  const uriChunks = cleanUris.map((u) => makeStringField(7, u));

  let fields = [];
  if (buf.length > 0) {
    try {
      fields = parseProtoFields(buf);
    } catch {
      fields = [];
    }
  }

  if (fields.length === 0) {
    const out = [
      ...wsChunks,
      makeTimestampField(2, nowDate),
      makeStringField(3, crypto.randomUUID()),
      makeStringField(6, conversationId),
      ...uriChunks,
      makeStringField(18, projectId)
    ];
    const built = Buffer.concat(out);
    if (!validateWireFormat(built)) throw new Error('invalid_patched_trajectory_metadata');
    return built;
  }

  const out = [];
  let wroteWs = false;
  let wroteUri = false;
  let wrotePid = false;
  let hasConvId = false;

  for (const f of fields) {
    if (f.fieldNumber === 1 && f.wireType === 2 && cleanUris.length > 0) {
      if (!wroteWs) {
        out.push(...wsChunks);
        wroteWs = true;
      }
      continue;
    }
    if (f.fieldNumber === 6 && f.wireType === 2) {
      hasConvId = true;
      out.push(f.raw);
      continue;
    }
    if (f.fieldNumber === 7 && f.wireType === 2 && cleanUris.length > 0) {
      if (!wroteUri) {
        out.push(...uriChunks);
        wroteUri = true;
      }
      continue;
    }
    if (f.fieldNumber === 18 && f.wireType === 2) {
      if (!wrotePid) {
        out.push(makeStringField(18, projectId));
        wrotePid = true;
      }
      continue;
    }
    out.push(f.raw);
  }

  if (!wroteWs && wsChunks.length > 0) out.push(...wsChunks);
  if (!hasConvId && conversationId) out.push(makeStringField(6, conversationId));
  if (!wroteUri && uriChunks.length > 0) out.push(...uriChunks);
  if (!wrotePid) out.push(makeStringField(18, projectId));

  const patched = Buffer.concat(out);
  if (!validateWireFormat(patched)) throw new Error('invalid_patched_trajectory_metadata');
  return patched;
}

/**
 * Losslessly patch `CascadeTrajectorySummary` (`raw_summary`) field 9 (workspaces) and field 17 (trajectoryMetadata).
 */
export function patchCascadeSummaryProject(
  rawSummaryBuf,
  { conversationId, projectId, workspaceUris = [], nowDate = new Date() }
) {
  const buf = Buffer.isBuffer(rawSummaryBuf) ? rawSummaryBuf : Buffer.from(rawSummaryBuf || []);
  const cleanUris = (Array.isArray(workspaceUris) ? workspaceUris : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  const ws9Chunks = cleanUris.map((u) => makeBytesField(9, buildWorkspaceInfoProto(u)));
  const fields = buf.length > 0 ? parseProtoFields(buf) : [];

  const out = [];
  let wroteWs9 = false;
  let wroteTm17 = false;
  let patchedTmBlob = null;

  for (const f of fields) {
    if (f.fieldNumber === 9 && f.wireType === 2 && cleanUris.length > 0) {
      if (!wroteWs9) {
        out.push(...ws9Chunks);
        wroteWs9 = true;
      }
      continue;
    }
    if (f.fieldNumber === 17 && f.wireType === 2) {
      if (!wroteTm17) {
        patchedTmBlob = patchTrajectoryMetadataProject(f.payload || Buffer.alloc(0), {
          conversationId,
          projectId,
          workspaceUris: cleanUris,
          nowDate
        });
        out.push(makeBytesField(17, patchedTmBlob));
        wroteTm17 = true;
      }
      continue;
    }
    out.push(f.raw);
  }

  if (!wroteWs9 && ws9Chunks.length > 0) out.push(...ws9Chunks);
  if (!wroteTm17) {
    patchedTmBlob = patchTrajectoryMetadataProject(Buffer.alloc(0), {
      conversationId,
      projectId,
      workspaceUris: cleanUris,
      nowDate
    });
    out.push(makeBytesField(17, patchedTmBlob));
  }

  const patchedSummary = Buffer.concat(out);
  if (!validateWireFormat(patchedSummary)) throw new Error('invalid_patched_raw_summary');
  return { patchedSummary, patchedTmBlob };
}

export function patchSummariesProtoCacheEntry(cacheBuf, conversationId, patchedRawSummary) {
  const fields = parseProtoFields(cacheBuf);
  let updated = false;
  const out = [];

  for (const f of fields) {
    if (f.fieldNumber === 1 && f.wireType === 2 && f.payload) {
      const subFields = parseProtoFields(f.payload);
      const idChunk = subFields.find((s) => s.fieldNumber === 1 && s.wireType === 2 && s.payload);
      if (idChunk?.payload?.toString('utf8') === conversationId) {
        let replaced = false;
        const nextSubs = [];
        for (const sub of subFields) {
          if (sub.fieldNumber === 2 && sub.wireType === 2) {
            if (!replaced) {
              nextSubs.push(makeBytesField(2, patchedRawSummary));
              replaced = true;
            }
          } else {
            nextSubs.push(sub.raw);
          }
        }
        if (!replaced) nextSubs.push(makeBytesField(2, patchedRawSummary));
        out.push(makeBytesField(1, Buffer.concat(nextSubs)));
        updated = true;
        continue;
      }
    }
    out.push(f.raw);
  }

  const nextBuf = Buffer.concat(out);
  if (!validateWireFormat(nextBuf)) throw new Error('invalid_patched_proto_cache');
  return { buffer: nextBuf, updated };
}

function writeBufferAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

export function readProjectDefinition(projectsDir, projectId) {
  const id = String(projectId || '').trim();
  if (!id || RESERVED_PROJECT_IDS.has(id) || !SAFE_PROJECT_ID_RE.test(id)) return null;
  const filePath = path.join(projectsDir, `${id}.json`);
  const rel = path.relative(path.resolve(projectsDir), path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const resources = Array.isArray(raw.projectResources?.resources) ? raw.projectResources.resources : [];
    const folderUris = [];
    for (const r of resources) {
      const uri = r?.folderUri || r?.gitFolder?.folderUri || '';
      if (typeof uri === 'string' && uri.trim()) folderUris.push(uri.trim());
    }
    if (Array.isArray(raw.folderUris)) {
      for (const u of raw.folderUris) {
        if (typeof u === 'string' && u.trim() && !folderUris.includes(u.trim())) folderUris.push(u.trim());
      }
    }
    return {
      id: String(raw.id || id),
      name: String(raw.name || id).trim() || id,
      folderUris
    };
  } catch {
    return null;
  }
}

function patchConversationDbMetadata(convDbPath, { conversationId, projectId, workspaceUris, fallbackTmBlob, nowDate }, DatabaseSyncClass) {
  if (!fs.existsSync(convDbPath)) return { patched: false, cleanedDirtyMeta: 0 };
  const db = new DatabaseSyncClass(convDbPath, { readOnly: false, readBigInts: true });
  let inTx = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;

    const existingBlobRow = db.prepare('SELECT id, data FROM trajectory_metadata_blob LIMIT 1').get();
    const existingData = existingBlobRow?.data ? Buffer.from(existingBlobRow.data) : Buffer.alloc(0);
    const nextBlob = existingData.length > 0
      ? patchTrajectoryMetadataProject(existingData, { conversationId, projectId, workspaceUris, nowDate })
      : (fallbackTmBlob && fallbackTmBlob.length > 0
          ? fallbackTmBlob
          : patchTrajectoryMetadataProject(Buffer.alloc(0), { conversationId, projectId, workspaceUris, nowDate }));

    if (existingBlobRow) {
      db.prepare('UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?').run(nextBlob, existingBlobRow.id);
    } else {
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', nextBlob);
    }

    let cleanedDirtyMeta = 0;
    try {
      const metaRows = db.prepare('SELECT trajectory_id, trajectory_type, source FROM trajectory_meta').all();
      const hasValid = metaRows.some((r) => Number(r.trajectory_type) !== 0 || Number(r.source) !== 0);
      if (hasValid) {
        const dirty = metaRows.filter((r) => Number(r.trajectory_type) === 0 && Number(r.source) === 0);
        for (const d of dirty) {
          db.prepare('DELETE FROM trajectory_meta WHERE trajectory_id = ?').run(d.trajectory_id);
          cleanedDirtyMeta += 1;
        }
      }
    } catch {}

    db.exec('COMMIT;');
    inTx = false;
    return { patched: true, cleanedDirtyMeta };
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch {}
    }
    throw err;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Persist moving a conversation into an existing Antigravity project across:
 * 1. `conversations/<id>.db` (`trajectory_metadata_blob` + dirty `trajectory_meta` cleanup, prevents bounce-back);
 * 2. `conversation_summaries.db` (`project_id`, `workspace_uris`, `raw_summary` fields 9 & 17, `conversations_fts`);
 * 3. `agyhub_summaries_proto.pb` cache snapshot.
 */
export function moveConversationToProject(
  { conversationId, projectId, nowDate = new Date() },
  { antigravityDir, projectsDir, DatabaseSyncClass = BuiltinDatabaseSync } = {}
) {
  const cid = String(conversationId || '').trim();
  if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_conversation_id' };
  if (!antigravityDir || !projectsDir) return { ok: false, error: 'missing_dirs' };
  if (!DatabaseSyncClass) return { ok: false, error: 'sqlite_unavailable' };

  const project = readProjectDefinition(projectsDir, projectId);
  if (!project) return { ok: false, error: 'project_not_found' };

  const summariesDbPath = path.join(antigravityDir, 'conversation_summaries.db');
  const convDbPath = path.join(antigravityDir, 'conversations', `${cid}.db`);
  const protoCachePath = path.join(antigravityDir, 'agyhub_summaries_proto.pb');
  if (!fs.existsSync(summariesDbPath)) return { ok: false, error: 'summaries_db_missing' };

  const workspaceUris = project.folderUris;
  const workspaceUrisJson = workspaceUris.length > 0 ? JSON.stringify(workspaceUris) : '';
  const primaryWorkspaceName = workspaceUris.length > 0 ? decodeFileUriName(workspaceUris[0]) : '';

  const db = new DatabaseSyncClass(summariesDbPath, { readOnly: false, readBigInts: true });
  let inTx = false;
  let patchedSummary = null;
  let patchedTmBlob = null;
  let ftsUpdated = false;
  let prevProjectId = '';

  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;

    const row = db
      .prepare('SELECT project_id, workspace_uris, raw_summary FROM conversation_summaries WHERE conversation_id = ?')
      .get(cid);
    if (!row) {
      db.exec('ROLLBACK;');
      inTx = false;
      return { ok: false, error: 'conversation_not_found' };
    }
    prevProjectId = String(row.project_id || '');
    const existingRaw = row.raw_summary ? Buffer.from(row.raw_summary) : Buffer.alloc(0);
    const patched = patchCascadeSummaryProject(existingRaw, {
      conversationId: cid,
      projectId: project.id,
      workspaceUris,
      nowDate
    });
    patchedSummary = patched.patchedSummary;
    patchedTmBlob = patched.patchedTmBlob;

    db.prepare(
      'UPDATE conversation_summaries SET project_id = ?, workspace_uris = ?, raw_summary = ? WHERE conversation_id = ?'
    ).run(project.id, workspaceUrisJson, patchedSummary, cid);

    try {
      const ftsRow = db
        .prepare('SELECT * FROM conversations_fts WHERE conversation_id = ? AND chunk_index = -1')
        .get(cid);
      if (ftsRow) {
        db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ? AND chunk_index = -1').run(cid);
        db.prepare(
          `INSERT INTO conversations_fts (
            conversation_id, chunk_index, chunk_first_step, chunk_last_step,
            last_modified_time, step_count, last_step_created_at, archived,
            user_step_byte_offsets, agent_step_byte_offsets,
            title, workspace, project, user_body, agent_body
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ftsRow.conversation_id,
          ftsRow.chunk_index,
          ftsRow.chunk_first_step,
          ftsRow.chunk_last_step,
          ftsRow.last_modified_time,
          ftsRow.step_count,
          ftsRow.last_step_created_at,
          ftsRow.archived,
          ftsRow.user_step_byte_offsets ?? Buffer.alloc(0),
          ftsRow.agent_step_byte_offsets ?? Buffer.alloc(0),
          ftsRow.title ?? '',
          primaryWorkspaceName || ftsRow.workspace || '',
          project.name,
          ftsRow.user_body ?? '',
          ftsRow.agent_body ?? ''
        );
        ftsUpdated = true;
      }
    } catch {}

    db.exec('COMMIT;');
    inTx = false;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch {}
    }
    return { ok: false, error: `summaries_db_error:${String(err?.message || err)}` };
  } finally {
    try { db.close(); } catch {}
  }

  let convDbPatched = false;
  let cleanedDirtyMeta = 0;
  try {
    const convRes = patchConversationDbMetadata(
      convDbPath,
      { conversationId: cid, projectId: project.id, workspaceUris, fallbackTmBlob: patchedTmBlob, nowDate },
      DatabaseSyncClass
    );
    convDbPatched = convRes.patched;
    cleanedDirtyMeta = convRes.cleanedDirtyMeta;
  } catch (err) {
    return { ok: false, error: `conv_db_error:${String(err?.message || err)}` };
  }

  let protoCacheUpdated = false;
  if (patchedSummary && fs.existsSync(protoCachePath)) {
    try {
      const cacheBuf = fs.readFileSync(protoCachePath);
      const patchRes = patchSummariesProtoCacheEntry(cacheBuf, cid, patchedSummary);
      if (patchRes.updated) {
        writeBufferAtomic(protoCachePath, patchRes.buffer);
        protoCacheUpdated = true;
      }
    } catch {}
  }

  return {
    ok: true,
    conversationId: cid,
    previousProjectId: prevProjectId,
    projectId: project.id,
    projectName: project.name,
    workspaceUris,
    convDbPatched,
    cleanedDirtyMeta,
    ftsUpdated,
    protoCacheUpdated
  };
}
