/**
 * Anti-Claude — core/decisions-client.js
 * Independent renderer module for the built-in Decision Log & Evolution workspace.
 *
 * Features:
 * - Mounts a Claude-style "决策记录 / Decisions" nav button in the left sidebar (with uncertain-count badge).
 * - Renders a full-pane workspace overlay (`#ag-decisions-view`) aligned beside the sidebar,
 *   automatically closing when switching to chats, Home, Automations, or Projects.
 * - Displays every `ask_question` decision with ALL original alternatives, live conversation title,
 *   conversation ID, review status (`decided` / `uncertain` / `changed` / `skipped` / `pending`),
 *   inline notes, revision timeline (`from → to` + reason), SPA jump to source conversation,
 *   and one-click "Copy / Insert Revisit Prompt" for AI follow-up.
 */
(function () {
  if (typeof window.__agDecisions?.dispose === 'function') {
    try {
      window.__agDecisions.dispose();
    } catch {}
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const SVG_DECISIONS_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>';
  const SVG_REFRESH_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
  const SVG_FOLDER_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
  const SVG_SEARCH_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  const SVG_COPY_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const SVG_JUMP_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const SVG_SWAP_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
  const SVG_SPARK_ICON =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>';
  const SVG_CLOSE_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  const STATUS_META = {
    decided: { zh: '已定', en: 'Decided', dot: 'decided' },
    uncertain: { zh: '拿捏不定', en: 'Uncertain', dot: 'uncertain' },
    changed: { zh: '已变更', en: 'Changed', dot: 'changed' },
    skipped: { zh: '已跳过', en: 'Skipped', dot: 'skipped' },
    pending: { zh: '待作答', en: 'Pending', dot: 'pending' }
  };

  let enabled = (typeof ctx !== 'undefined' && ctx?.modules?.decisionsLog) !== false;
  let disposed = false;
  let viewOpen = false;
  let viewEl = null;
  let modalEl = null;
  let sidebarRo = null;
  let observedSidebar = null;
  let domObs = null;
  let mountRaf = 0;
  let toastTimer = 0;
  let searchTimer = 0;
  let badgePollTimer = 0;
  let lastRouteKey = '';

  const state = {
    loading: false,
    syncing: false,
    error: '',
    projectId: '',
    projectLabel: '',
    conversationId: '',
    conversationLabel: '',
    status: 'all',
    search: '',
    stats: { total: 0, decided: 0, uncertain: 0, changed: 0, skipped: 0, pending: 0 },
    projects: [],
    items: [],
    total: 0,
    editingNoteId: '',
    revisingDecision: null
  };
  let lastConvRowTrigger = { id: '', title: '', ts: 0 };

  const L = (zh, en) => (document.documentElement?.getAttribute('data-ag-ux-lang') === 'zh' ? zh : en);

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function callDaemon(action, payload = {}, timeoutMs = 15000) {
    if (typeof window.__agProjectCall !== 'function') {
      return Promise.resolve({ ok: false, error: 'rpc_unavailable' });
    }
    return window.__agProjectCall(action, payload, timeoutMs);
  }

  function getActiveConversationId() {
    try {
      const m = String(window.location.pathname || '').match(/\/c\/([0-9a-f-]{36})/i);
      if (m) return m[1];
      const q = new URLSearchParams(window.location.search).get('cascadeId');
      if (q && UUID_RE.test(q)) return q;
      const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
      const cid = sel?.getAttribute('data-cascade-id') || '';
      if (UUID_RE.test(cid)) return cid;
    } catch {}
    return '';
  }

  function showToast(text, isError = false) {
    try {
      let el = document.getElementById('ag-dec-toast');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = 'ag-dec-toast';
        el.setAttribute('data-ag-i18n-ignore', '1');
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      if (!el) return;
      el.textContent = text;
      el.setAttribute('data-kind', isError ? 'error' : 'ok');
      el.setAttribute('data-visible', 'true');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = 0;
        el.setAttribute('data-visible', 'false');
      }, 2400);
    } catch {}
  }

  async function copyToClipboard(text) {
    const str = String(text || '');
    if (!str) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  function insertTextIntoActiveComposer(text) {
    const str = String(text || '');
    if (!str) return false;
    const box = document.getElementById('antigravity.agentSidePanelInputBox');
    const editor = box?.querySelector?.('[contenteditable="true"], [data-lexical-editor="true"], textarea');
    if (!editor) return false;
    try {
      editor.focus();
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const cur = editor.value || '';
        editor.value = cur ? `${cur}\n\n${str}` : str;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      const sel = window.getSelection?.();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const inserted = document.execCommand('insertText', false, str);
      if (inserted) return true;
    } catch {}
    return false;
  }

  function navigateToConversation(cascadeId) {
    const id = String(cascadeId || '').trim();
    if (!UUID_RE.test(id)) return false;
    closeView();

    /* 1. Try native React router / stepHandler from fiber tree */
    try {
      const anchors = [
        document.querySelector('[data-testid="conversation-list-sidebar"]'),
        document.querySelector('.bg-sidebar'),
        document.querySelector('main'),
        document.getElementById('root')?.firstElementChild
      ];
      let router = null;
      let stepHandler = null;
      const scan = (val) => {
        if (!val || typeof val !== 'object') return;
        if (!router && val.router && typeof val.router.navigate === 'function') router = val.router;
        if (!router && typeof val.navigate === 'function' && val.state && val.routesById) router = val;
        if (!stepHandler && val.stepHandler && typeof val.stepHandler.openConversation === 'function') {
          stepHandler = val.stepHandler;
        }
        if (!stepHandler && typeof val.openConversation === 'function') stepHandler = val;
      };
      for (const anchor of anchors) {
        if (!anchor) continue;
        const key = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
        let fiber = key ? anchor[key] : null;
        for (let d = 0; fiber && d < 65; d++, fiber = fiber.return) {
          scan(fiber.memoizedProps);
          scan(fiber.memoizedProps?.value);
          for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) scan(dep.memoizedValue);
          if (router || stepHandler) break;
        }
        if (router || stepHandler) break;
      }
      if (router) {
        router.navigate({ to: '/c/$cascadeId', params: { cascadeId: id } });
        return true;
      }
      if (stepHandler) {
        stepHandler.openConversation(id);
        return true;
      }
    } catch {}

    /* 2. Sidebar link click fallback */
    const link = document.querySelector(`[data-testid="conversation-row-sidebar"] a[href*="/c/${id}"]`);
    if (link) {
      link.click();
      return true;
    }

    /* 3. History pushState fallback */
    try {
      if (typeof history?.pushState === 'function') {
        history.pushState(null, '', `/c/${id}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
        return true;
      }
    } catch {}
    return false;
  }

  function formatDateShort(iso) {
    const s = String(iso || '').trim();
    if (!s) return '';
    try {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      const datePart = sameYear
        ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return s.slice(0, 16).replace('T', ' ');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Sidebar Entry & Overlay Positioning                                      */
  /* ------------------------------------------------------------------------ */

  function updateNavBadge() {
    const badge = document.querySelector('#ag-decisions-nav-btn .ag-dec-nav-badge');
    if (!badge) return;
    const count = Number(state.stats?.uncertain || 0);
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-flex';
      badge.title = L(`${count} 条拿捏不定的决策`, `${count} uncertain decisions`);
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  }

  function updateNavActiveVisual() {
    const btn = document.getElementById('ag-decisions-nav-btn');
    if (!btn) return;
    btn.setAttribute('data-ag-active', viewOpen ? 'true' : 'false');
    btn.setAttribute('aria-pressed', viewOpen ? 'true' : 'false');
  }

  function mountNavButton() {
    if (disposed || !enabled) return;
    const projBtn = document.getElementById('ag-claude-projects-nav-btn');
    const autoBtn = document.querySelector('[data-testid="automations-button"]');
    const anchor = projBtn || autoBtn;
    if (!anchor || !anchor.parentElement) return;

    let btn = document.getElementById('ag-decisions-nav-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ag-decisions-nav-btn';
      btn.setAttribute('data-testid', 'anti-claude-decisions-nav-button');
      btn.setAttribute('data-ag-i18n-ignore', '1');
      btn.className = (autoBtn || anchor).className;
      btn.innerHTML =
        `<span class="shrink-0 flex items-center">${SVG_DECISIONS_ICON}</span>` +
        `<span class="truncate ag-dec-nav-label">${escapeHtml(L('决策记录', 'Decisions'))}</span>` +
        `<span class="ag-dec-nav-badge" style="display:none"></span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleView();
      });
    } else {
      const lbl = btn.querySelector('.ag-dec-nav-label');
      const expected = L('决策记录', 'Decisions');
      if (lbl && lbl.textContent !== expected) lbl.textContent = expected;
    }

    if (btn.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement('afterend', btn);
    }
    updateNavActiveVisual();
    updateNavBadge();
  }

  function positionOverlay() {
    if (!viewEl || !viewOpen) return;
    const sb = document.querySelector('.bg-sidebar');
    let left = 0;
    if (sb) {
      const r = sb.getBoundingClientRect();
      if (r.width > 40 && r.right > 0 && r.right < window.innerWidth - 160) {
        left = Math.round(r.right);
      }
    }
    viewEl.style.left = `${left}px`;
  }

  function ensureSidebarObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    const sb = document.querySelector('.bg-sidebar');
    if (!sb || sb === observedSidebar) return;
    if (sidebarRo) {
      try { sidebarRo.disconnect(); } catch {}
    }
    observedSidebar = sb;
    sidebarRo = new ResizeObserver(() => positionOverlay());
    try { sidebarRo.observe(sb); } catch {}
  }

  function ensureViewEl() {
    if (viewEl && viewEl.isConnected) return viewEl;
    const el = document.createElement('section');
    el.id = 'ag-decisions-view';
    el.setAttribute('data-ag-i18n-ignore', '1');
    el.setAttribute('data-open', 'false');
    el.setAttribute('aria-label', L('对话决策记录', 'Decision Log'));
    el.hidden = true;
    document.body.appendChild(el);
    viewEl = el;
    bindViewEvents(el);
    return el;
  }

  /* ------------------------------------------------------------------------ */
  /* Data Fetching & Mutations                                                */
  /* ------------------------------------------------------------------------ */

  async function refreshBadgeStats() {
    if (disposed || !enabled) return;
    const res = await callDaemon('decisionsList', { limit: 1, includeRevisions: false, syncFirst: false }, 8000);
    if (res?.ok && res.stats) {
      state.stats = res.stats;
      updateNavBadge();
    }
  }

  async function loadDecisions({ syncFirst = true } = {}) {
    if (disposed || !enabled) return;
    state.loading = true;
    state.error = '';
    renderView();
    const res = await callDaemon(
      'decisionsList',
      {
        projectId: state.projectId,
        conversationId: state.conversationId,
        status: state.status === 'all' ? '' : state.status,
        search: state.search,
        limit: 200,
        offset: 0,
        includeRevisions: true,
        syncFirst
      },
      15000
    );
    state.loading = false;
    if (!res || !res.ok) {
      state.error = res?.error || 'load_failed';
      renderView();
      return;
    }
    state.stats = res.stats || state.stats;
    state.projects = Array.isArray(res.projects) ? res.projects : [];
    state.items = Array.isArray(res.items) ? res.items : [];
    state.total = Number(res.total || state.items.length);
    updateNavBadge();
    renderView();
  }

  async function triggerSyncNow() {
    if (state.syncing) return;
    state.syncing = true;
    renderView();
    const res = await callDaemon('decisionsSyncNow', { force: false }, 20000);
    state.syncing = false;
    if (!res?.ok) {
      showToast(L('同步失败，请稍后重试', 'Sync failed'), true);
      renderView();
      return;
    }
    const msg = res.upsertedDecisions > 0
      ? L(`同步完成：更新 ${res.upsertedDecisions} 条决策`, `Synced: ${res.upsertedDecisions} decisions updated`)
      : L('已是最新状态', 'Already up to date');
    showToast(msg);
    await loadDecisions({ syncFirst: false });
  }

  async function updateStatus(decisionId, nextStatus) {
    const res = await callDaemon('decisionsUpdateMeta', { id: decisionId, reviewStatus: nextStatus }, 10000);
    if (!res?.ok) {
      showToast(L('状态更新失败', 'Failed to update status'), true);
      return;
    }
    const label = STATUS_META[nextStatus] ? L(STATUS_META[nextStatus].zh, STATUS_META[nextStatus].en) : nextStatus;
    showToast(L(`已标记为「${label}」`, `Marked as "${label}"`));
    await loadDecisions({ syncFirst: false });
  }

  async function saveUserNote(decisionId, noteText) {
    const res = await callDaemon('decisionsUpdateMeta', { id: decisionId, userNote: noteText }, 10000);
    if (!res?.ok) {
      showToast(L('备注保存失败', 'Failed to save note'), true);
      return;
    }
    state.editingNoteId = '';
    showToast(L('备注已保存并同步到项目 Markdown', 'Note saved & synced'));
    await loadDecisions({ syncFirst: false });
  }

  async function submitRevision(decisionId, { toChoice, toOptionIndex, reason }) {
    const curCid = getActiveConversationId();
    const res = await callDaemon(
      'decisionsAddRevision',
      {
        id: decisionId,
        toChoice,
        toOptionIndex,
        reason,
        changedInConversationId: curCid
      },
      12000
    );
    if (!res?.ok) {
      showToast(L('保存变更失败：' + (res?.error || ''), 'Failed to save revision'), true);
      return false;
    }
    closeRevisionModal();
    showToast(L('已记录决策变更并同步项目 decisions.md', 'Revision recorded & synced'));
    await loadDecisions({ syncFirst: false });
    return true;
  }

  async function handleRevisitPrompt(decisionId, insertIntoComposer = false) {
    const detail = await callDaemon('decisionsGet', { decisionId }, 10000);
    const promptText = detail?.ok && detail.revisitPrompt ? detail.revisitPrompt : '';
    if (!promptText) {
      showToast(L('无法生成复盘引用文本', 'Failed to build revisit prompt'), true);
      return;
    }
    const copied = await copyToClipboard(promptText);
    if (insertIntoComposer) {
      closeView();
      setTimeout(() => {
        const inserted = insertTextIntoActiveComposer(promptText);
        if (inserted) {
          showToast(L('已填入当前对话输入框（同时已复制）', 'Inserted into composer (and copied)'));
        } else if (copied) {
          showToast(L('未检测到激活输入框，已复制到剪贴板，请直接粘贴', 'Copied to clipboard — paste in any chat'));
        }
      }, 60);
      return;
    }
    showToast(
      copied
        ? L('已复制决策上下文，可直接粘贴给 AI 复盘', 'Decision context copied for AI review')
        : L('复制失败', 'Copy failed'),
      !copied
    );
  }

  async function handleRevealProjectMd() {
    const selectedProj = state.projects.find((p) => p.key === state.projectId || p.projectId === state.projectId);
    const ws = selectedProj?.workspacePath || '';
    if (!ws) {
      showToast(L('请先选择一个拥有本地目录的项目', 'Select a project with a local folder first'), true);
      return;
    }
    const res = await callDaemon('decisionsRevealMarkdown', { workspacePath: ws }, 10000);
    if (!res?.ok) {
      showToast(L('未能定位 .anti-claude/decisions.md', 'Could not reveal decisions.md'), true);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Revision Modal                                                           */
  /* ------------------------------------------------------------------------ */

  function closeRevisionModal() {
    state.revisingDecision = null;
    if (modalEl) {
      try { modalEl.remove(); } catch {}
      modalEl = null;
    }
  }

  function openRevisionModal(decision) {
    closeRevisionModal();
    if (!decision || !document.body) return;
    state.revisingDecision = decision;

    const backdrop = document.createElement('div');
    backdrop.id = 'ag-dec-rev-modal';
    backdrop.setAttribute('data-ag-i18n-ignore', '1');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const curChoice = decision.currentChoice || decision.answerRaw || '';
    const optionsHtml = (decision.options || [])
      .map((opt) => {
        const isCurrent = curChoice === opt.label || curChoice === opt.cleanLabel;
        return `<label class="ag-dec-rev-opt ${isCurrent ? 'is-current' : ''}">
          <input type="radio" name="ag-dec-rev-pick" value="opt:${opt.index}" ${isCurrent ? 'checked' : ''} />
          <div class="ag-dec-rev-opt-body">
            <div class="ag-dec-rev-opt-title">
              <span class="ag-dec-opt-num">${opt.index + 1}</span>
              <span>${escapeHtml(opt.cleanLabel)}</span>
              ${opt.recommended ? `<span class="ag-dec-tag ag-dec-tag-rec">${escapeHtml(L('原推荐', 'Rec'))}</span>` : ''}
              ${isCurrent ? `<span class="ag-dec-tag ag-dec-tag-cur">${escapeHtml(L('当前方案', 'Current'))}</span>` : ''}
            </div>
            ${opt.description ? `<div class="ag-dec-rev-opt-desc">${escapeHtml(opt.description)}</div>` : ''}
          </div>
        </label>`;
      })
      .join('');

    backdrop.innerHTML = `
      <div class="ag-dec-modal-card">
        <div class="ag-dec-modal-head">
          <div>
            <h3>${escapeHtml(L('变更决策选择', 'Revise Decision'))}</h3>
            <p class="ag-dec-modal-sub">${escapeHtml(decision.question)}</p>
          </div>
          <button type="button" class="ag-dec-icon-btn" data-ag-dec-modal-close aria-label="${escapeHtml(L('关闭', 'Close'))}">${SVG_CLOSE_ICON}</button>
        </div>
        <div class="ag-dec-modal-body">
          <div class="ag-dec-modal-label">${escapeHtml(L('选择新的生效方案（可直接改选原备选项，或输入全新方案）', 'Pick a new active option (choose a previous alternative or enter a custom one)'))}</div>
          <div class="ag-dec-rev-opts">
            ${optionsHtml}
            <label class="ag-dec-rev-opt ag-dec-rev-opt-custom">
              <input type="radio" name="ag-dec-rev-pick" value="custom" />
              <div class="ag-dec-rev-opt-body">
                <div class="ag-dec-rev-opt-title">${escapeHtml(L('自定义新方案', 'Custom new decision'))}</div>
                <input type="text" class="ag-dec-input ag-dec-rev-custom-input" placeholder="${escapeHtml(L('输入新的决定内容…', 'Describe the new choice…'))}" />
              </div>
            </label>
          </div>
          <div class="ag-dec-modal-field">
            <label class="ag-dec-modal-label" for="ag-dec-rev-reason">${escapeHtml(L('变更原因（选填，方便未来回溯为什么推翻原方案）', 'Reason for change (optional)'))}</label>
            <textarea id="ag-dec-rev-reason" class="ag-dec-textarea" rows="3" placeholder="${escapeHtml(L('例如：上线后发现 Sales 需要跨组协作，严格隔离反而增加沟通成本…', 'e.g., After testing, strict isolation slowed down cross-team handoffs…'))}"></textarea>
          </div>
        </div>
        <div class="ag-dec-modal-foot">
          <button type="button" class="ag-dec-btn ag-dec-btn-ghost" data-ag-dec-modal-close>${escapeHtml(L('取消', 'Cancel'))}</button>
          <button type="button" class="ag-dec-btn ag-dec-btn-primary" data-ag-dec-modal-save>${escapeHtml(L('保存变更记录', 'Save Revision'))}</button>
        </div>
      </div>
    `;

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-ag-dec-modal-close]')) {
        closeRevisionModal();
      }
    });

    const customInput = backdrop.querySelector('.ag-dec-rev-custom-input');
    const customRadio = backdrop.querySelector('input[value="custom"]');
    if (customInput && customRadio) {
      customInput.addEventListener('focus', () => {
        customRadio.checked = true;
      });
    }

    const saveBtn = backdrop.querySelector('[data-ag-dec-modal-save]');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const picked = backdrop.querySelector('input[name="ag-dec-rev-pick"]:checked');
        const reasonEl = backdrop.querySelector('#ag-dec-rev-reason');
        const reason = String(reasonEl?.value || '').trim();
        let toChoice = '';
        let toOptionIndex = null;
        if (!picked) {
          showToast(L('请先选择一个方案', 'Please choose an option'), true);
          return;
        }
        if (picked.value === 'custom') {
          toChoice = String(customInput?.value || '').trim();
          if (!toChoice) {
            showToast(L('请输入自定义方案内容', 'Please enter your custom choice'), true);
            customInput?.focus();
            return;
          }
        } else if (picked.value.startsWith('opt:')) {
          const idx = Number(picked.value.slice(4));
          const opt = (decision.options || [])[idx];
          if (opt) {
            toChoice = opt.label;
            toOptionIndex = idx;
          }
        }
        saveBtn.disabled = true;
        await submitRevision(decision.id, { toChoice, toOptionIndex, reason });
        if (saveBtn.isConnected) saveBtn.disabled = false;
      });
    }

    document.body.appendChild(backdrop);
    modalEl = backdrop;
  }

  /* ------------------------------------------------------------------------ */
  /* Main View Rendering                                                      */
  /* ------------------------------------------------------------------------ */

  function renderDecisionCard(d) {
    const stMeta = STATUS_META[d.reviewStatus] || STATUS_META.decided;
    const title = d.currentTitle || d.titleSnapshot || d.conversationId.slice(0, 8);
    const projectLabel = d.projectName || L('未归属项目', 'Outside of Project');
    const timeLabel = formatDateShort(d.answeredAt || d.askedAt);
    const selectedSet = new Set(d.selectedOptions || []);
    const effectiveChoice = d.currentChoice || d.answerRaw || '';
    const hasRevisions = Array.isArray(d.revisions) && d.revisions.length > 0;
    const isEditingNote = state.editingNoteId === d.id;

    const optionsHtml = (d.options || [])
      .map((opt) => {
        const isInitialSelected = selectedSet.has(opt.label) || selectedSet.has(opt.cleanLabel);
        const isCurrentSelected = effectiveChoice === opt.label || effectiveChoice === opt.cleanLabel;
        const isActive = d.reviewStatus === 'changed' ? isCurrentSelected : isInitialSelected;
        const wasInitialOnly = d.reviewStatus === 'changed' && isInitialSelected && !isCurrentSelected;
        const rowCls = [
          'ag-dec-opt',
          isActive ? 'is-selected' : '',
          wasInitialOnly ? 'is-previous' : ''
        ]
          .filter(Boolean)
          .join(' ');
        const badges = [];
        if (opt.recommended) {
          badges.push(`<span class="ag-dec-tag ag-dec-tag-rec">${escapeHtml(L('推荐', 'Rec'))}</span>`);
        }
        if (d.reviewStatus === 'changed' && isCurrentSelected) {
          badges.push(`<span class="ag-dec-tag ag-dec-tag-cur">${escapeHtml(L('当前生效', 'Active'))}</span>`);
        } else if (wasInitialOnly) {
          badges.push(`<span class="ag-dec-tag ag-dec-tag-prev">${escapeHtml(L('原选择', 'Initial'))}</span>`);
        } else if (isActive) {
          badges.push(`<span class="ag-dec-tag ag-dec-tag-chosen">${escapeHtml(L('已选', 'Chosen'))}</span>`);
        }
        return `<div class="${rowCls}">
          <span class="ag-dec-opt-num">${opt.index + 1}</span>
          <div class="ag-dec-opt-content">
            <div class="ag-dec-opt-main">
              <span class="ag-dec-opt-label">${escapeHtml(opt.cleanLabel)}</span>
              ${badges.join('')}
            </div>
            ${opt.description ? `<div class="ag-dec-opt-desc">${escapeHtml(opt.description)}</div>` : ''}
          </div>
        </div>`;
      })
      .join('');

    let extraAnswerHtml = '';
    if (d.answerKind === 'custom' && d.answerRaw) {
      extraAnswerHtml = `<div class="ag-dec-custom-ans">
        <span class="ag-dec-tag ag-dec-tag-custom">${escapeHtml(L('自定义回答 (Other)', 'Custom Answer'))}</span>
        <span class="ag-dec-custom-text">${escapeHtml(d.answerRaw)}</span>
      </div>`;
    } else if (d.answerKind === 'skipped') {
      extraAnswerHtml = `<div class="ag-dec-custom-ans is-muted">
        <span class="ag-dec-tag ag-dec-tag-skip">${escapeHtml(L('已跳过', 'Skipped'))}</span>
        <span>${escapeHtml(L('当时未做选择（User Skipped）', 'User Skipped'))}</span>
      </div>`;
    } else if (d.answerKind === 'pending') {
      extraAnswerHtml = `<div class="ag-dec-custom-ans is-muted">
        <span class="ag-dec-tag ag-dec-tag-pending">${escapeHtml(L('待作答', 'Pending'))}</span>
        <span>${escapeHtml(L('该问题尚未提交选择', 'Awaiting user answer'))}</span>
      </div>`;
    }

    /* If changed to a custom choice not among preset options, show it clearly */
    const effectiveMatchesPreset = (d.options || []).some(
      (o) => o.label === effectiveChoice || o.cleanLabel === effectiveChoice
    );
    const customCurrentHtml =
      d.reviewStatus === 'changed' && effectiveChoice && !effectiveMatchesPreset
        ? `<div class="ag-dec-custom-ans is-active-custom">
            <span class="ag-dec-tag ag-dec-tag-cur">${escapeHtml(L('当前自定义方案', 'Active Custom'))}</span>
            <span class="ag-dec-custom-text">${escapeHtml(effectiveChoice)}</span>
          </div>`
        : '';

    const revisionsHtml = hasRevisions
      ? `<div class="ag-dec-revisions">
          <div class="ag-dec-rev-hdr">${escapeHtml(L(`变更演变历史 (${d.revisions.length})`, `Revision History (${d.revisions.length})`))}</div>
          ${d.revisions
            .map(
              (r) => `<div class="ag-dec-rev-row">
                <span class="ag-dec-rev-time">${escapeHtml(formatDateShort(r.createdAt))}</span>
                <div class="ag-dec-rev-diff">
                  <span class="ag-dec-rev-from">${escapeHtml(r.fromChoice || L('（无）', '(none)'))}</span>
                  <span class="ag-dec-rev-arrow">→</span>
                  <span class="ag-dec-rev-to">${escapeHtml(r.toChoice)}</span>
                  ${r.reason ? `<div class="ag-dec-rev-reason">${escapeHtml(L('原因：', 'Reason: '))}${escapeHtml(r.reason)}</div>` : ''}
                </div>
              </div>`
            )
            .join('')}
        </div>`
      : '';

    const noteHtml = isEditingNote
      ? `<div class="ag-dec-note-editor">
          <textarea class="ag-dec-textarea" data-ag-dec-note-input="${escapeHtml(d.id)}" rows="2" placeholder="${escapeHtml(L('记录你对这个决策的顾虑、后续触发变更的条件或复盘笔记…', 'Write your doubts, revisit conditions, or review notes…'))}">${escapeHtml(d.userNote || '')}</textarea>
          <div class="ag-dec-note-actions">
            <button type="button" class="ag-dec-btn ag-dec-btn-ghost ag-dec-btn-xs" data-ag-dec-note-cancel>${escapeHtml(L('取消', 'Cancel'))}</button>
            <button type="button" class="ag-dec-btn ag-dec-btn-primary ag-dec-btn-xs" data-ag-dec-note-save="${escapeHtml(d.id)}">${escapeHtml(L('保存备注', 'Save Note'))}</button>
          </div>
        </div>`
      : d.userNote
        ? `<div class="ag-dec-note-box" data-ag-dec-note-edit="${escapeHtml(d.id)}" title="${escapeHtml(L('点击编辑备注', 'Click to edit note'))}">
            <span class="ag-dec-note-lbl">${escapeHtml(L('备注', 'Note'))}</span>
            <span class="ag-dec-note-txt">${escapeHtml(d.userNote)}</span>
          </div>`
        : '';

    const statusSwitcher = ['decided', 'uncertain', 'changed']
      .map((st) => {
        const m = STATUS_META[st];
        const active = d.reviewStatus === st;
        return `<button type="button" class="ag-dec-st-pill ${active ? 'is-active' : ''}" data-st="${st}" data-ag-dec-set-status="${escapeHtml(d.id)}" data-status-val="${st}">${escapeHtml(L(m.zh, m.en))}</button>`;
      })
      .join('');

    const batchTag = d.questionCount > 1 ? `<span class="ag-dec-batch">${d.questionIndex + 1}/${d.questionCount}</span>` : '';
    const multiTag = d.isMultiSelect ? `<span class="ag-dec-batch">${escapeHtml(L('多选', 'Multi'))}</span>` : '';

    return `<article class="ag-dec-card" data-status="${escapeHtml(d.reviewStatus)}" data-dec-id="${escapeHtml(d.id)}">
      <div class="ag-dec-card-meta">
        <div class="ag-dec-meta-left">
          <span class="ag-dec-proj-chip" title="${escapeHtml(d.workspacePath || projectLabel)}">${SVG_FOLDER_ICON}<span>${escapeHtml(projectLabel)}</span></span>
          <button type="button" class="ag-dec-conv-link" data-ag-dec-jump="${escapeHtml(d.conversationId)}" title="${escapeHtml(L('点击跳转原对话', 'Open source conversation'))}">${escapeHtml(title)}</button>
          <button type="button" class="ag-dec-cid-chip" data-ag-dec-copy-cid="${escapeHtml(d.conversationId)}" title="${escapeHtml(L(`点击复制对话 ID: ${d.conversationId}`, `Copy Conversation ID: ${d.conversationId}`))}">#${escapeHtml(d.conversationId.slice(0, 8))}</button>
        </div>
        <div class="ag-dec-meta-right">
          ${timeLabel ? `<span class="ag-dec-time">${escapeHtml(timeLabel)}</span>` : ''}
          <span class="ag-dec-status-badge" data-st="${escapeHtml(stMeta.dot)}">${escapeHtml(L(stMeta.zh, stMeta.en))}</span>
        </div>
      </div>

      <div class="ag-dec-question">
        <span class="ag-dec-q-text">${escapeHtml(d.question)}</span>
        ${batchTag}${multiTag}
      </div>

      <div class="ag-dec-options">${optionsHtml}</div>
      ${extraAnswerHtml}
      ${customCurrentHtml}
      ${revisionsHtml}
      ${noteHtml}

      <div class="ag-dec-card-foot">
        <div class="ag-dec-foot-left">
          <div class="ag-dec-st-group" role="group" aria-label="${escapeHtml(L('状态标注', 'Status'))}">${statusSwitcher}</div>
          <button type="button" class="ag-dec-act-btn" data-ag-dec-note-edit="${escapeHtml(d.id)}">${escapeHtml(d.userNote ? L('改备注', 'Edit Note') : L('+ 备注', '+ Note'))}</button>
        </div>
        <div class="ag-dec-foot-right">
          <button type="button" class="ag-dec-act-btn" data-ag-dec-revise="${escapeHtml(d.id)}">${SVG_SWAP_ICON}<span>${escapeHtml(L('变更选择', 'Revise'))}</span></button>
          <button type="button" class="ag-dec-act-btn" data-ag-dec-copy-prompt="${escapeHtml(d.id)}" title="${escapeHtml(L('复制完整备选方案上下文给 AI 复盘', 'Copy decision context for AI review'))}">${SVG_COPY_ICON}<span>${escapeHtml(L('复制复盘', 'Copy'))}</span></button>
          <button type="button" class="ag-dec-act-btn ag-dec-act-accent" data-ag-dec-insert-prompt="${escapeHtml(d.id)}" title="${escapeHtml(L('填入当前对话输入框并复制', 'Insert revisit prompt into active chat'))}">${SVG_SPARK_ICON}<span>${escapeHtml(L('引用给 AI', 'Ask AI'))}</span></button>
          <button type="button" class="ag-dec-act-btn" data-ag-dec-jump="${escapeHtml(d.conversationId)}">${SVG_JUMP_ICON}<span>${escapeHtml(L('原对话', 'Open Chat'))}</span></button>
        </div>
      </div>
    </article>`;
  }

  function renderView() {
    if (!viewEl || !viewOpen) return;

    const st = state.stats || {};
    const curCid = getActiveConversationId();
    const selectedProj = state.projects.find((p) => p.key === state.projectId || p.projectId === state.projectId);
    const hasLocalMd = Boolean(selectedProj?.workspacePath);

    const projectOptionsList = [
      `<option value="">${escapeHtml(L(`全部项目 (${st.total || 0})`, `All Projects (${st.total || 0})`))}</option>`,
      ...state.projects.map((p) => {
        const name = p.key === '__unassigned__' ? L('未归属项目', 'Outside of Project') : p.projectName || p.key;
        const selected = state.projectId === p.key || (p.projectId && state.projectId === p.projectId);
        const uncSuffix = p.uncertainCount > 0 ? ` · ${p.uncertainCount}${L('待定', ' ?')}` : '';
        return `<option value="${escapeHtml(p.key)}" ${selected ? 'selected' : ''}>${escapeHtml(`${name} (${p.count}${uncSuffix})`)}</option>`;
      })
    ];
    if (state.projectId && !selectedProj) {
      const fallbackProjName = state.projectLabel || state.projectId;
      projectOptionsList.push(
        `<option value="${escapeHtml(state.projectId)}" selected>${escapeHtml(`${fallbackProjName} (0)`)}</option>`
      );
    }
    const projectOptions = projectOptionsList.join('');

    const scopedConvTitle =
      state.conversationId
        ? state.items[0]?.currentTitle || state.conversationLabel || `#${state.conversationId.slice(0, 8)}`
        : '';
    const scopedConvPillHtml = state.conversationId
      ? `<div class="ag-dec-scope-pill">
          <span class="ag-dec-scope-lbl">${escapeHtml(L('当前筛选对话：', 'Conversation: '))}</span>
          <span class="ag-dec-scope-val" title="${escapeHtml(state.conversationId)}">${escapeHtml(scopedConvTitle)}</span>
          <button type="button" class="ag-dec-scope-clear" data-ag-dec-clear-conv title="${escapeHtml(L('清除对话筛选，查看全部', 'Clear conversation filter'))}">× ${escapeHtml(L('查看全部', 'Show all'))}</button>
        </div>`
      : '';

    const tabs = [
      ['all', L('全部', 'All'), st.total || 0],
      ['uncertain', L('拿捏不定', 'Uncertain'), st.uncertain || 0],
      ['changed', L('已变更', 'Changed'), st.changed || 0],
      ['decided', L('已定', 'Decided'), st.decided || 0],
      ['skipped', L('已跳过', 'Skipped'), st.skipped || 0]
    ];
    if (st.pending > 0) tabs.push(['pending', L('待作答', 'Pending'), st.pending]);

    const tabsHtml = tabs
      .map(
        ([k, lbl, cnt]) => `<button type="button" class="ag-dec-tab ${state.status === k ? 'is-active' : ''}" data-ag-dec-tab="${k}">
          <span>${escapeHtml(lbl)}</span>
          <span class="ag-dec-tab-cnt">${cnt}</span>
        </button>`
      )
      .join('');

    let listBodyHtml = '';
    if (state.loading && state.items.length === 0) {
      listBodyHtml = `<div class="ag-dec-empty">${escapeHtml(L('正在加载并索引决策记录…', 'Loading & indexing decisions…'))}</div>`;
    } else if (state.error) {
      listBodyHtml = `<div class="ag-dec-empty is-error">${escapeHtml(L(`加载失败：${state.error}`, `Failed to load: ${state.error}`))}</div>`;
    } else if (state.items.length === 0) {
      listBodyHtml = `<div class="ag-dec-empty">
        <div class="ag-dec-empty-title">${escapeHtml(L('暂无匹配的决策记录', 'No matching decisions found'))}</div>
        <div class="ag-dec-empty-sub">${escapeHtml(L('当对话中出现 ask_question 选择卡片时，系统会自动记录全部备选项与你的选择。', 'Whenever ask_question decision cards appear in chats, all options and your choices are archived automatically.'))}</div>
      </div>`;
    } else {
      listBodyHtml = `<div class="ag-dec-list">${state.items.map(renderDecisionCard).join('')}</div>`;
    }

    const activeSearchEl = viewEl.querySelector('#ag-dec-search-input');
    const hadSearchFocus = activeSearchEl && document.activeElement === activeSearchEl;
    const selStart = hadSearchFocus ? activeSearchEl.selectionStart : null;
    const selEnd = hadSearchFocus ? activeSearchEl.selectionEnd : null;

    viewEl.innerHTML = `
      <div class="ag-dec-shell">
        <header class="ag-dec-header">
          <div class="ag-dec-header-left">
            <h1 class="ag-dec-title">${escapeHtml(L('对话决策记录', 'Decision Log'))}</h1>
            <span class="ag-dec-subtitle">${escapeHtml(L('保留每次选择的全部备选方案与演变轨迹，方便日后复盘与改选', 'All options, choices & revisions archived for future review'))}</span>
          </div>
          <div class="ag-dec-header-actions">
            ${
              hasLocalMd
                ? `<button type="button" class="ag-dec-btn ag-dec-btn-ghost" data-ag-dec-reveal-md title="${escapeHtml(selectedProj.workspacePath + '/.anti-claude/decisions.md')}">${SVG_FOLDER_ICON}<span>${escapeHtml(L('打开 decisions.md', 'Open decisions.md'))}</span></button>`
                : ''
            }
            <button type="button" class="ag-dec-btn ag-dec-btn-ghost ${state.syncing ? 'is-busy' : ''}" data-ag-dec-sync ${state.syncing ? 'disabled' : ''}>${SVG_REFRESH_ICON}<span>${escapeHtml(state.syncing ? L('同步中…', 'Syncing…') : L('立即同步', 'Sync Now'))}</span></button>
            <button type="button" class="ag-dec-icon-btn" data-ag-dec-close aria-label="${escapeHtml(L('关闭', 'Close'))}">${SVG_CLOSE_ICON}</button>
          </div>
        </header>

        <div class="ag-dec-toolbar">
          <div class="ag-dec-toolbar-row">
            <select id="ag-dec-project-select" class="ag-dec-select" aria-label="${escapeHtml(L('按项目筛选', 'Filter by project'))}">${projectOptions}</select>
            <div class="ag-dec-search-wrap">
              ${SVG_SEARCH_ICON}
              <input id="ag-dec-search-input" type="search" class="ag-dec-search" value="${escapeHtml(state.search)}" placeholder="${escapeHtml(L('搜索问题、备选方案、备注、对话标题或 ID…', 'Search questions, options, notes, title or ID…'))}" />
            </div>
            ${
              curCid && state.conversationId !== curCid
                ? `<button type="button" class="ag-dec-btn ag-dec-btn-ghost" data-ag-dec-toggle-cur-conv>${escapeHtml(L('仅看当前对话', 'Current Chat Only'))}</button>`
                : ''
            }
          </div>
          ${scopedConvPillHtml}
          <div class="ag-dec-tabs" role="tablist">${tabsHtml}</div>
        </div>

        <div class="ag-dec-scroll">${listBodyHtml}</div>
      </div>
    `;

    if (hadSearchFocus) {
      const nextInput = viewEl.querySelector('#ag-dec-search-input');
      if (nextInput) {
        nextInput.focus();
        try {
          if (selStart !== null && selEnd !== null) nextInput.setSelectionRange(selStart, selEnd);
        } catch {}
      }
    }
  }

  function bindViewEvents(el) {
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;

      if (t.closest('[data-ag-dec-close]')) {
        closeView();
        return;
      }
      if (t.closest('[data-ag-dec-sync]')) {
        triggerSyncNow();
        return;
      }
      if (t.closest('[data-ag-dec-reveal-md]')) {
        handleRevealProjectMd();
        return;
      }
      if (t.closest('[data-ag-dec-toggle-cur-conv]')) {
        const cid = getActiveConversationId();
        state.conversationId = state.conversationId === cid ? '' : cid;
        state.conversationLabel = '';
        state.projectId = '';
        state.projectLabel = '';
        loadDecisions({ syncFirst: false });
        return;
      }
      if (t.closest('[data-ag-dec-clear-conv]')) {
        state.conversationId = '';
        state.conversationLabel = '';
        loadDecisions({ syncFirst: false });
        return;
      }
      const tabBtn = t.closest('[data-ag-dec-tab]');
      if (tabBtn) {
        const nextSt = tabBtn.getAttribute('data-ag-dec-tab') || 'all';
        if (state.status !== nextSt) {
          state.status = nextSt;
          loadDecisions({ syncFirst: false });
        }
        return;
      }
      const jumpBtn = t.closest('[data-ag-dec-jump]');
      if (jumpBtn) {
        const cid = jumpBtn.getAttribute('data-ag-dec-jump');
        if (cid) navigateToConversation(cid);
        return;
      }
      const copyCidBtn = t.closest('[data-ag-dec-copy-cid]');
      if (copyCidBtn) {
        const cid = copyCidBtn.getAttribute('data-ag-dec-copy-cid');
        if (cid) {
          copyToClipboard(cid).then((ok) => {
            if (ok) showToast(L(`已复制对话 ID：${cid}`, `Copied ID: ${cid}`));
          });
        }
        return;
      }
      const stBtn = t.closest('[data-ag-dec-set-status]');
      if (stBtn) {
        const did = stBtn.getAttribute('data-ag-dec-set-status');
        const nextSt = stBtn.getAttribute('data-status-val');
        if (did && nextSt) updateStatus(did, nextSt);
        return;
      }
      const noteEditBtn = t.closest('[data-ag-dec-note-edit]');
      if (noteEditBtn) {
        const did = noteEditBtn.getAttribute('data-ag-dec-note-edit') || '';
        state.editingNoteId = state.editingNoteId === did ? '' : did;
        renderView();
        const ta = viewEl?.querySelector(`[data-ag-dec-note-input="${CSS.escape(did)}"]`);
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        return;
      }
      if (t.closest('[data-ag-dec-note-cancel]')) {
        state.editingNoteId = '';
        renderView();
        return;
      }
      const noteSaveBtn = t.closest('[data-ag-dec-note-save]');
      if (noteSaveBtn) {
        const did = noteSaveBtn.getAttribute('data-ag-dec-note-save');
        const ta = did ? viewEl?.querySelector(`[data-ag-dec-note-input="${CSS.escape(did)}"]`) : null;
        if (did && ta) saveUserNote(did, ta.value);
        return;
      }
      const revBtn = t.closest('[data-ag-dec-revise]');
      if (revBtn) {
        const did = revBtn.getAttribute('data-ag-dec-revise');
        const found = state.items.find((x) => x.id === did);
        if (found) openRevisionModal(found);
        return;
      }
      const copyPromptBtn = t.closest('[data-ag-dec-copy-prompt]');
      if (copyPromptBtn) {
        const did = copyPromptBtn.getAttribute('data-ag-dec-copy-prompt');
        if (did) handleRevisitPrompt(did, false);
        return;
      }
      const insertPromptBtn = t.closest('[data-ag-dec-insert-prompt]');
      if (insertPromptBtn) {
        const did = insertPromptBtn.getAttribute('data-ag-dec-insert-prompt');
        if (did) handleRevisitPrompt(did, true);
      }
    });

    el.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'ag-dec-project-select') {
        state.projectId = e.target.value || '';
        state.projectLabel = '';
        state.conversationId = '';
        state.conversationLabel = '';
        loadDecisions({ syncFirst: false });
      }
    });

    el.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'ag-dec-search-input') {
        state.search = e.target.value || '';
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchTimer = 0;
          loadDecisions({ syncFirst: false });
        }, 180);
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Open / Close / Global Listeners                                          */
  /* ------------------------------------------------------------------------ */

  function openView(opts = {}) {
    if (disposed || !enabled) return;
    if (typeof opts.projectId === 'string') {
      state.projectId = opts.projectId;
      state.projectLabel = typeof opts.projectName === 'string' ? opts.projectName.trim() : '';
    }
    if (typeof opts.conversationId === 'string') {
      state.conversationId = opts.conversationId;
      state.conversationLabel = typeof opts.conversationTitle === 'string' ? opts.conversationTitle.trim() : '';
    }
    if (typeof opts.status === 'string') state.status = opts.status || 'all';
    if (typeof opts.search === 'string') state.search = opts.search;

    /* Close Projects workspace if open so the two overlays never stack */
    const projView = document.getElementById('ag-claude-projects-view');
    if (projView && projView.getAttribute('data-open') === 'true') {
      try {
        window.dispatchEvent(new CustomEvent('ag-decisions-view-opened'));
      } catch {}
    }

    const el = ensureViewEl();
    viewOpen = true;
    lastRouteKey = `${window.location.pathname}${window.location.search}`;
    el.hidden = false;
    el.setAttribute('data-open', 'true');
    ensureSidebarObserver();
    positionOverlay();
    updateNavActiveVisual();
    loadDecisions({ syncFirst: true });
  }

  function closeView() {
    closeRevisionModal();
    if (!viewOpen) return;
    viewOpen = false;
    if (viewEl) {
      viewEl.setAttribute('data-open', 'false');
      viewEl.hidden = true;
    }
    updateNavActiveVisual();
  }

  function toggleView() {
    if (viewOpen) closeView();
    else {
      state.conversationId = '';
      state.conversationLabel = '';
      openView();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Native Sidebar Conversation Three-Dot `⋮` Menu Injection                 */
  /* ------------------------------------------------------------------------ */

  function dismissNativeMenu() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch {}
  }

  function recordConvRowTrigger(ev) {
    if (disposed || !enabled) return;
    const row = ev.target?.closest?.('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    if (!row) return;
    const cid = row.getAttribute('data-cascade-id') || '';
    if (!UUID_RE.test(cid)) return;
    const titleEl = row.querySelector('.flex-col > span, a[href] span');
    const linkEl = row.querySelector('a[href]');
    const title = (titleEl?.textContent || linkEl?.getAttribute('aria-label') || '').trim();
    lastConvRowTrigger = { id: cid, title, ts: Date.now() };
  }

  function enhanceNativeConversationMenu(menuEl) {
    if (disposed || !enabled || !menuEl || menuEl.querySelector('[data-ag-conv-decisions-item]')) return;
    if (!lastConvRowTrigger.id || Date.now() - lastConvRowTrigger.ts > 3500) return;
    const cid = lastConvRowTrigger.id;
    const title = lastConvRowTrigger.title;

    const anchorItem =
      menuEl.querySelector('[data-testid="conversation-mark-read-menu-item"]') ||
      menuEl.querySelector('[data-testid="conversation-pin-menu-item"]') ||
      menuEl.querySelector('[data-testid="conversation-rename-menu-item"]');
    if (!anchorItem) return;

    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('data-ag-conv-decisions-item', cid);
    item.setAttribute('data-ag-i18n-ignore', '1');
    const hasLeadingIcon = Boolean(anchorItem.querySelector('svg'));
    item.className = `${anchorItem.className || ''} ag-dec-native-menu-item`.trim();
    item.innerHTML = `${hasLeadingIcon ? `<span class="ag-dec-menu-ico">${SVG_DECISIONS_ICON}</span>` : ''}<span class="truncate">${escapeHtml(L('对话决策记录', 'Conversation Decisions'))}</span>`;

    const triggerOpen = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dismissNativeMenu();
      openView({ conversationId: cid, conversationTitle: title, projectId: '', projectName: '', status: 'all' });
    };
    item.addEventListener('pointerenter', () => {
      menuEl.querySelectorAll('[role="menuitem"][data-highlighted]').forEach((el) => {
        if (el !== item) el.removeAttribute('data-highlighted');
      });
    });
    item.addEventListener('click', triggerOpen);
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') triggerOpen(ev);
    });

    anchorItem.insertAdjacentElement('afterend', item);
  }

  function scanNativeConversationMenus() {
    if (disposed || !enabled) return;
    const anchors = document.querySelectorAll(
      '[data-testid="conversation-mark-read-menu-item"], [data-testid="conversation-pin-menu-item"], [data-testid="conversation-rename-menu-item"]'
    );
    const seen = new Set();
    for (const el of anchors) {
      const menu = el.closest('[role="menu"]');
      if (!menu || menu.id === 'ag-recent-row-menu' || seen.has(menu)) continue;
      seen.add(menu);
      enhanceNativeConversationMenu(menu);
    }
  }

  function onGlobalClick(e) {
    if (!viewOpen || disposed) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#ag-decisions-view, #ag-dec-rev-modal, #ag-decisions-nav-btn, #ag-dec-toast')) return;
    /* Close when clicking sidebar chats, home, projects, automations, or customizations */
    if (
      t.closest(
        '[data-testid="conversation-row-sidebar"], [data-testid="automations-button"], #ag-claude-projects-nav-btn, a[href="/"], a[href^="/c/"], a[href*="customizations"], .ag-recent-row'
      )
    ) {
      closeView();
    }
  }

  function onGlobalKeyDown(e) {
    if (disposed) return;
    if (e.key === 'Escape') {
      if (modalEl) {
        e.preventDefault();
        e.stopPropagation();
        closeRevisionModal();
      } else if (viewOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeView();
      }
    }
  }

  function onRouteCheck() {
    if (!viewOpen) return;
    const cur = `${window.location.pathname}${window.location.search}`;
    if (cur !== lastRouteKey) {
      lastRouteKey = cur;
      closeView();
    }
  }

  function scheduleMount() {
    if (disposed || !enabled || mountRaf) return;
    mountRaf = requestAnimationFrame(() => {
      mountRaf = 0;
      mountNavButton();
      scanNativeConversationMenus();
      if (viewOpen) positionOverlay();
    });
  }

  function setEnabled(on) {
    const next = Boolean(on);
    if (enabled === next) return;
    enabled = next;
    if (!enabled) {
      closeView();
      document.getElementById('ag-decisions-nav-btn')?.remove();
      document.querySelectorAll('[data-ag-conv-decisions-item]').forEach((n) => n.remove());
    } else {
      scheduleMount();
      refreshBadgeStats();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    closeView();
    if (mountRaf) {
      try { cancelAnimationFrame(mountRaf); } catch {}
      mountRaf = 0;
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = 0;
    }
    if (badgePollTimer) {
      clearInterval(badgePollTimer);
      badgePollTimer = 0;
    }
    if (sidebarRo) {
      try { sidebarRo.disconnect(); } catch {}
      sidebarRo = null;
      observedSidebar = null;
    }
    if (domObs) {
      try { domObs.disconnect(); } catch {}
      domObs = null;
    }
    document.removeEventListener('click', onGlobalClick, true);
    document.removeEventListener('keydown', onGlobalKeyDown, true);
    document.removeEventListener('pointerdown', recordConvRowTrigger, true);
    document.removeEventListener('contextmenu', recordConvRowTrigger, true);
    window.removeEventListener('resize', positionOverlay);
    window.removeEventListener('popstate', onRouteCheck);
    document.getElementById('ag-decisions-nav-btn')?.remove();
    document.querySelectorAll('[data-ag-conv-decisions-item]').forEach((n) => n.remove());
    document.getElementById('ag-decisions-view')?.remove();
    document.getElementById('ag-dec-rev-modal')?.remove();
    document.getElementById('ag-dec-toast')?.remove();
    viewEl = null;
    modalEl = null;
    if (window.__agDecisions === api) delete window.__agDecisions;
  }

  document.addEventListener('click', onGlobalClick, true);
  document.addEventListener('keydown', onGlobalKeyDown, true);
  document.addEventListener('pointerdown', recordConvRowTrigger, true);
  document.addEventListener('contextmenu', recordConvRowTrigger, true);
  window.addEventListener('resize', positionOverlay);
  window.addEventListener('popstate', onRouteCheck);

  if (typeof MutationObserver === 'function' && document.body) {
    domObs = new MutationObserver(scheduleMount);
    domObs.observe(document.body, { childList: true, subtree: true });
  }

  if (enabled) {
    scheduleMount();
    setTimeout(() => refreshBadgeStats(), 1200);
  }
  badgePollTimer = setInterval(() => {
    if (!disposed && enabled && !document.hidden) refreshBadgeStats();
  }, 30000);

  const api = {
    open: openView,
    close: closeView,
    toggle: toggleView,
    setEnabled,
    refresh: () => loadDecisions({ syncFirst: true }),
    getStats: () => Object.assign({}, state.stats),
    dispose
  };

  window.__agDecisions = api;
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
