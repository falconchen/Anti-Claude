import crypto from 'node:crypto';

export const APPROVAL_SCOPES = Object.freeze(['command', 'mcp', 'readFile', 'writeFile']);
const ACTION_SCOPE = Object.freeze({ command: 'command', unsandboxed: 'command', mcp: 'mcp', read_file: 'readFile', write_file: 'writeFile' });

export function normalizeApprovalSettings(raw = {}) {
  const delay = Number(raw?.delaySeconds);
  return {
    delaySeconds: Number.isFinite(delay) ? Math.min(3600, Math.max(0, Math.round(delay))) : 3,
    scopes: Object.fromEntries(APPROVAL_SCOPES.map(key => [key, typeof raw?.scopes?.[key] === 'boolean' ? raw.scopes[key] : true]))
  };
}

// Only immutable permission identity and resource data cross the bridge. No UI text matching.
export function normalizeApprovalCandidate(raw) {
  const str = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!raw || !str(raw.cascadeId) || !str(raw.trajectoryId) || !Number.isSafeInteger(raw.stepIndex) || raw.stepIndex < 0) return null;
  if (!Object.hasOwn(ACTION_SCOPE, raw.action) || !str(raw.target, 65536)) return null;
  // Scope selection cannot turn an unknown or non-permission interaction into an approval.
  if (raw.kind !== 'permission' || !str(raw.specSignature, 131072)) return null;
  return { cascadeId: raw.cascadeId, trajectoryId: raw.trajectoryId, stepIndex: raw.stepIndex,
    kind: 'permission', action: raw.action, target: raw.target, specSignature: raw.specSignature };
}

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const approvalKey = candidate => hash([candidate.cascadeId, candidate.trajectoryId, candidate.stepIndex]);
const fingerprint = candidate => hash(candidate);

// One coordinator in the daemon arbitrates all windows. The journal contains hashes, IDs
// and outcome timestamps only; commands, paths and MCP targets are never persisted.
export class AutoApprovalCoordinator {
  constructor({ now = Date.now, persist = () => {}, records = [] } = {}) {
    this.now = now;
    this.persist = persist;
    if (!Array.isArray(records) || records.some(r => !r || !/^[a-f0-9]{64}$/.test(r.key) || !/^[a-f0-9]{64}$/.test(r.fingerprint)
      || typeof r.cascadeId !== 'string' || !Number.isFinite(r.at) || !['submitted', 'confirmed', 'failed', 'uncertain'].includes(r.stage))) {
      throw new Error('invalid_approval_journal');
    }
    if (new Set(records.map(r => r.key)).size !== records.length) throw new Error('invalid_approval_journal');
    this.records = new Map(records.map(r => [r.key, { ...r, stage: ['confirmed', 'failed'].includes(r.stage) ? r.stage : 'uncertain', token: null }]));
    this.pending = new Map();
    this.policySignature = '';
    this.lastConfirmedAt = Math.max(0, ...records.filter(r => r.stage === 'confirmed').map(r => r.at));
  }

  save() {
    const cutoff = this.now() - 7 * 86400000;
    for (const [key, r] of this.records) if (r.stage === 'confirmed' && r.at < cutoff) this.records.delete(key);
    this.persist([...this.records.values()].map(({ token, owner, ...record }) => record));
  }

  policy({ enabled, settings, conflict = false }) {
    settings = normalizeApprovalSettings(settings);
    const signature = JSON.stringify([!!enabled, settings, !!conflict]);
    if (signature !== this.policySignature) { this.pending.clear(); this.policySignature = signature; }
    return { enabled: !!enabled, settings, conflict };
  }

