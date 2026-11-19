#!/usr/bin/env node
/**
 * Anti-Claude — Antigravity CLI (agy) Status Line
 * Zero-dependency Claude-inspired status bar for `agy` TUI (Node.js >= 22).
 *
 * Reads the live JSON telemetry payload from stdin and prints a single concise line:
 *   Model · ▓▓▓░░░░░ 38% · main* · ● Working
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  muted: '\x1b[38;5;245m',
  accent: '\x1b[38;5;173m', // warm Claude terracotta
  blue: '\x1b[38;5;68m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m'
};

export function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function codePointDisplayWidth(cp) {
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  /* Zero-width / combining / variation selector code points */
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  /* East Asian Wide / Fullwidth & Astral Emoji / CJK Ideographs */
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
      (cp >= 0x3250 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4c6) ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function stringDisplayWidth(str) {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) {
    width += codePointDisplayWidth(ch.codePointAt(0));
  }
  return width;
}

export function truncateToDisplayWidth(str, maxCols) {
  const plain = stripAnsi(str);
  if (maxCols <= 0) return '';
  if (stringDisplayWidth(plain) <= maxCols) return plain;
  if (maxCols === 1) return '…';
  const targetCols = maxCols - 1;
  let used = 0;
  let out = '';
  for (const ch of plain) {
    const w = codePointDisplayWidth(ch.codePointAt(0));
    if (used + w > targetCols) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function paint(text, code, noColor) {
  if (!text) return '';
  if (noColor || !code) return text;
  return `${code}${text}${ANSI.reset}`;
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function resolveModelName(payload) {
  if (!payload) return '';
  if (typeof payload.model === 'string') return payload.model.trim();
  if (payload.model && typeof payload.model === 'object') {
    return String(payload.model.display_name || payload.model.name || payload.model.id || '').trim();
  }
  return '';
}

function resolveContextPct(payload) {
  const cw = payload?.context_window;
  if (!cw || typeof cw !== 'object') return null;
  if (cw.used_percentage !== undefined && cw.used_percentage !== null) {
    return clampPct(cw.used_percentage);
  }
  const used = Number(cw.used_tokens ?? cw.current_usage?.input_tokens);
  const total = Number(cw.context_window_size ?? cw.max_tokens);
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
    return clampPct((used / total) * 100);
  }
  return null;
}

function resolveStateLabel(rawState) {
  const s = String(rawState || '').trim().toLowerCase();
  if (!s || s === 'idle' || s === 'ready') return null;
  if (s === 'thinking' || s === 'reasoning') return { label: 'Thinking', color: ANSI.blue };
  if (s === 'tool_use' || s === 'tool' || s === 'running_tool') return { label: 'Tool', color: ANSI.blue };
  if (s === 'working' || s === 'running' || s === 'streaming') return { label: 'Working', color: ANSI.accent };
  if (s === 'waiting' || s === 'needs_approval' || s === 'pending') return { label: 'Waiting', color: ANSI.amber };
  if (s === 'error' || s === 'failed') return { label: 'Error', color: ANSI.red };
  return { label: s.charAt(0).toUpperCase() + s.slice(1), color: ANSI.muted };
}

function resolveWorkspaceName(payload) {
  const dir = payload?.workspace?.current_dir || payload?.workspace_dir || payload?.cwd;
  if (typeof dir === 'string' && dir.trim()) {
    return path.basename(dir.trim());
  }
  if (typeof payload?.project_name === 'string' && payload.project_name.trim()) {
    return payload.project_name.trim();
  }
  return '';
}

function renderBar(pct, width = 8) {
  const filled = Math.round((pct / 100) * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

export function formatStatusLine(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const noColor = Boolean(options.noColor ?? (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''));
  const maxCols = Number(options.terminalWidth ?? payload.terminal_width ?? process.stdout.columns ?? 100) || 100;
  const sep = paint(' · ', ANSI.dim, noColor);

  const model = resolveModelName(payload);
  const pct = resolveContextPct(payload);
  const state = resolveStateLabel(payload.agent_state);
  const branch = typeof payload?.vcs?.branch === 'string' ? payload.vcs.branch.trim() : '';
  const dirty = Boolean(payload?.vcs?.dirty);
  const workspace = resolveWorkspaceName(payload);

  const pctColor = pct === null ? ANSI.muted : pct >= 85 ? ANSI.red : pct >= 60 ? ANSI.amber : ANSI.muted;

  const buildSegments = ({ includeWorkspace, includeVcs, includeBar, includeState }) => {
    const parts = [];
    if (model) parts.push(paint(model, ANSI.bold, noColor));
    if (pct !== null) {
      const ctxText = includeBar ? `${renderBar(pct, 8)} ${pct}%` : `Ctx ${pct}%`;
      parts.push(paint(ctxText, pctColor, noColor));
    }
    if (includeVcs && branch) {
      const branchText = `${branch}${dirty ? '*' : ''}`;
      parts.push(paint(branchText, dirty ? ANSI.amber : ANSI.muted, noColor));
    }
    if (includeWorkspace && workspace) {
      parts.push(paint(workspace, ANSI.muted, noColor));
    }
    if (includeState && state) {
      parts.push(paint(`● ${state.label}`, state.color, noColor));
    }
    return parts.join(sep);
  };

  const budget = Math.max(4, maxCols - 2);
  const levels = [
    { includeWorkspace: true, includeVcs: true, includeBar: true, includeState: true },
    { includeWorkspace: false, includeVcs: true, includeBar: true, includeState: true },
    { includeWorkspace: false, includeVcs: true, includeBar: false, includeState: true },
    { includeWorkspace: false, includeVcs: false, includeBar: false, includeState: true },
    { includeWorkspace: false, includeVcs: false, includeBar: false, includeState: false }
  ];

  for (const cfg of levels) {
    const line = buildSegments(cfg);
    if (!line) return '';
    if (stringDisplayWidth(line) <= budget) return line;
  }

  const fallback = buildSegments(levels[levels.length - 1]);
  if (stringDisplayWidth(fallback) <= budget) return fallback;
  const truncatedPlain = truncateToDisplayWidth(fallback, budget);
  return model ? paint(truncatedPlain, ANSI.bold, noColor) : truncatedPlain;
}

async function readStdinText() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const raw = (await readStdinText()).trim();
    if (raw) {
      const payload = JSON.parse(raw);
      const out = formatStatusLine(payload);
      if (out) process.stdout.write(`${out}\n`);
    }
  } catch {
    // Never break the agy TUI on malformed telemetry
  }
}
