/**
 * Anti-Claude — core/decisions.mjs
 * Zero-dependency decision log engine for Google Antigravity Desktop (Node.js >= 22).
 *
 * Responsibilities:
 * 1. Incrementally scans `brain/<cid>/.system_generated/logs/transcript.jsonl` (and `transcript_full.jsonl` on truncation)
 *    for `ask_question` tool calls and corresponding user answers (single-select, multi-select, custom Other, skipped, pending).
 * 2. Stores structured decisions, FTS search index, and append-only revision history in local SQLite (`decisions.db`).
 * 3. Dynamically enriches records with live conversation titles & project metadata from `conversation_summaries.db`
 *    and `~/.gemini/config/projects/*.json`, while preserving `title_snapshot` as a deletion fallback.
 * 4. Atomically syncs human- & AI-readable `<project>/.anti-claude/decisions.md` for projects with local workspaces.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

let BuiltinDatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync: BuiltinDatabaseSync } = req('node:sqlite'));
} catch {}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DECISION_STATUSES = ['decided', 'uncertain', 'changed', 'skipped', 'pending'];
export const ANSWER_KINDS = ['preset', 'multi', 'custom', 'skipped', 'pending'];
export const RESERVED_PROJECT_IDS = new Set(['outside-of-project', 'default-cli-project']);

const RECOMMENDED_PREFIX_RE = /^\s*(?:\(Recommended\)|（Recommended）|\[Recommended\]|推荐[：:])\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*(?:\(Recommended\)|（Recommended）|\[Recommended\])\s*$/i;
const TIMESTAMP_LINE_RE = /^(?:Created At|Completed At)\s*:\s*(.+)$/i;
const ANSWER_LINE_RE = /^A(\d+)\s*:\s*(.*)$/;
const SKIPPED_RE = /^(?:User\s+Skipped|Skipped|已跳过)$/i;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function writeAtomicUtf8(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function decodeFileUriToPath(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file://')) {
    try {
      let pathname = decodeURIComponent(new URL(raw).pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname.replace(/\/+$/, '') || pathname;
    } catch {
      return raw.replace(/^file:\/\//, '').replace(/\/+$/, '');
    }
  }
  return raw.replace(/\/+$/, '') || raw;
}

export function isSafeProjectWorkspace(workspacePath, { homeDir = os.homedir(), antigravityDir = '' } = {}) {
  const raw = String(workspacePath || '').trim();
  if (!raw || !path.isAbsolute(raw)) return false;
  const abs = path.resolve(raw);
  const root = path.parse(abs).root;
  if (abs === root) return false;
  const resolvedHome = path.resolve(homeDir);
  if (abs === resolvedHome) return false;
  if (antigravityDir) {
    const resolvedAg = path.resolve(antigravityDir);
    if (abs === resolvedAg || abs.startsWith(resolvedAg + path.sep)) return false;
  }
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  return Boolean(st && st.isDirectory());
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Option & Answer Normalization                                              */
/* -------------------------------------------------------------------------- */

export function normalizeOptionItem(raw, index = 0) {
  let label = '';
  let description = '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    label = String(raw.label ?? raw.text ?? raw.value ?? raw.title ?? '').trim();
    description = String(raw.description ?? raw.desc ?? '').trim();
  } else {
    label = String(raw ?? '').trim();
  }
  const recommended = RECOMMENDED_PREFIX_RE.test(label) || RECOMMENDED_SUFFIX_RE.test(label);
  const cleanLabel = label.replace(RECOMMENDED_PREFIX_RE, '').replace(RECOMMENDED_SUFFIX_RE, '').trim() || label;
  return {
    index,
    label,
    cleanLabel,
    description,
    recommended
  };
}

export function parseAnswerContent(rawContent) {
  const text = String(rawContent ?? '').replace(/\r\n/g, '\n');
  const answers = new Map();
  let createdAt = '';
  let completedAt = '';
  let currentIdx = null;

  for (const line of text.split('\n')) {
    const tsMatch = line.match(TIMESTAMP_LINE_RE);
    if (tsMatch && currentIdx === null) {
      if (/^Created At/i.test(line)) createdAt = tsMatch[1].trim();
      else if (/^Completed At/i.test(line)) completedAt = tsMatch[1].trim();
      continue;
    }
    const ansMatch = line.match(ANSWER_LINE_RE);
    if (ansMatch) {
      currentIdx = Number(ansMatch[1]);
      answers.set(currentIdx, ansMatch[2]);
      continue;
    }
    if (currentIdx !== null) {
      const prev = answers.get(currentIdx) || '';
      answers.set(currentIdx, prev ? `${prev}\n${line}` : line);
    }
  }

  for (const [k, v] of answers.entries()) {
    answers.set(k, String(v || '').trim());
  }

  return { answers, createdAt, completedAt };
}

/**
 * Matches raw answer text against normalized preset options.
 * For multi-select answers joined by `, `, performs greedy left-to-right matching against known option
 * labels so commas inside an option's own text do not split it erroneously.
 */
export function matchAnswerToOptions(answerText, options, isMultiSelect = false) {
  const raw = String(answerText ?? '').trim();
  if (!raw) {
    return { answerKind: 'pending', selectedOptions: [], selectedIndices: [], currentChoice: '' };
  }
  if (SKIPPED_RE.test(raw)) {
    return { answerKind: 'skipped', selectedOptions: [], selectedIndices: [], currentChoice: '' };
  }

  const opts = Array.isArray(options) ? options : [];
  const exactMatch = (candidate) => {
    const c = candidate.trim();
    if (!c) return null;
    return opts.find((o) => o.label === c || o.cleanLabel === c) || null;
  };

  const single = exactMatch(raw);
  if (single) {
    return {
      answerKind: isMultiSelect ? 'multi' : 'preset',
      selectedOptions: [single.label],
      selectedIndices: [single.index],
      currentChoice: single.label
    };
  }

  if (isMultiSelect && opts.length > 0) {
    const candidates = [];
    for (const o of opts) {
      if (o.label) candidates.push({ opt: o, text: o.label });
      if (o.cleanLabel && o.cleanLabel !== o.label) candidates.push({ opt: o, text: o.cleanLabel });
    }
    /* Longer labels first so prefixes never shadow full labels */
    candidates.sort((a, b) => b.text.length - a.text.length);

    const matchedOpts = [];
    const matchedIdxSet = new Set();
    let remaining = raw;
    let guard = 0;

    while (remaining.length > 0 && guard++ < 64) {
      remaining = remaining.replace(/^[\s,，;；]+/, '');
      if (!remaining) break;
      let hit = null;
      for (const cand of candidates) {
        if (remaining.startsWith(cand.text)) {
          const after = remaining.slice(cand.text.length);
          if (after === '' || /^[\s,，;；]/.test(after)) {
            hit = cand;
            break;
          }
        }
      }
      if (hit) {
        if (!matchedIdxSet.has(hit.opt.index)) {
          matchedIdxSet.add(hit.opt.index);
          matchedOpts.push(hit.opt);
        }
        remaining = remaining.slice(hit.text.length);
      } else {
        /* Consume unrecognized segment up to next comma/newline as custom entry */
        const commaIdx = remaining.search(/,\s+/);
        if (commaIdx === -1) {
          remaining = '';
        } else {
          remaining = remaining.slice(commaIdx + 1);
        }
      }
    }

    if (matchedOpts.length > 0) {
      return {
        answerKind: 'multi',
        selectedOptions: matchedOpts.map((o) => o.label),
        selectedIndices: matchedOpts.map((o) => o.index),
        currentChoice: raw
      };
    }
  }

  return {
    answerKind: 'custom',
    selectedOptions: [],
    selectedIndices: [],
    currentChoice: raw
  };
}

