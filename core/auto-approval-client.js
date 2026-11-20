/* Independent renderer module. Native permission RPC only; never clicks translated UI. */
(function () {
  if (typeof window.__agAutoApproval?.dispose === 'function') window.__agAutoApproval.dispose();
  const scopeLabels = {
    command: ['终端命令', 'Terminal commands'], mcp: ['MCP 工具与资源', 'MCP tools and resources'],
    readFile: ['文件读取', 'File reads'], writeFile: ['文件写入', 'File writes']
  };
  const actions = { command: 'command', unsandboxed: 'command', mcp: 'mcp', read_file: 'readFile', write_file: 'writeFile' };
  const initial = ctx.config?.autoApproval || {};
  let settings = { delaySeconds: Number.isFinite(Number(initial.delaySeconds)) ? Math.min(3600, Math.max(0, Math.round(Number(initial.delaySeconds)))) : 3,
    scopes: Object.fromEntries(Object.keys(scopeLabels).map(key => [key, initial.scopes?.[key] !== false])) };
  let enabled = ctx.modules?.autoApproval === true;
  let disposed = false, busy = false, saving = false, pauseRequested = false, storeRef = null, unsubscribe = null;
  let status = { status: enabled ? 'connecting' : 'paused' };
  let badge = null, nav = null, panel = null, sidebarRef = null, rightRef = null, closeEnhancements = null;
  let lastActivity = 0;
  const manualRequests = new Set();
  const L = (zh, en) => document.documentElement.getAttribute('data-ag-ux-lang') === 'zh' ? zh : en;
  const call = (action, payload) => typeof window.__agProjectCall === 'function'
    ? window.__agProjectCall(action, payload, 5000) : Promise.resolve({ ok: false, error: 'rpc_unavailable' });
  const identity = c => JSON.stringify([c.cascadeId, c.trajectoryId, c.stepIndex]);
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k => k !== '$typeName').sort().map(k => [k, canonical(value[k])]));
    return typeof value === 'bigint' ? String(value) : value;
  };

  function bindings() {
    let service = null, store = null;
    const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const anchors = [sb?.firstElementChild, sb, document.querySelector('.bg-sidebar'), document.getElementById('antigravity.agentSidePanelInputBox'), document.querySelector('[data-testid="settings-sidebar"]'), document.querySelector('main'), document.getElementById('root')?.firstElementChild];
    const scan = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.handleCascadeUserInteraction === 'function') service = value;
      if (value.sidebarStore && typeof value.sidebarStore.getState === 'function') store = value.sidebarStore;
      if (value.store && typeof value.store.getState === 'function' && value.store.getState()?.trajectorySummaries?.summaries) store = value.store;
    };
    for (const anchor of anchors) {
      const key = anchor && Object.keys(anchor).find(k => k.startsWith('__reactFiber$'));
      let fiber = key ? anchor[key] : null;
      let root = fiber;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber?.alternate || fiber;
      for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
        scan(fiber.memoizedProps); scan(fiber.memoizedProps?.value);
        for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) scan(dep.memoizedValue);
      }
    }
    return { store, service };
  }

  function snapshot(store) {
    const summaries = store?.getState()?.trajectorySummaries?.summaries;
    if (!summaries || typeof summaries !== 'object') return null;
    const candidates = [], waitingIdentities = [], unknownWaitingIds = new Set();
    let manual = 0, unsupported = 0;
    for (const [cascadeId, summary] of Object.entries(summaries)) {
      if (!summary || summary.killed) continue;
      for (const waiting of summary.waitingSteps || []) {
        const step = waiting.step;
        const source = step?.metadata?.sourceTrajectoryStepInfo;
        if (typeof source?.trajectoryId === 'string' && source.trajectoryId && Number.isSafeInteger(source.stepIndex) && source.stepIndex >= 0) {
          waitingIdentities.push({ cascadeId, trajectoryId: source.trajectoryId, stepIndex: source.stepIndex });
        } else unknownWaitingIds.add(cascadeId);
        const interaction = step?.requestedInteraction?.interaction;
        const spec = interaction?.value;
        const resource = spec?.resource;
        if (interaction?.case !== 'permission' || !Object.hasOwn(actions, resource?.action || '')) { unsupported++; continue; }
        if ((step.status !== undefined && step.status !== 9) || !source?.trajectoryId || !Number.isSafeInteger(source.stepIndex)
          || source.stepIndex < 0 || typeof resource.target !== 'string' || !resource.target) { unsupported++; continue; }
        let specSignature;
        try { specSignature = JSON.stringify(canonical(spec)); } catch { unsupported++; continue; }
        const candidate = { cascadeId, trajectoryId: source.trajectoryId, stepIndex: source.stepIndex,
          kind: 'permission', action: resource.action, target: resource.target, specSignature };
        if (manualRequests.has(identity(candidate))) { manual++; continue; }
        candidates.push(candidate);
      }
    }
    return { candidates, knownIds: Object.keys(summaries), waiting: waitingIdentities, unknownWaitingIds: [...unknownWaitingIds], manual, unsupported };
  }

  function message() {
    const labels = {
      paused: L('已暂停', 'Paused'), connecting: L('正在连接客户端', 'Connecting to client'), idle: L('待机', 'Idle'),
      countdown: L(`${status.remaining || 0} 秒后批准`, `Allowing in ${status.remaining || 0}s`), ready: L('正在复核请求', 'Checking request'),
      verifying: L('已提交，等待状态更新', 'Submitted; awaiting state update'), excluded: L('待处理请求不在审批范围内', 'Pending requests are outside the selected scope'),
      unsupported: L('有请求需要手动处理', 'Some requests require manual action'), manual: L('已交由你手动处理当前请求', 'Current request left for you to handle'),
      interacting: L('等待操作结束', 'Waiting until you finish interacting'),
      conflict: L('外部自动审批工具仍在运行，请先暂停它', 'Pause the other auto-approval tool to continue'),
      uncertain: L('请求结果未确认，请手动检查', 'Request result is unconfirmed; check it manually'),
      journal_full: L('审批记录已满，已停止处理', 'Approval history is full; processing stopped'),
      unavailable: L('连接不可用，已停止处理', 'Connection unavailable; processing stopped'),
      error: L('审批未完成，请手动检查', 'Approval did not complete; check manually')
    };
    if (status.status === 'idle' && status.lastConfirmedAt) return `${labels.idle} · ${L('最近批准', 'Last allowed')} ${new Date(status.lastConfirmedAt).toLocaleTimeString()}`;
    return labels[status.status] || labels.unavailable;
  }

  function updateStatus(next) {
    status = next;
    if (panel) {
      const node = panel.querySelector('[data-ag-approval-status]');
      if (node) { node.textContent = message(); node.setAttribute('data-status', status.status); }
    }
    if (enabled && !badge?.isConnected) {
      const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
      const host = sb?.parentElement;
      if (host?.parentElement) {
        badge?.remove();
        badge = document.createElement('div'); badge.id = 'ag-auto-approval-badge'; badge.setAttribute('data-ag-i18n-ignore', '1');
        const text = document.createElement('span'); text.setAttribute('data-ag-approval-label', '');
        const pause = document.createElement('button'); pause.type = 'button'; pause.textContent = L('暂停', 'Pause');
        pause.addEventListener('click', () => setEnabled(false));
        badge.append(text, pause); host.parentElement.insertBefore(badge, host);
      }
    }
    if (badge) {
      badge.hidden = !enabled;
      badge.setAttribute('data-status', status.status);
      badge.querySelector('[data-ag-approval-label]').textContent = `${L('自动审批', 'Auto approval')} · ${message()}`;
      badge.querySelector('button').textContent = L('暂停', 'Pause');
    }
  }

  async function tick() {
    if (disposed || busy || saving) return;
    if (!enabled) { updateStatus({ status: 'paused' }); return; }
    busy = true;
    try {
      const { store, service } = bindings();
      if (storeRef !== store) {
        unsubscribe?.(); storeRef = store;
        unsubscribe = typeof store?.subscribe === 'function' ? store.subscribe(() => { queueMicrotask(tick); }) : null;
      }
      const state = snapshot(store);
      if (!state || !service) { updateStatus({ status: 'unavailable' }); return; }
      const reply = await call('autoApprovalPoll', { candidates: state.candidates, knownIds: state.knownIds, waiting: state.waiting, unknownWaitingIds: state.unknownWaitingIds,
        userActive: Date.now() - lastActivity < 1000 });
      if (disposed || !enabled) return;
      if (!reply?.ok) { updateStatus({ status: 'unavailable' }); return; }
      updateStatus(reply.status === 'idle' && state.manual ? { ...reply, status: 'manual' }
        : reply.status === 'idle' && state.unsupported ? { ...reply, status: 'unsupported' } : reply);
      if (!reply.claim) return;
      // A claim is not permission to submit: re-read native state, then obtain a durable permit.
      const fresh = snapshot(store);
      // Select by server identity hash below, never just the first candidate of a batch.
      const hashKey = async c => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity(c))))]
        .map(v => v.toString(16).padStart(2, '0')).join('');
      let selected = null;
      for (const c of fresh?.candidates || []) {
        if (await hashKey(c) === reply.claim.key && state.candidates.some(old => JSON.stringify(old) === JSON.stringify(c))) { selected = c; break; }
      }
      if (!selected || disposed || !enabled || Date.now() - lastActivity < 1000) return;
      const permit = await call('autoApprovalCommit', { token: reply.claim.token, candidate: selected });
      if (!permit?.ok || !permit.permit) return;
      // Recheck after the asynchronous permit; a changed request is never submitted.
      const final = snapshot(store)?.candidates.find(c => JSON.stringify(c) === JSON.stringify(selected));
      if (disposed || !enabled || !final || Date.now() - lastActivity < 1000) {
        await call('autoApprovalResult', { key: permit.key, token: reply.claim.token, succeeded: false });
        return;
      }
      let succeeded = false, requestTimeout = 0;
      try {
        await Promise.race([service.handleCascadeUserInteraction(final.cascadeId, {
          trajectoryId: final.trajectoryId, stepIndex: final.stepIndex,
          interaction: { case: 'permission', value: { allow: true, scope: 1 } }
        }), new Promise((_, reject) => { requestTimeout = setTimeout(() => reject(new Error('approval_timeout')), 8000); })]);
        succeeded = true;
      } catch { /* A failed or lost reply is never automatically retried. */ }
      finally { clearTimeout(requestTimeout); }
      await call('autoApprovalResult', { key: permit.key, token: reply.claim.token, succeeded });
      if (!disposed) updateStatus({ status: succeeded ? 'verifying' : 'error' });
    } catch { if (!disposed) updateStatus({ status: 'unavailable' }); }
    finally { busy = false; }
  }

  async function save(nextEnabled = enabled, nextSettings = settings) {
    if (saving || disposed) return false;
    saving = true;
    panel?.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
    try {
      const result = await call('saveUiPrefs', { modules: { autoApproval: nextEnabled }, autoApproval: nextSettings });
      if (!result?.ok || disposed) { updateStatus({ status: 'unavailable' }); return false; }
      enabled = nextEnabled; settings = result.autoApproval || nextSettings;
      renderPanel(); updateStatus({ status: enabled ? 'connecting' : 'paused' });
      return true;
    } catch {
      updateStatus({ status: 'unavailable' }); return false;
    } finally {
      saving = false; panel?.querySelectorAll('input, button').forEach(el => { el.disabled = false; });
      if (pauseRequested) { pauseRequested = false; setEnabled(false); }
      else queueMicrotask(tick);
    }
  }

  function setEnabled(value) {
    // Pause locally before any async call so an in-flight countdown cannot submit.
    if (!value) {
      enabled = false; updateStatus({ status: 'paused' });
      if (saving) { pauseRequested = true; return Promise.resolve(false); }
    }
    return save(!!value);
  }

  function closeSettings() {
    rightRef?.removeAttribute('data-ag-auto-approval-open');
    sidebarRef?.removeAttribute('data-ag-auto-approval-nav-open');
    nav?.querySelector('button')?.classList.remove('bg-sidebar-secondary');
    nav?.querySelector('button')?.removeAttribute('aria-current');
    if (panel) panel.hidden = true;
  }

  function renderPanel() {
    if (!panel) return;
    const wasHidden = panel.hidden;
    panel.innerHTML = `<div class="ag-cux-settings-wrap">
      <h2 class="text-2xl m-0">${L('自动审批', 'Auto approval')}</h2>
      <p class="ag-cux-settings-desc">${L('自动处理所选范围内的权限请求，只允许本次。支持后台对话和子对话。', 'Automatically allow selected permission requests once, including background conversations and subagents.')}</p>
      <div class="ag-cux-settings-group">
        <div class="ag-cux-settings-row"><div><div class="ag-cux-settings-title">${L('启用自动审批', 'Enable auto approval')}</div><div class="ag-cux-settings-desc">${L('关闭后立即停止处理新请求', 'Turn off to stop processing new requests immediately')}</div></div><button type="button" class="ag-claude-switch" role="switch" data-ag-approval-enabled aria-label="${L('启用自动审批', 'Enable auto approval')}" aria-checked="${enabled}"><span></span></button></div>
        <label class="ag-cux-settings-row"><span class="ag-cux-settings-title">${L('等待秒数', 'Delay in seconds')}</span><input data-ag-approval-delay type="number" min="0" max="3600" step="1" value="${settings.delaySeconds}" /></label>
      </div>
      <h3 class="m-0">${L('审批范围', 'Approval scope')}</h3>
      <div class="ag-cux-settings-group">${Object.entries(scopeLabels).map(([key, labels]) => `<label class="ag-cux-settings-row"><span>${L(...labels)}</span><input type="checkbox" data-ag-approval-scope="${key}" ${settings.scopes[key] ? 'checked' : ''} /></label>`).join('')}</div>
      <p class="ag-cux-settings-desc">${L('URL、下载、管理员提权、自定义权限及需要文字回答的问题由你手动处理。终端范围包含沙盒外执行；模块不按命令内容额外拦截。', 'URLs, downloads, administrator elevation, custom permissions and questions require manual action. Terminal scope includes unsandboxed commands; commands are not additionally filtered by content.')}</p>
      <div class="ag-cux-settings-group"><div class="ag-cux-settings-row"><span>${L('运行状态', 'Status')}</span><span role="status" aria-live="polite" data-ag-approval-status></span></div></div>
      <p class="ag-cux-settings-desc">${L('识别到请求取消或变化时重新检查；提交结果不确定时停止重试，并保留记录。', 'Canceled or changed requests are checked again. Unconfirmed submissions are recorded and are not retried automatically.')}</p>
    </div>`;
    panel.hidden = wasHidden;
    panel.querySelector('[data-ag-approval-enabled]').addEventListener('click', () => setEnabled(!enabled));
    panel.querySelector('[data-ag-approval-delay]').addEventListener('change', event => {
      const value = Number(event.target.value);
      if (!Number.isInteger(value) || value < 0 || value > 3600 || event.target.value === '') { event.target.value = settings.delaySeconds; return; }
      save(enabled, { ...settings, delaySeconds: value });
    });
    for (const input of panel.querySelectorAll('[data-ag-approval-scope]')) input.addEventListener('change', () => {
      save(enabled, { ...settings, scopes: { ...settings.scopes, [input.dataset.agApprovalScope]: input.checked } });
    });
    updateStatus(status);
  }

  function onSettingsClick(event) {
    if (event.target.closest('button') && !event.target.closest('#ag-auto-approval-nav')) closeSettings();
  }

  function attachSettings(sidebar, right, after, closeOther) {
    if (disposed || !sidebar || !right || !after) return;
    if (sidebarRef !== sidebar || !nav?.isConnected) {
      detachSettings(); sidebarRef = sidebar; rightRef = right; closeEnhancements = closeOther;
      nav = document.createElement('div'); nav.id = 'ag-auto-approval-nav'; nav.className = after.className;
      nav.setAttribute('data-ag-i18n-ignore', '1');
      const button = document.createElement('button'); button.type = 'button';
      button.className = after.querySelector('button')?.className || '';
      button.classList.remove('bg-sidebar-secondary'); button.setAttribute('data-testid', 'settings-nav-item-AutoApproval');
      button.addEventListener('click', () => {
        closeEnhancements?.();
        if (!panel?.isConnected) { panel = document.createElement('div'); panel.id = 'ag-auto-approval-panel'; panel.setAttribute('data-ag-i18n-ignore', '1'); panel.setAttribute('role', 'region'); rightRef.appendChild(panel); }
        renderPanel(); panel.hidden = false; rightRef.setAttribute('data-ag-auto-approval-open', 'true');
        sidebarRef.setAttribute('data-ag-auto-approval-nav-open', 'true');
        button.classList.add('bg-sidebar-secondary'); button.setAttribute('aria-current', 'page'); rightRef.scrollTop = 0;
      });
      nav.appendChild(button); after.after(nav); sidebar.addEventListener('click', onSettingsClick, true);
    }
    const text = L('自动审批', 'Auto approval');
    const button = nav.querySelector('button');
    if (button.textContent !== text) { button.textContent = text; if (panel?.isConnected) renderPanel(); }
    panel?.setAttribute('aria-label', text);
  }

  function detachSettings() {
    closeSettings(); sidebarRef?.removeEventListener('click', onSettingsClick, true);
    nav?.remove(); panel?.remove(); nav = panel = sidebarRef = rightRef = null;
  }

  function onActivity(event) {
    if (!event.isTrusted || event.target.closest?.('#ag-auto-approval-panel, #ag-auto-approval-badge')) return;
    lastActivity = Date.now();
    if (!event.target.closest?.('[data-testid="permission-target-editor"], [data-testid^="ask-question"], [data-testid="interaction-continue-button"], [data-testid="interaction-skip-button"]')) return;
    const state = snapshot(bindings().store);
    const activeId = location.pathname.match(/\/c\/([^/]+)/)?.[1];
    for (const c of state?.candidates || []) if (c.cascadeId === activeId) manualRequests.add(identity(c));
  }

  const timer = setInterval(tick, 500);
  document.addEventListener('pointerdown', onActivity, true);
  document.addEventListener('keydown', onActivity, true);
  function dispose() {
    if (disposed) return;
    disposed = true; clearInterval(timer); unsubscribe?.(); detachSettings(); badge?.remove();
    document.removeEventListener('pointerdown', onActivity, true); document.removeEventListener('keydown', onActivity, true);
    if (window.__agAutoApproval === api) delete window.__agAutoApproval;
  }
  const api = { attachSettings, detachSettings, closeSettings, setEnabled, tick, dispose,
    getStatus: () => ({ ...status, enabled }), getSettings: () => JSON.parse(JSON.stringify(settings)) };
  window.__agAutoApproval = api;
  ctx.onCleanup?.(dispose);
})();
