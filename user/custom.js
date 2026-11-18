/**
 * Anti-Claude — user/custom.js
 * Non-invasive runtime UX extension for Google Antigravity Desktop 2.0:
 * 1. Unfolds outer `worked-for-collapsible` end-of-turn wrapper so interleaved narration & tool summaries stay inline.
 * 2. Adds smooth 190ms collapse transition when React unmounts finished `tool-group-collapsible` panels.
 * 3. Renders an in-place reactive Claude `TodoWrite` checklist card (`- [ ]` pending / `- [/]` active / `- [x]` completed),
 *    deduplicating and merging all checklist updates within the same turn into a single card.
 * 4. Attaches orbiting official-blue dots + live `1s / 2s...` elapsed timer exclusively to the actively executing step row.
 *
 * Feature switches (user/config.json -> "modules", all default true):
 *   claudeUxStepUnfold, claudeUxCollapseAnimation, claudeUxTodoCard, claudeUxRunningTimer,
 *   claudeUxContextRing, claudeUxModelMenu
 */
(function () {
  const MODS =
    (typeof ctx !== 'undefined' && ctx && (ctx.modules || (ctx.config && ctx.config.modules))) || {};
  const MODULE_STORAGE_KEY = 'ag_claude_ux_modules_v1';
  function loadLocalModuleOverrides() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODULE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  let localModOverrides = loadLocalModuleOverrides();
  function effectiveModBool(key, defaultVal = true) {
    if (Object.prototype.hasOwnProperty.call(localModOverrides, key)) {
      return Boolean(localModOverrides[key]);
    }
    if (Object.prototype.hasOwnProperty.call(MODS, key)) {
      return Boolean(MODS[key]);
    }
    return defaultVal;
  }
  const FEAT = {
    stepUnfold: effectiveModBool('claudeUxStepUnfold', true),
    collapseAnim: effectiveModBool('claudeUxCollapseAnimation', true),
    todoCard: effectiveModBool('claudeUxTodoCard', true),
    runningTimer: effectiveModBool('claudeUxRunningTimer', true),
    contextRing: effectiveModBool('claudeUxContextRing', true),
    modelMenu: effectiveModBool('claudeUxModelMenu', true),
    inlineUndo: effectiveModBool('claudeUxInlineUndo', true),
    folderStatus: effectiveModBool('claudeUxFolderStatus', true),
    recentSection: effectiveModBool('claudeUxRecentSection', true)
  };

  /* an older instance that was never cleaned up (no ctx.onCleanup) must not keep running */
  if (typeof window.__agClaudeUxDispose === 'function') {
    try {
      window.__agClaudeUxDispose();
    } catch {}
  }

  const userToggled = new WeakSet();
  const autoExpandCount = new WeakMap();
  const openSnapshots = new WeakMap();
  const runningTimers = new WeakMap();
  const paneLastActiveTs = new WeakMap();
  const paneUndockTimers = new WeakMap();
  const todoParseCache = new WeakMap();
  let timerIntervalId = null;
  let rafPending = false;

  /* ---- lifecycle: every async callback is tracked and becomes a no-op after cleanup ---- */
  let disposed = false;
  const pendingRafs = new Set();
  const pendingTimeouts = new Set();
  function frame(fn) {
    if (disposed) return 0;
    const id = requestAnimationFrame((ts) => {
      pendingRafs.delete(id);
      if (!disposed) fn(ts);
    });
    pendingRafs.add(id);
    return id;
  }
  function later(fn, ms) {
    if (disposed) return 0;
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      if (!disposed) fn();
    }, ms);
    pendingTimeouts.add(id);
    return id;
  }
  function cancelLater(id) {
    if (!id) return;
    clearTimeout(id);
    pendingTimeouts.delete(id);
  }

  const SVG_PENDING =
    '<svg class="ag-todo-ico ag-todo-pending" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.4"/></svg>';
  const SVG_ACTIVE =
    '<svg class="ag-todo-ico ag-todo-active" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.5"/><path d="M8 1.4a6.6 6.6 0 0 1 6.6 6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const SVG_DONE =
    '<svg class="ag-todo-ico ag-todo-done" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path class="ag-todo-done-check" d="M5.1 8.15l1.95 1.95 3.95-4.1" stroke="#FFFFFF" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const PAST_LABEL_RE = /^(?:Explored|Ran\b|Edited\b|Done\b|已探索|已运行|已编辑|已完成)/i;

  const onDocClick = (e) => {
    if (!e.isTrusted) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="worked-for-collapsible"]');
    if (btn) userToggled.add(btn);
  };
  document.addEventListener('click', onDocClick, true);

  function captureOpenToolPanels() {
    /* Keep a reference to the live panel node (no innerHTML serialisation per frame).
       It is cloned only at the moment React collapses it. */
    const openBtns = document.querySelectorAll('button[data-testid="tool-group-collapsible"][aria-expanded="true"]');
    for (const btn of openBtns) {
      const panel = btn.nextElementSibling;
      if (!panel || panel.classList.contains('ag-collapse-ghost')) continue;
      const snap = openSnapshots.get(btn);
      if (!snap || snap.panel !== panel) openSnapshots.set(btn, { panel });
    }
  }

  function animateCollapseIfNeeded(btn) {
    const snap = openSnapshots.get(btn);
    if (!snap) return;
    openSnapshots.delete(btn);
    if (btn.getAttribute('aria-expanded') !== 'false') return;
    const parent = btn.parentElement;
    if (!parent || parent.querySelector(':scope > .ag-collapse-ghost')) return;
    const src = snap.panel;
    if (!src || !src.firstChild) return;

    const ghost = document.createElement('div');
    ghost.className = `${src.className} ag-collapse-ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    for (const n of Array.from(src.childNodes)) ghost.appendChild(n.cloneNode(true));
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.style.cssText = 'overflow: hidden; pointer-events: none; opacity: 1; transform: translateY(0)';
    btn.insertAdjacentElement('afterend', ghost);

    const height = Math.min(ghost.scrollHeight || 0, 360);
    if (height <= 8) {
      ghost.remove();
      return;
    }
    ghost.style.maxHeight = `${height}px`;
    ghost.style.transition =
      'max-height 190ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease-out, transform 190ms cubic-bezier(0.16, 1, 0.3, 1), margin 190ms ease';

    frame(() => {
      frame(() => {
        ghost.style.maxHeight = '0px';
        ghost.style.opacity = '0';
        ghost.style.transform = 'translateY(-4px)';
        ghost.style.marginTop = '0px';
        ghost.style.marginBottom = '0px';
      });
    });

    const cleanup = () => {
      if (ghost.parentNode) ghost.remove();
    };
    ghost.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 240); /* intentionally untracked: must also run after dispose */
  }

  function parseTodoUlUncached(ul) {
    const allLis = Array.from(ul.children).filter((el) => el.tagName === 'LI');
    const lis = allLis.filter((el) => el.classList.contains('task-list-item'));
    if (lis.length < 2 || lis.length > 15 || lis.length !== allLis.length) return null;

    const items = [];
    for (const li of lis) {
      const iconBox = li.querySelector(':scope > div:first-child, :scope > p:first-child > div:first-child');
      let status = 'pending';
      if (li.classList.contains('task-checked')) {
        status = 'completed';
      } else if (iconBox && iconBox.classList.contains('bg-primary')) {
        status = 'in_progress';
      }
      const clone = li.cloneNode(true);
      const firstDiv = clone.querySelector(':scope > div:first-child, :scope > p:first-child > div:first-child');
      if (firstDiv) firstDiv.remove();
      const checkedSpan = clone.querySelector(':scope > span.task-checked-content, :scope > p > span.task-checked-content');
      const labelHtml = (checkedSpan ? checkedSpan.innerHTML : clone.innerHTML).trim();
      if (!labelHtml) return null;
      items.push({ status, html: labelHtml });
    }
    return items;
  }

  function parseTodoUl(ul) {
    if (!ul.classList || !ul.classList.contains('contains-task-list')) return null;
    if (ul.closest('pre, code, [data-testid="user-input-step"], .agy-user-bubble')) return null;
    if (ul.closest('[data-testid="tool-group-collapsible"] + div')) return null;
    if (ul.closest('.ag-claude-todo-card, .ag-collapse-ghost')) return null;

    /* cheap signature: item count + status classes + text; avoids re-cloning unchanged lists every sync */
    const sig = `${ul.children.length}|${ul.querySelectorAll(':scope > li.task-checked').length}|${
      ul.querySelectorAll(':scope > li > div.bg-primary:first-child').length
    }|${ul.textContent}`;
    const cached = todoParseCache.get(ul);
    if (cached && cached.sig === sig) return cached.items;
    const items = parseTodoUlUncached(ul);
    todoParseCache.set(ul, { sig, items });
    return items;
  }

  function normalizeTodoText(html) {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isChecklistEvolution(prevItems, nextItems) {
    if (!prevItems || !nextItems) return false;
    const a = prevItems.map((it) => normalizeTodoText(it.html));
    const b = nextItems.map((it) => normalizeTodoText(it.html));
    let matches = 0;
    for (const txtB of b) {
      if (!txtB) continue;
      const hit = a.some(
        (txtA) =>
          txtA === txtB ||
          (txtA.length >= 6 && txtB.length >= 6 && (txtA.includes(txtB.slice(0, 6)) || txtB.includes(txtA.slice(0, 6))))
      );
      if (hit) matches += 1;
    }
    return matches >= Math.max(1, Math.ceil(Math.min(a.length, b.length) * 0.4));
  }

  function iconForStatus(status) {
    return status === 'completed' ? SVG_DONE : status === 'in_progress' ? SVG_ACTIVE : SVG_PENDING;
  }

  function patchCardDom(card, items, paused) {
    if (paused) card.setAttribute('data-ag-todo-paused', 'true');
    else card.removeAttribute('data-ag-todo-paused');
    const sig = JSON.stringify(items);
    if (card.getAttribute('data-ag-todo-sig') === sig) return;
    card.setAttribute('data-ag-todo-sig', sig);

    const existingRows = Array.from(card.children).filter((el) => el.classList.contains('ag-claude-todo-row'));
    if (existingRows.length === items.length) {
      for (let i = 0; i < items.length; i++) {
        const row = existingRows[i];
        const it = items[i];
        const prevStatus = row.getAttribute('data-status');
        if (prevStatus !== it.status) {
          row.setAttribute('data-status', it.status);
          const ico = row.querySelector(':scope > .ag-todo-ico');
          if (ico) {
            ico.outerHTML = iconForStatus(it.status);
          }
        }
        const lbl = row.querySelector(':scope > .ag-claude-todo-label');
        if (lbl && lbl.innerHTML !== it.html) {
          lbl.innerHTML = it.html;
        }
      }
      return;
    }

    card.innerHTML = items
      .map(
        (it) =>
          `<div class="ag-claude-todo-row" data-status="${it.status}">${iconForStatus(it.status)}<span class="ag-claude-todo-label">${it.html}</span></div>`
      )
      .join('');
  }

  function removeInlineMount(ul) {
    if (ul.nextElementSibling && ul.nextElementSibling.hasAttribute('data-ag-todo-mount')) {
      ul.nextElementSibling.remove();
    }
  }

  function markMergedUl(ul) {
    ul.removeAttribute('data-ag-todo-primary');
    ul.setAttribute('data-ag-todo-merged', 'true');
    removeInlineMount(ul);
    const pWrap = ul.parentElement;
    if (pWrap && pWrap.children.length === 1) {
      pWrap.setAttribute('data-ag-todo-empty-wrap', 'true');
    }
  }

  function restoreNativeUl(ul) {
    ul.removeAttribute('data-ag-todo-primary');
    ul.removeAttribute('data-ag-todo-merged');
    removeInlineMount(ul);
    const pWrap = ul.parentElement;
    if (pWrap) pWrap.removeAttribute('data-ag-todo-empty-wrap');
  }

  function renderInlineTodoCard(anchorUl, items, paused) {
    anchorUl.setAttribute('data-ag-todo-primary', 'true');
    anchorUl.removeAttribute('data-ag-todo-merged');
    let card = anchorUl.nextElementSibling;
    if (!card || !card.hasAttribute('data-ag-todo-mount')) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      anchorUl.insertAdjacentElement('afterend', card);
    }
    patchCardDom(card, items, paused);
  }

  /* One pane = one composer input box + its conversation. Computed once per sync (panes are few). */
  const INPUT_BOX_SEL = '[id="antigravity.agentSidePanelInputBox"]';
  function collectPanes() {
    const panes = [];
    for (const inputBox of document.querySelectorAll(INPUT_BOX_SEL)) {
      let cur = inputBox.parentElement;
      for (let i = 0; i < 16 && cur; i++, cur = cur.parentElement) {
        if (cur.querySelector('[data-testid="agent-response"]')) {
          if (cur.querySelectorAll(INPUT_BOX_SEL).length === 1) panes.push({ root: cur, inputBox });
          break;
        }
      }
    }
    return panes;
  }

  function paneFor(el, panes) {
    for (const p of panes) if (p.root.contains(el)) return p;
    return null;
  }

  function isPaneActivelyGenerating(pane) {
    if (!pane) return false;
    const hasCancel = Boolean(pane.inputBox.querySelector('button[data-testid="input-cancel-button"]'));
    const now = Date.now();
    if (hasCancel) {
      paneLastActiveTs.set(pane.root, now);
      const pendingTimer = paneUndockTimers.get(pane.root);
      if (pendingTimer) {
        cancelLater(pendingTimer);
        paneUndockTimers.delete(pane.root);
      }
      return true;
    }
    const lastTs = paneLastActiveTs.get(pane.root) || 0;
    if (now - lastTs < 280) {
      if (!paneUndockTimers.has(pane.root)) {
        const tid = later(() => {
          paneUndockTimers.delete(pane.root);
          scheduleSync();
        }, 300);
        paneUndockTimers.set(pane.root, tid);
      }
      return true;
    }
    return false;
  }

  function renderLiveDockedTodoCard(turnEl, items) {
    if (!turnEl) return false;
    let dock = turnEl.querySelector(':scope > [data-ag-todo-dock="true"]');
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ag-claude-todo-live-dock';
      dock.setAttribute('data-ag-todo-dock', 'true');
      turnEl.appendChild(dock);
    } else if (turnEl.lastElementChild !== dock) {
      turnEl.appendChild(dock);
    }
    let card = dock.querySelector(':scope > .ag-claude-todo-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      dock.appendChild(card);
    }
    patchCardDom(card, items, false);
    return dock;
  }

  function isAllTodoCompleted(items) {
    return Boolean(items && items.length > 0 && items.every((it) => it.status === 'completed'));
  }

  function hasActiveTodo(items) {
    return Boolean(items && items.some((it) => it.status === 'in_progress'));
  }

  /*
   * Per-turn checklist memory. Antigravity virtualises the step stream: once a mid-turn narration scrolls out
   * of its render window the node (and its checklist) is unmounted, leaving only the turn's first list and the
   * final summary in the DOM. Every checklist version seen while mounted is remembered here, keyed by content
   * signature (so a version re-mounted by scrolling up keeps its original order). The newest version is the one
   * with the most progress; ties go to the one seen last.
   */
  const turnTodoMemory = new WeakMap();
  let todoSeenSeq = 0;
  function todoSignature(items) {
    return items.map((it) => `${it.status.charAt(0)}:${normalizeTodoText(it.html)}`).join('|');
  }
  function todoProgress(items) {
    let score = 0;
    for (const it of items) score += it.status === 'completed' ? 2 : it.status === 'in_progress' ? 1 : 0;
    return score;
  }
  function rememberTurnTodo(turnEl, items) {
    if (!turnEl || !items) return;
    let mem = turnTodoMemory.get(turnEl);
    if (!mem) {
      mem = new Map();
      turnTodoMemory.set(turnEl, mem);
    }
    const sig = todoSignature(items);
    if (!mem.has(sig)) mem.set(sig, { seq: ++todoSeenSeq, items, progress: todoProgress(items) });
  }
  function latestRememberedTodo(turnEl, baseItems) {
    const mem = turnEl && turnTodoMemory.get(turnEl);
    if (!mem || !baseItems) return null;
    let best = null;
    for (const rec of mem.values()) {
      if (!isChecklistEvolution(baseItems, rec.items)) continue;
      if (!best || rec.progress > best.progress || (rec.progress === best.progress && rec.seq > best.seq)) best = rec;
    }
    if (!best || todoProgress(baseItems) > best.progress) return null;
    return best.items;
  }

  /*
   * Mid-turn narration is frequently NOT rendered as markdown: Antigravity stores the text that accompanies tool
   * calls in the planner step's `thinking` field and shows it inside the (often collapsed) tool group, so no
   * <ul class="contains-task-list"> ever exists for it. Read checklists straight from the step data instead.
   */
  const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/])\]\s+(.+?)\s*$/;
  function stripFencedCode(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '');
  }
  function stripAllCode(md) {
    return stripFencedCode(md).replace(/`[^`\n]+`/g, '');
  }
  function renderInlineMd(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function extractTaskLists(md) {
    const lists = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2 && cur.length <= 15) lists.push(cur);
      cur = null;
    };
    for (const line of stripFencedCode(md).split('\n')) {
      const m = line.match(TASK_LINE_RE);
      if (m) {
        if (!cur) cur = [];
        const mark = m[1];
        cur.push({
          status: mark === '/' ? 'in_progress' : mark === ' ' ? 'pending' : 'completed',
          html: renderInlineMd(m[2])
        });
      } else if (line.trim() || cur === null) {
        flush();
      }
    }
    flush();
    return lists;
  }
  /*
   * The turn container's props hold the complete, ordered step list (independent of what is mounted).
   * Crucial React 18/19 detail: `turnEl.__reactFiber$` is bound at initial mount and is NOT swapped when React
   * commits to `fiber.alternate`; we therefore inspect BOTH `f` and `f.alternate` and pick the fresher step array.
   * Mid-turn progress is signalled via an invisible HTML comment `<!-- todo:N/M -->` (never shown in prose), with
   * fenced & inline code stripped first so prose examples like `` `〔进度 2/4〕` `` can never pollute progress state.
   */
  const PROGRESS_RE =
    /<!--\s*todo\s*:\s*(\d+)\s*\/\s*(\d+)\s*-->|〔\s*进度\s*(\d+)\s*\/\s*(\d+)\s*〕|\[\s*progress\s*(\d+)\s*\/\s*(\d+)\s*\]/gi;
  const LEGACY_MARKER_LINE_RE = /^\s*(?:〔\s*进度\s*\d+\s*\/\s*\d+\s*〕|\[\s*progress\s*\d+\s*\/\s*\d+\s*\])[^\n]*$/i;
  const turnProgressByTotal = new WeakMap();
  const stepScanState = new WeakMap();

  function hideLegacyProgressParagraphs() {
    for (const p of document.querySelectorAll('[data-testid="agent-response"] p')) {
      if (p.hasAttribute('data-ag-todo-marker-line')) continue;
      if (LEGACY_MARKER_LINE_RE.test((p.textContent || '').trim())) {
        p.setAttribute('data-ag-todo-marker-line', 'true');
        const pWrap = p.parentElement;
        if (pWrap && pWrap.children.length === 1) {
          pWrap.setAttribute('data-ag-todo-empty-wrap', 'true');
        }
      }
    }
  }

  function stepsFromFiberBranch(f) {
    const p = f && f.memoizedProps;
    return p && p.container && Array.isArray(p.container.steps) ? p.container.steps : null;
  }

  function stepTailSig(steps) {
    if (!steps || !steps.length) return 0;
    const last = steps[steps.length - 1];
    const v = last && last.step && last.step.value;
    const txt = v && typeof v === 'object' ? v.modifiedResponse || v.response || '' : '';
    return steps.length * 1000000 + txt.length;
  }

  function turnStepsOf(turnEl) {
    const fk = Object.keys(turnEl).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? turnEl[fk] : null;
    let best = null;
    for (let i = 0; i < 8 && f; i++, f = f.return) {
      const a = stepsFromFiberBranch(f);
      const b = stepsFromFiberBranch(f.alternate);
      const pick = stepTailSig(b) > stepTailSig(a) ? b : a;
      if (pick && stepTailSig(pick) > stepTailSig(best)) {
        best = pick;
      }
      if (best) break;
    }
    return best;
  }

  function turnContinuesChecklist(turnEl, baseItems) {
    if (!turnEl || !baseItems || !baseItems.length) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (mem && mem.size > 0) {
      for (const rec of mem.values()) {
        if (isChecklistEvolution(baseItems, rec.items)) return true;
      }
      return false;
    }
    const byTotal = turnProgressByTotal.get(turnEl);
    return Boolean(byTotal && byTotal.has(baseItems.length));
  }

  function recordProgressMarker(turnEl, total, n) {
    if (!turnEl || !(n >= 1 && total >= n && total <= 15)) return false;
    let byTotal = turnProgressByTotal.get(turnEl);
    if (!byTotal) {
      byTotal = new Map();
      turnProgressByTotal.set(turnEl, byTotal);
    }
    const prev = byTotal.get(total) || 0;
    if (n > prev) {
      byTotal.set(total, n);
      return true;
    }
    return false;
  }

  function harvestStepChecklists(turnEl, isLiveTurn = true) {
    if (!turnEl) return false;
    const steps = turnStepsOf(turnEl);
    if (!steps || !steps.length) return false;
    let changed = false;
    const lastIdx = steps.length - 1;
    for (let idx = 0; idx < steps.length; idx++) {
      const s = steps[idx];
      const v = s && s.step && s.step.case === 'plannerResponse' ? s.step.value : null;
      if (!v || typeof v !== 'object') continue;
      const text = v.modifiedResponse || v.response || '';
      if (!text) continue;
      /* Re-evaluate the trailing planner step on live turns in case SSE appended `<!-- todo:N/M -->` without a DOM childList mutation */
      if ((!isLiveTurn || idx < lastIdx) && stepScanState.get(v) === text.length) continue;
      stepScanState.set(v, text.length);

      for (const items of extractTaskLists(text)) {
        const before = latestRememberedTodo(turnEl, items);
        rememberTurnTodo(turnEl, items);
        const after = latestRememberedTodo(turnEl, items);
        if (after && (!before || todoSignature(after) !== todoSignature(before))) changed = true;
      }

      const cleanText = stripAllCode(text);
      PROGRESS_RE.lastIndex = 0;
      let m;
      while ((m = PROGRESS_RE.exec(cleanText))) {
        const n = Number(m[1] || m[3] || m[5]);
        const total = Number(m[2] || m[4] || m[6]);
        if (recordProgressMarker(turnEl, total, n)) changed = true;
      }
    }
    return changed;
  }

  function applyProgressMarker(turnEls, items) {
    if (!items || !items.length) return items;
    const list = Array.isArray(turnEls) ? turnEls : [turnEls];
    let maxN = 0;
    for (const t of list) {
      const byTotal = t && turnProgressByTotal.get(t);
      const n = byTotal ? byTotal.get(items.length) || 0 : 0;
      if (n > maxN) maxN = n;
    }
    if (!maxN) return items;
    const next = items.map((it, i) => ({
      status: i < maxN - 1 ? 'completed' : i === maxN - 1 ? 'in_progress' : 'pending',
      html: it.html
    }));
    return todoProgress(next) > todoProgress(items) ? next : items;
  }

  const sliceStepSeen = new WeakSet();
  const paneSliceActiveOrigins = new WeakMap();

  function sliceStepsFromBranch(f) {
    const ts = f && f.memoizedProps && f.memoizedProps.trajectorySlice;
    return ts && Array.isArray(ts.stepsInSlice) ? ts.stepsInSlice : null;
  }

  function harvestPaneSliceOrigins(pane) {
    if (!pane || !pane.root) return;
    const vp = pane.root.querySelector('[data-testid="autoscroll-viewport"]');
    if (!vp) return;
    const fk = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? vp[fk] : null;
    let sliceSteps = null;
    for (let i = 0; i < 12 && f; i++, f = f.return) {
      const a = sliceStepsFromBranch(f);
      const b = sliceStepsFromBranch(f.alternate);
      const pick = (b ? b.length : 0) > (a ? a.length : 0) ? b : a;
      if (pick && pick.length) {
        sliceSteps = pick;
        break;
      }
    }
    if (!sliceSteps) return;
    let origins = paneSliceActiveOrigins.get(pane.root);
    if (!origins) {
      origins = new Map();
      paneSliceActiveOrigins.set(pane.root, origins);
    }
    for (let i = 0; i < sliceSteps.length; i++) {
      const s = sliceSteps[i];
      const v = s && s.step && s.step.case === 'plannerResponse' ? s.step.value : null;
      if (!v || typeof v !== 'object' || sliceStepSeen.has(v)) continue;
      const text = v.modifiedResponse || v.response || '';
      if (!text) continue;
      sliceStepSeen.add(v);
      for (const items of extractTaskLists(text)) {
        if (hasActiveTodo(items)) {
          origins.set(todoSignature(items), items);
        }
      }
    }
  }

  function paneHasSliceActiveOrigin(pane, items) {
    const origins = pane && paneSliceActiveOrigins.get(pane.root);
    if (!origins || !items) return false;
    for (const originItems of origins.values()) {
      if (isChecklistEvolution(originItems, items)) return true;
    }
    return false;
  }

  function turnHasActiveTodoOrigin(turnEl, items) {
    if (!turnEl || !items) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (!mem) return false;
    for (const rec of mem.values()) {
      if (hasActiveTodo(rec.items) && isChecklistEvolution(rec.items, items)) return true;
    }
    return false;
  }

  function turnHasUnclaimedProgressMarker(turnEl, total) {
    const byTotal = turnEl && turnProgressByTotal.get(turnEl);
    if (!byTotal || !byTotal.has(total)) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (!mem) return true;
    for (const rec of mem.values()) {
      if (rec.items.length === total && isAllTodoCompleted(rec.items)) return false;
    }
    return true;
  }

  /*
   * When mid-turn planner steps are collapsed (`worked-for-collapsible` / `progress-updates-collapsible`) or
   * earlier turns in a multi-turn task are virtual-scroll unmounted by `autoscroll-viewport` (`v2.33.0+`),
   * only the final all-`[x]` `<ul>` may be mounted in the DOM. Check:
   *  1) `turnTodoMemory` (`[/]` evolution) or own `<!-- todo:N/M -->` marker on `turnEl`;
   *  2) preceding mounted `paneTurns` (`[/]` evolution, or an unclaimed `<!-- todo:N/M -->` sub-turn not yet closed);
   *  3) unmounted `[/]` origins in `trajectorySlice.stepsInSlice` on `autoscroll-viewport`.
   * Ordinary `[ ] / [x]` answer checklists (which never had an `[/]` step or `<!-- todo:N/M -->`) stay untouched.
   */
  function findStepActiveOriginTurns(pane, paneTurns, turnEl, items) {
    if (!items) return { matched: false, turns: [] };
    if (turnEl) {
      const ownMarkers = turnProgressByTotal.get(turnEl);
      if ((ownMarkers && ownMarkers.has(items.length)) || turnHasActiveTodoOrigin(turnEl, items)) {
        return { matched: true, turns: [turnEl] };
      }
    }
    if (paneTurns && paneTurns.length) {
      const endIdx = turnEl ? paneTurns.indexOf(turnEl) : -1;
      const upper = endIdx >= 0 ? endIdx : paneTurns.length;
      let seenInterveningCompletedSameLen = false;
      for (let i = upper - 1; i >= 0; i--) {
        const prevTurn = paneTurns[i];
        if (turnHasActiveTodoOrigin(prevTurn, items)) {
          return { matched: true, turns: turnEl ? [prevTurn, turnEl] : [prevTurn] };
        }
        if (!seenInterveningCompletedSameLen && turnHasUnclaimedProgressMarker(prevTurn, items.length)) {
          return { matched: true, turns: turnEl ? [prevTurn, turnEl] : [prevTurn] };
        }
        const prevMem = turnTodoMemory.get(prevTurn);
        if (prevMem) {
          for (const rec of prevMem.values()) {
            if (rec.items.length === items.length && isAllTodoCompleted(rec.items)) {
              seenInterveningCompletedSameLen = true;
            }
          }
        }
      }
    }
    if (pane && paneHasSliceActiveOrigin(pane, items)) {
      return { matched: true, turns: turnEl ? [turnEl] : [] };
    }
    return { matched: false, turns: [] };
  }

  function bestRememberedInTurn(turnEl) {
    const mem = turnEl && turnTodoMemory.get(turnEl);
    if (!mem || mem.size === 0) return null;
    let best = null;
    for (const rec of mem.values()) {
      if (!best || rec.progress > best.progress || (rec.progress === best.progress && rec.seq > best.seq)) {
        best = rec;
      }
    }
    return best;
  }

  function turnContinuesChecklist(turnEl, baseItems) {
    if (!turnEl || !baseItems || !baseItems.length) return false;
    const mem = turnTodoMemory.get(turnEl);
    if (mem && mem.size > 0) {
      for (const rec of mem.values()) {
        if (isChecklistEvolution(baseItems, rec.items)) return true;
      }
      return false;
    }
    const byTotal = turnProgressByTotal.get(turnEl);
    return Boolean(byTotal && byTotal.has(baseItems.length));
  }

  /**
   * Only *execution-progress* checklists are taken over:
   *  - a cluster starts with a list containing an active `[/]` item (either mounted in DOM or recorded in
   *    `container.steps` when Knowledge Work mode hides mid-turn steps);
   *  - later lists join it when they evolve from it (same items) or, across turns, when they still look like
   *    progress (`[/]` present or 100% done).
   * Ordinary answer checklists (materials, review points: only `[ ]` / `[x]`, no `[/]` anywhere) stay native.
   * A taken-over list is never hidden without a visible replacement card.
   */
  function syncTodoCards(panes) {
    const touched = new Set();
    const activeDocks = new Set();

    if (FEAT.todoCard) {
      hideLegacyProgressParagraphs();

      const paneMeta = new Map();
      for (const pane of panes) {
        const paneLive = isPaneActivelyGenerating(pane);
        const paneTurns = Array.from(pane.root.querySelectorAll('[data-testid="agent-response"]'));
        const latestPaneTurn = paneTurns.length ? paneTurns[paneTurns.length - 1] : null;
        harvestPaneSliceOrigins(pane);
        for (const tEl of paneTurns) {
          harvestStepChecklists(tEl, paneLive && tEl === latestPaneTurn);
        }
        paneMeta.set(pane, { paneLive, paneTurns, latestPaneTurn });
      }

      const byPane = new Map();
      for (const ul of document.querySelectorAll('ul.contains-task-list')) {
        const items = parseTodoUl(ul);
        if (!items) continue;
        const turnEl = ul.closest('[data-testid="agent-response"]');
        const pane = turnEl ? paneFor(turnEl, panes) : null;
        if (turnEl && !pane) harvestStepChecklists(turnEl, false);
        const key = pane || ul; /* orphan lists form their own group */
        let group = byPane.get(key);
        if (!group) {
          group = { pane, entries: [] };
          byPane.set(key, group);
        }
        group.entries.push({ ul, items, turnEl });
        rememberTurnTodo(turnEl, items);
      }

      const handledLiveTurns = new Set();

      for (const group of byPane.values()) {
        const meta = group.pane ? paneMeta.get(group.pane) : null;
        const paneTurns = meta ? meta.paneTurns : null;
        const paneLive = Boolean(meta && meta.paneLive);
        const latestPaneTurn = meta ? meta.latestPaneTurn : null;

        const clusters = [];
        for (const entry of group.entries) {
          const last = clusters[clusters.length - 1];
          const active = hasActiveTodo(entry.items);
          let join = false;
          if (last) {
            const evolved = isChecklistEvolution(last.items, entry.items);
            const sameTurn = Boolean(entry.turnEl && last.lastTurnEl === entry.turnEl);
            if (sameTurn) {
              join = evolved;
            } else {
              const looksLikeProgress = active || isAllTodoCompleted(entry.items);
              join = evolved || (!isAllTodoCompleted(last.items) && looksLikeProgress);
            }
          }
          if (join) {
            last.lists.push(entry.ul);
            last.items = entry.items;
            if (entry.turnEl) {
              last.lastTurnEl = entry.turnEl;
              if (!last.turnEls.includes(entry.turnEl)) last.turnEls.push(entry.turnEl);
            }
          } else {
            const origin = active
              ? { matched: true, turns: entry.turnEl ? [entry.turnEl] : [] }
              : findStepActiveOriginTurns(group.pane, paneTurns, entry.turnEl, entry.items);
            if (origin.matched) {
              clusters.push({
                lists: [entry.ul],
                items: entry.items,
                lastTurnEl: entry.turnEl || null,
                turnEls: origin.turns.length ? origin.turns : entry.turnEl ? [entry.turnEl] : []
              });
            }
          }
          /* else: ordinary checklist, left untouched */
        }

        for (let i = 0; i < clusters.length; i++) {
          const cluster = clusters[i];
          for (const ul of cluster.lists) touched.add(ul);

          /* Only relay a prior incomplete checklist into latestPaneTurn when latestPaneTurn itself signals
             continuation (`<!-- todo:N/M -->` or an evolved checklist), preventing old cards from resurrecting on fresh prompts */
          const isLastCluster = i === clusters.length - 1;
          const relayedIntoLatest =
            paneLive &&
            isLastCluster &&
            Boolean(latestPaneTurn) &&
            cluster.lastTurnEl !== latestPaneTurn &&
            !isAllTodoCompleted(cluster.items) &&
            turnContinuesChecklist(latestPaneTurn, cluster.items);
          const candidateTurns =
            relayedIntoLatest && !cluster.turnEls.includes(latestPaneTurn)
              ? [...cluster.turnEls, latestPaneTurn]
              : cluster.turnEls;

          /* Scan forward across mounted turns in case a later step / split turn recorded an all-[x] completion */
          const firstTurnIdx = paneTurns && cluster.turnEls.length ? paneTurns.indexOf(cluster.turnEls[0]) : -1;
          const memoryScanTurns = paneTurns && firstTurnIdx >= 0 ? paneTurns.slice(firstTurnIdx) : candidateTurns;
          for (const tEl of memoryScanTurns) {
            const remembered = latestRememberedTodo(tEl, cluster.items);
            if (remembered) cluster.items = remembered;
          }
          cluster.items = applyProgressMarker(candidateTurns, cluster.items);

          const isDockedLiveCluster =
            paneLive &&
            isLastCluster &&
            Boolean(latestPaneTurn) &&
            (cluster.lastTurnEl === latestPaneTurn || relayedIntoLatest);
          const mountedDock = isDockedLiveCluster ? renderLiveDockedTodoCard(latestPaneTurn, cluster.items) : null;

          if (mountedDock) {
            handledLiveTurns.add(latestPaneTurn);
            activeDocks.add(mountedDock);
            for (const ul of cluster.lists) markMergedUl(ul);
          } else {
            /* finished (100%) or paused/interrupted: keep a visible card at the latest list */
            const anchorUl = cluster.lists[cluster.lists.length - 1];
            for (let j = 0; j < cluster.lists.length - 1; j++) markMergedUl(cluster.lists[j]);
            renderInlineTodoCard(anchorUl, cluster.items, !isAllTodoCompleted(cluster.items));
          }
        }
      }

      /* Fallback when ALL <ul> nodes in the live turn were unmounted off-screen or hidden in Knowledge Work mode */
      for (const pane of panes) {
        const meta = paneMeta.get(pane);
        if (!meta || !meta.paneLive || !meta.latestPaneTurn || handledLiveTurns.has(meta.latestPaneTurn)) continue;
        const { paneTurns, latestPaneTurn } = meta;
        let best = bestRememberedInTurn(latestPaneTurn);
        let turnScope = [latestPaneTurn];
        if (!best && paneTurns.length >= 2) {
          const prevTurn = paneTurns[paneTurns.length - 2];
          const prevBest = bestRememberedInTurn(prevTurn);
          if (
            prevBest &&
            !isAllTodoCompleted(prevBest.items) &&
            turnContinuesChecklist(latestPaneTurn, prevBest.items)
          ) {
            best = prevBest;
            turnScope = [prevTurn, latestPaneTurn];
          }
        }
        if (best && (hasActiveTodo(best.items) || turnScope.some((t) => turnHasActiveTodoOrigin(t, best.items)))) {
          const items = applyProgressMarker(turnScope, best.items);
          const mountedDock = renderLiveDockedTodoCard(latestPaneTurn, items);
          if (mountedDock) activeDocks.add(mountedDock);
        }
      }
    }

    /* release lists we no longer own (re-render, rule change, feature off) */
    for (const ul of document.querySelectorAll('ul[data-ag-todo-merged], ul[data-ag-todo-primary]')) {
      if (!touched.has(ul)) restoreNativeUl(ul);
    }
    for (const card of document.querySelectorAll('[data-ag-todo-mount]')) {
      if (card.parentElement && card.parentElement.hasAttribute('data-ag-todo-dock')) continue;
      const prev = card.previousElementSibling;
      if (!prev || !prev.hasAttribute('data-ag-todo-primary')) card.remove();
    }
    for (const dock of document.querySelectorAll('[data-ag-todo-dock="true"]')) {
      if (!activeDocks.has(dock)) dock.remove();
    }
  }

  function isActivelyRunningRow(el, isLastCandidate, turnGenerating) {
    if (!turnGenerating || !isLastCandidate) return false;
    if (el.getAttribute('data-testid') === 'ephemeral-tool-status') return true;
    const span = el.querySelector(':scope > span[title], :scope > span[data-ag-orig-title]');
    const raw =
      (span && (span.getAttribute('data-ag-orig-title') || span.getAttribute('title'))) ||
      el.getAttribute('data-ag-orig-aria-label') ||
      el.getAttribute('aria-label') ||
      el.textContent ||
      '';
    return !PAST_LABEL_RE.test(raw.trim());
  }

  function syncRunningToolIndicators(panesArg) {
    if (disposed) return;
    const candidates = FEAT.runningTimer
      ? Array.from(document.querySelectorAll('button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"]'))
      : [];
    const panes = panesArg || collectPanes();
    const globalGenerating = Boolean(document.querySelector('button[data-testid="input-cancel-button"]'));

    /* "last row" and "generating" are evaluated per pane, so a busy pane never lights up another one */
    const lastInPane = new Map();
    const paneOfEl = new Map();
    for (const el of candidates) {
      const pane = paneFor(el, panes);
      paneOfEl.set(el, pane);
      lastInPane.set(pane, el);
    }
    const generatingCache = new Map();
    const paneGenerating = (pane) => {
      if (!pane) return panes.length === 0 && globalGenerating;
      if (!generatingCache.has(pane)) {
        generatingCache.set(pane, Boolean(pane.inputBox.querySelector('button[data-testid="input-cancel-button"]')));
      }
      return generatingCache.get(pane);
    };

    let activeCount = 0;
    const now = Date.now();
    for (const el of candidates) {
      const pane = paneOfEl.get(el);
      const isRunning = isActivelyRunningRow(el, lastInPane.get(pane) === el, paneGenerating(pane));
      let orbit = el.querySelector(':scope > .ag-orbit-dots');
      let timerEl = el.querySelector(':scope > .ag-elapsed-timer');

      if (isRunning) {
        activeCount += 1;
        let startTs = runningTimers.get(el);
        if (!startTs) {
          startTs = now;
          runningTimers.set(el, startTs);
        }
        if (!orbit) {
          orbit = document.createElement('span');
          orbit.className = 'ag-orbit-dots';
          orbit.setAttribute('aria-hidden', 'true');
          orbit.innerHTML = '<i></i><i></i>';
          el.insertBefore(orbit, el.firstChild);
        }
        const secs = Math.max(1, Math.floor((now - startTs) / 1000));
        if (!timerEl) {
          timerEl = document.createElement('span');
          timerEl.className = 'ag-elapsed-timer';
          const chevron = el.querySelector(':scope > svg');
          if (chevron) {
            el.insertBefore(timerEl, chevron);
          } else {
            el.appendChild(timerEl);
          }
        }
        const txt = `${secs}s`;
        if (timerEl.textContent !== txt) timerEl.textContent = txt;
      } else {
        if (orbit) orbit.remove();
        if (timerEl) timerEl.remove();
        runningTimers.delete(el);
      }
    }
    /* stale indicators on rows that are no longer candidates */
    if (!FEAT.runningTimer) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
    }

    const keepPolling = activeCount > 0 || (FEAT.todoCard && globalGenerating);
    if (keepPolling && !timerIntervalId) {
      timerIntervalId = setInterval(() => {
        const ps = collectPanes();
        syncTodoCards(ps);
        syncRunningToolIndicators(ps);
      }, 1000);
    } else if (!keepPolling && timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  let lastSyncTs = 0;
  function syncStepStream() {
    rafPending = false;
    if (disposed) return;
    lastSyncTs = Date.now();
    if (FEAT.stepUnfold) {
      const workedBtns = document.querySelectorAll('button[data-testid="worked-for-collapsible"]');
      for (const btn of workedBtns) {
        const wrap = btn.parentElement;
        if (wrap && !wrap.hasAttribute('data-ag-inline-stream')) {
          wrap.setAttribute('data-ag-inline-stream', 'true');
        }
        if (btn.getAttribute('aria-expanded') === 'false' && !userToggled.has(btn)) {
          /* bounded: never fight the app in a click loop if it keeps re-collapsing the same node */
          const n = autoExpandCount.get(btn) || 0;
          if (n < 3) {
            autoExpandCount.set(btn, n + 1);
            btn.click();
          }
        }
      }
    }
    if (FEAT.collapseAnim) captureOpenToolPanels();
    const panes = collectPanes();
    syncTodoCards(panes);
    syncRunningToolIndicators(panes);
    if (FEAT.contextRing) {
      ensureMetricsWrapped();
      ensureComposerContextRing();
      syncCompactVisualState(false);
    } else {
      const oldRing = document.getElementById('ag-claude-ctx-ring');
      if (oldRing) oldRing.remove();
      if (typeof closeQuotaPopover === 'function') closeQuotaPopover();
    }
    syncSidebarEnhancements();
    reconcileSettingsPanel();
  }

  /* ==========================================================================
   * 5. Claude-Style Composer Context Ring + Live Plan Quota Popover + Slim Pill
   *    - Strips `Ctx ...`, `Out ...` & `+N sub` from `#ag-live-metrics-pill` while keeping `tok/s · TTFT`
   *    - Transforms `#ag-live-metrics-tooltip` into a compact 272px two-section Claude popover (with TTFT)
   *    - Mounts radial context progress ring right beside the Model Selector
   *    - Clicking opens real-time Usage Popover (`retrieveUserQuotaSummary` 5h & weekly buckets)
   * ========================================================================== */
  const RING_CIRC = 2 * Math.PI * 7;
  const SVG_COMPACT_ICON =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4.5 2.75L8 6.25L11.5 2.75M4.5 13.25L8 9.75L11.5 13.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  const SVG_COMPACT_DONE =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3.5 8.3L6.6 11.4L12.6 4.8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  let cachedQuotaSvc = null;
  let cachedUserTierName = '';
  let cachedQuotaGroups = null;
  let lastQuotaFetchTs = 0;
  let quotaFetchInFlight = null;
  let quotaPopoverOpen = false;
  let selectedQuotaGroupIdx = -1;
  let latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: '' };
  let manualCompactPending = { cascadeId: '', startedAt: 0 };
  let compactedStaleSigByCid = new Map();
  let lastObservedCompactKey = '';
  let compactPollTimerId = null;

  function getActiveCascadeId() {
    const m = (window.location.pathname || '').match(/\/c\/([0-9a-f-]+)/i);
    if (m) return m[1];
    if (window.__ag_watched_cascade_id) return String(window.__ag_watched_cascade_id);
    const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    return (sel && sel.getAttribute('data-cascade-id')) || '';
  }

  function discoverAgentInputProps() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && typeof pr.handleSubmit === 'function') return pr;
    }
    return null;
  }

  function discoverComposerContextFromInputBox() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && pr.value && pr.value.inputBoxRef) return pr.value;
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        const v = dep.memoizedValue;
        if (v && typeof v === 'object' && v.inputBoxRef) return v;
        dep = dep.next;
      }
    }
    return null;
  }

  function isPaneCurrentlyRunning(agentPropsArg) {
    const pr = agentPropsArg !== undefined ? agentPropsArg : discoverAgentInputProps();
    if (pr && typeof pr.isRunning === 'boolean') return pr.isRunning;
    return Boolean(document.querySelector('button[data-testid="input-cancel-button"]'));
  }

  function isCompactUserStepObj(s) {
    if (!s || (s.type !== 14 && (!s.step || s.step.case !== 'userInput'))) return false;
    const val = s.step && s.step.value;
    if (!val) return false;
    if (/^\s*\/compact\b/i.test(String(val.userResponse || ''))) return true;
    if (Array.isArray(val.items)) {
      return val.items.some(
        (it) =>
          it &&
          it.chunk &&
          it.chunk.case === 'item' &&
          it.chunk.value &&
          it.chunk.value.scopeItem &&
          it.chunk.value.scopeItem.case === 'slashCommand' &&
          it.chunk.value.scopeItem.value &&
          it.chunk.value.scopeItem.value.info &&
          it.chunk.value.scopeItem.value.info.name === 'compact'
      );
    }
    return false;
  }

  function isDomCompactUserStep(stepEl) {
    if (!stepEl) return false;
    if (stepEl.querySelector('[data-uri="slashCommand:compact"]')) return true;
    const contentEl = stepEl.querySelector('[data-testid="user-message-content"]');
    const raw = ((contentEl || stepEl).textContent || '').trim();
    return /^\/?compact$/i.test(raw);
  }

  function domTurnHasAssistantContent(turnEl) {
    if (!turnEl) return false;
    return Boolean(
      turnEl.querySelector(
        'button[data-testid="worked-for-collapsible"], [data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"], .prose, p, pre, ul, ol'
      )
    );
  }

  function currentCtxStaleSig() {
    if (!latestCtxState.hasData) return '';
    return `${latestCtxState.ratioText}|${latestCtxState.outText}|${latestCtxState.pct}`;
  }

  /* Real-time /compact detector:
   * `daemon.mjs` reads `gen_metadata` (whose last row right after `/compact` is the summarization call itself, e.g. 483k/94%),
   * and `CHECKPOINT` (`step_type = 23`) writes no post-compact `gen_metadata` row until the user sends a new message.
   * Inspecting live `trajectorySlice` (with DOM fallback) lets the ring, popover & tooltip reflect `compacting` / `compacted` immediately. */
  function detectCompactStatus(curCidArg) {
    const curCid = curCidArg !== undefined ? curCidArg : getActiveCascadeId();
    const agentProps = discoverAgentInputProps();
    const running = isPaneCurrentlyRunning(agentProps);
    const cidKey = curCid || '__active__';
    const curSig = currentCtxStaleSig();

    const viewports = document.querySelectorAll('[data-testid="autoscroll-viewport"], .overflow-y-auto');
    for (const vp of viewports) {
      const fk = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? vp[fk] : null;
      for (let i = 0; i < 35 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        const slice = p && p.trajectorySlice;
        if (!slice || !Array.isArray(slice.stepsInSlice)) continue;
        if (curCid && slice.conversationId && slice.conversationId !== curCid) break;

        const arr = slice.stepsInSlice;
        let lastCompactUserIdx = -1;
        let lastCheckpointIdx = -1;
        let lastCheckpointStep = null;
        let lastRegularUserIdx = -1;
        let lastPlannerIdx = -1;

        for (let idx = 0; idx < arr.length; idx++) {
          const s = arr[idx];
          if (!s) continue;
          const sc = (s.step && s.step.case) || '';
          if (sc === 'checkpoint' || s.type === 23) {
            lastCheckpointIdx = idx;
            lastCheckpointStep = s;
          } else if (sc === 'userInput' || s.type === 14) {
            if (isCompactUserStepObj(s)) lastCompactUserIdx = idx;
            else lastRegularUserIdx = idx;
          } else if (sc === 'plannerResponse' || s.type === 15) {
            lastPlannerIdx = idx;
          }
        }

        const anchorIdx = Math.max(lastCompactUserIdx, lastCheckpointIdx);
        if (anchorIdx >= 0 && lastRegularUserIdx < anchorIdx && lastPlannerIdx < anchorIdx) {
          manualCompactPending = { cascadeId: '', startedAt: 0 };
          const cpStatus = lastCheckpointStep ? lastCheckpointStep.status : undefined;
          const cpFailed = Boolean(
            (lastCheckpointStep && lastCheckpointStep.step && lastCheckpointStep.step.value && lastCheckpointStep.step.value.modelSummarizationFailed) ||
              (typeof cpStatus === 'number' && cpStatus > 3)
          );
          if (cpFailed) {
            compactedStaleSigByCid.delete(cidKey);
            return 'idle';
          }
          if (running || (typeof cpStatus === 'number' && cpStatus > 0 && cpStatus < 3)) {
            return 'compacting';
          }
          if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
          return 'compacted';
        }

        if (anchorIdx >= 0 && lastRegularUserIdx > anchorIdx) {
          const staleSig = compactedStaleSigByCid.get(cidKey);
          if (staleSig && curSig && staleSig === curSig && running) {
            return 'compacted';
          }
          if (staleSig && curSig && staleSig !== curSig) {
            compactedStaleSigByCid.delete(cidKey);
          }
        }

        if (
          manualCompactPending.cascadeId === cidKey &&
          Date.now() - manualCompactPending.startedAt < 15000
        ) {
          return 'compacting';
        }
        return 'idle';
      }
    }

    /* DOM fallback (covers jsdom unit tests & early mounts before trajectorySlice attaches) */
    const flowNodes = Array.from(
      document.querySelectorAll('[data-testid="user-input-step"], [data-testid="agent-response"]')
    );
    let lastUserFlowIdx = -1;
    for (let i = flowNodes.length - 1; i >= 0; i--) {
      if (flowNodes[i].getAttribute('data-testid') === 'user-input-step') {
        lastUserFlowIdx = i;
        break;
      }
    }
    if (lastUserFlowIdx >= 0 && isDomCompactUserStep(flowNodes[lastUserFlowIdx])) {
      const hasReplyAfter = flowNodes
        .slice(lastUserFlowIdx + 1)
        .some((el) => el.getAttribute('data-testid') === 'agent-response' && domTurnHasAssistantContent(el));
      if (!hasReplyAfter) {
        manualCompactPending = { cascadeId: '', startedAt: 0 };
        if (running) return 'compacting';
        if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
        return 'compacted';
      }
    }

    const staleSig = compactedStaleSigByCid.get(cidKey);
    if (staleSig && curSig) {
      if (staleSig === curSig && running) return 'compacted';
      if (staleSig !== curSig) compactedStaleSigByCid.delete(cidKey);
    }

    if (
      manualCompactPending.cascadeId === cidKey &&
      Date.now() - manualCompactPending.startedAt < 15000
    ) {
      return 'compacting';
    }
    return 'idle';
  }

  function extractCompactLabels(ctxState) {
    const rawRatio = String((ctxState && ctxState.ratioText) || '');
    const parts = rawRatio.split('/');
    const preUsed = (parts[0] || '').trim();
    const limitLabel = (parts[1] || '').trim();
    const sumOut = String((ctxState && ctxState.outText) || '')
      .replace(/^Out\s+/i, '')
      .trim();
    return { preUsed, limitLabel, sumOut };
  }

  function ensureCompactPollTimer() {
    if (compactPollTimerId || disposed) return;
    compactPollTimerId = setInterval(() => {
      if (disposed) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
        return;
      }
      const st = detectCompactStatus();
      syncCompactVisualState(false);
      if (st !== 'compacting' && !quotaPopoverOpen) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
      }
    }, 500);
  }

  function syncCompactVisualState(forceRender) {
    if (disposed || !FEAT.contextRing) return;
    const curCid = getActiveCascadeId();
    const st = detectCompactStatus(curCid);
    const running = isPaneCurrentlyRunning();
    const key = `${curCid}|${st}|${running ? '1' : '0'}`;
    if (!forceRender && key === lastObservedCompactKey) return;
    lastObservedCompactKey = key;

    if (st === 'compacting') ensureCompactPollTimer();

    if (window.__ag_last_metrics && typeof window.__ag_render_metrics === 'function') {
      try {
        window.__ag_render_metrics(window.__ag_last_metrics);
        return;
      } catch {}
    }
    updateComposerRingVisuals();
    if (quotaPopoverOpen) renderQuotaPopoverBody();
  }

  async function triggerConversationCompact() {
    if (disposed) return false;
    const curCid = getActiveCascadeId();
    const cidKey = curCid || '__active__';
    const curStatus = detectCompactStatus(curCid);
    if (curStatus === 'compacting' || curStatus === 'compacted') return false;

    const agentProps = discoverAgentInputProps();
    if (isPaneCurrentlyRunning(agentProps)) return false;

    manualCompactPending = { cascadeId: cidKey, startedAt: Date.now() };
    syncCompactVisualState(true);
    ensureCompactPollTimer();

    try {
      if (agentProps && typeof agentProps.handleSubmit === 'function') {
        const slashItems = Array.isArray(agentProps.slashCommandItems) ? agentProps.slashCommandItems : [];
        const compactDef = slashItems.find(
          (x) => x && (x.title === 'compact' || (x.info && x.info.name === 'compact'))
        );
        const slashInfo = (compactDef && compactDef.info) || {
          $typeName: 'exa.codeium_common_pb.SlashCommandInfo',
          name: 'compact',
          modelFacingText: '',
          type: 1,
          icon: 'collapse_all',
          displayName: '',
          logo: ''
        };
        const submitItems = [
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'item',
              value: {
                $typeName: 'exa.codeium_common_pb.ContextScopeItem',
                scopeItem: {
                  case: 'slashCommand',
                  value: {
                    $typeName: 'exa.codeium_common_pb.SlashCommandScopeItem',
                    argumentValues: {},
                    info: slashInfo
                  }
                }
              }
            }
          },
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'text',
              value: ' '
            }
          }
        ];
        await agentProps.handleSubmit(submitItems, [], () => {});
        syncCompactVisualState(true);
        return true;
      }

      const compCtx = discoverComposerContextFromInputBox();
      if (compCtx && !composerHasExistingDraft(compCtx)) {
        setComposerText(compCtx, '/compact ');
        const ref = compCtx.inputBoxRef && compCtx.inputBoxRef.current;
        if (ref && typeof ref.submit === 'function') {
          ref.submit();
          syncCompactVisualState(true);
          return true;
        }
      }
    } catch {}

    manualCompactPending = { cascadeId: '', startedAt: 0 };
    syncCompactVisualState(true);
    return false;
  }

  function fmtCompactTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return String(Math.round(n));
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }

  function fmtDurationSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    if (sec >= 60) {
      const total = Math.round(sec);
      const mins = Math.floor(total / 60);
      const rem = total % 60;
      return `${mins}m ${rem}s`;
    }
    return `${sec.toFixed(1)}s`;
  }

  function cacheTierForRate(rate) {
    if (!Number.isFinite(rate)) return '';
    const pct = Math.round(rate);
    if (pct >= 90) return 'high';
    if (pct >= 85) return 'mid';
    return 'low';
  }

  function parseMetricsTooltipData(rawTooltip) {
    if (!rawTooltip || typeof rawTooltip !== 'string') return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = rawTooltip;
    const data = {
      streamTps: NaN,
      isBuffered: false,
      ttftSec: NaN,
      isHold: false,
      stepDur: NaN,
      lastCacheRate: NaN,
      stepOut: NaN,
      turnSteps: 1,
      turnOut: NaN,
      turnDur: NaN,
      sessionTurns: 1,
      sessionCalls: 1,
      ctxRatio: '',
      ctxPct: '',
      sessionCacheRate: NaN,
      sessionTotalOut: '',
      subLabel: '',
      subSub: '',
      warnHtml: ''
    };

    const secHdr = tmp.querySelector('.ag-tt-hdr.ag-tt-sec');
    if (secHdr) {
      const m = (secHdr.textContent || '').match(/(\d+)\s*轮提问\s*\/\s*(\d+)\s*次/);
      if (m) {
        data.sessionTurns = Number(m[1]) || 1;
        data.sessionCalls = Number(m[2]) || 1;
      }
    }

    tmp.querySelectorAll('.ag-tt-row').forEach((row) => {
      const lbl = (row.querySelector('.ag-tt-lbl')?.textContent || '').trim();
      const val = (row.querySelector('.ag-tt-val')?.textContent || '').trim();
      if (!lbl) return;

      if (lbl === '生成速度') {
        const sm = val.match(/流式\s*([\d.]+)\s*tok\/s/i);
        if (sm) {
          data.streamTps = Number(sm[1]);
          data.isBuffered = false;
        } else {
          const em = val.match(/([\d.]+)\s*tok\/s/i);
          if (em) {
            data.streamTps = Number(em[1]);
            data.isBuffered = true;
          }
        }
      } else if (lbl === '响应耗时') {
        const fm = val.match(/(TTFT|等待)\s*([\d.]+)s/i);
        if (fm) {
          data.isHold = fm[1] === '等待';
          data.ttftSec = Number(fm[2]);
        }
        const tm = val.match(/总计\s*([\d.]+)s/i);
        if (tm) data.stepDur = Number(tm[1]);
      } else if (lbl === '当前上下文') {
        const cm = val.match(/,\s*([\d.]+)%\)/);
        if (cm) data.lastCacheRate = Number(cm[1]);
      } else if (lbl === '本步输出量') {
        const om = val.match(/^([\d,]+)/);
        if (om) data.stepOut = Number(om[1].replace(/,/g, ''));
      } else if (/^本轮合计/.test(lbl)) {
        const sm = lbl.match(/\((\d+)\s*步\)/);
        if (sm) data.turnSteps = Number(sm[1]) || 1;
        const om = val.match(/^输出\s*([\d,]+)/);
        if (om) data.turnOut = Number(om[1].replace(/,/g, ''));
        const dm = val.match(/耗时\s*([\d.]+)s/i);
        if (dm) data.turnDur = Number(dm[1]);
      } else if (lbl === '压缩水位线') {
        const wm = val.match(/^(.+?)\s*\((\d+%)\)/);
        if (wm) {
          data.ctxRatio = wm[1].trim();
          data.ctxPct = wm[2];
        }
      } else if (lbl === '累计输入量') {
        const hm = val.match(/命中率\s*([\d.]+)%/);
        if (hm) data.sessionCacheRate = Number(hm[1]);
      } else if (/^子\s*Agent/i.test(lbl)) {
        const cm = lbl.match(/\((\d+)/);
        const syncing = lbl.includes('同步中');
        if (cm) {
          data.subLabel = `+${cm[1]} 个`;
          const outM = val.match(/输出\s*([^\s·]+)/);
          if (outM) data.subSub = `输出 ${outM[1]}`;
          else if (syncing) data.subSub = '同步中';
        } else if (syncing) {
          data.subLabel = '同步中';
        }
      } else if (lbl === '累计输出量') {
        const om = val.match(/总计\s*([^\s(]+)/);
        if (om) data.sessionTotalOut = om[1];
      }
    });

    const warnEl = tmp.querySelector('.ag-tt-warn');
    if (warnEl) data.warnHtml = warnEl.outerHTML;

    if (!Number.isFinite(data.streamTps) && !data.ctxRatio) return null;
    return data;
  }

  function buildSlimMetricsTooltipHtml(d, ctxFallback, compactStatus) {
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const row = (lbl, valHtml) =>
      `<div class="ag-ux-tt-row"><span class="ag-ux-tt-lbl">${esc(lbl)}</span><span class="ag-ux-tt-val">${valHtml}</span></div>`;

    const steps = d.turnSteps > 1 ? d.turnSteps : 1;
    const durVal = Number.isFinite(d.turnDur) ? d.turnDur : d.stepDur;
    const outVal = Number.isFinite(d.turnOut) ? d.turnOut : d.stepOut;
    const speedHtml = Number.isFinite(d.streamTps)
      ? `${Math.round(d.streamTps)} tok/s${d.isBuffered ? '<span class="ag-ux-tt-sub">缓冲</span>' : ''}`
      : '—';
    const ttftHtml = Number.isFinite(d.ttftSec) ? fmtDurationSec(d.ttftSec) : '';
    const durHtml = fmtDurationSec(durVal) || '—';
    const outHtml = fmtCompactTokens(outVal) || '—';

    const ctxRatio = d.ctxRatio || ctxFallback.ratioText || '';
    const ctxPct = d.ctxPct || (ctxFallback.hasData ? `${ctxFallback.pct}%` : '');
    const { preUsed } = extractCompactLabels({ ratioText: ctxRatio, outText: ctxFallback.outText });
    let ctxHtml = '—';
    if (compactStatus === 'compacting') {
      ctxHtml = `压缩中…${preUsed ? `<span class="ag-ux-tt-sub">原 ${esc(preUsed)}</span>` : ''}`;
    } else if (compactStatus === 'compacted') {
      ctxHtml = `已压缩${preUsed ? `<span class="ag-ux-tt-sub">原 ${esc(preUsed)}</span>` : ''}`;
    } else if (ctxRatio) {
      ctxHtml = `${esc(ctxRatio)}${ctxPct ? `<span class="ag-ux-tt-sub">${esc(ctxPct)}</span>` : ''}`;
    }

    const lastCache = Number.isFinite(d.lastCacheRate) ? `${Math.round(d.lastCacheRate)}%` : '';
    const lastTier = cacheTierForRate(d.lastCacheRate);
    const sessCache = Number.isFinite(d.sessionCacheRate) ? `${Math.round(d.sessionCacheRate)}%` : '';
    const sessTier = cacheTierForRate(d.sessionCacheRate);
    const cacheHtml = lastCache
      ? `<span class="ag-ux-tt-cache" data-cache-tier="${lastTier}">${lastCache}</span>${sessCache ? `<span class="ag-ux-tt-sub">累计 ${sessCache}</span>` : ''}`
      : sessCache
        ? `<span class="ag-ux-tt-cache" data-cache-tier="${sessTier}">${sessCache}</span>`
        : '—';

    const sec1List = [row('生成速度', speedHtml)];
    if (ttftHtml) {
      sec1List.push(row(d.isHold ? '首包等待' : '首字耗时', ttftHtml));
    }
    sec1List.push(row('本轮耗时', durHtml), row('本轮输出', outHtml));

    const sec2List = [row('上下文', ctxHtml), row('缓存命中', cacheHtml)];
    if ((d.sessionTurns > 1 || d.subLabel) && d.sessionTotalOut) {
      sec2List.push(row('累计输出', esc(d.sessionTotalOut)));
    }
    if (d.subLabel) {
      sec2List.push(
        row('子 Agent', `${esc(d.subLabel)}${d.subSub ? `<span class="ag-ux-tt-sub">${esc(d.subSub)}</span>` : ''}`)
      );
    }

    return (
      `<div class="ag-ux-tt">` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">本轮响应</span><span class="ag-ux-tt-badge">${steps} 步</span></div>` +
      sec1List.join('') +
      `</div>` +
      `<div class="ag-ux-tt-div"></div>` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">当前会话</span><span class="ag-ux-tt-badge">${d.sessionTurns} 轮</span></div>` +
      sec2List.join('') +
      `</div>` +
      (d.warnHtml || '') +
      `</div>`
    );
  }

  function parseAndSlimMetricsPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const rawInline = payload.__agOrigInlineHtml || payload.inlineHtml || '';
    const rawTooltip = payload.__agOrigTooltipHtml || payload.tooltipHtml || '';
    const curCid = getActiveCascadeId();

    if (payload.hasData && rawInline && (!curCid || payload.cascadeId === curCid)) {
      const parsedTt = parseMetricsTooltipData(rawTooltip);
      const tmp = document.createElement('div');
      tmp.innerHTML = rawInline;
      let ratioText = '';
      let pct = 0;
      let outText = '';

      const kids = Array.from(tmp.children);
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        const txt = (el.textContent || '').trim();
        if (/^Ctx\b/i.test(txt)) {
          const m = txt.match(/Ctx\s+([^\s(]+)\s*(?:\((\d+)%\))?/i);
          if (m) {
            ratioText = m[1].replace('/', ' / ');
            pct = Math.max(0, Math.min(100, Number(m[2] || 0)));
          }
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (/^Out\b/i.test(txt)) {
          outText = txt;
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (el.classList.contains('ag-sub-badge') || /^\+?\d+\s*sub\b/i.test(txt)) {
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        }
      }
      while (tmp.firstElementChild && tmp.firstElementChild.classList.contains('ag-sep')) {
        tmp.firstElementChild.remove();
      }

      latestCtxState = {
        pct,
        ratioText,
        outText,
        hasData: Boolean(ratioText),
        cascadeId: payload.cascadeId || curCid
      };

      const compactStatus = detectCompactStatus(curCid);
      const nextTooltipHtml = parsedTt
        ? buildSlimMetricsTooltipHtml(parsedTt, latestCtxState, compactStatus)
        : rawTooltip;
      const slimmed = Object.assign({}, payload, {
        __agOrigInlineHtml: rawInline,
        __agOrigTooltipHtml: rawTooltip,
        inlineHtml: tmp.innerHTML,
        tooltipHtml: nextTooltipHtml
      });
      return slimmed;
    }

    if (!curCid || payload.cascadeId !== curCid || !payload.hasData) {
      latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: curCid };
    }
    return payload;
  }

  function positionMetricsTooltip(pill, tt) {
    if (!pill || !tt || !tt.querySelector('.ag-ux-tt')) return;
    const r = pill.getBoundingClientRect();
    const ttWidth = 272;
    const left = Math.round(Math.max(12, Math.min(r.left, window.innerWidth - ttWidth - 16)));
    const bottomPx = Math.round(
      Math.max(8, Math.min(window.innerHeight - r.top + 8, window.innerHeight - (tt.offsetHeight || 220) - 12))
    );
    tt.style.left = `${left}px`;
    tt.style.bottom = `${bottomPx}px`;
  }

  const onMetricsPillMouseEnter = (e) => {
    if (disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt) positionMetricsTooltip(pill, tt);
  };

  const onMetricsPillMouseLeave = (e) => {
    if (disposed) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt && tt.getAttribute('data-ag-pinned') === '1') {
      tt.setAttribute('data-visible', '1');
    }
  };

  const onMetricsPillClick = (e) => {
    if (disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      const willPin = tt.getAttribute('data-ag-pinned') !== '1';
      if (willPin) {
        positionMetricsTooltip(pill, tt);
        tt.setAttribute('data-ag-pinned', '1');
        tt.setAttribute('data-visible', '1');
      } else {
        tt.removeAttribute('data-ag-pinned');
        tt.removeAttribute('data-visible');
      }
      return;
    }
    if (tt.getAttribute('data-ag-pinned') === '1' && !tt.contains(e.target)) {
      tt.removeAttribute('data-ag-pinned');
      tt.removeAttribute('data-visible');
    }
  };

  document.addEventListener('mouseenter', onMetricsPillMouseEnter, true);
  document.addEventListener('mouseleave', onMetricsPillMouseLeave, true);
  document.addEventListener('click', onMetricsPillClick, true);

  /* Wrapped lazily (retried every sync) so load order vs. the upstream runtime does not matter.
     A stale wrapper left by an older instance is unwrapped first; after dispose or feature toggle-off ours restores original HTML. */
  let ownMetricsWrapper = null;
  function ensureMetricsWrapped() {
    let cur = window.__ag_render_metrics;
    if (typeof cur !== 'function' || cur === ownMetricsWrapper) return;
    while (cur && cur.__agSlimWrapped && typeof cur.__agOrig === 'function') cur = cur.__agOrig;
    const origRenderMetrics = cur;
    const wrappedRender = function (payload) {
      if (disposed || !FEAT.contextRing) {
        const rawPayload =
          payload && typeof payload === 'object'
            ? Object.assign({}, payload, {
                inlineHtml: payload.__agOrigInlineHtml !== undefined ? payload.__agOrigInlineHtml : payload.inlineHtml,
                tooltipHtml: payload.__agOrigTooltipHtml !== undefined ? payload.__agOrigTooltipHtml : payload.tooltipHtml
              })
            : payload;
        return origRenderMetrics.call(this, rawPayload);
      }
      const slimPayload = parseAndSlimMetricsPayload(payload);
      const ret = origRenderMetrics.call(this, slimPayload);
      if (payload && payload.__agOrigInlineHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigInlineHtml = payload.inlineHtml;
      }
      if (payload && payload.__agOrigTooltipHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigTooltipHtml = payload.tooltipHtml;
      }
      updateComposerRingVisuals();
      if (quotaPopoverOpen) renderQuotaPopoverBody();
      return ret;
    };
    wrappedRender.__agSlimWrapped = true;
    wrappedRender.__agOrig = origRenderMetrics;
    ownMetricsWrapper = wrappedRender;
    window.__ag_render_metrics = wrappedRender;

    if (window.__ag_last_metrics) {
      window.__ag_render_metrics(window.__ag_last_metrics);
    }
  }
  ensureMetricsWrapped();

  function discoverQuotaService() {
    if (cachedQuotaSvc) return cachedQuotaSvc;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    const seen = new Set();

    const walkObj = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return;
      seen.add(obj);
      try {
        if (!cachedQuotaSvc && typeof obj.retrieveUserQuotaSummary === 'function') {
          cachedQuotaSvc = obj;
        }
        if (!cachedUserTierName && obj.userTier && typeof obj.userTier.name === 'string') {
          cachedUserTierName = obj.userTier.name;
        }
      } catch {}
      let keys = [];
      try {
        keys = Object.keys(obj).slice(0, 40);
      } catch {}
      for (const k of keys) {
        try {
          const v = obj[k];
          if (v && typeof v === 'object') walkObj(v, depth + 1);
        } catch {}
      }
    };

    for (let n = 0; n < 45 && f; n++, f = f.return) {
      walkObj(f.memoizedProps, 0);
      walkObj(f.memoizedState, 0);
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        walkObj(dep.memoizedValue, 0);
        dep = dep.next;
      }
      if (cachedQuotaSvc && cachedUserTierName) break;
    }
    return cachedQuotaSvc;
  }

  function fetchQuotaSummary(forceRefresh = false) {
    const svc = discoverQuotaService();
    if (!svc) return Promise.resolve(cachedQuotaGroups || []);
    const now = Date.now();
    if (!forceRefresh && cachedQuotaGroups && now - lastQuotaFetchTs < 15000) {
      return Promise.resolve(cachedQuotaGroups);
    }
    if (quotaFetchInFlight) return quotaFetchInFlight;

    quotaFetchInFlight = new Promise((resolve) => resolve(svc.retrieveUserQuotaSummary(Boolean(forceRefresh))))
      .then((res) => {
        if (disposed) return [];
        const rawGroups = (res && res.response && res.response.groups) || (res && res.groups) || [];
        cachedQuotaGroups = rawGroups.filter((g) => g && Array.isArray(g.buckets) && g.buckets.length > 0);
        lastQuotaFetchTs = Date.now();
        if (quotaPopoverOpen) renderQuotaPopoverBody();
        return cachedQuotaGroups;
      })
      .catch(() => {
        cachedQuotaSvc = null; /* service object may belong to an unmounted tree: rediscover next time */
        return cachedQuotaGroups || [];
      })
      .finally(() => {
        quotaFetchInFlight = null;
      });
    return quotaFetchInFlight;
  }

  function formatResetLabel(bucket, usedPct) {
    const win = String(bucket.window || '').trim().toLowerCase();
    const secStr = bucket.resetTime && bucket.resetTime.seconds !== undefined ? String(bucket.resetTime.seconds) : '';
    const resetMs = secStr ? Number(secStr) * 1000 : 0;

    if (win === '5h' && usedPct === 0 && !bucket.description) {
      return '从发送第一条消息时起算';
    }
    if (!resetMs || Number.isNaN(resetMs)) {
      return usedPct === 0 ? '从发送第一条消息时起算' : '';
    }
    const diffMs = resetMs - Date.now();
    if (diffMs <= 60000) return '即将重置';

    if (win === 'weekly') {
      const dt = new Date(resetMs);
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      return `${weekdays[dt.getDay()]} ${hh}:${mm} 重置`;
    }

    const totalMins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs > 0) {
      return mins > 0 ? `${hrs} 小时 ${mins} 分后重置` : `${hrs} 小时后重置`;
    }
    return `${Math.max(1, mins)} 分钟后重置`;
  }

  function localizeGroupShortName(name) {
    const s = String(name || '').trim();
    if (/gemini/i.test(s)) return 'Gemini 模型';
    if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude / GPT';
    if (/claude/i.test(s)) return 'Claude 模型';
    return s || '全部模型';
  }

  function detectDefaultGroupIndex(groups) {
    if (!groups || groups.length <= 1) return 0;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const txt = inputBox ? inputBox.textContent || '' : '';
    const want3p = /claude|sonnet|opus|gpt/i.test(txt);
    const idx = groups.findIndex((g) =>
      want3p ? /claude|gpt/i.test(g.displayName || '') : /gemini/i.test(g.displayName || '')
    );
    return idx >= 0 ? idx : 0;
  }

  function barColorForPct(pct, warnAt = 70, critAt = 85) {
    if (pct >= critAt) return '#DC2626';
    if (pct >= warnAt) return '#D97706';
    return 'var(--primary, #2F75C3)';
  }

  function ensureQuotaPopover() {
    let pop = document.getElementById('ag-claude-quota-popover');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'ag-claude-quota-popover';
    pop.setAttribute('data-ag-i18n-ignore', '1');
    pop.setAttribute('data-open', 'false');
    pop.addEventListener('click', (e) => {
      const compactBtn = e.target.closest('[data-ag-qp-compact]');
      if (compactBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (!compactBtn.disabled) triggerConversationCompact();
        return;
      }
      const tabBtn = e.target.closest('[data-ag-quota-tab]');
      if (tabBtn) {
        e.stopPropagation();
        selectedQuotaGroupIdx = Number(tabBtn.getAttribute('data-ag-quota-tab')) || 0;
        renderQuotaPopoverBody();
        return;
      }
      const viewAll = e.target.closest('[data-ag-quota-view-all]');
      if (viewAll) {
        e.stopPropagation();
        closeQuotaPopover();
        const settingsBtn = document.querySelector('button[data-testid="settings-button"]');
        if (settingsBtn) {
          settingsBtn.click();
          let tries = 0;
          const jumpModels = () => {
            const modelsBtn = document.querySelector('button[data-testid="settings-nav-item-Models"]');
            if (modelsBtn) {
              modelsBtn.click();
            } else if (++tries < 12) {
              frame(jumpModels);
            }
          };
          frame(jumpModels);
        }
      }
    });
    document.body.appendChild(pop);
    return pop;
  }

  function positionQuotaPopover() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (!ring || !pop) return;
    const r = ring.getBoundingClientRect();
    const popW = 344;
    const left = Math.max(12, Math.min(Math.round(r.left - 84), window.innerWidth - popW - 14));
    const bottom = Math.max(12, Math.round(window.innerHeight - r.top + 10));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
  }

  function renderQuotaPopoverBody() {
    const pop = ensureQuotaPopover();
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean((!curCid || latestCtxState.cascadeId === curCid) && latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const paneRunning = isPaneCurrentlyRunning();
    const { preUsed, sumOut } = extractCompactLabels(latestCtxState);

    let ctxPct = hasCtx ? latestCtxState.pct : 0;
    let ctxPctLabel = `${ctxPct}%`;
    let ctxSub = hasCtx
      ? `${latestCtxState.ratioText}${latestCtxState.outText ? ` · ${latestCtxState.outText}` : ''}`
      : '当前会话暂无消耗';
    let ctxColor = barColorForPct(ctxPct, 70, 85);
    let fillCompactingAttr = '';
    let compactBtnHtml = '';

    if (compactStatus === 'compacting') {
      ctxPct = 14;
      ctxPctLabel = '…';
      ctxSub = preUsed ? `正在压缩 ${preUsed}…` : '正在生成压缩摘要…';
      ctxColor = 'var(--primary, #2F75C3)';
      fillCompactingAttr = ' data-compacting="true"';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacting" disabled title="正在总结历史并压缩上下文…">${SVG_COMPACT_ICON}<span>压缩中…</span></button>`;
    } else if (compactStatus === 'compacted') {
      ctxPct = hasCtx ? 5 : 0;
      ctxPctLabel = hasCtx ? '~5%' : '0%';
      ctxSub = preUsed && sumOut ? `${preUsed} → 摘要 ${sumOut}` : '已完成压缩 · 下轮刷新';
      ctxColor = 'var(--primary, #2F75C3)';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacted" disabled title="当前对话历史已完成压缩，发下一条消息即按新上下文计费">${SVG_COMPACT_DONE}<span>已压缩</span></button>`;
    } else if (!hasCtx) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="empty" disabled title="当前会话暂无可压缩上下文">${SVG_COMPACT_ICON}<span>压缩</span></button>`;
    } else if (paneRunning) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="busy" disabled title="请等待当前回复结束后再压缩上下文">${SVG_COMPACT_ICON}<span>压缩</span></button>`;
    } else {
      const urgentAttr = ctxPct >= 85 ? ' data-urgent="crit"' : ctxPct >= 70 ? ' data-urgent="warn"' : '';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="ready"${urgentAttr} title="立即执行 /compact 压缩当前对话上下文">${SVG_COMPACT_ICON}<span>压缩</span></button>`;
    }

    discoverQuotaService();
    const tierShort = cachedUserTierName
      ? cachedUserTierName.replace(/^Google\s+AI\s+/i, '').trim() || cachedUserTierName
      : 'Pro';

    const groups = cachedQuotaGroups || [];
    if (selectedQuotaGroupIdx < 0 || selectedQuotaGroupIdx >= groups.length) {
      selectedQuotaGroupIdx = detectDefaultGroupIndex(groups);
    }

    let tabsHtml = '';
    if (groups.length > 1) {
      tabsHtml = `<div class="ag-qp-tabs">${groups
        .map((g, idx) => {
          const active = idx === selectedQuotaGroupIdx ? ' data-active="true"' : '';
          return `<button type="button" class="ag-qp-tab" data-ag-quota-tab="${idx}"${active}>${escapeHtml(localizeGroupShortName(
            g.displayName
          ))}</button>`;
        })
        .join('')}</div>`;
    }

    let quotaRowsHtml = '';
    if (!cachedQuotaGroups && quotaFetchInFlight) {
      quotaRowsHtml = '<div class="ag-qp-empty">正在读取实时套餐限额…</div>';
    } else if (groups.length === 0) {
      quotaRowsHtml = '<div class="ag-qp-empty">暂无可用套餐限额数据</div>';
    } else {
      const grp = groups[selectedQuotaGroupIdx] || groups[0];
      const grpShort = localizeGroupShortName(grp.displayName);
      const sortedBuckets = (grp.buckets || []).slice().sort((a, b) => {
        const rank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
        return rank(String(a.window || '').toLowerCase()) - rank(String(b.window || '').toLowerCase());
      });

      quotaRowsHtml = sortedBuckets
        .map((b) => {
          const rem =
            b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
              ? b.remaining.value
              : typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : 1;
          const usedPct = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
          const win = String(b.window || '').trim().toLowerCase();
          const title =
            win === '5h'
              ? '5 小时限额'
              : win === 'weekly'
                ? `每周 · ${grpShort}`
                : win === 'daily'
                  ? `每日 · ${grpShort}`
                  : b.displayName || '使用限额';
          const resetTxt = formatResetLabel(b, usedPct);
          const fillCol = barColorForPct(usedPct, 75, 90);
          return `<div class="ag-qp-item">
            <div class="ag-qp-row">
              <span class="ag-qp-title">${escapeHtml(title)}</span>
              <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(resetTxt)}</span><span class="ag-qp-pct">${usedPct}%</span></span>
            </div>
            <div class="ag-qp-track"><div class="ag-qp-fill" style="width:${usedPct}%;background:${fillCol}"></div></div>
          </div>`;
        })
        .join('');
    }

    pop.innerHTML = `
      <div class="ag-qp-hdr">
        <span class="ag-qp-tier">套餐使用限额 · ${escapeHtml(tierShort)}</span>
        <button type="button" class="ag-qp-all" data-ag-quota-view-all="true">
          <span>查看全部</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m0 0L8.8 4.3M12.5 8l-3.7 3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="ag-qp-item">
        <div class="ag-qp-row">
          <span class="ag-qp-title-group">
            <span class="ag-qp-title">当前上下文</span>
            ${compactBtnHtml}
          </span>
          <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(ctxSub)}</span><span class="ag-qp-pct">${escapeHtml(ctxPctLabel)}</span></span>
        </div>
        <div class="ag-qp-track"><div class="ag-qp-fill"${fillCompactingAttr} style="width:${ctxPct}%;background:${ctxColor}"></div></div>
      </div>
      <div class="ag-qp-divider"></div>
      ${tabsHtml}
      <div class="ag-qp-group-list">${quotaRowsHtml}</div>
    `;
    positionQuotaPopover();
  }

  function openQuotaPopover() {
    if (typeof closeClaudeModelPopover === 'function' && modelPopoverOpen) {
      closeClaudeModelPopover();
    }
    quotaPopoverOpen = true;
    selectedQuotaGroupIdx = -1;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'true');
    const pop = ensureQuotaPopover();
    renderQuotaPopoverBody();
    pop.setAttribute('data-open', 'true');
    positionQuotaPopover();
    fetchQuotaSummary(false).then(() => {
      if (Date.now() - lastQuotaFetchTs > 12000) fetchQuotaSummary(true);
    });
  }

  function closeQuotaPopover() {
    quotaPopoverOpen = false;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'false');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (pop) pop.setAttribute('data-open', 'false');
  }

  function updateComposerRingVisuals() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (!ring) return;
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean((!curCid || latestCtxState.cascadeId === curCid) && latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const { preUsed, sumOut } = extractCompactLabels(latestCtxState);
    const arc = ring.querySelector('.ag-ctx-ring-arc');

    if (compactStatus === 'compacting') {
      const pct = 18;
      if (arc) {
        arc.style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        arc.style.strokeOpacity = '1';
      }
      ring.setAttribute('data-level', 'normal');
      ring.setAttribute('data-compact-state', 'compacting');
      ring.title = preUsed
        ? `正在压缩上下文 (原 ${preUsed})… · 点击查看状态`
        : '正在压缩上下文… · 点击查看状态';
      return;
    }

    if (compactStatus === 'compacted') {
      const pct = hasCtx ? 5 : 0;
      if (arc) {
        arc.style.strokeDashoffset = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        arc.style.strokeOpacity = pct <= 0 ? '0' : '1';
      }
      ring.setAttribute('data-level', 'normal');
      ring.setAttribute('data-compact-state', 'compacted');
      ring.title =
        preUsed && sumOut
          ? `当前上下文已压缩 (${preUsed} → 摘要 ${sumOut}) · 点击查看套餐限额`
          : '当前上下文已压缩 · 点击查看套餐限额';
      return;
    }

    ring.removeAttribute('data-compact-state');
    const pct = hasCtx ? latestCtxState.pct : 0;
    if (arc) {
      const offset = RING_CIRC * (1 - pct / 100);
      arc.style.strokeDashoffset = offset.toFixed(2);
      arc.style.strokeOpacity = pct <= 0 ? '0' : '1';
      let level = 'normal';
      if (pct >= 85) level = 'crit';
      else if (pct >= 70) level = 'warn';
      ring.setAttribute('data-level', level);
    }
    ring.title = hasCtx
      ? `当前上下文 ${latestCtxState.ratioText} (${pct}%) · 点击查看套餐限额`
      : '当前会话暂无上下文消耗 · 点击查看套餐限额';
  }

  function ensureComposerContextRing() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return;
    const leftGroup = inputBox.querySelector('div.flex.min-w-0.flex-1.items-center');
    if (!leftGroup) return;

    const modelWrap = Array.from(leftGroup.children).find(
      (ch) => ch.tagName === 'DIV' && ch.id !== 'ag-live-metrics-pill' && ch.querySelector('button')
    );
    if (!modelWrap) return;

    let ring = document.getElementById('ag-claude-ctx-ring');
    let newlyInserted = false;
    if (!ring) {
      newlyInserted = true;
      ring = document.createElement('button');
      ring.id = 'ag-claude-ctx-ring';
      ring.type = 'button';
      ring.setAttribute('data-no-drag', '');
      ring.setAttribute('data-ag-i18n-ignore', '1');
      ring.setAttribute('data-open', quotaPopoverOpen ? 'true' : 'false');
      ring.setAttribute('aria-label', '上下文与套餐使用限额');
      ring.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">' +
        '<circle class="ag-ctx-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/>' +
        `<circle class="ag-ctx-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(
          2
        )}" stroke-dashoffset="${RING_CIRC.toFixed(2)}"/>` +
        '</svg>';
      ring.addEventListener('click', (e) => {
        e.stopPropagation();
        if (quotaPopoverOpen) {
          closeQuotaPopover();
        } else {
          openQuotaPopover();
        }
      });
    }

    if (modelWrap.nextElementSibling !== ring) {
      modelWrap.insertAdjacentElement('afterend', ring);
      newlyInserted = true;
    }

    updateComposerRingVisuals();

    if (newlyInserted && typeof window.__ag_ensure_metrics_pill_fn === 'function') {
      frame(() => {
        if (typeof window.__ag_ensure_metrics_pill_fn === 'function') {
          window.__ag_ensure_metrics_pill_fn(true);
        }
      });
    }
  }

  const onOutsidePopoverPointerDown = (e) => {
    if (!quotaPopoverOpen) return;
    const pop = document.getElementById('ag-claude-quota-popover');
    const ring = document.getElementById('ag-claude-ctx-ring');
    if ((pop && pop.contains(e.target)) || (ring && ring.contains(e.target))) return;
    closeQuotaPopover();
  };
  const onPopoverKeyDown = (e) => {
    if (quotaPopoverOpen && e.key === 'Escape') {
      closeQuotaPopover();
    }
  };
  const onWindowResizePopover = () => {
    if (quotaPopoverOpen) positionQuotaPopover();
    if (modelPopoverOpen) positionModelPopovers();
  };
  document.addEventListener('pointerdown', onOutsidePopoverPointerDown, true);
  document.addEventListener('keydown', onPopoverKeyDown, true);
  window.addEventListener('resize', onWindowResizePopover);

  /* ==========================================================================
   * 6. Claude-Style Stratified Model Selector Popover
   *    - Replaces crowded 9-row flat native list & noisy `新 / 快速` badges
   *    - Top: `模型 · 本次会话` + 4 core Gemini models (full names, `1-4` keys, blue `✓`)
   *    - Bottom: unified `思考强度 >` flyout (`Low/Medium/High/XHigh`) & `更多模型 >` flyout
   *    - Calls Antigravity's native React Fiber `setSelectedModel(option)` directly
   * ========================================================================== */
  const EFFORT_LABEL_RE = /^(.*?)\s*\((Low|Medium|High|XHigh|Max)\)\s*$/i;
  const EFFORT_NORM = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  const EFFORT_RANK = { Low: 0, Medium: 1, High: 2, XHigh: 3, Max: 4 };
  const EFFORT_DESC = {
    Low: '最快响应，轻量日常问答',
    Medium: '速度与推理均衡（默认）',
    High: '深度推演与复杂问题排障',
    XHigh: '极限长链深度推理',
    Max: '最高推理强度'
  };
  const SVG_CM_CHECK =
    '<svg class="ag-cm-check" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 8.4L6.5 11.7L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG_CM_CHEVRON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let modelPopoverOpen = false;
  let activeModelSubmenu = null; // null | 'effort' | 'more'
  let activeModelTriggerBtn = null;
  let lastPreferredEffort = 'Medium';
  let currentCatalogSnapshot = null;

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findModelTriggerBtn() {
    if (activeModelTriggerBtn && document.body.contains(activeModelTriggerBtn)) {
      return activeModelTriggerBtn;
    }
    return document.querySelector('button[data-testid="model-selector-trigger"]');
  }

  function discoverModelSelectorApi(btnEl) {
    const btn = btnEl || findModelTriggerBtn();
    if (!btn) return null;
    const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? btn[fk] : null;
    for (let i = 0; i < 26 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p.setSelectedModel === 'function' && Array.isArray(p.modelOptions) && p.modelOptions.length > 0) {
        return p;
      }
    }
    return null;
  }

  function buildModelCatalog(api) {
    const rawOpts = (api.modelOptions || []).filter((o) => o && !o.disabled && o.label);
    const customOpts = Array.isArray(api.customModels)
      ? api.customModels.filter((o) => o && !o.disabled && o.label)
      : [];
    const allOpts = rawOpts.concat(customOpts);

    const familyMap = new Map();
    for (const opt of allOpts) {
      const m = String(opt.label).match(EFFORT_LABEL_RE);
      const baseName = m ? m[1].trim() : String(opt.label).trim();
      const effort = m ? EFFORT_NORM[m[2].toLowerCase()] || m[2] : null;
      let fam = familyMap.get(baseName);
      if (!fam) {
        fam = { baseName, variants: [] };
        familyMap.set(baseName, fam);
      }
      fam.variants.push({ effort, opt });
    }

    for (const fam of familyMap.values()) {
      fam.variants.sort((a, b) => {
        const ra = a.effort && EFFORT_RANK[a.effort] !== undefined ? EFFORT_RANK[a.effort] : 99;
        const rb = b.effort && EFFORT_RANK[b.effort] !== undefined ? EFFORT_RANK[b.effort] : 99;
        return ra - rb;
      });
    }

    const families = Array.from(familyMap.values());
    const isOrch = (f) => /orchestrator/i.test(f.baseName);
    const isCoreGemini = (f) => /^gemini\b/i.test(f.baseName) && !isOrch(f);

    const coreRank = (name) => {
      if (/carbon/i.test(name)) return 0;
      if (/argon/i.test(name)) return 1;
      if (/hydrogen/i.test(name)) return 2;
      if (/flash/i.test(name)) return 3;
      return 10;
    };

    const primaryFamilies = families
      .filter(isCoreGemini)
      .sort((a, b) => coreRank(a.baseName) - coreRank(b.baseName))
      .slice(0, 4);

    const primarySet = new Set(primaryFamilies);
    const moreFamilies = families
      .filter((f) => !primarySet.has(f))
      .map((f) => ({
        group: isOrch(f) ? '多智能体编排' : '其他模型',
        fam: f
      }))
      .sort((a, b) => (a.group === b.group ? 0 : a.group === '多智能体编排' ? -1 : 1));

    const sel = api.selectedModel || null;
    let activeFamily = null;
    let activeVariant = null;

    if (sel) {
      for (const fam of families) {
        for (const v of fam.variants) {
          if (
            (sel.value !== undefined && v.opt.value === sel.value) ||
            (sel.modelId && v.opt.modelId === sel.modelId) ||
            v.opt.label === sel.label
          ) {
            activeFamily = fam;
            activeVariant = v;
            break;
          }
        }
        if (activeFamily) break;
      }
    }

    if (!activeFamily && primaryFamilies.length > 0) {
      activeFamily = primaryFamilies[0];
      activeVariant = activeFamily.variants[0] || null;
    }

    if (activeVariant && activeVariant.effort) {
      lastPreferredEffort = activeVariant.effort;
    }

    return {
      primaryFamilies,
      moreFamilies,
      activeFamily,
      activeVariant
    };
  }

  function pickVariantForFamily(fam, desiredEffort) {
    if (!fam || !fam.variants.length) return null;
    if (desiredEffort) {
      const exact = fam.variants.find((v) => v.effort === desiredEffort);
      if (exact) return exact.opt;
      if (desiredEffort === 'XHigh' || desiredEffort === 'Max') {
        const high = fam.variants.find((v) => v.effort === 'High');
        if (high) return high.opt;
      }
    }
    const med = fam.variants.find((v) => v.effort === 'Medium');
    return (med || fam.variants[0]).opt;
  }

  function ensureModelPopovers() {
    let mainPop = document.getElementById('ag-claude-model-popover');
    if (!mainPop) {
      mainPop = document.createElement('div');
      mainPop.id = 'ag-claude-model-popover';
      mainPop.setAttribute('data-ag-i18n-ignore', '1');
      mainPop.setAttribute('data-open', 'false');
      mainPop.addEventListener('mouseover', (e) => {
        const row = e.target.closest('[data-ag-cm-hover]');
        if (!row) return;
        const kind = row.getAttribute('data-ag-cm-hover');
        const nextSub = kind === 'none' ? null : kind;
        if (activeModelSubmenu !== nextSub) {
          activeModelSubmenu = nextSub;
          renderModelPopovers();
        }
      });
      mainPop.addEventListener('click', (e) => {
        e.stopPropagation();
        const famBtn = e.target.closest('[data-ag-cm-family]');
        if (famBtn) {
          const baseName = famBtn.getAttribute('data-ag-cm-family');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            const fam = cat.primaryFamilies.find((f) => f.baseName === baseName);
            const targetOpt = pickVariantForFamily(fam, lastPreferredEffort);
            if (targetOpt) api.setSelectedModel(targetOpt);
          }
          closeClaudeModelPopover();
          return;
        }
        const subTrigger = e.target.closest('[data-ag-cm-subtrigger]');
        if (subTrigger) {
          if (subTrigger.getAttribute('data-disabled') === 'true') return;
          const kind = subTrigger.getAttribute('data-ag-cm-subtrigger');
          activeModelSubmenu = activeModelSubmenu === kind ? null : kind;
          renderModelPopovers();
        }
      });
      document.body.appendChild(mainPop);
    }

    let subPop = document.getElementById('ag-claude-model-subpop');
    if (!subPop) {
      subPop = document.createElement('div');
      subPop.id = 'ag-claude-model-subpop';
      subPop.setAttribute('data-ag-i18n-ignore', '1');
      subPop.setAttribute('data-open', 'false');
      subPop.addEventListener('click', (e) => {
        e.stopPropagation();
        const effBtn = e.target.closest('[data-ag-cm-effort]');
        if (effBtn) {
          const eff = effBtn.getAttribute('data-ag-cm-effort');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            if (cat.activeFamily) {
              const v = cat.activeFamily.variants.find((x) => x.effort === eff);
              if (v && v.opt) {
                lastPreferredEffort = eff;
                api.setSelectedModel(v.opt);
              }
            }
          }
          closeClaudeModelPopover();
          return;
        }
        const moreBtn = e.target.closest('[data-ag-cm-more-family]');
        if (moreBtn) {
          const baseName = moreBtn.getAttribute('data-ag-cm-more-family');
          const api = discoverModelSelectorApi();
          if (api) {
            const cat = buildModelCatalog(api);
            const entry = cat.moreFamilies.find((x) => x.fam.baseName === baseName);
            const targetOpt = entry ? pickVariantForFamily(entry.fam, lastPreferredEffort) : null;
            if (targetOpt) api.setSelectedModel(targetOpt);
          }
          closeClaudeModelPopover();
        }
      });
      document.body.appendChild(subPop);
    }

    return { mainPop, subPop };
  }

  function positionModelPopovers() {
    const btn = findModelTriggerBtn();
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    if (!btn || !mainPop) return;

    const r = btn.getBoundingClientRect();
    const mainW = 254;
    const left = Math.max(12, Math.min(Math.round(r.left), window.innerWidth - mainW - 14));
    const bottom = Math.max(12, Math.round(window.innerHeight - r.top + 8));
    mainPop.style.left = `${left}px`;
    mainPop.style.bottom = `${bottom}px`;

    if (subPop && subPop.getAttribute('data-open') === 'true') {
      const mr = mainPop.getBoundingClientRect();
      const subW = 236;
      let subLeft = Math.round(mr.right + 6);
      if (subLeft + subW > window.innerWidth - 10) {
        subLeft = Math.max(10, Math.round(mr.left - subW - 6));
      }
      subPop.style.left = `${subLeft}px`;
      subPop.style.bottom = `${bottom}px`;
    }
  }

  function renderModelPopoversRaw() {
    const api = discoverModelSelectorApi();
    if (!api) return;
    const { mainPop, subPop } = ensureModelPopovers();
    const cat = buildModelCatalog(api);
    currentCatalogSnapshot = cat;

    const multiEfforts = cat.activeFamily
      ? cat.activeFamily.variants.filter((v) => Boolean(v.effort))
      : [];
    const hasAdjustableEffort = multiEfforts.length > 1;
    const curEffortText =
      cat.activeVariant && cat.activeVariant.effort
        ? cat.activeVariant.effort
        : hasAdjustableEffort
          ? lastPreferredEffort
          : '固定';

    const activeInMore = cat.moreFamilies.some((x) => cat.activeFamily && x.fam.baseName === cat.activeFamily.baseName);
    const moreShortLabel =
      activeInMore && cat.activeFamily
        ? cat.activeFamily.baseName.replace(/^Orchestrator\s*/i, 'Orch ').replace(/^Claude\s+/i, '')
        : '';

    const primaryRowsHtml = cat.primaryFamilies
      .map((fam, idx) => {
        const isSelected = Boolean(cat.activeFamily && cat.activeFamily.baseName === fam.baseName);
        const rightHtml = isSelected ? SVG_CM_CHECK : `<span class="ag-cm-key">${idx + 1}</span>`;
        return `<button type="button" class="ag-cm-row" data-ag-cm-hover="none" data-ag-cm-family="${escapeHtml(
          fam.baseName
        )}">
          <span>${escapeHtml(fam.baseName)}</span>
          ${rightHtml}
        </button>`;
      })
      .join('');

    const effSubActive = activeModelSubmenu === 'effort' && hasAdjustableEffort ? ' data-active-sub="true"' : '';
    const effDisabled = hasAdjustableEffort ? '' : ' data-disabled="true"';
    const moreSubActive = activeModelSubmenu === 'more' ? ' data-active-sub="true"' : '';

    mainPop.innerHTML = `
      <div class="ag-cm-sec-hdr">模型 · 本次会话</div>
      <div>${primaryRowsHtml}</div>
      <div class="ag-cm-divider"></div>
      <button type="button" class="ag-cm-row" data-ag-cm-hover="${
        hasAdjustableEffort ? 'effort' : 'none'
      }" data-ag-cm-subtrigger="effort"${effSubActive}${effDisabled}>
        <span>思考强度</span>
        <span class="ag-cm-right"><span>${escapeHtml(curEffortText)}</span>${
          hasAdjustableEffort ? SVG_CM_CHEVRON : ''
        }</span>
      </button>
      <button type="button" class="ag-cm-row" data-ag-cm-hover="more" data-ag-cm-subtrigger="more"${moreSubActive}>
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span>更多模型</span>
          ${activeInMore ? '<span class="ag-cm-dot"></span>' : ''}
        </span>
        <span class="ag-cm-right">
          ${moreShortLabel ? `<span style="font-size:12px;">${escapeHtml(moreShortLabel)}</span>` : ''}
          ${SVG_CM_CHEVRON}
        </span>
      </button>
    `;

    if (activeModelSubmenu === 'effort' && hasAdjustableEffort) {
      const famTitle = cat.activeFamily ? cat.activeFamily.baseName : '';
      subPop.innerHTML =
        `<div class="ag-cm-sec-hdr">思考强度 · ${escapeHtml(famTitle)}</div>` +
        multiEfforts
          .map((v) => {
            const on = Boolean(cat.activeVariant && v.effort === cat.activeVariant.effort);
            const desc = EFFORT_DESC[v.effort] || '';
            return `<button type="button" class="ag-cm-row" data-ag-cm-effort="${escapeHtml(v.effort)}">
              <span>
                <span style="display:block;line-height:1.25;">${escapeHtml(v.effort)}</span>
                ${desc ? `<span class="ag-cm-sub-desc" style="display:block;">${escapeHtml(desc)}</span>` : ''}
              </span>
              ${on ? SVG_CM_CHECK : ''}
            </button>`;
          })
          .join('');
      subPop.setAttribute('data-open', 'true');
    } else if (activeModelSubmenu === 'more' && cat.moreFamilies.length > 0) {
      let lastGrp = '';
      subPop.innerHTML = cat.moreFamilies
        .map(({ group, fam }) => {
          let hdr = '';
          if (group !== lastGrp) {
            hdr = `${lastGrp ? '<div class="ag-cm-divider"></div>' : ''}<div class="ag-cm-sec-hdr">${escapeHtml(
              group
            )}</div>`;
            lastGrp = group;
          }
          const on = Boolean(cat.activeFamily && cat.activeFamily.baseName === fam.baseName);
          return `${hdr}<button type="button" class="ag-cm-row" style="min-height:34px;font-size:13.5px;" data-ag-cm-more-family="${escapeHtml(
            fam.baseName
          )}">
            <span>${escapeHtml(fam.baseName)}</span>
            ${on ? SVG_CM_CHECK : ''}
          </button>`;
        })
        .join('');
      subPop.setAttribute('data-open', 'true');
    } else {
      subPop.setAttribute('data-open', 'false');
    }

    positionModelPopovers();
  }

  /* ---- menu accessibility: roles, inert when closed, focus preserved across re-renders ---- */
  const MENU_KEY_ATTRS = ['data-ag-cm-family', 'data-ag-cm-subtrigger', 'data-ag-cm-effort', 'data-ag-cm-more-family'];
  let focusBeforeModelMenu = null;
  let lastKeyToggleTs = 0;

  function menuFocusKey(el) {
    if (!el || !el.getAttribute) return null;
    for (const a of MENU_KEY_ATTRS) if (el.hasAttribute(a)) return [a, el.getAttribute(a)];
    return null;
  }

  function findMenuRowByKey(key) {
    if (!key) return null;
    for (const id of ['ag-claude-model-popover', 'ag-claude-model-subpop']) {
      const pop = document.getElementById(id);
      if (!pop) continue;
      for (const row of pop.querySelectorAll(`[${key[0]}]`)) if (row.getAttribute(key[0]) === key[1]) return row;
    }
    return null;
  }

  function isInModelMenu(el) {
    return Boolean(el && el.closest && el.closest('#ag-claude-model-popover, #ag-claude-model-subpop'));
  }

  function syncMenuA11y() {
    for (const id of ['ag-claude-model-popover', 'ag-claude-model-subpop']) {
      const pop = document.getElementById(id);
      if (!pop) continue;
      const open = pop.getAttribute('data-open') === 'true';
      pop.setAttribute('role', 'menu');
      pop.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) pop.removeAttribute('inert');
      else pop.setAttribute('inert', '');
      pop.querySelectorAll('.ag-cm-row').forEach((row) => {
        row.setAttribute('role', 'menuitem');
        row.setAttribute('tabindex', '-1');
        if (row.getAttribute('data-disabled') === 'true') row.setAttribute('aria-disabled', 'true');
      });
      pop.querySelectorAll('[data-ag-cm-subtrigger]').forEach((row) => {
        row.setAttribute('aria-haspopup', 'menu');
        row.setAttribute('aria-expanded', row.hasAttribute('data-active-sub') ? 'true' : 'false');
      });
    }
  }

  function renderModelPopovers() {
    const active = document.activeElement;
    const key = isInModelMenu(active) ? menuFocusKey(active) : null;
    renderModelPopoversRaw();
    syncMenuA11y();
    if (key) {
      const row = findMenuRowByKey(key);
      if (row) row.focus();
    }
  }

  function menuRows(pop) {
    return pop ? Array.from(pop.querySelectorAll('.ag-cm-row')).filter((r) => r.getAttribute('data-disabled') !== 'true') : [];
  }

  function focusFirstRow(pop, preferSelected) {
    const rows = menuRows(pop);
    if (!rows.length) return;
    const sel = preferSelected ? rows.find((r) => r.querySelector('.ag-cm-check')) : null;
    (sel || rows[0]).focus();
  }

  function openClaudeModelPopover(btnEl, opts = {}) {
    const btn = btnEl || findModelTriggerBtn();
    const api = discoverModelSelectorApi(btn);
    if (!api) return false;
    if (quotaPopoverOpen) closeQuotaPopover();
    if (api.open && typeof api.setIsOpen === 'function') {
      try {
        api.setIsOpen(false);
      } catch {}
    }
    focusBeforeModelMenu = document.activeElement && document.activeElement !== document.body ? document.activeElement : btn;
    activeModelTriggerBtn = btn;
    modelPopoverOpen = true;
    activeModelSubmenu = null;
    if (btn) {
      btn.setAttribute('data-ag-model-open', 'true');
      btn.setAttribute('aria-expanded', 'true');
    }
    const { mainPop } = ensureModelPopovers();
    renderModelPopoversRaw();
    mainPop.setAttribute('data-open', 'true');
    syncMenuA11y();
    positionModelPopovers();
    if (opts.focus) focusFirstRow(mainPop, true);
    return true;
  }

  function closeClaudeModelPopover(opts = {}) {
    const hadFocus = isInModelMenu(document.activeElement);
    modelPopoverOpen = false;
    activeModelSubmenu = null;
    currentCatalogSnapshot = null;
    if (activeModelTriggerBtn) {
      activeModelTriggerBtn.removeAttribute('data-ag-model-open');
      activeModelTriggerBtn.setAttribute('aria-expanded', 'false');
    }
    document.querySelectorAll('button[data-ag-model-open]').forEach((el) => el.removeAttribute('data-ag-model-open'));
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    if (mainPop) mainPop.setAttribute('data-open', 'false');
    if (subPop) subPop.setAttribute('data-open', 'false');
    syncMenuA11y();
    if (opts.returnFocus || hadFocus) {
      const target =
        focusBeforeModelMenu && document.body.contains(focusBeforeModelMenu) ? focusBeforeModelMenu : activeModelTriggerBtn;
      if (target && typeof target.focus === 'function') target.focus();
    }
    focusBeforeModelMenu = null;
  }

  function toggleClaudeModelPopover(btnEl, opts) {
    if (modelPopoverOpen) {
      closeClaudeModelPopover({ returnFocus: Boolean(opts && opts.focus) });
      return true;
    }
    return openClaudeModelPopover(btnEl, opts);
  }

  const TRIGGER_SEL = 'button[data-testid="model-selector-trigger"]';

  const onModelTriggerPointerDown = (e) => {
    if (!FEAT.modelMenu) return;
    const trigger = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (trigger) {
      if (e.button !== undefined && e.button !== 0) return;
      const api = discoverModelSelectorApi(trigger);
      if (!api) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleClaudeModelPopover(trigger);
      return;
    }
    if (!modelPopoverOpen) return;
    if (isInModelMenu(e.target)) return;
    closeClaudeModelPopover();
  };

  /* Mouse: the menu already toggled on pointerdown, so swallow the follow-up mousedown/click.
     Keyboard / assistive tech: activation arrives as a click with detail === 0 -> toggle here. */
  const onModelTriggerSwallowMouseClick = (e) => {
    if (!FEAT.modelMenu) return;
    const trigger = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (!trigger) return;
    const api = discoverModelSelectorApi(trigger);
    if (!api) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.detail === 0 && Date.now() - lastKeyToggleTs > 1000) {
      lastKeyToggleTs = Date.now();
      toggleClaudeModelPopover(trigger, { focus: true });
    }
  };

  const onModelPopoverKeyDown = (e) => {
    if (disposed || !FEAT.modelMenu) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '/') {
      const btn = findModelTriggerBtn();
      if (btn && discoverModelSelectorApi(btn)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleClaudeModelPopover(btn, { focus: true });
        return;
      }
    }

    const trig = e.target && e.target.closest && e.target.closest(TRIGGER_SEL);
    if (trig && plain && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (discoverModelSelectorApi(trig)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        lastKeyToggleTs = Date.now();
        if (modelPopoverOpen && e.key.startsWith('Arrow')) {
          focusFirstRow(document.getElementById('ag-claude-model-popover'), true);
        } else {
          toggleClaudeModelPopover(trig, { focus: true });
        }
        return;
      }
    }

    if (!modelPopoverOpen) return;
    const mainPop = document.getElementById('ag-claude-model-popover');
    const subPop = document.getElementById('ag-claude-model-subpop');
    const active = document.activeElement;
    const inSub = Boolean(subPop && subPop.contains(active));
    const inMain = Boolean(mainPop && mainPop.contains(active));
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    if (e.key === 'Escape') {
      stop();
      if (inSub && activeModelSubmenu) {
        const kind = activeModelSubmenu;
        activeModelSubmenu = null;
        renderModelPopovers();
        const t = mainPop && mainPop.querySelector(`[data-ag-cm-subtrigger="${kind}"]`);
        if (t) t.focus();
      } else {
        closeClaudeModelPopover({ returnFocus: true });
      }
      return;
    }
    if (e.key === 'Tab' && (inMain || inSub)) {
      stop();
      closeClaudeModelPopover({ returnFocus: true });
      return;
    }
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      stop();
      const rows = menuRows(inSub ? subPop : mainPop);
      if (!rows.length) return;
      const down = e.key === 'ArrowDown';
      let idx = rows.indexOf(active);
      idx = idx < 0 ? (down ? 0 : rows.length - 1) : (idx + (down ? 1 : -1) + rows.length) % rows.length;
      rows[idx].focus();
      return;
    }
    if (plain && e.key === 'ArrowRight' && inMain && active.hasAttribute('data-ag-cm-subtrigger')) {
      stop();
      if (active.getAttribute('data-disabled') === 'true') return;
      activeModelSubmenu = active.getAttribute('data-ag-cm-subtrigger');
      renderModelPopovers();
      focusFirstRow(subPop, true);
      return;
    }
    if (plain && e.key === 'ArrowLeft' && inSub) {
      stop();
      const kind = activeModelSubmenu;
      activeModelSubmenu = null;
      renderModelPopovers();
      const t = mainPop && mainPop.querySelector(`[data-ag-cm-subtrigger="${kind}"]`);
      if (t) t.focus();
      return;
    }
    if (plain && /^[1-4]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const api = discoverModelSelectorApi();
      if (api) {
        const cat = currentCatalogSnapshot || buildModelCatalog(api);
        const fam = cat.primaryFamilies[idx];
        if (fam) {
          stop();
          const targetOpt = pickVariantForFamily(fam, lastPreferredEffort);
          if (targetOpt) api.setSelectedModel(targetOpt);
          closeClaudeModelPopover({ returnFocus: true });
        }
      }
    }
  };

  document.addEventListener('pointerdown', onModelTriggerPointerDown, true);
  document.addEventListener('mousedown', onModelTriggerSwallowMouseClick, true);
  document.addEventListener('click', onModelTriggerSwallowMouseClick, true);
  document.addEventListener('keydown', onModelPopoverKeyDown, true);

  /* ==========================================================================
   * 7. Inline Undo & Edit (1:1 Claude Message In-Bubble Re-Edit)
   *    - Intercepts `button[data-testid="revert-button"]` to expand a clean
   *      in-bubble editor without wiping downstream turns until confirmed.
   *    - 100% delegates file revert previews & Lexical state to native host.
   * ========================================================================== */
  let activeInlineEdit = null;
  let inlineUndoBusy = false;

  function activeReactFiber(el) {
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? el[fk] : null;
    let top = fiber;
    while (top && top.return) top = top.return;
    if (top && top.stateNode && top.stateNode.current && top.stateNode.current !== top) {
      fiber = (fiber && fiber.alternate) || fiber;
    }
    return fiber;
  }

  function resolveNativeRevertTarget(button) {
    let state = null;
    let context = null;
    let session;
    let index;
    let text;
    for (let f = activeReactFiber(button), depth = 0; f && depth < 65; f = f.return, depth++) {
      const props = f.memoizedProps;
      if (!state && props && props.revertState) state = props.revertState;
      if (session === undefined && props && typeof props.cascadeId === 'string') session = props.cascadeId;
      if (index === undefined && props && Number.isInteger(props.userStepIndex)) index = props.userStepIndex;
      if (text === undefined && props && Array.isArray(props.items)) {
        text = props.items
          .filter((it) => it && it.chunk && it.chunk.case === 'text')
          .map((it) => it.chunk.value || '')
          .join('');
      }
      for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
        const val = d.memoizedValue;
        if (!context && val && val.stepHandler && val.stepHandler.getRevertPreviews && val.inputBoxRef) {
          context = val;
        }
      }
      if (state && context && session && index !== undefined && text !== undefined) break;
    }
    if (!state || !state.canRevert || !state.revertPreviewState || !state.revertPreviewState.revert || !context || !session || index === undefined) {
      return null;
    }
    if (text === undefined) {
      const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
      const q =
        stepEl &&
        stepEl.querySelector('[data-testid="user-message-content"] [data-quotable="true"], [data-testid="user-message-content"]');
      text = (q && q.textContent) || '';
    }
    return { state: state.revertPreviewState, context, session, index, text };
  }

  function getComposerLexicalRoot(context) {
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    return ref && ref.lexicalRef && ref.lexicalRef.current && ref.lexicalRef.current.getRootElement
      ? ref.lexicalRef.current.getRootElement()
      : null;
  }

  function composerHasExistingDraft(context) {
    const rootEl = getComposerLexicalRoot(context);
    if (rootEl && (rootEl.textContent || '').trim()) return true;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const media = ref && typeof ref.getMediaAttachments === 'function' ? ref.getMediaAttachments() : null;
    return Boolean(media && media.length);
  }

  function setComposerText(context, text) {
    const value = String(text ?? '');
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const ed = ref && ref.lexicalRef && ref.lexicalRef.current;
    if (ed && ed._nodes && typeof ed.update === 'function') {
      const ParaNode = ed._nodes.get('paragraph') && ed._nodes.get('paragraph').klass;
      const TextNode = ed._nodes.get('text') && ed._nodes.get('text').klass;
      const LineBreakNode = ed._nodes.get('linebreak') && ed._nodes.get('linebreak').klass;
      if (ParaNode && TextNode) {
        ed.update(
          () => {
            const rootNode = ed.getEditorState()._nodeMap.get('root')?.getWritable?.();
            if (!rootNode) return;
            rootNode.clear();
            const p = new ParaNode();
            value.split(/\r?\n/).forEach((line, i) => {
              if (i > 0 && LineBreakNode) p.append(new LineBreakNode());
              if (line) p.append(new TextNode(line));
            });
            rootNode.append(p);
            if (typeof p.selectEnd === 'function') p.selectEnd();
          },
          { discrete: true }
        );
        return;
      }
    }
    const el = getComposerLexicalRoot(context);
    if (el) el.textContent = value;
  }

  async function performNativeRevert(target) {
    const handler = target.context.stepHandler;
    const orig = handler.revertToIndex;
    let pending;
    handler.revertToIndex = function (...args) {
      const res = orig.apply(this, args);
      if (args[0] === target.session && args[1] === target.index - 1) {
        pending = Promise.resolve(res);
      }
      return res;
    };
    try {
      target.state.revert();
    } finally {
      handler.revertToIndex = orig;
    }
    if (!pending) throw new Error('revert_not_dispatched');
    await pending;
    await new Promise((r) => setTimeout(r, 0));
  }

  async function submitComposerAfterRevert(context, composerEl) {
    await new Promise((r) => setTimeout(r, 360));
    if (disposed) return;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    if (ref && typeof ref.submit === 'function') {
      ref.submit();
      return;
    }
    const scope =
      (getComposerLexicalRoot(context) && getComposerLexicalRoot(context).closest('[data-testid="agent-input-box"]')) ||
      composerEl ||
      document;
    const sendBtn = scope.querySelector(
      'button[data-testid="input-send-button"]:not(:disabled), button[aria-label="Send message"]:not(:disabled), button[aria-label*="发送"]:not(:disabled)'
    );
    if (sendBtn) sendBtn.click();
  }

  function closeInlineEdit(restoreFocus) {
    if (!activeInlineEdit) return;
    const { button, bubble, contentEl, hosts, editorBox } = activeInlineEdit;
    activeInlineEdit = null;
    inlineUndoBusy = false;
    if (editorBox && editorBox.parentNode) editorBox.remove();
    if (bubble) bubble.classList.remove('ag-claude-editing-bubble');
    if (hosts) hosts.forEach((h) => h.classList.remove('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = false;
      contentEl.classList.remove('ag-claude-inline-hidden');
    }
    if (restoreFocus && button && button.isConnected && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }

  function renderInlineEditMeta(stObj) {
    if (!stObj || activeInlineEdit !== stObj) return;
    const { editorBox, button } = stObj;
    const metaEl = editorBox.querySelector('[data-ag-inline-meta]');
    const filesEl = editorBox.querySelector('[data-ag-inline-files]');
    if (!metaEl) return;
    const cur = resolveNativeRevertTarget(button) || stObj.target;
    const rState = cur.state;
    const convOnly = stObj.conversationOnly !== undefined ? stObj.conversationOnly : Boolean(rState.conversationOnly);
    const loading = !convOnly && stObj.preview === null && !stObj.previewError;
    const fileSummary = convOnly
      ? '仅撤回对话 · 保留文件修改'
      : loading
        ? '正在检查变更文件…'
        : stObj.previewError
          ? '文件预览获取失败'
          : stObj.preview && stObj.preview.length
            ? `还原 ${stObj.preview.length} 个文件`
            : '无关联文件变更';
    const hasMedia = Boolean(
      stObj.bubble && stObj.bubble.querySelector('.agy-user-bubble-header, img, [data-testid*="attachment"], [data-testid*="media"]')
    );
    metaEl.innerHTML =
      (rState.conversationOnlyRevertEnabled
        ? `<button type="button" class="ag-claude-switch" role="switch" data-ag-revert-files-switch aria-label="同步撤回文件修改" aria-checked="${!convOnly}"><span></span></button><span>同步撤回文件</span><span style="opacity:0.45">·</span>`
        : '') +
      `<span>${escapeHtml(fileSummary)}</span>` +
      (hasMedia ? '<span style="opacity:0.75" title="重发时自动保留原消息图片/附件；如需增删附件请点「移至底栏」">· 保留原附件</span>' : '');

    if (filesEl) {
      if (!convOnly && !loading && !stObj.previewError && stObj.preview && stObj.preview.length) {
        const chips = stObj.preview
          .slice(0, 8)
          .map((p) => {
            const raw = String(p.fileUri || p.uri || 'file');
            const base = decodeURIComponent(raw.split('/').pop() || raw);
            return `<span class="ag-claude-inline-file-chip">${escapeHtml(base)}</span>`;
          })
          .join('');
        const extra = stObj.preview.length > 8 ? `<span class="ag-claude-inline-file-chip">+${stObj.preview.length - 8}</span>` : '';
        filesEl.innerHTML = `<div>撤回此步将一并还原以下 ${stObj.preview.length} 个文件至提问前状态：</div><div class="ag-claude-inline-file-chips">${chips}${extra}</div>`;
      } else {
        filesEl.innerHTML = '';
      }
    }

    const sw = metaEl.querySelector('[data-ag-revert-files-switch]');
    if (sw) {
      sw.addEventListener('click', () => {
        const latest = resolveNativeRevertTarget(button) || stObj.target;
        const nextConvOnly = !(stObj.conversationOnly ?? Boolean(latest.state.conversationOnly));
        stObj.conversationOnly = nextConvOnly;
        if (typeof latest.state.setConversationOnly === 'function') {
          latest.state.setConversationOnly(nextConvOnly);
        }
        if (!nextConvOnly && !stObj.previewLoaded && !stObj.previewError) {
          stObj.preview = null;
          renderInlineEditMeta(stObj);
          loadInlineRevertPreview(stObj);
          return;
        }
        renderInlineEditMeta(stObj);
      });
    }
  }

  async function loadInlineRevertPreview(stObj) {
    if (!stObj || stObj.previewLoading) return;
    stObj.previewLoading = true;
    try {
      const preview = await stObj.target.context.stepHandler.getRevertPreviews(stObj.target.session, stObj.target.index - 1);
      if (activeInlineEdit !== stObj) return;
      stObj.preview = Array.isArray(preview) ? preview : [];
      stObj.previewLoaded = true;
    } catch (err) {
      if (activeInlineEdit !== stObj) return;
      stObj.previewError = String((err && err.message) || err);
    } finally {
      stObj.previewLoading = false;
    }
    renderInlineEditMeta(stObj);
  }

  async function applyInlineUndo(shouldSubmit) {
    const stObj = activeInlineEdit;
    if (!stObj || inlineUndoBusy) return;
    let current = resolveNativeRevertTarget(stObj.button) || stObj.target;
    if (!current) return;
    inlineUndoBusy = true;
    const { editorBox } = stObj;
    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    if (ta) {
      stObj.draftText = ta.value;
      ta.disabled = true;
    }
    editorBox.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
    if (warnEl) warnEl.textContent = shouldSubmit ? '正在撤回并重发…' : '正在移至底栏…';

    const rootEl = getComposerLexicalRoot(current.context);
    const composerEl = (rootEl && rootEl.closest('[data-testid="agent-input-box"]')) || null;
    try {
      if (
        current.state &&
        current.state.conversationOnlyRevertEnabled &&
        stObj.conversationOnly !== undefined &&
        current.state.conversationOnly !== stObj.conversationOnly
      ) {
        current.state.setConversationOnly(stObj.conversationOnly);
        await new Promise((r) => setTimeout(r, 30));
        current = resolveNativeRevertTarget(stObj.button) || current;
      }
      await performNativeRevert(current);
      if (disposed || activeInlineEdit !== stObj) return;
      setComposerText(current.context, stObj.draftText);
      closeInlineEdit(false);
      if (shouldSubmit) {
        await submitComposerAfterRevert(current.context, composerEl);
      } else {
        const nextRoot = getComposerLexicalRoot(current.context);
        if (nextRoot && typeof nextRoot.focus === 'function') nextRoot.focus();
      }
    } catch (err) {
      inlineUndoBusy = false;
      if (activeInlineEdit !== stObj) return;
      if (ta) ta.disabled = false;
      editorBox.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
      if (warnEl) warnEl.textContent = '撤回失败，请重试';
    }
  }

  function openInlineEdit(button, target) {
    const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
    const bubble = (stepEl && stepEl.querySelector('[data-testid="user-message-bubble"]')) || button.parentElement;
    if (!bubble) return;
    const contentEl = bubble.querySelector('[data-testid="user-message-content"]');
    const hosts = [];
    for (let el = bubble.parentElement; el && el !== stepEl; el = el.parentElement) {
      const cls = String(el.className || '');
      if (el.classList.contains('agy-user-bubble-frame') || cls.includes('max-w-')) {
        hosts.push(el);
      }
    }
    bubble.classList.add('ag-claude-editing-bubble');
    hosts.forEach((h) => h.classList.add('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = true;
      contentEl.classList.add('ag-claude-inline-hidden');
    }

    const editorBox = document.createElement('div');
    editorBox.className = 'ag-claude-inline-editor';
    editorBox.setAttribute('role', 'region');
    editorBox.setAttribute('aria-label', '原地编辑消息');
    editorBox.addEventListener('click', (ev) => ev.stopPropagation());

    const convOnly = Boolean(target.state && target.state.conversationOnly);
    const stObj = {
      button,
      target,
      bubble,
      contentEl,
      hosts,
      editorBox,
      draftText: target.text || '',
      conversationOnly: convOnly,
      preview: convOnly ? [] : null,
      previewError: '',
      previewLoaded: convOnly,
      previewLoading: false
    };
    activeInlineEdit = stObj;

    editorBox.innerHTML = `
      <textarea class="ag-claude-inline-textarea" aria-label="编辑消息内容" rows="1"></textarea>
      <div class="ag-claude-inline-files" data-ag-inline-files></div>
      <div class="ag-claude-inline-footer">
        <div class="ag-claude-inline-meta">
          <span data-ag-inline-meta style="display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap"></span>
          <span class="ag-claude-inline-warn" data-ag-inline-warn role="status"></span>
        </div>
        <div class="ag-claude-inline-actions">
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-cancel>取消</button>
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-bottom title="撤回并移回底部输入框（可增删图片附件或切换模型）">移至底栏</button>
          <button type="button" class="ag-claude-inline-btn" data-primary="true" data-ag-inline-send>重发</button>
        </div>
      </div>
    `;
    bubble.appendChild(editorBox);

    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    ta.value = stObj.draftText;
    const autoResize = () => {
      ta.style.height = 'auto';
      const h = Number(ta.scrollHeight) || 26;
      ta.style.height = `${Math.min(240, Math.max(26, h))}px`;
    };
    autoResize();
    ta.addEventListener('input', () => {
      stObj.draftText = ta.value;
      autoResize();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        ev.stopPropagation();
        applyInlineUndo(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeInlineEdit(true);
      }
    });
    editorBox.querySelector('[data-ag-inline-cancel]').addEventListener('click', () => closeInlineEdit(true));
    editorBox.querySelector('[data-ag-inline-bottom]').addEventListener('click', () => applyInlineUndo(false));
    editorBox.querySelector('[data-ag-inline-send]').addEventListener('click', () => applyInlineUndo(true));

    renderInlineEditMeta(stObj);
    if (composerHasExistingDraft(target.context)) {
      const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
      if (warnEl) warnEl.textContent = '将覆盖底栏现有草稿';
    }
    if (typeof ta.focus === 'function') {
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(len, len);
    }
    if (!convOnly) loadInlineRevertPreview(stObj);
  }

  const onRevertButtonClick = (e) => {
    if (disposed || !FEAT.inlineUndo) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="revert-button"]');
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    const target = resolveNativeRevertTarget(btn);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (inlineUndoBusy) return;
    if (activeInlineEdit && activeInlineEdit.button === btn) {
      closeInlineEdit(true);
      return;
    }
    closeInlineEdit(false);
    openInlineEdit(btn, target);
  };

  const onInlineEditDocKeyDown = (e) => {
    if (disposed || !activeInlineEdit || inlineUndoBusy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeInlineEdit(true);
    }
  };

  document.addEventListener('click', onRevertButtonClick, true);
  document.addEventListener('keydown', onInlineEditDocKeyDown, true);

  /* ==========================================================================
   * 8. Sidebar Enhancements: Collapsed Project Status Badges + Top Recents
   *    - Purely reads in-memory Redux `trajectorySummaries` (0 network calls).
   *    - Badges automatically fade on hover to yield to native `+ / ⋯` actions.
   *    - Top `最近对话` sorts `pending > running > recent` with 0ms router switch.
   * ========================================================================== */
  const SIDEBAR_IGNORED_TYPES = new Set([21, 22, 23]);
  const PENDING_TERM_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 5l3 3-3 3"/><path d="M8 11h4.5"/></svg>';
  const PENDING_LOCK_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const PENDING_BELL_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 6.5a3.5 3.5 0 1 0-7 0c0 3.2-1.3 4.3-1.3 4.3h9.6s-1.3-1.1-1.3-4.3"/><path d="M6.8 13a1.3 1.3 0 0 0 2.4 0"/></svg>';

  let sidebarStoreRef = null;
  let sidebarStoreUnsub = null;
  let sidebarSyncTimer = 0;
  let recentExpanded = false;
  let recentLastSig = '';
  let recentCollapsed = (() => {
    try {
      return typeof localStorage === 'object' && localStorage && localStorage.getItem('ag_claude_ux_recent_collapsed') === '1';
    } catch {
      return false;
    }
  })();

  function protoSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.seconds !== undefined && ts.seconds !== null) return Number(ts.seconds) || 0;
    return 0;
  }

  function pendingSubkindOf(waitingStep) {
    const tool = String((waitingStep && waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.name) || '')
      .split(':')
      .pop();
    if (tool === 'ask_permission') {
      try {
        const args = JSON.parse((waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.argumentsJson) || '{}');
        if (args.command || args.CommandLine) return 'terminal';
        if (args.read_file || args.write_file || args.Path || args.AbsolutePath || args.TargetFile) return 'lock';
      } catch {}
      return 'lock';
    }
    if (/run_command|command/i.test(tool)) return 'terminal';
    return 'bell';
  }

  function isSidebarVisibleSummary(id, summary, state) {
    if (!id || !summary) return false;
    if (summary.annotations && summary.annotations.archived) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.parentConversationId) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.isBattleModeFork) return false;
    if (
      summary.trajectoryMetadata &&
      summary.trajectoryMetadata.sourceMetadata &&
      summary.trajectoryMetadata.sourceMetadata.hideFromConversationList
    ) {
      return false;
    }
    if (SIDEBAR_IGNORED_TYPES.has(summary.trajectoryType)) return false;
    const idxSidebar =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.sidebar;
    if (idxSidebar) {
      if (typeof idxSidebar.has === 'function') {
        if (idxSidebar.size > 0 && !idxSidebar.has(id)) return false;
      } else if (typeof idxSidebar === 'object') {
        const keys = Object.keys(idxSidebar);
        if (keys.length > 0 && !Object.prototype.hasOwnProperty.call(idxSidebar, id)) return false;
      }
    }
    return true;
  }

  function isSummaryPinned(id, summary, state) {
    if (summary && summary.annotations && summary.annotations.pinned) return true;
    const idxPinned =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.pinned;
    if (idxPinned) {
      if (typeof idxPinned.has === 'function') return idxPinned.has(id);
      if (typeof idxPinned === 'object') return Object.prototype.hasOwnProperty.call(idxPinned, id);
    }
    return false;
  }

  function formatCjkSpacing(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
      .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
  }

  function syncSidebarCjkSpacing() {
    const spans = document.querySelectorAll(
      '[data-testid="conversation-row-sidebar"] span.truncate, .agy-sidebar-row span.truncate'
    );
    for (const span of spans) {
      if (span.childNodes.length !== 1 || !span.firstChild || span.firstChild.nodeType !== 3) continue;
      const cur = span.firstChild.nodeValue || '';
      const next = formatCjkSpacing(cur);
      if (next !== cur) {
        if (!span.hasAttribute('data-ag-orig-cjk')) span.setAttribute('data-ag-orig-cjk', cur);
        span.firstChild.nodeValue = next;
      }
    }
  }

  function classifySidebarConversation(id, summary, state, activeId, hasFocus) {
    if (!isSidebarVisibleSummary(id, summary, state)) return null;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const byParent = state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byParent;
    let waitingStep = (summary.waitingSteps && summary.waitingSteps[0]) || null;
    const rawChildren = byParent && byParent[id];
    if (!waitingStep && rawChildren) {
      const childIds =
        typeof rawChildren[Symbol.iterator] === 'function'
          ? rawChildren
          : typeof rawChildren === 'object'
            ? Object.keys(rawChildren)
            : [];
      for (const cid of childIds) {
        const ch = summaries[cid];
        if (ch && ch.waitingSteps && ch.waitingSteps.length) {
          waitingStep = ch.waitingSteps[0];
          break;
        }
      }
    }
    const title = formatCjkSpacing((summary.annotations && summary.annotations.title) || summary.summary || id);
    if (waitingStep) {
      return { kind: 'pending', subkind: pendingSubkindOf(waitingStep), title };
    }

    const status = summary.status ?? 0;
    const isWorking =
      !summary.killed && (status === 2 || status === 3 || status === 4 || Boolean(summary.hasRunningSubagents));
    const isBgWorking =
      !summary.killed && (status === 1 || status === 0) && !summary.hasRunningSubagents && Boolean(summary.notFullyIdle);
    if (isWorking || isBgWorking) {
      return { kind: 'running', subkind: 'orbit', title };
    }

    if (!summary.notFullyIdle) {
      const marked = Boolean(summary.annotations && summary.annotations.markedAsUnread);
      const isFocusedHere = activeId === id && hasFocus;
      if (marked || !isFocusedHere) {
        const lastMod = protoSeconds(summary.lastModifiedTime);
        const remoteView = protoSeconds(summary.annotations && summary.annotations.lastUserViewTime);
        const localView = Number((state && state.conversation && state.conversation.localLastViewedTimes && state.conversation.localLastViewedTimes[id]) || 0);
        if (marked || (lastMod > 0 && lastMod > Math.max(remoteView, localView))) {
          return { kind: 'unread', subkind: 'dot', title };
        }
      }
    }
    return null;
  }

  function pendingGlyphSvg(subkind) {
    if (subkind === 'terminal') return PENDING_TERM_SVG;
    if (subkind === 'lock') return PENDING_LOCK_SVG;
    return PENDING_BELL_SVG;
  }

  function findSidebarBindings() {
    const sidebar = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!sidebar) return null;
    let f = activeReactFiber(sidebar.firstElementChild || sidebar) || activeReactFiber(sidebar);
    let store = null;
    let router = null;
    let stepHandler = null;
    const groupsById = new Map();
    const projectLabels = new Map();

    for (let d = 0; f && d < 36; d++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.sidebarStore && !store) store = p.sidebarStore;
      if (p && p.sidebarRouter && !router) router = p.sidebarRouter;
      if (p && Array.isArray(p.sidebarGroups) && !groupsById.size) {
        for (const g of p.sidebarGroups) {
          if (g && g.id) {
            groupsById.set(g.id, g.conversationIds || []);
            if (g.label || g.name) projectLabels.set(g.id, g.label || g.name);
          }
        }
      }
      if (!groupsById.size) {
        for (let s = f.memoizedState; s; s = s.next) {
          const v = s.memoizedState;
          if (Array.isArray(v) && v.length && v[0] && Array.isArray(v[0].conversationIds)) {
            for (const g of v) {
              if (g && g.id) {
                groupsById.set(g.id, g.conversationIds || []);
                const lbl = g.label || g.name || g.title;
                if (lbl) projectLabels.set(g.id, lbl);
              }
            }
            if (groupsById.size) break;
          }
        }
      }
      for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
        const mv = dep.memoizedValue;
        if (!store && mv && mv.store && typeof mv.store.getState === 'function') {
          const st = mv.store.getState();
          if (st && st.trajectorySummaries && st.trajectorySummaries.summaries) {
            store = mv.store;
          }
        }
        if (!router && mv && typeof mv.navigate === 'function' && mv.state && mv.state.location) {
          router = mv;
        }
        if (!stepHandler && mv && mv.stepHandler && typeof mv.stepHandler.openConversation === 'function') {
          stepHandler = mv.stepHandler;
        }
      }
      if (store && router && groupsById.size) break;
    }
    if (!store) return null;
    for (const hdr of sidebar.querySelectorAll('button[data-testid="project-header"]')) {
      const drop = hdr.closest('[data-sidebar-section-drop-id]');
      const pid = drop && drop.getAttribute('data-sidebar-section-drop-id');
      const lbl = hdr.getAttribute('data-project-label') || (hdr.textContent || '').trim();
      if (pid && lbl && !projectLabels.has(pid)) projectLabels.set(pid, lbl);
    }
    return { sidebar, store, router, stepHandler, groupsById, projectLabels };
  }

  function resolveProjectHeaderId(btn) {
    const drop = btn.closest('[data-sidebar-section-drop-id]');
    if (drop) {
      const id = drop.getAttribute('data-sidebar-section-drop-id');
      if (id) return id;
    }
    for (let f = activeReactFiber(btn), d = 0; f && d < 10; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p && typeof p.projectId === 'string' && p.projectId) return p.projectId;
      if (p && typeof p.brandedProjectId === 'string' && p.brandedProjectId) return p.brandedProjectId;
    }
    return '';
  }

  function clearAllFolderBadges() {
    document.querySelectorAll('.ag-claude-folder-badges').forEach((el) => el.remove());
    document.querySelectorAll('button[data-testid="project-header"][data-ag-folder-tip]').forEach((btn) => {
      const orig = btn.getAttribute('data-ag-orig-folder-title');
      btn.removeAttribute('data-ag-folder-tip');
      btn.removeAttribute('data-ag-orig-folder-title');
      if (orig) btn.setAttribute('title', orig);
      else btn.removeAttribute('title');
    });
  }

  function syncFolderStatusBadges(bindings, state, activeId, hasFocus) {
    if (!FEAT.folderStatus || !bindings) {
      clearAllFolderBadges();
      return;
    }
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const headers = bindings.sidebar.querySelectorAll('button[data-testid="project-header"]');
    for (const btn of headers) {
      const host = btn.closest('.group\\/header') || btn.parentElement;
      if (!host) continue;
      if (!host.style.position && !host.classList.contains('relative')) {
        host.style.position = 'relative';
      }
      const collapsed = btn.getAttribute('aria-expanded') === 'false';
      const pid = collapsed ? resolveProjectHeaderId(btn) : '';
      const convIds = pid ? bindings.groupsById.get(pid) : null;
      let badgeWrap = host.querySelector(':scope > .ag-claude-folder-badges');

      if (!collapsed || !convIds || !convIds.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const buckets = {
        pending: { kind: 'pending', count: 0, subkind: null, titles: [] },
        running: { kind: 'running', count: 0, subkind: 'orbit', titles: [] },
        unread: { kind: 'unread', count: 0, subkind: 'dot', titles: [] }
      };
      const seen = new Set();
      for (const cid of convIds) {
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        const cls = classifySidebarConversation(cid, summaries[cid], state, activeId, hasFocus);
        if (!cls) continue;
        const b = buckets[cls.kind];
        b.count += 1;
        if (!b.subkind) b.subkind = cls.subkind;
        if (b.titles.length < 3 && cls.title) b.titles.push(cls.title);
      }

      const active = ['pending', 'running', 'unread'].map((k) => buckets[k]).filter((b) => b.count > 0);
      if (!active.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const kindLabels = { pending: '待处理', running: '运行中', unread: '已完成未读' };
      const summaryLine = active.map((b) => `${b.count} 个${kindLabels[b.kind]}`).join(' · ');
      const detailLines = active.flatMap((b) => b.titles.map((t) => `${kindLabels[b.kind]}：${t}`)).slice(0, 4);
      const tip = detailLines.length ? `${summaryLine}\n${detailLines.join('\n')}` : summaryLine;
      if (!btn.hasAttribute('data-ag-folder-tip')) {
        const orig = btn.getAttribute('title');
        if (orig) btn.setAttribute('data-ag-orig-folder-title', orig);
        btn.setAttribute('data-ag-folder-tip', 'true');
      }
      if (btn.getAttribute('title') !== tip) btn.setAttribute('title', tip);

      const html = active
        .slice(0, 2)
        .map((b) => {
          const ico =
            b.kind === 'pending'
              ? pendingGlyphSvg(b.subkind)
              : b.kind === 'running'
                ? '<span class="ag-folder-orbit"></span>'
                : '<span class="ag-claude-unread-dot"></span>';
          return `<span class="ag-claude-folder-badge" data-kind="${b.kind}">${ico}<span>${b.count}</span></span>`;
        })
        .join('');

      if (!badgeWrap) {
        badgeWrap = document.createElement('div');
        badgeWrap.className = 'ag-claude-folder-badges';
        badgeWrap.setAttribute('aria-hidden', 'true');
        host.appendChild(badgeWrap);
      }
      const sig = `${active.map((b) => `${b.kind}:${b.subkind}:${b.count}`).join('|')}`;
      if (badgeWrap.getAttribute('data-ag-sig') !== sig) {
        badgeWrap.setAttribute('data-ag-sig', sig);
        badgeWrap.innerHTML = html;
      }
    }
  }

  function formatRelativeAge(sec, nowSec) {
    if (!sec) return '';
    const diff = Math.max(0, nowSec - sec);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  function resolveSummaryProjectLabel(summary, projectLabels) {
    const pid = summary && summary.trajectoryMetadata && summary.trajectoryMetadata.projectId;
    if (!pid || pid === 'outside-of-project') return '';
    if (projectLabels && projectLabels.has(pid)) return projectLabels.get(pid);
    const uri = (summary.trajectoryMetadata && summary.trajectoryMetadata.workspaceUris && summary.trajectoryMetadata.workspaceUris[0]) || '';
    return decodeURIComponent(String(uri).split('/').filter(Boolean).pop() || '');
  }

  function navigateSidebarConversation(id, bindings) {
    if (!id) return;
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({ to: '/c/$cascadeId', params: { cascadeId: id } });
        return;
      } catch {}
    }
    if (bindings && bindings.stepHandler && typeof bindings.stepHandler.openConversation === 'function') {
      try {
        bindings.stepHandler.openConversation(id);
        return;
      } catch {}
    }
    const link = document.querySelector(`a[href*="/c/${id}"]`);
    if (link && typeof link.click === 'function') {
      link.click();
      return;
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', `/c/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  function removeRecentSection() {
    const el = document.getElementById('ag-claude-recent-section');
    if (el) el.remove();
    recentLastSig = '';
  }

  function syncRecentSection(bindings, state, activeId, hasFocus) {
    if (!FEAT.recentSection || !bindings) {
      removeRecentSection();
      return;
    }
    const sbParent = bindings.sidebar.parentElement;
    const sbGrand = sbParent && sbParent.parentElement;
    if (!sbParent || !sbGrand) return;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const list = [];
    for (const [id, summary] of Object.entries(summaries)) {
      if (!isSidebarVisibleSummary(id, summary, state)) continue;
      if (isSummaryPinned(id, summary, state)) continue;
      const rawTitle = (summary.annotations && summary.annotations.title) || summary.summary;
      if (!rawTitle) continue;
      const title = formatCjkSpacing(rawTitle);
      const updatedAt = Math.max(protoSeconds(summary.lastModifiedTime), protoSeconds(summary.createdTime));
      const status = classifySidebarConversation(id, summary, state, activeId, hasFocus);
      const priority = status && status.kind === 'pending' ? 3 : status && status.kind === 'running' ? 2 : 1;
      list.push({
        id,
        title,
        project: resolveSummaryProjectLabel(summary, bindings.projectLabels),
        updatedAt,
        status,
        priority
      });
    }
    if (!list.length) {
      removeRecentSection();
      return;
    }
    list.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
    const limit = recentExpanded ? 8 : 4;
    const items = list.slice(0, limit);
    const total = list.length;
    const nowBucket = Math.floor(Date.now() / 30000);
    const nowSec = Math.floor(Date.now() / 1000);

    let sec = document.getElementById('ag-claude-recent-section');
    if (!sec || sec.parentElement !== sbGrand) {
      if (sec) sec.remove();
      sec = document.createElement('section');
      sec.id = 'ag-claude-recent-section';
      sec.setAttribute('aria-label', '最近对话');
      sec.addEventListener('click', (ev) => {
        const hdr = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-toggle]');
        if (hdr) {
          recentCollapsed = !recentCollapsed;
          try {
            localStorage.setItem('ag_claude_ux_recent_collapsed', recentCollapsed ? '1' : '0');
          } catch {}
          recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const more = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-more]');
        if (more) {
          recentExpanded = !recentExpanded;
          recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row) {
          const cid = row.getAttribute('data-ag-recent-id');
          const curBindings = findSidebarBindings() || bindings;
          navigateSidebarConversation(cid, curBindings);
          scheduleSidebarSync();
        }
      });
      sbGrand.insertBefore(sec, sbParent);
      recentLastSig = '';
    }

    const sig = `${recentCollapsed ? 1 : 0}|${recentExpanded ? 1 : 0}|${activeId}|${nowBucket}|${total}|${items
      .map((it) => `${it.id}:${it.title}:${it.project}:${it.status ? `${it.status.kind}-${it.status.subkind}` : 'idle'}:${Math.floor(it.updatedAt / 60)}`)
      .join(';')}`;
    if (sig === recentLastSig) return;
    recentLastSig = sig;

    const rowsHtml = recentCollapsed
      ? ''
      : `<div class="ag-recent-list">${items
          .map((it) => {
            const isAct = it.id === activeId;
            const age = formatRelativeAge(it.updatedAt, nowSec);
            let sideHtml = `<span>${escapeHtml(age)}</span>`;
            if (it.status && it.status.kind === 'pending') {
              sideHtml = `<span class="ag-claude-folder-badge" data-kind="pending">${pendingGlyphSvg(it.status.subkind)}</span>`;
            } else if (it.status && it.status.kind === 'running') {
              sideHtml = '<span class="ag-folder-orbit"></span>';
            } else if (it.status && it.status.kind === 'unread') {
              sideHtml = `<span class="ag-claude-unread-dot"></span>${age ? `<span>${escapeHtml(age)}</span>` : ''}`;
            }
            const tip = it.project ? `${it.title}\n所属项目：${it.project}` : it.title;
            return `<button type="button" class="ag-recent-row" data-ag-recent-id="${escapeHtml(it.id)}" data-active="${isAct ? 'true' : 'false'}" title="${escapeHtml(tip)}"><div class="ag-recent-main"><div class="ag-recent-title">${escapeHtml(it.title)}</div></div><div class="ag-recent-side">${sideHtml}</div></button>`;
          })
          .join('')}</div>` +
        (total > 4
          ? `<button type="button" class="ag-recent-more" data-ag-recent-more>${recentExpanded ? '收起' : '展开更多'}</button>`
          : '');

    sec.innerHTML = `<button type="button" class="ag-recent-hdr" data-ag-recent-toggle aria-expanded="${!recentCollapsed}"><span>最近对话</span><span class="ag-recent-chevron">▾</span></button>${rowsHtml}`;
  }

  function scheduleSidebarSync() {
    if (disposed || sidebarSyncTimer) return;
    sidebarSyncTimer = later(() => {
      sidebarSyncTimer = 0;
      syncSidebarEnhancements();
    }, 90);
  }

  function syncSidebarEnhancements() {
    if (disposed) return;
    syncSidebarCjkSpacing();
    if (!FEAT.folderStatus && !FEAT.recentSection) {
      if (sidebarStoreUnsub) {
        sidebarStoreUnsub();
        sidebarStoreUnsub = null;
        sidebarStoreRef = null;
      }
      clearAllFolderBadges();
      removeRecentSection();
      return;
    }
    const bindings = findSidebarBindings();
    if (!bindings) return;
    if (sidebarStoreRef !== bindings.store) {
      if (sidebarStoreUnsub) sidebarStoreUnsub();
      sidebarStoreRef = bindings.store;
      if (typeof bindings.store.subscribe === 'function') {
        sidebarStoreUnsub = bindings.store.subscribe(() => scheduleSidebarSync());
      } else {
        sidebarStoreUnsub = null;
      }
    }
    const state = bindings.store.getState();
    const activeId = getActiveCascadeId();
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    syncFolderStatusBadges(bindings, state, activeId, hasFocus);
    syncRecentSection(bindings, state, activeId, hasFocus);
  }

  const onWindowSidebarEvent = () => scheduleSidebarSync();
  window.addEventListener('focus', onWindowSidebarEvent);
  window.addEventListener('blur', onWindowSidebarEvent);
  window.addEventListener('popstate', onWindowSidebarEvent);

  /* ==========================================================================
   * 9. Native Settings -> `界面增强` (Claude UX) Live Module Toggle Panel
   *    - Injects `settings-nav-item-ClaudeUX` right after `Appearance` (`外观`)
   *      inside `[data-testid="settings-sidebar"]`.
   *    - Toggles persist to `localStorage` and take effect in 0ms without reload.
   * ========================================================================== */
  const SETTINGS_GROUPS = [
    {
      heading: '对话与过程流增强',
      items: [
        ['claudeUxModelMenu', 'modelMenu', '分层模型选择器 (⌘/)', '精简主列表为 4 款主力模型，独立拆分思考强度与更多模型二级菜单'],
        ['claudeUxContextRing', 'contextRing', '上下文圆环与套餐限额浮层 (◎)', '模型旁显示占用圆环，点击查看 5 小时 / 每周真实限额与重置倒计时'],
        ['claudeUxTodoCard', 'todoCard', '流内 TodoWrite 实时进度卡片', '将多阶段任务清单渲染为 14px 圆角白卡，兼容虚拟滚动与知识工作模式'],
        ['claudeUxStepUnfold', 'stepUnfold', '自动展开回合步骤折叠', '回合结束时保持中间进展与工具摘要平铺可见，不被外层折叠吞没'],
        ['claudeUxRunningTimer', 'runningTimer', '运行中官方蓝旋转点与实时读秒', '在正在执行的工具步骤行挂载官方蓝双点旋转与 1s / 2s 读秒器'],
        ['claudeUxCollapseAnimation', 'collapseAnim', '工具面板平滑收起动画', '收拢工具详情面板时补齐 190ms 丝滑过渡动画']
      ]
    },
    {
      heading: '侧边栏与消息编辑增强',
      items: [
        ['claudeUxInlineUndo', 'inlineUndo', '原地撤回重编消息', '点击撤回时在原气泡直接展开编辑框，支持变更文件还原预览与原附件保留'],
        ['claudeUxFolderStatus', 'folderStatus', '折叠项目状态聚合角标', '项目文件夹折叠时在右侧安静汇总待审批、运行中与已完成未读状态'],
        ['claudeUxRecentSection', 'recentSection', '侧边栏顶部最近对话', '在侧边栏顶部按活跃优先级展示非置顶最近会话，支持跨项目无刷秒切与收起']
      ]
    }
  ];

  let settingsSidebarRef = null;
  let settingsRightRef = null;
  let settingsNavWrap = null;
  let settingsNavBtn = null;
  let settingsPanelEl = null;
  let settingsToastTimer = 0;

  function applyImmediateFeatureEffects(featKey, on) {
    if (featKey === 'modelMenu' && !on) {
      closeClaudeModelPopover();
    } else if (featKey === 'contextRing') {
      if (!on) {
        const ring = document.getElementById('ag-claude-ctx-ring');
        if (ring) ring.remove();
        closeQuotaPopover();
        const tt = document.getElementById('ag-live-metrics-tooltip');
        if (tt) tt.removeAttribute('data-ag-pinned');
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    } else if (featKey === 'todoCard' && !on) {
      document.querySelectorAll('[data-ag-todo-dock]').forEach((d) => d.remove());
      document.querySelectorAll('ul[data-ag-todo-primary], ul[data-ag-todo-merged]').forEach((u) => restoreNativeUl(u));
    } else if (featKey === 'runningTimer' && !on) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
    } else if (featKey === 'inlineUndo' && !on) {
      closeInlineEdit(false);
    }
    syncSidebarEnhancements();
    scheduleSync();
  }

  function setModuleOverride(modKey, featKey, nextBool) {
    localModOverrides[modKey] = Boolean(nextBool);
    try {
      localStorage.setItem(MODULE_STORAGE_KEY, JSON.stringify(localModOverrides));
    } catch {}
    FEAT[featKey] = Boolean(nextBool);
    applyImmediateFeatureEffects(featKey, FEAT[featKey]);
    syncSettingsSwitchesUi();
    if (settingsPanelEl) {
      const toast = settingsPanelEl.querySelector('[data-ag-cux-toast]');
      if (toast) {
        toast.setAttribute('data-visible', 'true');
        cancelLater(settingsToastTimer);
        settingsToastTimer = later(() => {
          toast.setAttribute('data-visible', 'false');
        }, 1400);
      }
    }
  }

  function syncSettingsSwitchesUi() {
    if (!settingsPanelEl) return;
    for (const grp of SETTINGS_GROUPS) {
      for (const [modKey, featKey] of grp.items) {
        const sw = settingsPanelEl.querySelector(`[data-ag-cux-switch="${modKey}"]`);
        if (sw) sw.setAttribute('aria-checked', String(Boolean(FEAT[featKey])));
      }
    }
  }

  function closeClaudeUxSettingsPane() {
    if (settingsRightRef) settingsRightRef.removeAttribute('data-ag-claude-settings-open');
    if (settingsSidebarRef) settingsSidebarRef.removeAttribute('data-ag-claude-nav-open');
    if (settingsNavBtn) {
      settingsNavBtn.classList.remove('bg-sidebar-secondary');
      settingsNavBtn.removeAttribute('aria-current');
    }
    if (settingsPanelEl) settingsPanelEl.hidden = true;
  }

  function onNativeSettingsNavClick(e) {
    if (e.target && e.target.closest && !e.target.closest('#ag-claude-ux-settings-nav') && e.target.closest('button')) {
      closeClaudeUxSettingsPane();
    }
  }

  function openClaudeUxSettingsPane() {
    if (!settingsSidebarRef || !settingsRightRef || !settingsNavBtn) return;
    settingsSidebarRef.setAttribute('data-ag-claude-nav-open', 'true');
    settingsRightRef.setAttribute('data-ag-claude-settings-open', 'true');
    settingsNavBtn.classList.add('bg-sidebar-secondary');
    settingsNavBtn.setAttribute('aria-current', 'page');

    if (!settingsPanelEl || settingsPanelEl.parentElement !== settingsRightRef) {
      if (settingsPanelEl) settingsPanelEl.remove();
      const panel = document.createElement('div');
      panel.id = 'ag-claude-ux-settings-panel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', '界面增强设置');
      panel.innerHTML = `
        <div class="ag-cux-settings-wrap">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div>
              <h2 class="text-2xl m-0" style="color:var(--foreground)">界面增强</h2>
              <div class="ag-cux-settings-desc" style="margin-top:4px">管理 Claude UX 视觉、过程流与侧边栏效率模块，点击开关即时生效并跨重启自动记忆。</div>
            </div>
            <span class="ag-cux-toast" data-ag-cux-toast data-visible="false">✓ 已保存并即时生效</span>
          </div>
          ${SETTINGS_GROUPS.map(
            (grp) => `
            <div style="display:flex;flex-direction:column;gap:8px">
              <h3 class="m-0">${escapeHtml(grp.heading)}</h3>
              <div class="ag-cux-settings-group">
                ${grp.items
                  .map(
                    ([modKey, featKey, title, desc]) => `
                  <div class="ag-cux-settings-row">
                    <div style="min-width:0">
                      <div class="ag-cux-settings-title">${escapeHtml(title)}</div>
                      <div class="ag-cux-settings-desc">${escapeHtml(desc)}</div>
                    </div>
                    <button type="button" class="ag-claude-switch" role="switch" data-ag-cux-switch="${modKey}" data-ag-cux-feat="${featKey}" aria-label="${escapeHtml(title)}" aria-checked="${Boolean(FEAT[featKey])}"><span></span></button>
                  </div>`
                  )
                  .join('')}
              </div>
            </div>`
          ).join('')}
        </div>
      `;
      panel.querySelectorAll('[data-ag-cux-switch]').forEach((sw) => {
        sw.addEventListener('click', () => {
          const modKey = sw.getAttribute('data-ag-cux-switch');
          const featKey = sw.getAttribute('data-ag-cux-feat');
          setModuleOverride(modKey, featKey, !FEAT[featKey]);
        });
      });
      settingsRightRef.appendChild(panel);
      settingsPanelEl = panel;
    }
    settingsPanelEl.hidden = false;
    syncSettingsSwitchesUi();
    settingsRightRef.scrollTop = 0;
  }

  function detachSettingsPanel() {
    closeClaudeUxSettingsPane();
    if (settingsSidebarRef) {
      settingsSidebarRef.removeEventListener('click', onNativeSettingsNavClick, true);
    }
    if (settingsNavWrap && settingsNavWrap.parentNode) settingsNavWrap.remove();
    if (settingsPanelEl && settingsPanelEl.parentNode) settingsPanelEl.remove();
    settingsSidebarRef = null;
    settingsRightRef = null;
    settingsNavWrap = null;
    settingsNavBtn = null;
    settingsPanelEl = null;
  }

  function reconcileSettingsPanel() {
    if (disposed) return;
    const sb = document.querySelector('[data-testid="settings-sidebar"]');
    if (!sb) {
      if (settingsSidebarRef) detachSettingsPanel();
      return;
    }
    if (settingsNavWrap && settingsNavWrap.isConnected && settingsSidebarRef === sb) return;
    detachSettingsPanel();

    const anchorBtn =
      sb.querySelector('button[data-testid="settings-nav-item-Appearance"]') ||
      sb.querySelector('button[data-testid="settings-nav-item-General"]') ||
      sb.querySelector('button[data-testid^="settings-nav-item-"]');
    const splitRoot = sb.closest('[data-split-root="true"], [data-split-root]') || (sb.parentElement && sb.parentElement.parentElement && sb.parentElement.parentElement.parentElement);
    const rightOuter = splitRoot && splitRoot.children && splitRoot.children.length >= 2 ? splitRoot.children[splitRoot.children.length - 1] : null;
    const rightContent = (rightOuter && rightOuter.firstElementChild) || rightOuter;
    if (!anchorBtn || !anchorBtn.parentElement || !anchorBtn.parentElement.parentElement || !rightContent) return;

    settingsSidebarRef = sb;
    settingsRightRef = rightContent;
    const navWrap = document.createElement('div');
    navWrap.id = 'ag-claude-ux-settings-nav';
    navWrap.className = anchorBtn.parentElement.className || 'relative group/nav-item mx-2';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-testid', 'settings-nav-item-ClaudeUX');
    btn.className = (anchorBtn.className || '').replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-muted');
    btn.innerHTML = '<span class="truncate">界面增强</span>';
    btn.addEventListener('click', () => openClaudeUxSettingsPane());
    navWrap.appendChild(btn);

    anchorBtn.parentElement.insertAdjacentElement('afterend', navWrap);
    sb.addEventListener('click', onNativeSettingsNavClick, true);
    settingsNavWrap = navWrap;
    settingsNavBtn = btn;
  }

  /* ---- scheduling: rAF-coalesced, throttled, and blind to our own DOM writes ---- */
  const MIN_SYNC_GAP_MS = 80;
  let throttleTimer = 0;
  function scheduleSync() {
    if (disposed || rafPending || throttleTimer) return;
    const wait = MIN_SYNC_GAP_MS - (Date.now() - lastSyncTs);
    if (wait > 0) {
      throttleTimer = later(() => {
        throttleTimer = 0;
        scheduleSync();
      }, wait);
      return;
    }
    rafPending = true;
    frame(syncStepStream);
  }

  const OWN_SEL =
    '.ag-claude-todo-card, .ag-claude-todo-live-dock, .ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, #ag-claude-ctx-ring, #ag-claude-quota-popover, #ag-claude-model-popover, #ag-claude-model-subpop, .ag-claude-inline-editor, .ag-claude-folder-badges, #ag-claude-recent-section, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel';
  const CLASS_WATCH_SEL =
    'ul.contains-task-list, [id="antigravity.agentSidePanelInputBox"], [data-testid="tool-group-collapsible"], [data-testid="worked-for-collapsible"], [data-testid="progress-updates-collapsible"], [data-testid="ephemeral-tool-status"]';

  function isOwnNode(n) {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.closest && el.closest(OWN_SEL));
  }

  function isOwnChildListMutation(m) {
    if (isOwnNode(m.target)) return true;
    const total = m.addedNodes.length + m.removedNodes.length;
    if (!total) return true;
    for (const n of m.addedNodes) if (!isOwnNode(n)) return false;
    for (const n of m.removedNodes) if (!isOwnNode(n)) return false;
    return true;
  }

  const observer = new MutationObserver((mutations) => {
    if (disposed) return;
    let needSync = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (!t || !t.getAttribute) continue;
        if (m.attributeName === 'aria-expanded') {
          if (FEAT.collapseAnim && t.getAttribute('data-testid') === 'tool-group-collapsible' && t.getAttribute('aria-expanded') === 'false') {
            animateCollapseIfNeeded(t);
          }
          if (!isOwnNode(t)) needSync = true;
        } else if (m.attributeName === 'class') {
          if (!isOwnNode(t) && t.closest && t.closest(CLASS_WATCH_SEL)) needSync = true;
        }
      } else if (m.type === 'childList') {
        if (!isOwnChildListMutation(m)) needSync = true;
      }
    }
    if (needSync) scheduleSync();
  });

  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'class']
    });
    syncStepStream();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    for (const id of pendingRafs) cancelAnimationFrame(id);
    pendingRafs.clear();
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts.clear();
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    if (compactPollTimerId) {
      clearInterval(compactPollTimerId);
      compactPollTimerId = null;
    }
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('pointerdown', onOutsidePopoverPointerDown, true);
    document.removeEventListener('keydown', onPopoverKeyDown, true);
    document.removeEventListener('pointerdown', onModelTriggerPointerDown, true);
    document.removeEventListener('mousedown', onModelTriggerSwallowMouseClick, true);
    document.removeEventListener('click', onModelTriggerSwallowMouseClick, true);
    document.removeEventListener('keydown', onModelPopoverKeyDown, true);
    document.removeEventListener('click', onRevertButtonClick, true);
    document.removeEventListener('keydown', onInlineEditDocKeyDown, true);
    document.removeEventListener('mouseenter', onMetricsPillMouseEnter, true);
    document.removeEventListener('mouseleave', onMetricsPillMouseLeave, true);
    document.removeEventListener('click', onMetricsPillClick, true);
    window.removeEventListener('resize', onWindowResizePopover);
    window.removeEventListener('focus', onWindowSidebarEvent);
    window.removeEventListener('blur', onWindowSidebarEvent);
    window.removeEventListener('popstate', onWindowSidebarEvent);
    if (sidebarStoreUnsub) {
      sidebarStoreUnsub();
      sidebarStoreUnsub = null;
      sidebarStoreRef = null;
    }
    closeInlineEdit(false);
    clearAllFolderBadges();
    removeRecentSection();
    detachSettingsPanel();
    const ttEl = document.getElementById('ag-live-metrics-tooltip');
    if (ttEl) {
      ttEl.removeAttribute('data-ag-pinned');
      ttEl.removeAttribute('data-visible');
    }
    if (ownMetricsWrapper && window.__ag_render_metrics === ownMetricsWrapper) {
      window.__ag_render_metrics = ownMetricsWrapper.__agOrig;
      if (window.__ag_last_metrics && typeof window.__ag_last_metrics === 'object') {
        if (window.__ag_last_metrics.__agOrigInlineHtml !== undefined) {
          window.__ag_last_metrics.inlineHtml = window.__ag_last_metrics.__agOrigInlineHtml;
        }
        if (window.__ag_last_metrics.__agOrigTooltipHtml !== undefined) {
          window.__ag_last_metrics.tooltipHtml = window.__ag_last_metrics.__agOrigTooltipHtml;
        }
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    }
    document
      .querySelectorAll(
        '.ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, [data-ag-todo-mount], [data-ag-todo-dock], #ag-claude-ctx-ring, #ag-claude-quota-popover, #ag-claude-model-popover, #ag-claude-model-subpop'
      )
      .forEach((el) => el.remove());
    document
      .querySelectorAll(
        '[data-ag-todo-primary], [data-ag-todo-merged], [data-ag-todo-empty-wrap], [data-ag-todo-marker-line], [data-ag-model-open], [data-ag-inline-stream]'
      )
      .forEach((el) => {
        el.removeAttribute('data-ag-todo-primary');
        el.removeAttribute('data-ag-todo-merged');
        el.removeAttribute('data-ag-todo-empty-wrap');
        el.removeAttribute('data-ag-todo-marker-line');
        el.removeAttribute('data-ag-model-open');
        el.removeAttribute('data-ag-inline-stream');
      });
    document.querySelectorAll('[data-ag-orig-cjk]').forEach((el) => {
      const orig = el.getAttribute('data-ag-orig-cjk');
      el.removeAttribute('data-ag-orig-cjk');
      if (orig !== null && el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeType === 3) {
        el.firstChild.nodeValue = orig;
      }
    });
    if (window.__agClaudeUxDispose === dispose) window.__agClaudeUxDispose = null;
  }

  window.__agClaudeUxDispose = dispose;
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