/* -------------------------------------------------------------------------- */
/* Transcript Parser                                                          */
/* -------------------------------------------------------------------------- */

function loadFullTranscriptIndex(fullTranscriptPath) {
  const byStep = new Map();
  if (!fullTranscriptPath || !fs.existsSync(fullTranscriptPath)) return byStep;
  try {
    const raw = fs.readFileSync(fullTranscriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.step_index === 'number') {
          byStep.set(obj.step_index, obj);
        }
      } catch {}
    }
  } catch {}
  return byStep;
}

export function parseTranscriptDecisions(transcriptPath, { conversationId = '', fullTranscriptPath = '' } = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  if (!raw.includes('ask_question')) return [];

  const cid = conversationId || path.basename(path.resolve(transcriptPath, '..', '..', '..'));
  const resolvedFullPath = fullTranscriptPath || path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  const lines = raw.split('\n').filter((l) => l.trim());
  const steps = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch {}
  }

  let fullIndex = null;
  const resolveUntruncated = (step, fieldName) => {
    const trunc = Array.isArray(step?.truncated_fields) ? step.truncated_fields : [];
    if (!trunc.includes(fieldName)) return step;
    if (fullIndex === null) fullIndex = loadFullTranscriptIndex(resolvedFullPath);
    return fullIndex.get(step.step_index) || step;
  };

  const results = [];

  for (let i = 0; i < steps.length; i++) {
    let step = steps[i];
    if (!step || !Array.isArray(step.tool_calls)) continue;
    const hasAsk = step.tool_calls.some((tc) => (tc?.name || tc?.tool_name) === 'ask_question');
    if (!hasAsk) continue;

    step = resolveUntruncated(step, 'tool_calls');
    const askCalls = (step.tool_calls || []).filter((tc) => (tc?.name || tc?.tool_name) === 'ask_question');
    if (!askCalls.length) continue;

    const callStepIndex = typeof step.step_index === 'number' ? step.step_index : i;
    const askedAt = String(step.created_at || '');

    /* Locate the corresponding GENERIC response step right after this planner step */
    let answerStep = null;
    for (let j = i + 1; j < Math.min(i + 6, steps.length); j++) {
      const cand = steps[j];
      if (!cand) continue;
      if (cand.type === 'USER_INPUT') break;
      if (
        cand.type === 'PLANNER_RESPONSE' &&
        Array.isArray(cand.tool_calls) &&
        cand.tool_calls.some((tc) => (tc?.name || tc?.tool_name) === 'ask_question')
      ) {
        break;
      }
      if (cand.type === 'GENERIC') {
        const resolvedCand = resolveUntruncated(cand, 'content');
        const contentStr = String(resolvedCand?.content || '');
        if (/^A1\s*:/m.test(contentStr) || /User\s+Skipped/i.test(contentStr)) {
          answerStep = resolvedCand;
          break;
        }
      }
    }

    const parsedAns = answerStep ? parseAnswerContent(answerStep.content) : null;
    const answerStepIndex = answerStep && typeof answerStep.step_index === 'number' ? answerStep.step_index : null;
    const answeredAt = answerStep ? parsedAns.completedAt || String(answerStep.created_at || '') : '';

    let qOffset = 0;
    for (const tc of askCalls) {
      const rawQuestions = tc?.args?.questions;
      const questions =
        typeof rawQuestions === 'string'
          ? safeJsonParse(rawQuestions, [])
          : Array.isArray(rawQuestions)
            ? rawQuestions
            : [];
      if (!Array.isArray(questions) || questions.length === 0) continue;

      const totalCount = questions.length;
      for (let qIdx = 0; qIdx < totalCount; qIdx++) {
        const qObj = questions[qIdx];
        if (!qObj || typeof qObj !== 'object') continue;
        const questionText = String(qObj.question || '').trim();
        if (!questionText) continue;

        const isMultiSelect = Boolean(qObj.is_multi_select);
        const rawOpts = Array.isArray(qObj.options) ? qObj.options : [];
        const options = rawOpts.map((o, idx) => normalizeOptionItem(o, idx));
        const recOpt = options.find((o) => o.recommended)?.label || '';

        const ansNumber = qOffset + qIdx + 1;
        const answerRaw = parsedAns ? String(parsedAns.answers.get(ansNumber) || '').trim() : '';
        const matched = matchAnswerToOptions(answerRaw, options, isMultiSelect);

        results.push({
          id: `${cid}:${callStepIndex}:${qOffset + qIdx}`,
          groupId: `${cid}:${callStepIndex}`,
          conversationId: cid,
          callStepIndex,
          answerStepIndex,
          questionIndex: qOffset + qIdx,
          questionCount: totalCount,
          question: questionText,
          isMultiSelect,
          options,
          recommendedOption: recOpt,
          answerRaw,
          selectedOptions: matched.selectedOptions,
          selectedIndices: matched.selectedIndices,
          answerKind: matched.answerKind,
          currentChoice: matched.currentChoice,
          askedAt,
          answeredAt
        });
      }
      qOffset += totalCount;
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Markdown & Revisit Prompt Formatting                                       */
/* -------------------------------------------------------------------------- */

const STATUS_BADGE_ZH = {
  decided: '✅ 已定',
  uncertain: '🤔 拿捏不定',
  changed: '🔄 已变更',
  skipped: '⏭️ 已跳过',
  pending: '⏳ 待作答'
};

const ANSWER_KIND_ZH = {
  preset: '预设选项',
  multi: '多选',
  custom: '自定义回答（Other）',
  skipped: '已跳过',
  pending: '待作答'
};

export function renderProjectDecisionsMarkdown({ projectName, workspacePath, decisions = [] }) {
  const lines = [];
  lines.push(`# ${projectName || path.basename(workspacePath || '') || 'Project'} — 对话决策记录`);
  lines.push('');
  lines.push('> 由 Anti-Claude 自动索引与同步，保留每次 `ask_question` 的完整备选方案、当时选择、复盘备注与变更历史。');
  lines.push('> 可在对话中直接 `@.anti-claude/decisions.md` 引用给 AI，或通过 `anti-claude-decisions` MCP 检索。');
  lines.push('');

  if (!decisions.length) {
    lines.push('_当前项目暂无决策记录。_');
    lines.push('');
    return lines.join('\n');
  }

  /* Summary counts */
  const counts = { total: decisions.length, decided: 0, uncertain: 0, changed: 0, skipped: 0, pending: 0 };
  for (const d of decisions) {
    if (Object.prototype.hasOwnProperty.call(counts, d.reviewStatus)) counts[d.reviewStatus] += 1;
  }
  lines.push(
    `**统计**：共 ${counts.total} 条决策（✅ 已定 ${counts.decided} · 🤔 拿捏不定 ${counts.uncertain} · 🔄 已变更 ${counts.changed} · ⏭️ 已跳过 ${counts.skipped}${counts.pending ? ` · ⏳ 待作答 ${counts.pending}` : ''}）`
  );
  lines.push('');

  /* Group by conversationId preserving newest-first order */
  const convOrder = [];
  const byConv = new Map();
  for (const d of decisions) {
    if (!byConv.has(d.conversationId)) {
      byConv.set(d.conversationId, []);
      convOrder.push(d.conversationId);
    }
    byConv.get(d.conversationId).push(d);
  }

  for (const cid of convOrder) {
    const items = byConv.get(cid);
    const first = items[0];
    const title = first.currentTitle || first.titleSnapshot || cid.slice(0, 8);
    const dateStr = (first.answeredAt || first.askedAt || '').slice(0, 10);
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${title}`);
    lines.push(`- **Conversation ID**: \`${cid}\`${dateStr ? ` · **日期**: ${dateStr}` : ''}`);
    lines.push('');

    /* Order within conversation chronologically (step_index asc, question_index asc) */
    const ordered = items
      .slice()
      .sort((a, b) => a.callStepIndex - b.callStepIndex || a.questionIndex - b.questionIndex);

    for (const d of ordered) {
      const badge = STATUS_BADGE_ZH[d.reviewStatus] || d.reviewStatus;
      const batchTag = d.questionCount > 1 ? ` (${d.questionIndex + 1}/${d.questionCount})` : '';
      lines.push(`### ${badge} ${d.question}${batchTag}`);
      lines.push('');

      const selectedSet = new Set(d.selectedOptions || []);
      const effectiveChoice = d.currentChoice || d.answerRaw || '';

      lines.push('**当时提供的备选方案**：');
      for (const opt of d.options || []) {
        const isInitialSelected = selectedSet.has(opt.label) || selectedSet.has(opt.cleanLabel);
        const isCurrentSelected = effectiveChoice === opt.label || effectiveChoice === opt.cleanLabel;
        const checked = isCurrentSelected || (d.reviewStatus !== 'changed' && isInitialSelected);
        const tags = [];
        if (opt.recommended) tags.push('★ 推荐');
        if (d.reviewStatus === 'changed' && isInitialSelected && !isCurrentSelected) tags.push('原选择');
        if (d.reviewStatus === 'changed' && isCurrentSelected) tags.push('当前生效');
        const tagSuffix = tags.length ? ` _(${tags.join(' / ')})_` : '';
        const descSuffix = opt.description ? ` — ${opt.description}` : '';
        lines.push(`- [${checked ? 'x' : ' '}] ${opt.index + 1}. ${opt.cleanLabel}${descSuffix}${tagSuffix}`);
      }

      if (d.answerKind === 'custom' && d.answerRaw) {
        lines.push(`- [x] **自定义回答（Other）**：${d.answerRaw}`);
      } else if (d.answerKind === 'skipped') {
        lines.push(`- _用户跳过了该问题（User Skipped）_`);
      } else if (d.answerKind === 'pending') {
        lines.push(`- _等待作答_`);
      }

      if (d.reviewStatus === 'changed' && effectiveChoice) {
        lines.push('');
        lines.push(`**当前生效方案**：${effectiveChoice}`);
      }

      if (d.userNote) {
        lines.push('');
        lines.push(`**复盘备注**：${d.userNote}`);
      }

      if (Array.isArray(d.revisions) && d.revisions.length > 0) {
        lines.push('');
        lines.push('**变更历史**：');
        for (const rev of d.revisions) {
          const revDate = String(rev.createdAt || '').slice(0, 16).replace('T', ' ');
          const reasonPart = rev.reason ? `（原因：${rev.reason}）` : '';
          lines.push(`- \`${revDate}\` ${rev.fromChoice || '（无）'} → **${rev.toChoice}**${reasonPart}`);
        }
      }

      lines.push('');
      lines.push(`<sub>Decision ID: \`${d.id}\` · 类型: ${ANSWER_KIND_ZH[d.answerKind] || d.answerKind}${d.answeredAt ? ` · 决策时间: ${d.answeredAt}` : ''}</sub>`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function formatDecisionRevisitPrompt(decision, revisions = [], siblings = []) {
  if (!decision) return '';
  const title = decision.currentTitle || decision.titleSnapshot || decision.conversationId;
  const badge = STATUS_BADGE_ZH[decision.reviewStatus] || decision.reviewStatus;
  const lines = [
    `【历史决策复盘引用】`,
    `- 项目：${decision.projectName || '未归属项目'}`,
    `- 来源对话：${title}（ID: ${decision.conversationId}）`,
    `- 决策状态：${badge}${decision.answeredAt ? ` · 记录时间：${decision.answeredAt}` : ''}`,
    `- 原问题：${decision.question}`,
    `- 当时提供的备选方案：`
  ];

  const selectedSet = new Set(decision.selectedOptions || []);
  for (const opt of decision.options || []) {
    const marks = [];
    if (opt.recommended) marks.push('原推荐');
    if (selectedSet.has(opt.label) || selectedSet.has(opt.cleanLabel)) marks.push('当时所选');
    if (decision.reviewStatus === 'changed' && (decision.currentChoice === opt.label || decision.currentChoice === opt.cleanLabel)) {
      marks.push('当前生效');
    }
    const markStr = marks.length ? ` [${marks.join(' / ')}]` : '';
    const descStr = opt.description ? ` — ${opt.description}` : '';
    lines.push(`  ${opt.index + 1}. ${opt.cleanLabel}${descStr}${markStr}`);
  }

  if (decision.answerKind === 'custom' && decision.answerRaw) {
    lines.push(`- 当时自定义回答：${decision.answerRaw}`);
  } else if (decision.answerKind === 'skipped') {
    lines.push(`- 当时状态：已跳过（User Skipped）`);
  }

  if (decision.currentChoice && decision.currentChoice !== decision.answerRaw) {
    lines.push(`- 当前生效选择：${decision.currentChoice}`);
  }
  if (decision.userNote) {
    lines.push(`- 我的备注：${decision.userNote}`);
  }
  if (Array.isArray(revisions) && revisions.length > 0) {
    lines.push(`- 变更历史：`);
    for (const r of revisions) {
      lines.push(`  - ${String(r.createdAt || '').slice(0, 10)}: ${r.fromChoice} → ${r.toChoice}${r.reason ? `（${r.reason}）` : ''}`);
    }
  }
  if (Array.isArray(siblings) && siblings.length > 1) {
    const otherQs = siblings.filter((s) => s.id !== decision.id);
    if (otherQs.length > 0) {
      lines.push(`- 同轮次其他关联决策：`);
      for (const s of otherQs) {
        lines.push(`  - ${s.question} → ${s.currentChoice || s.answerRaw || '（未作答）'}`);
      }
    }
  }

  lines.push('');
  lines.push('请结合当前代码和最新需求，帮我对比以上备选方案：如果把当前选择切换为其他备选方案，会带来哪些影响和改动？');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* SQLite DecisionStore                                                       */
/* -------------------------------------------------------------------------- */

export class DecisionStore {
  constructor({
    dbPath,
    antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity'),
    projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects'),
    homeDir = os.homedir(),
    syncMarkdown = true,
    DatabaseSyncClass = BuiltinDatabaseSync
  } = {}) {
    this.antigravityDir = path.resolve(antigravityDir);
    this.brainDir = path.join(this.antigravityDir, 'brain');
    this.summariesDbPath = path.join(this.antigravityDir, 'conversation_summaries.db');
    this.projectsDir = path.resolve(projectsDir);
    this.homeDir = path.resolve(homeDir);
    this.dbPath = path.resolve(dbPath || path.join(this.antigravityDir, 'anti-claude', 'decisions.db'));
    this.syncMarkdown = Boolean(syncMarkdown);
    this.DatabaseSyncClass = DatabaseSyncClass;
    this.db = null;
  }

  ensureOpen() {
    if (this.db) return this.db;
    if (!this.DatabaseSyncClass) {
      throw new Error('node:sqlite is unavailable (Node.js >= 22 required)');
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new this.DatabaseSyncClass(this.dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS transcript_scan_state (
        conversation_id TEXT PRIMARY KEY,
        transcript_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        call_step_index INTEGER NOT NULL,
        answer_step_index INTEGER,
        question_index INTEGER NOT NULL,
        question_count INTEGER NOT NULL DEFAULT 1,
        project_id TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL DEFAULT '',
        title_snapshot TEXT NOT NULL DEFAULT '',
        question TEXT NOT NULL,
        is_multi_select INTEGER NOT NULL DEFAULT 0,
        options_json TEXT NOT NULL DEFAULT '[]',
        options_text TEXT NOT NULL DEFAULT '',
        recommended_option TEXT NOT NULL DEFAULT '',
        answer_raw TEXT NOT NULL DEFAULT '',
        selected_options_json TEXT NOT NULL DEFAULT '[]',
        answer_kind TEXT NOT NULL DEFAULT 'pending',
        asked_at TEXT NOT NULL DEFAULT '',
        answered_at TEXT NOT NULL DEFAULT '',
        review_status TEXT NOT NULL DEFAULT 'decided',
        current_choice TEXT NOT NULL DEFAULT '',
        user_note TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_conv ON decisions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_proj ON decisions(project_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_ws ON decisions(workspace_path);
      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(review_status);
      CREATE INDEX IF NOT EXISTS idx_decisions_group ON decisions(group_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_time ON decisions(asked_at DESC, answered_at DESC);

      CREATE TABLE IF NOT EXISTS decision_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        from_choice TEXT NOT NULL DEFAULT '',
        to_choice TEXT NOT NULL,
        to_option_index INTEGER,
        reason TEXT NOT NULL DEFAULT '',
        changed_in_conversation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_revisions_decision ON decision_revisions(decision_id, id ASC);

      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        decision_id UNINDEXED,
        question,
        options_text,
        answer_raw,
        current_choice,
        user_note,
        project_name,
        title_snapshot,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    this.db = db;
    return db;
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  /**
   * Reads native Antigravity projects & conversation summaries (strictly read-only, short timeout).
   */
  readLiveMetadata() {
    const projectsById = new Map();
    const projectsByWorkspace = new Map();

    try {
      if (fs.existsSync(this.projectsDir)) {
        for (const name of fs.readdirSync(this.projectsDir)) {
          if (!name.endsWith('.json')) continue;
          const filePath = path.join(this.projectsDir, name);
          const raw = safeJsonParse(fs.readFileSync(filePath, 'utf8'), null);
          if (!raw || typeof raw !== 'object') continue;
          const id = String(raw.id || name.slice(0, -5)).trim();
          if (!id || RESERVED_PROJECT_IDS.has(id)) continue;
          const resources = Array.isArray(raw.projectResources?.resources) ? raw.projectResources.resources : [];
          const folderUris = [];
          for (const r of resources) {
            const u = r?.folderUri || r?.gitFolder?.folderUri || '';
            if (typeof u === 'string' && u.trim()) folderUris.push(u.trim());
          }
          if (Array.isArray(raw.folderUris)) {
            for (const u of raw.folderUris) {
              if (typeof u === 'string' && u.trim() && !folderUris.includes(u.trim())) folderUris.push(u.trim());
            }
          }
          const workspacePath = folderUris.length > 0 ? decodeFileUriToPath(folderUris[0]) : '';
          const projName = String(raw.name || '').trim() || (workspacePath ? path.basename(workspacePath) : id);
          const entry = { id, name: projName, folderUris, workspacePath };
          projectsById.set(id, entry);
          if (workspacePath) projectsByWorkspace.set(workspacePath, entry);
        }
      }
    } catch {}

    const convsById = new Map();
    if (this.DatabaseSyncClass && fs.existsSync(this.summariesDbPath)) {
      let sdb = null;
      try {
        sdb = new this.DatabaseSyncClass(this.summariesDbPath, { readOnly: true, timeout: 150 });
        const rows = sdb
          .prepare(
            'SELECT conversation_id, title, project_id, workspace_uris, last_modified_time FROM conversation_summaries'
          )
          .all();
        for (const r of rows) {
          const cid = String(r.conversation_id || '').trim();
          if (!cid) continue;
          const rawPid = String(r.project_id || '').trim();
          const projectId = RESERVED_PROJECT_IDS.has(rawPid) ? '' : rawPid;
          const uris = safeJsonParse(String(r.workspace_uris || ''), []);
          let workspacePath = Array.isArray(uris) && uris.length > 0 ? decodeFileUriToPath(uris[0]) : '';
          let project = projectId ? projectsById.get(projectId) : null;
          if (!project && workspacePath) {
            project = projectsByWorkspace.get(workspacePath) || null;
          }
          if (!workspacePath && project?.workspacePath) {
            workspacePath = project.workspacePath;
          }
          const resolvedProjectId = project?.id || projectId || '';
          const resolvedProjectName =
            project?.name || (workspacePath ? path.basename(workspacePath) : '');
          convsById.set(cid, {
            conversationId: cid,
            title: String(r.title || '').trim(),
            projectId: resolvedProjectId,
            projectName: resolvedProjectName,
            workspacePath,
            lastModifiedTime: String(r.last_modified_time || '')
          });
        }
      } catch {
        /* Read-only best effort: tolerate transient SQLite lock */
      } finally {
        try {
          sdb?.close();
        } catch {}
      }
    }

    return { projectsById, convsById };
  }

  _syncFtsRow(db, row) {
    db.prepare('DELETE FROM decisions_fts WHERE decision_id = ?').run(row.id);
    db.prepare(
      `INSERT INTO decisions_fts (
        decision_id, question, options_text, answer_raw, current_choice, user_note, project_name, title_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.question || '',
      row.options_text || '',
      row.answer_raw || '',
      row.current_choice || '',
      row.user_note || '',
      row.project_name || '',
      row.title_snapshot || ''
    );
  }

  /**
   * Incrementally scans Antigravity brain transcripts and updates decisions.db + project Markdown files.
   */
  syncFromTranscripts({ force = false, onlyConversationIds = null, syncMarkdown = this.syncMarkdown } = {}) {
    const db = this.ensureOpen();
    const { convsById } = this.readLiveMetadata();

    let candidateIds = [];
    if (Array.isArray(onlyConversationIds) && onlyConversationIds.length > 0) {
      candidateIds = onlyConversationIds.filter((id) => UUID_RE.test(String(id || '')));
    } else if (fs.existsSync(this.brainDir)) {
      try {
        for (const entry of fs.readdirSync(this.brainDir)) {
          if (UUID_RE.test(entry)) candidateIds.push(entry);
        }
      } catch {}
    }

    const scanStateMap = new Map();
    for (const r of db.prepare('SELECT conversation_id, file_size, file_mtime_ms FROM transcript_scan_state').all()) {
      scanStateMap.set(r.conversation_id, r);
    }

    let scannedFiles = 0;
    let updatedFiles = 0;
    let upsertedDecisions = 0;
    const dirtyWorkspaces = new Set();
    const nowIso = new Date().toISOString();

    const selectExistingStmt = db.prepare(
      'SELECT id, review_status, current_choice, user_note, pinned, workspace_path, project_id, project_name, title_snapshot FROM decisions WHERE id = ?'
    );
    const countRevisionsStmt = db.prepare('SELECT COUNT(*) AS cnt FROM decision_revisions WHERE decision_id = ?');
    const upsertScanStateStmt = db.prepare(
      `INSERT INTO transcript_scan_state (conversation_id, transcript_path, file_size, file_mtime_ms, last_scanned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         transcript_path = excluded.transcript_path,
         file_size = excluded.file_size,
         file_mtime_ms = excluded.file_mtime_ms,
         last_scanned_at = excluded.last_scanned_at`
    );
    const insertDecisionStmt = db.prepare(
      `INSERT INTO decisions (
        id, group_id, conversation_id, call_step_index, answer_step_index,
        question_index, question_count, project_id, project_name, workspace_path,
        title_snapshot, question, is_multi_select, options_json, options_text,
        recommended_option, answer_raw, selected_options_json, answer_kind,
        asked_at, answered_at, review_status, current_choice, user_note, pinned, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateDecisionStmt = db.prepare(
      `UPDATE decisions SET
        answer_step_index = ?,
        question_count = ?,
        project_id = ?,
        project_name = ?,
        workspace_path = ?,
        title_snapshot = ?,
        question = ?,
        is_multi_select = ?,
        options_json = ?,
        options_text = ?,
        recommended_option = ?,
        answer_raw = ?,
        selected_options_json = ?,
        answer_kind = ?,
        asked_at = ?,
        answered_at = ?,
        review_status = ?,
        current_choice = ?,
        updated_at = ?
      WHERE id = ?`
    );

    for (const cid of candidateIds) {
      const tPath = path.join(this.brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
      const st = fs.statSync(tPath, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      scannedFiles += 1;

      const prevState = scanStateMap.get(cid);
      const mtimeMs = Math.floor(st.mtimeMs);
      if (!force && prevState && prevState.file_size === st.size && prevState.file_mtime_ms === mtimeMs) {
        continue;
      }

      updatedFiles += 1;
      const parsed = parseTranscriptDecisions(tPath, { conversationId: cid });
      const liveMeta = convsById.get(cid) || null;

      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const item of parsed) {
          const existing = selectExistingStmt.get(item.id);
          const optionsJson = JSON.stringify(item.options);
          const optionsText = item.options.map((o) => `${o.label} ${o.description}`.trim()).join('\n');
          const selectedJson = JSON.stringify(item.selectedOptions);

          const projectId = liveMeta?.projectId || existing?.project_id || '';
          const projectName = liveMeta?.projectName || existing?.project_name || '';
          const workspacePath = liveMeta?.workspacePath || existing?.workspace_path || '';
          const titleSnapshot = liveMeta?.title || existing?.title_snapshot || '';

          if (!existing) {
            const initialStatus =
              item.answerKind === 'pending'
                ? 'pending'
                : item.answerKind === 'skipped'
                  ? 'skipped'
                  : 'decided';
            insertDecisionStmt.run(
              item.id,
              item.groupId,
              item.conversationId,
              item.callStepIndex,
              item.answerStepIndex,
              item.questionIndex,
              item.questionCount,
              projectId,
              projectName,
              workspacePath,
              titleSnapshot,
              item.question,
              item.isMultiSelect ? 1 : 0,
              optionsJson,
              optionsText,
              item.recommendedOption,
              item.answerRaw,
              selectedJson,
              item.answerKind,
              item.askedAt,
              item.answeredAt,
              initialStatus,
              item.currentChoice,
              '',
              0,
              nowIso
            );
            this._syncFtsRow(db, {
              id: item.id,
              question: item.question,
              options_text: optionsText,
              answer_raw: item.answerRaw,
              current_choice: item.currentChoice,
              user_note: '',
              project_name: projectName,
              title_snapshot: titleSnapshot
            });
          } else {
            const revCount = Number(countRevisionsStmt.get(item.id)?.cnt || 0);
            let nextStatus = existing.review_status;
            if (existing.review_status === 'pending' && item.answerKind !== 'pending') {
              nextStatus = item.answerKind === 'skipped' ? 'skipped' : 'decided';
            }
            const hasRevisions = revCount > 0 || existing.review_status === 'changed';
            const nextChoice = hasRevisions ? existing.current_choice : item.currentChoice || existing.current_choice;

            updateDecisionStmt.run(
              item.answerStepIndex,
              item.questionCount,
              projectId,
              projectName,
              workspacePath,
              titleSnapshot,
              item.question,
              item.isMultiSelect ? 1 : 0,
              optionsJson,
              optionsText,
              item.recommendedOption,
              item.answerRaw,
              selectedJson,
              item.answerKind,
              item.askedAt,
              item.answeredAt,
              nextStatus,
              nextChoice,
              nowIso,
              item.id
            );
            this._syncFtsRow(db, {
              id: item.id,
              question: item.question,
              options_text: optionsText,
              answer_raw: item.answerRaw,
              current_choice: nextChoice,
              user_note: existing.user_note || '',
              project_name: projectName,
              title_snapshot: titleSnapshot
            });
            if (existing.workspace_path && existing.workspace_path !== workspacePath) {
              dirtyWorkspaces.add(existing.workspace_path);
            }
          }

          if (workspacePath) dirtyWorkspaces.add(workspacePath);
          upsertedDecisions += 1;
        }

        upsertScanStateStmt.run(cid, tPath, st.size, mtimeMs, nowIso);
        db.exec('COMMIT;');
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {}
        throw err;
      }
    }

    /* Reconcile moved or renamed conversations across already-indexed decisions */
    const indexedConvs = db
      .prepare('SELECT DISTINCT conversation_id, project_id, project_name, workspace_path, title_snapshot FROM decisions')
      .all();
    const updateConvMetaStmt = db.prepare(
      'UPDATE decisions SET project_id = ?, project_name = ?, workspace_path = ?, title_snapshot = ? WHERE conversation_id = ?'
    );
    const touchedMetaCids = [];
    for (const row of indexedConvs) {
      const live = convsById.get(row.conversation_id);
      if (!live) continue;
      const nextPid = live.projectId || row.project_id;
      const nextPname = live.projectName || row.project_name;
      const nextWs = live.workspacePath || row.workspace_path;
      const nextTitle = live.title || row.title_snapshot;
      if (
        nextPid !== row.project_id ||
        nextPname !== row.project_name ||
        nextWs !== row.workspace_path ||
        nextTitle !== row.title_snapshot
      ) {
        updateConvMetaStmt.run(nextPid, nextPname, nextWs, nextTitle, row.conversation_id);
        touchedMetaCids.push(row.conversation_id);
        if (row.workspace_path) dirtyWorkspaces.add(row.workspace_path);
        if (nextWs) dirtyWorkspaces.add(nextWs);
      }
    }
    if (touchedMetaCids.length > 0) {
      for (const cid of touchedMetaCids) {
        const rows = db.prepare('SELECT * FROM decisions WHERE conversation_id = ?').all(cid);
        for (const r of rows) this._syncFtsRow(db, r);
      }
    }

    /* Ensure every indexed workspace has its decisions.md created on initial sync */
    const syncedMarkdownPaths = [];
    if (syncMarkdown) {
      const allWsRows = db
        .prepare("SELECT DISTINCT workspace_path FROM decisions WHERE workspace_path != ''")
        .all();
      for (const r of allWsRows) {
        const ws = r.workspace_path;
        if (!dirtyWorkspaces.has(ws)) {
          const mdPath = path.join(ws, '.anti-claude', 'decisions.md');
          if (!fs.existsSync(mdPath)) dirtyWorkspaces.add(ws);
        }
      }
      for (const ws of dirtyWorkspaces) {
        const synced = this.syncProjectMarkdown(ws, convsById);
        if (synced?.written && synced.filePath) {
          syncedMarkdownPaths.push(synced.filePath);
        }
      }
    }

    return {
      ok: true,
      scannedFiles,
      updatedFiles,
      upsertedDecisions,
      syncedMarkdownPaths
    };
  }

  _hydrateRow(row, liveMetaMap, revisionsByDecisionId = null) {
    const live = liveMetaMap?.get(row.conversation_id) || null;
    const options = safeJsonParse(row.options_json, []);
    const selectedOptions = safeJsonParse(row.selected_options_json, []);
    const currentTitle = live?.title || row.title_snapshot || '';
    const projectId = live?.projectId || row.project_id || '';
    const projectName = live?.projectName || row.project_name || '';
    const workspacePath = live?.workspacePath || row.workspace_path || '';
    const revisions = revisionsByDecisionId ? revisionsByDecisionId.get(row.id) || [] : [];

    return {
      id: row.id,
      groupId: row.group_id,
      conversationId: row.conversation_id,
      callStepIndex: row.call_step_index,
      answerStepIndex: row.answer_step_index,
      questionIndex: row.question_index,
      questionCount: row.question_count,
      projectId,
      projectName,
      workspacePath,
      titleSnapshot: row.title_snapshot || '',
      currentTitle,
      titleChanged: Boolean(live?.title && row.title_snapshot && live.title !== row.title_snapshot),
      question: row.question,
      isMultiSelect: Boolean(row.is_multi_select),
      options,
      recommendedOption: row.recommended_option || '',
      answerRaw: row.answer_raw || '',
      selectedOptions,
      answerKind: row.answer_kind || 'pending',
      askedAt: row.asked_at || '',
      answeredAt: row.answered_at || '',
      reviewStatus: row.review_status || 'decided',
      currentChoice: row.current_choice || '',
      userNote: row.user_note || '',
      pinned: Boolean(row.pinned),
      updatedAt: row.updated_at || '',
      revisions
    };
  }

  _loadRevisionsMap(decisionIds) {
    const map = new Map();
    if (!Array.isArray(decisionIds) || decisionIds.length === 0) return map;
    const db = this.ensureOpen();
    const placeholders = decisionIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, decision_id, from_choice, to_choice, to_option_index, reason, changed_in_conversation_id, created_at
         FROM decision_revisions
         WHERE decision_id IN (${placeholders})
         ORDER BY id ASC`
      )
      .all(...decisionIds);
    for (const r of rows) {
      let arr = map.get(r.decision_id);
      if (!arr) {
        arr = [];
        map.set(r.decision_id, arr);
      }
      arr.push({
        id: r.id,
        decisionId: r.decision_id,
        fromChoice: r.from_choice,
        toChoice: r.to_choice,
        toOptionIndex: r.to_option_index,
        reason: r.reason,
        changedInConversationId: r.changed_in_conversation_id,
        createdAt: r.created_at
      });
    }
    return map;
  }

  listDecisions({
    projectId = '',
    projectName = '',
    workspacePath = '',
    conversationId = '',
    status = '',
    search = '',
    limit = 100,
    offset = 0,
    includeRevisions = true
  } = {}) {
    const db = this.ensureOpen();
    const { convsById } = this.readLiveMetadata();

    const allRows = db
      .prepare('SELECT * FROM decisions ORDER BY pinned DESC, COALESCE(NULLIF(answered_at, \'\'), asked_at) DESC, call_step_index DESC, question_index ASC')
      .all();

    /* Compute global stats and project facets using live metadata */
    const stats = { total: 0, decided: 0, uncertain: 0, changed: 0, skipped: 0, pending: 0 };
    const projectMap = new Map();
    const hydratedAll = [];

    for (const row of allRows) {
      const h = this._hydrateRow(row, convsById, null);
      hydratedAll.push(h);
      stats.total += 1;
      if (Object.prototype.hasOwnProperty.call(stats, h.reviewStatus)) stats[h.reviewStatus] += 1;

      const pKey = h.projectId || (h.workspacePath ? `ws:${h.workspacePath}` : '__unassigned__');
      let pf = projectMap.get(pKey);
      if (!pf) {
        pf = {
          key: pKey,
          projectId: h.projectId || '',
          projectName: h.projectName || '',
          workspacePath: h.workspacePath || '',
          count: 0,
          uncertainCount: 0,
          changedCount: 0
        };
        projectMap.set(pKey, pf);
      }
      pf.count += 1;
      if (h.reviewStatus === 'uncertain') pf.uncertainCount += 1;
      if (h.reviewStatus === 'changed') pf.changedCount += 1;
    }

    const q = String(search || '').trim().toLowerCase();
    const filterPid = String(projectId || '').trim();
    const filterPname = String(projectName || '').trim().toLowerCase();
    const filterWs = String(workspacePath || '').trim() ? path.resolve(String(workspacePath).trim()) : '';
    const filterCid = String(conversationId || '').trim();
    const filterStatus = String(status || '').trim();

    let ftsMatches = null;
    if (q) {
      ftsMatches = new Set();
      try {
        /* Try FTS5 query safely (escape quotes) */
        const tokens = q
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `"${t.replace(/"/g, '""')}"*`);
        if (tokens.length > 0) {
          const ftsRows = db
            .prepare('SELECT decision_id FROM decisions_fts WHERE decisions_fts MATCH ?')
            .all(tokens.join(' AND '));
          for (const fr of ftsRows) ftsMatches.add(fr.decision_id);
        }
      } catch {}
    }

    const filtered = hydratedAll.filter((d) => {
      if (filterCid && d.conversationId !== filterCid) return false;
      if (filterStatus && filterStatus !== 'all' && d.reviewStatus !== filterStatus) return false;
      if (filterPid) {
        if (filterPid === '__unassigned__') {
          if (d.projectId || d.workspacePath) return false;
        } else if (filterPid.startsWith('ws:')) {
          if (d.workspacePath !== filterPid.slice(3)) return false;
        } else if (d.projectId !== filterPid) {
          return false;
        }
      }
      if (filterPname && !d.projectName.toLowerCase().includes(filterPname)) return false;
      if (filterWs) {
        const dws = d.workspacePath ? path.resolve(d.workspacePath) : '';
        if (dws !== filterWs) return false;
      }
      if (q) {
        if (ftsMatches && ftsMatches.has(d.id)) return true;
        /* Substring fallback guarantees CJK short-word matching (e.g. "权限", "隔离") */
        const haystack = [
          d.question,
          d.options.map((o) => `${o.label} ${o.description}`).join(' '),
          d.answerRaw,
          d.currentChoice,
          d.userNote,
          d.projectName,
          d.currentTitle,
          d.titleSnapshot,
          d.conversationId
        ]
          .join('\n')
          .toLowerCase();
        return q.split(/\s+/).filter(Boolean).every((tok) => haystack.includes(tok));
      }
      return true;
    });

    const total = filtered.length;
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const pageItems = filtered.slice(safeOffset, safeOffset + safeLimit);

    if (includeRevisions && pageItems.length > 0) {
      const revMap = this._loadRevisionsMap(pageItems.map((i) => i.id));
      for (const item of pageItems) {
        item.revisions = revMap.get(item.id) || [];
      }
    }

    const projects = Array.from(projectMap.values()).sort((a, b) => {
      if (a.key === '__unassigned__') return 1;
      if (b.key === '__unassigned__') return -1;
      return b.count - a.count || a.projectName.localeCompare(b.projectName);
    });

    return {
      ok: true,
      total,
      stats,
      projects,
      items: pageItems
    };
  }

  getDecisionDetail({ decisionId = '', conversationId = '' } = {}) {
    const db = this.ensureOpen();
    const { convsById } = this.readLiveMetadata();

    if (decisionId) {
      const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(String(decisionId).trim());
      if (!row) return { ok: false, error: 'decision_not_found' };
      const revMap = this._loadRevisionsMap([row.id]);
      const decision = this._hydrateRow(row, convsById, revMap);
      const siblingRows = db
        .prepare('SELECT * FROM decisions WHERE group_id = ? ORDER BY question_index ASC')
        .all(row.group_id);
      const sibRevMap = this._loadRevisionsMap(siblingRows.map((s) => s.id));
      const siblings = siblingRows.map((s) => this._hydrateRow(s, convsById, sibRevMap));
      return {
        ok: true,
        decision,
        revisions: decision.revisions,
        siblings,
        revisitPrompt: formatDecisionRevisitPrompt(decision, decision.revisions, siblings)
      };
    }

    if (conversationId) {
      const cid = String(conversationId).trim();
      const rows = db
        .prepare('SELECT * FROM decisions WHERE conversation_id = ? ORDER BY call_step_index ASC, question_index ASC')
        .all(cid);
      const revMap = this._loadRevisionsMap(rows.map((r) => r.id));
      const decisions = rows.map((r) => this._hydrateRow(r, convsById, revMap));
      const live = convsById.get(cid);
      return {
        ok: true,
        conversationId: cid,
        currentTitle: live?.title || decisions[0]?.titleSnapshot || '',
        projectId: live?.projectId || decisions[0]?.projectId || '',
        projectName: live?.projectName || decisions[0]?.projectName || '',
        workspacePath: live?.workspacePath || decisions[0]?.workspacePath || '',
        decisions
      };
    }

    return { ok: false, error: 'missing_decision_or_conversation_id' };
  }

  updateDecisionMeta({ id, reviewStatus, userNote, pinned } = {}) {
    const db = this.ensureOpen();
    const did = String(id || '').trim();
    if (!did) return { ok: false, error: 'missing_decision_id' };
    const existing = db.prepare('SELECT * FROM decisions WHERE id = ?').get(did);
    if (!existing) return { ok: false, error: 'decision_not_found' };

    const nextStatus =
      reviewStatus !== undefined
        ? DECISION_STATUSES.includes(String(reviewStatus))
          ? String(reviewStatus)
          : null
        : existing.review_status;
    if (!nextStatus) return { ok: false, error: 'invalid_review_status' };

    const nextNote = userNote !== undefined ? String(userNote ?? '').slice(0, 4000) : existing.user_note;
    const nextPinned = pinned !== undefined ? (pinned ? 1 : 0) : existing.pinned;
    const nowIso = new Date().toISOString();

    db.prepare('UPDATE decisions SET review_status = ?, user_note = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
      nextStatus,
      nextNote,
      nextPinned,
      nowIso,
      did
    );

    const updated = db.prepare('SELECT * FROM decisions WHERE id = ?').get(did);
    this._syncFtsRow(db, updated);

    const { convsById } = this.readLiveMetadata();
    const hydrated = this._hydrateRow(updated, convsById, this._loadRevisionsMap([did]));
    let markdownPath = '';
    if (this.syncMarkdown && hydrated.workspacePath) {
      const mdRes = this.syncProjectMarkdown(hydrated.workspacePath, convsById);
      if (mdRes?.filePath) markdownPath = mdRes.filePath;
    }

    return { ok: true, decision: hydrated, markdownPath };
  }

  addDecisionRevision({ id, toChoice, toOptionIndex = null, reason = '', changedInConversationId = '' } = {}) {
    const db = this.ensureOpen();
    const did = String(id || '').trim();
    if (!did) return { ok: false, error: 'missing_decision_id' };
    const existing = db.prepare('SELECT * FROM decisions WHERE id = ?').get(did);
    if (!existing) return { ok: false, error: 'decision_not_found' };

    const options = safeJsonParse(existing.options_json, []);
    let resolvedChoice = String(toChoice || '').trim();
    let resolvedOptIdx =
      toOptionIndex !== null && toOptionIndex !== undefined && Number.isInteger(Number(toOptionIndex))
        ? Number(toOptionIndex)
        : null;

    if (!resolvedChoice && resolvedOptIdx !== null && options[resolvedOptIdx]) {
      resolvedChoice = options[resolvedOptIdx].label;
    }
    if (!resolvedChoice) return { ok: false, error: 'missing_new_choice' };

    if (resolvedOptIdx === null) {
      const matchedOpt = options.find((o) => o.label === resolvedChoice || o.cleanLabel === resolvedChoice);
      if (matchedOpt) resolvedOptIdx = matchedOpt.index;
    }

    const fromChoice = existing.current_choice || existing.answer_raw || '';
    const cleanReason = String(reason || '').trim().slice(0, 2000);
    const cleanConvId = UUID_RE.test(String(changedInConversationId || '').trim())
      ? String(changedInConversationId).trim()
      : '';
    const nowIso = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `INSERT INTO decision_revisions (
          decision_id, from_choice, to_choice, to_option_index, reason, changed_in_conversation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(did, fromChoice, resolvedChoice, resolvedOptIdx, cleanReason, cleanConvId, nowIso);

      db.prepare('UPDATE decisions SET current_choice = ?, review_status = ?, updated_at = ? WHERE id = ?').run(
        resolvedChoice,
        'changed',
        nowIso,
        did
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }

    const updated = db.prepare('SELECT * FROM decisions WHERE id = ?').get(did);
    this._syncFtsRow(db, updated);

    const { convsById } = this.readLiveMetadata();
    const hydrated = this._hydrateRow(updated, convsById, this._loadRevisionsMap([did]));
    let markdownPath = '';
    if (this.syncMarkdown && hydrated.workspacePath) {
      const mdRes = this.syncProjectMarkdown(hydrated.workspacePath, convsById);
      if (mdRes?.filePath) markdownPath = mdRes.filePath;
    }

    return { ok: true, decision: hydrated, revisions: hydrated.revisions, markdownPath };
  }

  getProjectSummary({ projectId = '', projectName = '', workspacePath = '' } = {}) {
    const res = this.listDecisions({
      projectId,
      projectName,
      workspacePath,
      limit: 500,
      includeRevisions: true
    });
    const counts = { total: res.items.length, decided: 0, uncertain: 0, changed: 0, skipped: 0, pending: 0 };
    const uncertain = [];
    const changed = [];
    const recent = [];

    for (const d of res.items) {
      if (Object.prototype.hasOwnProperty.call(counts, d.reviewStatus)) counts[d.reviewStatus] += 1;
      const brief = {
        id: d.id,
        conversationId: d.conversationId,
        currentTitle: d.currentTitle,
        question: d.question,
        currentChoice: d.currentChoice || d.answerRaw,
        reviewStatus: d.reviewStatus,
        userNote: d.userNote,
        answeredAt: d.answeredAt || d.askedAt,
        revisionCount: d.revisions.length
      };
      if (d.reviewStatus === 'uncertain') uncertain.push(brief);
      if (d.reviewStatus === 'changed') changed.push(brief);
      if (recent.length < 15) recent.push(brief);
    }

    const targetWs = workspacePath || res.items[0]?.workspacePath || '';
    const markdownPath =
      targetWs && isSafeProjectWorkspace(targetWs, { homeDir: this.homeDir, antigravityDir: this.antigravityDir })
        ? path.join(path.resolve(targetWs), '.anti-claude', 'decisions.md')
        : '';

    return {
      ok: true,
      projectName: projectName || res.items[0]?.projectName || '',
      workspacePath: targetWs,
      markdownPath: markdownPath && fs.existsSync(markdownPath) ? markdownPath : '',
      counts,
      uncertain,
      changed,
      recent
    };
  }

  syncProjectMarkdown(workspacePath, preloadedConvsById = null) {
    if (!isSafeProjectWorkspace(workspacePath, { homeDir: this.homeDir, antigravityDir: this.antigravityDir })) {
      return { ok: false, skipped: true, reason: 'unsafe_or_missing_workspace' };
    }
    const db = this.ensureOpen();
    const absWs = path.resolve(workspacePath);
    const convsById = preloadedConvsById || this.readLiveMetadata().convsById;

    const allRows = db
      .prepare('SELECT * FROM decisions ORDER BY COALESCE(NULLIF(answered_at, \'\'), asked_at) DESC, call_step_index DESC, question_index ASC')
      .all();
    const matching = [];
    for (const row of allRows) {
      const h = this._hydrateRow(row, convsById, null);
      if (h.workspacePath && path.resolve(h.workspacePath) === absWs) {
        matching.push(h);
      }
    }

    const mdPath = path.join(absWs, '.anti-claude', 'decisions.md');
    if (matching.length === 0) {
      return { ok: true, written: false, filePath: mdPath, count: 0 };
    }

    const revMap = this._loadRevisionsMap(matching.map((m) => m.id));
    for (const m of matching) m.revisions = revMap.get(m.id) || [];

    const projectName = matching[0]?.projectName || path.basename(absWs);
    const mdText = renderProjectDecisionsMarkdown({ projectName, workspacePath: absWs, decisions: matching });

    try {
      const prevText = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
      if (prevText === mdText) {
        return { ok: true, written: false, unchanged: true, filePath: mdPath, count: matching.length };
      }
      writeAtomicUtf8(mdPath, mdText);
      return { ok: true, written: true, filePath: mdPath, count: matching.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), filePath: mdPath };
    }
  }
}