  observe(owner, payload, policyInput) {
    const policy = this.policy(policyInput);
    const now = this.now();
    if (!Array.isArray(payload?.candidates) || payload.candidates.length > 256) return { ok: false, error: 'invalid_snapshot' };
    const candidates = (Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 256) : [])
      .map(normalizeApprovalCandidate).filter(Boolean);
    const knownIds = new Set(Array.isArray(payload?.knownIds) ? payload.knownIds.filter(s => typeof s === 'string').slice(0, 10000) : []);
    const current = new Map(candidates.map(c => [approvalKey(c), c]));
    const liveKeys = Array.isArray(payload.waiting) ? new Set(payload.waiting.slice(0, 10000).filter(w => w
      && typeof w.cascadeId === 'string' && typeof w.trajectoryId === 'string' && Number.isSafeInteger(w.stepIndex) && w.stepIndex >= 0).map(approvalKey)) : new Set(current.keys());
    const unknownWaitingIds = new Set(Array.isArray(payload.unknownWaitingIds) ? payload.unknownWaitingIds : []);
    let journalChanged = false;
    for (const r of this.records.values()) {
      if (r.stage === 'submitted') {
        if (r.owner === owner && r.rpcSucceeded && knownIds.has(r.cascadeId) && !liveKeys.has(r.key) && !unknownWaitingIds.has(r.cascadeId)) {
          r.stage = 'confirmed'; r.at = now; this.lastConfirmedAt = now; journalChanged = true;
        } else if (now - r.at > 10000) { r.stage = 'uncertain'; journalChanged = true; }
      }
    }
    if (journalChanged) this.save();
    for (const [key, p] of this.pending) {
      if ((p.owner === owner && !current.has(key)) || now - p.seenAt > 5000) this.pending.delete(key);
    }
    const unresolved = [...this.records.values()].filter(r => knownIds.has(r.cascadeId) && current.has(r.key) && ['failed', 'uncertain'].includes(r.stage)).length;
    const verifying = [...this.records.values()].some(r => r.stage === 'submitted');
    const base = { ok: true, enabled: policy.enabled, lastConfirmedAt: this.lastConfirmedAt, unresolved };
    if (!policy.enabled) return { ...base, status: 'paused' };
    if (policy.conflict) return { ...base, status: 'conflict' };
    if (payload?.userActive) {
      for (const [key, p] of this.pending) if (p.owner === owner) this.pending.delete(key);
      return { ...base, status: 'interacting' };
    }
    if (this.records.size >= 5000) this.save();
    if (this.records.size >= 5000) return { ...base, status: 'journal_full' };
    let next = null;
    let excluded = 0;
    for (const [key, candidate] of current) {
      if (!policy.settings.scopes[ACTION_SCOPE[candidate.action]]) { excluded++; continue; }
      if (this.records.has(key)) continue;
      const fp = fingerprint(candidate);
      let p = this.pending.get(key);
      if (!p || p.fingerprint !== fp) {
        p = { key, fingerprint: fp, owner, seenAt: now, deadline: now + policy.settings.delaySeconds * 1000, token: null };
        this.pending.set(key, p);
      }
      if (p.owner !== owner) continue;
      p.seenAt = now;
      if (!next || p.deadline < next.deadline) next = p;
    }
    if (verifying) return { ...base, status: 'verifying' };
    if (!next) return { ...base, status: unresolved ? 'uncertain' : excluded ? 'excluded' : 'idle' };
    if (next.deadline > now) return { ...base, status: 'countdown', remaining: Math.ceil((next.deadline - now) / 1000) };
    if (!next.token) next.token = crypto.randomBytes(20).toString('hex');
    return { ...base, status: 'ready', claim: { key: next.key, token: next.token } };
  }

  commit(owner, payload, policyInput) {
    const policy = this.policy(policyInput);
    const candidate = normalizeApprovalCandidate(payload?.candidate);
    if (!policy.enabled || policy.conflict || !candidate || !policy.settings.scopes[ACTION_SCOPE[candidate.action]]) return { ok: false, error: 'policy_changed' };
    const key = approvalKey(candidate);
    const p = this.pending.get(key);
    if (!p || p.owner !== owner || !p.token || p.token !== payload.token || this.records.has(key) || p.fingerprint !== fingerprint(candidate)
      || this.now() < p.deadline || this.now() - p.seenAt > 3000) return { ok: false, error: 'stale_request' };
    const record = { key, cascadeId: candidate.cascadeId, fingerprint: p.fingerprint, stage: 'submitted', at: this.now(), owner, token: p.token, rpcSucceeded: false };
    this.records.set(key, record);
    try { this.save(); } catch {
      this.records.delete(key);
      return { ok: false, error: 'journal_write_failed' };
    }
    this.pending.delete(key);
    return { ok: true, permit: true, key };
  }

  result(owner, payload) {
    const r = this.records.get(payload?.key);
    if (!r || r.owner !== owner || r.token !== payload?.token || r.stage !== 'submitted') return { ok: false, error: 'stale_result' };
    if (payload.succeeded === true) r.rpcSucceeded = true;
    else r.stage = 'failed';
    this.save();
    return { ok: true };
  }
}
