/**
 * DOM behaviour tests for user/custom.js (jsdom). Skipped automatically when jsdom is not installed:
 *   npm i --no-save jsdom && node --test test/
 * or point JSDOM_FROM at any package.json whose node_modules contains jsdom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let JSDOM = null;
try {
  JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM;
} catch {}
const skip = JSDOM ? false : 'jsdom not installed';

const SRC = fs
  .readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8')
  .replace(
    /\}\)\(\);\s*$/,
    'window.__t = { scheduleSync, syncStepStream, dispose, parseAndSlimMetricsPayload, cacheTierForRate, detectCompactStatus, triggerConversationCompact }; })();'
  );

function mount(html, { modules = {}, dict = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/c/abcd-1234',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const queue = new Map();
  let nextId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => queue.delete(id);
  const cleanups = [];
  window.ctx = { modules, dict: dict || undefined, onCleanup: (fn) => cleanups.push(fn) };
  window.eval(SRC);
  const flushFrames = () => {
    for (let i = 0; i < 10 && queue.size; i++) {
      const cbs = [...queue.values()];
      queue.clear();
      cbs.forEach((cb) => cb(0));
    }
  };
  const microtasks = () => new Promise((r) => setTimeout(r, 0));
  return { window, doc: window.document, queue, cleanups, flushFrames, microtasks, close: () => window.close() };
}

const li = (text, status = 'pending') =>
  status === 'completed'
    ? `<li class="task-list-item task-checked"><div></div><span class="task-checked-content">${text}</span></li>`
    : `<li class="task-list-item"><div class="${status === 'in_progress' ? 'bg-primary' : ''}"></div>${text}</li>`;
const ul = (...items) => `<ul class="contains-task-list">${items.join('')}</ul>`;
const pane = (turns, { generating = false } = {}) =>
  `<section>${turns.map((t) => `<div data-testid="agent-response">${t}</div>`).join('')}<div id="antigravity.agentSidePanelInputBox">${
    generating ? '<button data-testid="input-cancel-button"></button>' : ''
  }</div></section>`;

test('ordinary answer checklist stays native and visible', { skip }, () => {
  const h = mount(pane([ul(li('身份证复印件'), li('合同原件'))]));
  const list = h.doc.querySelector('ul');
  assert.equal(list.hasAttribute('data-ag-todo-merged'), false);
  assert.equal(list.hasAttribute('data-ag-todo-primary'), false);
  assert.equal(h.doc.querySelectorAll('.ag-claude-todo-card').length, 0);
  h.close();
});

test('ordinary checklist with some items ticked is also left alone', { skip }, () => {
  const h = mount(pane([ul(li('营业执照', 'completed'), li('授权委托书'), li('身份证明'))]));
  assert.equal(h.doc.querySelectorAll('.ag-claude-todo-card').length, 0);
  assert.equal(h.doc.querySelector('ul').attributes.length, 1);
  h.close();
});

test('interrupted execution checklist keeps a visible paused card', { skip }, () => {
  const h = mount(pane([ul(li('读代码', 'completed'), li('修复 bug', 'in_progress'), li('跑测试'))]));
  const list = h.doc.querySelector('ul');
  assert.equal(list.getAttribute('data-ag-todo-primary'), 'true');
  const card = list.nextElementSibling;
  assert.ok(card && card.classList.contains('ag-claude-todo-card'));
  assert.equal(card.getAttribute('data-ag-todo-paused'), 'true');
  assert.equal(card.querySelectorAll('.ag-claude-todo-row').length, 3);
  h.close();
});

test('cross-turn progress merges into one card; ordinary list in a later turn is untouched', { skip }, () => {
  const h = mount(
    pane([
      ul(li('阶段一 读代码', 'in_progress'), li('阶段二 修复'), li('阶段三 测试')),
      ul(li('阶段一 读代码', 'completed'), li('阶段二 修复', 'completed'), li('阶段三 测试', 'completed')),
      ul(li('身份证复印件'), li('合同原件'))
    ])
  );
  const lists = h.doc.querySelectorAll('ul');
  assert.equal(lists[0].getAttribute('data-ag-todo-merged'), 'true');
  assert.equal(lists[1].getAttribute('data-ag-todo-primary'), 'true');
  assert.equal(lists[1].nextElementSibling.hasAttribute('data-ag-todo-paused'), false);
  assert.equal(lists[2].hasAttribute('data-ag-todo-merged'), false);
  assert.equal(h.doc.querySelectorAll('.ag-claude-todo-card').length, 1);
  h.close();
});

test('live execution checklist follows the bottom of the active turn in-flow (never fixed outside on composer)', { skip }, async () => {
  const h = mount(pane([ul(li('读代码', 'in_progress'), li('修复'))], { generating: true }));
  const turn = h.doc.querySelector('[data-testid="agent-response"]');
  const dock = h.doc.querySelector('[data-ag-todo-dock]');
  assert.ok(dock);
  assert.equal(dock.parentElement, turn);
  assert.equal(turn.lastElementChild, dock);
  /* when new tool steps append into the turn, the card jumps down below the newest step */
  const toolStep = h.doc.createElement('div');
  toolStep.textContent = 'Running tool';
  turn.appendChild(toolStep);
  await h.microtasks();
  await new Promise((r) => setTimeout(r, 100));
  h.flushFrames();
  assert.equal(turn.lastElementChild, dock, 'card stays at the very bottom of the active turn');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('dispose cancels queued frames: no marker is resurrected', { skip }, async () => {
  const h = mount(pane([ul(li('读代码', 'in_progress'), li('修复'))]));
  h.doc.querySelector('section').appendChild(h.doc.createElement('p')); /* trigger a mutation -> scheduled sync */
  await h.microtasks();
  h.window.__t.scheduleSync();
  h.cleanups.forEach((fn) => fn());
  assert.equal(h.doc.querySelector('ul').hasAttribute('data-ag-todo-primary'), false);
  h.flushFrames();
  await new Promise((r) => setTimeout(r, 120)); /* any throttled timeout would have fired by now */
  h.flushFrames();
  assert.equal(h.doc.querySelector('ul').hasAttribute('data-ag-todo-primary'), false);
  assert.equal(h.doc.querySelectorAll('.ag-claude-todo-card').length, 0);
  h.close();
});

test('own DOM writes do not schedule another sync (no self-trigger loop)', { skip }, async () => {
  const h = mount(pane([ul(li('读代码', 'in_progress'), li('修复'))], { generating: true }));
  await h.microtasks();
  await h.microtasks();
  assert.equal(h.queue.size, 0, 'card/dock insertion must not re-trigger syncStepStream');
  h.close();
});

test('running timer lights only the generating pane', { skip }, async () => {
  const row = (label) => `<button data-testid="tool-group-collapsible" aria-expanded="false"><span title="${label}">${label}</span><svg></svg></button>`;
  const h = mount(
    `<div>${pane([row('Running command')], { generating: true })}${pane([row('Running command')], { generating: false })}</div>`
  );
  const [a, b] = h.doc.querySelectorAll('button[data-testid="tool-group-collapsible"]');
  assert.ok(a.querySelector('.ag-orbit-dots'), 'generating pane shows the indicator');
  assert.equal(b.querySelector('.ag-orbit-dots'), null, 'idle pane must stay clean');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

function modelTrigger(h) {
  const btn = h.doc.createElement('button');
  btn.setAttribute('data-testid', 'model-selector-trigger');
  btn.textContent = 'Gemini';
  let selected = { label: 'Gemini 4 Carbon (Medium)', value: 'c-m' };
  btn.__reactFiber$test = {
    memoizedProps: {
      modelOptions: [
        { label: 'Gemini 4 Carbon (Medium)', value: 'c-m' },
        { label: 'Gemini 4 Carbon (High)', value: 'c-h' },
        { label: 'Gemini 4 Carbon (XHigh)', value: 'c-xh' },
        { label: 'Gemini 3.8 Flash', value: 'f' }
      ],
      get selectedModel() {
        return selected;
      },
      setSelectedModel(o) {
        selected = o;
      }
    }
  };
  h.doc.body.appendChild(btn);
  return { btn, selected: () => selected };
}

test('keyboard activation (click detail=0) opens the custom menu', { skip }, () => {
  const h = mount('');
  const { btn, selected } = modelTrigger(h);
  btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  const pop = h.doc.getElementById('ag-claude-model-popover');
  assert.ok(pop);
  assert.equal(pop.getAttribute('data-open'), 'true');
  assert.equal(pop.getAttribute('role'), 'menu');

  /* Effort flyout displays XHigh as "Extra" while still selecting the underlying XHigh option */
  const effortTrigger = pop.querySelector('[data-ag-cm-subtrigger="effort"]');
  effortTrigger.click();
  const subPop = h.doc.getElementById('ag-claude-model-subpop');
  assert.equal(subPop.getAttribute('data-open'), 'true');
  const xhRow = subPop.querySelector('[data-ag-cm-effort="XHigh"]');
  assert.ok(xhRow, 'XHigh option row exists');
  assert.equal(xhRow.textContent.includes('Extra'), true, 'displays Extra label');
  assert.equal(xhRow.textContent.includes('XHigh'), false, 'hides raw XHigh text');
  xhRow.click();
  assert.equal(selected().value, 'c-xh', 'selecting Extra commits underlying XHigh option');

  /* Re-opening reflects Extra on the main effort row too */
  btn.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.match(pop.querySelector('[data-ag-cm-subtrigger="effort"]').textContent, /Extra/);
  assert.equal(h.doc.querySelectorAll('#ag-claude-model-popover').length, 1);
  h.close();
});

test('Enter opens + focuses menu, arrows move, Escape returns focus', { skip }, () => {
  const h = mount('');
  const { btn } = modelTrigger(h);
  btn.focus();
  const key = (target, k) => target.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key(btn, 'Enter');
  const pop = h.doc.getElementById('ag-claude-model-popover');
  assert.equal(pop.getAttribute('data-open'), 'true');
  assert.ok(pop.contains(h.doc.activeElement), 'focus moved into the menu');
  const first = h.doc.activeElement;
  key(first, 'ArrowDown');
  assert.notEqual(h.doc.activeElement, first);
  key(h.doc.activeElement, 'Escape');
  assert.equal(pop.getAttribute('data-open'), 'false');
  assert.ok(pop.hasAttribute('inert'), 'closed menu leaves the tab order');
  assert.equal(h.doc.activeElement, btn);
  h.close();
});

test('feature switch off: model menu is not intercepted, checklists untouched', { skip }, () => {
  const h = mount(pane([ul(li('读代码', 'in_progress'), li('修复'))]), {
    modules: { claudeUxModelMenu: false, claudeUxTodoCard: false }
  });
  const { btn } = modelTrigger(h);
  let native = 0;
  btn.addEventListener('click', () => native++);
  btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  assert.equal(native, 1);
  assert.equal(h.doc.getElementById('ag-claude-model-popover'), null);
  assert.equal(h.doc.querySelectorAll('.ag-claude-todo-card').length, 0);
  h.close();
});

test('virtualised step stream: card keeps the newest progress after the mid-turn list is unmounted', { skip }, async () => {
  const h = mount(pane([ul(li('阶段一 读代码', 'in_progress'), li('阶段二 修复'), li('阶段三 测试'))], { generating: true }));
  const statuses = () => Array.from(h.doc.querySelectorAll('[data-ag-todo-dock] .ag-claude-todo-row')).map((r) => r.getAttribute('data-status'));
  const settle = async () => {
    await h.microtasks();
    await new Promise((r) => setTimeout(r, 100));
    h.flushFrames();
  };
  assert.deepEqual(statuses(), ['in_progress', 'pending', 'pending']);

  /* a later step streams in with an updated checklist ... */
  const turn = h.doc.querySelector('[data-testid="agent-response"]');
  const step = h.doc.createElement('div');
  step.innerHTML = `<div data-testid="planner-response-text">${ul(li('阶段一 读代码', 'completed'), li('阶段二 修复', 'completed'), li('阶段三 测试', 'in_progress'))}</div>`;
  turn.appendChild(step);
  await settle();
  assert.deepEqual(statuses(), ['completed', 'completed', 'in_progress']);

  /* ... then scrolls out of the render window and is unmounted by the app */
  step.remove();
  await settle();
  assert.deepEqual(statuses(), ['completed', 'completed', 'in_progress'], 'must not fall back to the first list');

  /* scrolling back up re-mounts the first list: progress must not regress either */
  turn.appendChild(h.doc.createElement('p'));
  await settle();
  assert.deepEqual(statuses(), ['completed', 'completed', 'in_progress']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

function attachTurnSteps(h, texts) {
  const turn = h.doc.querySelector('[data-testid="agent-response"]');
  const steps = texts.map((t) => ({ step: { case: 'plannerResponse', value: { response: t, thinking: '- [x] 阶段一 (thinking must be ignored)' } } }));
  turn.__reactFiber$t = { memoizedProps: {}, return: { memoizedProps: { container: { steps } } } };
  return { turn, steps };
}

async function settle(h) {
  await h.microtasks();
  await new Promise((r) => setTimeout(r, 100));
  h.flushFrames();
}

const dockStatuses = (h) => Array.from(h.doc.querySelectorAll('[data-ag-todo-dock] .ag-claude-todo-row')).map((r) => r.getAttribute('data-status'));

test('invisible <!-- todo:N/M --> comment advances the live card; legacy 〔进度 N/M〕 lines are hidden', { skip }, async () => {
  const h = mount(
    pane([`${ul(li('切换守护', 'in_progress'), li('真机验证'), li('收尾说明'))}<p>〔进度 2/3〕真机验证</p>`], { generating: true })
  );
  assert.equal(h.doc.querySelector('p').getAttribute('data-ag-todo-marker-line'), 'true', 'legacy visible marker line is hidden');
  const { turn, steps } = attachTurnSteps(h, ['开场说明', '守护已切换。<!-- todo:2/3 -->']);
  turn.appendChild(h.doc.createElement('div'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['completed', 'in_progress', 'pending']);

  steps.push({ step: { case: 'plannerResponse', value: { response: '进入收尾。<!-- todo:3/3 -->' } } });
  turn.appendChild(h.doc.createElement('div'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['completed', 'completed', 'in_progress']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('full checklist in an unrendered step response is used; thinking text is ignored', { skip }, async () => {
  const h = mount(pane([ul(li('阶段一', 'in_progress'), li('阶段二'), li('阶段三'))], { generating: true }));
  const { turn } = attachTurnSteps(h, ['进展：\n- [x] 阶段一\n- [/] 阶段二\n- [ ] 阶段三']);
  turn.appendChild(h.doc.createElement('p'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['completed', 'in_progress', 'pending']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('marker with a mismatched total is ignored', { skip }, async () => {
  const h = mount(pane([ul(li('阶段一', 'in_progress'), li('阶段二'), li('阶段三'))], { generating: true }));
  const { turn } = attachTurnSteps(h, ['〔进度 2/5〕别的任务']);
  turn.appendChild(h.doc.createElement('p'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['in_progress', 'pending', 'pending']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('inline backtick or fenced code examples never pollute progress; fresher fiber.alternate wins', { skip }, async () => {
  const h = mount(pane([ul(li('阶段一', 'in_progress'), li('阶段二'), li('阶段三'))], { generating: true }));
  const turn = h.doc.querySelector('[data-testid="agent-response"]');
  const staleSteps = [{ step: { case: 'plannerResponse', value: { response: '开场说明' } } }];
  const freshSteps = [
    { step: { case: 'plannerResponse', value: { response: '开场说明' } } },
    {
      step: {
        case: 'plannerResponse',
        value: {
          response: '正文引用示例 `<!-- todo:3/3 -->` 和 `〔进度 3/3〕` 不应生效，只有真实注释生效。<!-- todo:2/3 -->'
        }
      }
    }
  ];
  /* Simulate React 18 double-buffering where __reactFiber$ points to the stale branch and fresher steps sit on .alternate */
  turn.__reactFiber$t = {
    memoizedProps: {},
    return: {
      memoizedProps: { container: { steps: staleSteps } },
      alternate: { memoizedProps: { container: { steps: freshSteps } } }
    }
  };
  turn.appendChild(h.doc.createElement('div'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['completed', 'in_progress', 'pending']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('follow-up live turn relays incomplete checklist and advances via <!-- todo:N/M --> without re-emitting <ul>', { skip }, async () => {
  const h = mount(
    pane([ul(li('阶段一', 'in_progress'), li('阶段二'), li('阶段三')), '<p>继续执行第二阶段</p>'], { generating: true })
  );
  const turns = h.doc.querySelectorAll('[data-testid="agent-response"]');
  const secondTurn = turns[1];
  secondTurn.__reactFiber$t = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        container: {
          steps: [{ step: { case: 'plannerResponse', value: { response: '继续第二阶段。<!-- todo:2/3 -->' } } }]
        }
      }
    }
  };
  secondTurn.appendChild(h.doc.createElement('div'));
  await settle(h);
  const dock = h.doc.querySelector('[data-ag-todo-dock]');
  assert.equal(dock.parentElement, secondTurn, 'live card relays into the follow-up turn');
  assert.deepEqual(dockStatuses(h), ['completed', 'in_progress', 'pending']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('Knowledge Work mode: final all-[x] DOM <ul> still renders as TodoWrite card when container.steps had [/] origin, while ordinary checklists stay native', { skip }, async () => {
  const h = mount(
    pane([
      ul(li('首航体检', 'completed'), li('查更新日志', 'completed'), li('汇总报告', 'completed')),
      ul(li('身份证复印件', 'completed'), li('合同原件'))
    ])
  );
  const turns = h.doc.querySelectorAll('[data-testid="agent-response"]');
  turns[0].__reactFiber$t = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        container: {
          steps: [
            {
              step: {
                case: 'plannerResponse',
                value: { response: '- [/] 首航体检\n- [ ] 查更新日志\n- [ ] 汇总报告' }
              }
            },
            {
              step: {
                case: 'plannerResponse',
                value: { response: '- [x] 首航体检\n- [x] 查更新日志\n- [x] 汇总报告' }
              }
            }
          ]
        }
      }
    }
  };
  turns[1].__reactFiber$t = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        container: {
          steps: [{ step: { case: 'plannerResponse', value: { response: '- [x] 身份证复印件\n- [ ] 合同原件' } } }]
        }
      }
    }
  };
  turns[0].appendChild(h.doc.createElement('span'));
  await settle(h);

  const cards = h.doc.querySelectorAll('.ag-claude-todo-card');
  assert.equal(cards.length, 1, 'only the execution-progress list becomes a card');
  const cardStatuses = Array.from(cards[0].querySelectorAll('.ag-claude-todo-row')).map((r) => r.getAttribute('data-status'));
  assert.deepEqual(cardStatuses, ['completed', 'completed', 'completed']);
  assert.equal(turns[1].querySelector('ul').hasAttribute('data-ag-todo-primary'), false, 'ordinary answer checklist untouched');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('Knowledge Work mode live turn: mounts live dock card from container.steps even when zero <ul> exist in DOM', { skip }, async () => {
  const h = mount(
    pane(['<button type="button" data-testid="progress-updates-collapsible" aria-expanded="false">已工作 12s · 2 条进展</button>'], {
      generating: true
    })
  );
  attachTurnSteps(h, ['- [/] 阶段一\n- [ ] 阶段二\n- [ ] 阶段三', '推进第二阶段。<!-- todo:2/3 -->']);
  const turn = h.doc.querySelector('[data-testid="agent-response"]');
  turn.appendChild(h.doc.createElement('span'));
  await settle(h);
  assert.deepEqual(dockStatuses(h), ['completed', 'in_progress', 'pending']);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('v2.33+ virtualized scroll: follow-up turn with <!-- todo:N/M --> + all-[x] <ul> renders card even when opening [/] turn is unmounted', { skip }, async () => {
  const h = mount(
    pane([
      ul(li('检查版本与日志', 'completed'), li('修复调试端口守护', 'completed'), li('实机校验自愈状态', 'completed')),
      ul(li('普通附件核对一', 'completed'), li('普通附件核对二', 'completed'), li('普通附件核对三', 'completed'))
    ])
  );
  const turns = h.doc.querySelectorAll('[data-testid="agent-response"]');
  turns[0].__reactFiber$t = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        container: {
          steps: [
            { step: { case: 'plannerResponse', value: { response: '开始第三阶段校验。<!-- todo:3/3 -->' } } },
            {
              step: {
                case: 'plannerResponse',
                value: { response: '- [x] 检查版本与日志\n- [x] 修复调试端口守护\n- [x] 实机校验自愈状态' }
              }
            }
          ]
        }
      }
    }
  };
  turns[0].appendChild(h.doc.createElement('span'));
  await settle(h);

  const cards = h.doc.querySelectorAll('.ag-claude-todo-card');
  assert.equal(cards.length, 1, 'follow-up turn with matching <!-- todo:3/3 --> becomes a bordered TodoWrite card');
  assert.equal(turns[0].querySelector('ul').getAttribute('data-ag-todo-primary'), 'true');
  assert.equal(turns[1].querySelector('ul').hasAttribute('data-ag-todo-primary'), false, 'ordinary all-[x] list without todo marker stays native');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('v2.33+ trajectorySlice.stepsInSlice: recovers [/] origin when earlier turn DOM node was virtual-scroll unmounted', { skip }, async () => {
  const h = mount(
    pane([
      `<div data-testid="autoscroll-viewport"></div>`,
      ul(li('拉取补丁源码', 'completed'), li('验证热重载', 'completed'), li('推送远端仓库', 'completed'))
    ])
  );
  const vp = h.doc.querySelector('[data-testid="autoscroll-viewport"]');
  vp.__reactFiber$vp = {
    memoizedProps: {},
    return: {
      memoizedProps: {
        trajectorySlice: {
          stepsInSlice: [
            {
              step: {
                case: 'plannerResponse',
                value: { response: '- [/] 拉取补丁源码\n- [ ] 验证热重载\n- [ ] 推送远端仓库' }
              }
            }
          ]
        }
      }
    }
  };
  const turns = h.doc.querySelectorAll('[data-testid="agent-response"]');
  turns[1].appendChild(h.doc.createElement('span'));
  await settle(h);

  const cards = h.doc.querySelectorAll('.ag-claude-todo-card');
  assert.equal(cards.length, 1, 'final all-[x] list inherits [/] origin from trajectorySlice.stepsInSlice');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('inline undo & edit: expands in-bubble editor, previews modified files, toggles file revert, and resends via host', { skip }, async () => {
  const h = mount(`
    <div data-testid="user-input-step">
      <div class="max-w-[80%]">
        <div data-testid="user-message-bubble">
          <div data-testid="user-message-content">原始提问内容</div>
        </div>
      </div>
      <button type="button" data-testid="revert-button">撤回</button>
    </div>
    <div data-testid="agent-input-box"><div id="lex-root"></div></div>
  `);
  const revBtn = h.doc.querySelector('button[data-testid="revert-button"]');
  const lexRoot = h.doc.getElementById('lex-root');
  let submitted = false;
  let convOnlyVal = false;
  const stepHandler = {
    getRevertPreviews: async () => [{ fileUri: 'file:///repo/user/custom.js' }, { fileUri: 'file:///repo/user/custom.css' }],
    revertToIndex: async () => true
  };
  const revertPreviewState = {
    get conversationOnly() {
      return convOnlyVal;
    },
    conversationOnlyRevertEnabled: true,
    setConversationOnly(v) {
      convOnlyVal = v;
    },
    revert() {
      stepHandler.revertToIndex('11111111-2222-3333-4444-555555555555', 4);
    }
  };
  revBtn.__reactFiber$r = {
    memoizedProps: {
      revertState: { canRevert: true, revertPreviewState },
      cascadeId: '11111111-2222-3333-4444-555555555555',
      userStepIndex: 5,
      items: [{ chunk: { case: 'text', value: '原始提问内容' } }]
    },
    dependencies: {
      firstContext: {
        memoizedValue: {
          stepHandler,
          inputBoxRef: {
            current: {
              lexicalRef: { current: { getRootElement: () => lexRoot } },
              getMediaAttachments: () => [],
              submit: () => {
                submitted = true;
              }
            }
          }
        }
      }
    }
  };

  revBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  const editor = h.doc.querySelector('.ag-claude-inline-editor');
  assert.ok(editor, 'in-bubble editor mounted');
  assert.equal(h.doc.querySelector('[data-testid="user-message-content"]').hidden, true, 'original bubble content hidden while editing');
  assert.match(editor.textContent, /custom\.js/, 'file revert preview chips rendered');

  const fileSwitch = editor.querySelector('[data-ag-revert-files-switch]');
  assert.equal(fileSwitch.getAttribute('aria-checked'), 'true');
  fileSwitch.click();
  assert.equal(convOnlyVal, true, 'file revert switch updates conversationOnly');

  const ta = editor.querySelector('.ag-claude-inline-textarea');
  ta.value = '修改后的新提问';
  ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  editor.querySelector('[data-ag-inline-send]').click();
  await new Promise((r) => setTimeout(r, 430));

  assert.equal(lexRoot.textContent, '修改后的新提问', 'edited prompt written to host composer');
  assert.equal(submitted, true, 'host submit() invoked after revert');
  assert.equal(h.doc.querySelector('.ag-claude-inline-editor'), null, 'inline editor cleaned up');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('sidebar folder status badges & top Recents: aggregates collapsed folders, sorts pending > running > recent, and navigates via router', { skip }, async () => {
  const h = mount(`
    <div class="sidebar-grand">
      <div class="sidebar-parent">
        <div data-testid="conversation-list-sidebar">
          <div>
            <div data-sidebar-section-drop-id="proj-a">
              <div class="group/header"><button type="button" data-testid="project-header" data-project-label="项目A" aria-expanded="false">项目A</button></div>
              <div data-testid="conversation-row-sidebar" class="agy-sidebar-row"><span class="truncate">恢复谷歌浏览器Gemini侧边栏</span></div>
            </div>
            <div data-sidebar-section-drop-id="proj-b">
              <div class="group/header"><button type="button" data-testid="project-header" data-project-label="项目B" aria-expanded="true">项目B</button></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);
  let navigatedTo = null;
  const nowSec = Math.floor(Date.now() / 1000);
  const storeState = {
    trajectorySummaries: {
      summaries: {
        'conv-idle-unread': {
          annotations: { title: '恢复谷歌浏览器Gemini侧边栏', lastUserViewTime: { seconds: nowSec - 600 } },
          lastModifiedTime: { seconds: nowSec - 60 },
          trajectoryMetadata: { projectId: 'proj-a' },
          status: 1
        },
        'conv-running': {
          annotations: { title: '正在后台编译' },
          lastModifiedTime: { seconds: nowSec - 300 },
          trajectoryMetadata: { projectId: 'proj-b' },
          status: 2
        },
        'conv-pending': {
          annotations: { title: '等待终端命令确认' },
          lastModifiedTime: { seconds: nowSec - 900 },
          trajectoryMetadata: { projectId: 'proj-a' },
          waitingSteps: [{ metadata: { toolCall: { name: 'run_command' } } }],
          status: 2
        },
        'conv-hidden-ocr': {
          summary: '你是高精度文档转录器。把这一页扫描件逐字转录为 Markdown：',
          lastModifiedTime: { seconds: nowSec - 180 },
          trajectoryMetadata: { projectId: 'proj-a', sourceMetadata: { hideFromConversationList: true } },
          status: 1
        },
        'conv-hidden-workflow': {
          summary: '后台批处理 workflow',
          lastModifiedTime: { seconds: nowSec - 120 },
          trajectoryMetadata: { projectId: 'proj-b', sourceMetadata: { hideFromConversationList: true } },
          status: 1
        },
        'conv-pinned': {
          annotations: { title: '已置顶高频会话', pinned: true },
          lastModifiedTime: { seconds: nowSec - 10 },
          trajectoryMetadata: { projectId: 'outside-of-project' },
          status: 1
        }
      }
    }
  };
  const sb = h.doc.querySelector('[data-testid="conversation-list-sidebar"]');
  sb.firstElementChild.__reactFiber$sb = {
    memoizedProps: {
      sidebarStore: { getState: () => storeState, subscribe: () => () => {} },
      sidebarRouter: {
        state: { location: { pathname: '/' } },
        navigate: (arg) => {
          navigatedTo = arg;
        }
      },
      sidebarGroups: [
        { id: 'proj-a', label: '项目A', conversationIds: ['conv-idle-unread', 'conv-pending', 'conv-hidden-ocr'] },
        { id: 'proj-b', label: '项目B', conversationIds: ['conv-running', 'conv-hidden-workflow'] }
      ]
    }
  };
  sb.appendChild(h.doc.createElement('span'));
  await settle(h);

  const hdrs = h.doc.querySelectorAll('button[data-testid="project-header"]');
  const badgesA = hdrs[0].parentElement.querySelectorAll('.ag-claude-folder-badge');
  const badgesB = hdrs[1].parentElement.querySelectorAll('.ag-claude-folder-badge');
  assert.equal(badgesA.length, 2, 'collapsed proj-a renders pending + unread badges');
  assert.equal(badgesA[0].getAttribute('data-kind'), 'pending');
  assert.equal(badgesA[1].getAttribute('data-kind'), 'unread');
  assert.equal(badgesA[1].textContent.trim(), '1', 'hidden hideFromConversationList sessions do not count as ghost unread');
  assert.equal(badgesB.length, 0, 'expanded proj-b suppresses folder badges');

  const recentRows = h.doc.querySelectorAll('#ag-claude-recent-section .ag-recent-row');
  assert.equal(recentRows.length, 3);
  assert.deepEqual(
    Array.from(recentRows).map((r) => r.getAttribute('data-ag-recent-id')),
    ['conv-pending', 'conv-running', 'conv-idle-unread'],
    'sorted by pending > running > recent and excludes hidden workflow & already-pinned sessions'
  );
  assert.equal(h.doc.documentElement.getAttribute('lang'), 'zh-CN', 'sets zh-CN root locale for CJK shaping & line-break rules');
  assert.equal(
    h.doc.querySelector('#ag-claude-recent-section .ag-recent-row:nth-child(3) .ag-recent-title').textContent,
    '恢复谷歌浏览器Gemini侧边栏',
    'keeps raw title untouched so native CSS text-autospace provides uniform 1/8em spacing'
  );
  assert.equal(h.doc.querySelector('[data-testid="conversation-row-sidebar"] span.truncate').textContent, '恢复谷歌浏览器Gemini侧边栏');
  assert.equal(h.doc.querySelectorAll('#ag-claude-recent-section .ag-recent-proj').length, 0, 'Variant A uses pure single-line rows');
  assert.match(recentRows[1].getAttribute('title') || '', /Project: 项目B/, 'hover title exposes project name in default English UI');
  recentRows[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(navigatedTo)), { to: '/c/$cascadeId', params: { cascadeId: 'conv-running' } });
  h.cleanups.forEach((fn) => fn());
  assert.equal(h.doc.documentElement.hasAttribute('lang'), false, 'dispose restores original html lang state');
  h.close();
});

test('native Settings -> UI Enhancements panel: defaults to English and live-toggles Chinese UI localization with localStorage persistence', { skip }, async () => {
  const h = mount(
    `
    <div data-split-root="true">
      <div>
        <div data-testid="settings-sidebar">
          <div class="flex flex-col gap-0.5">
            <div class="group/nav-item"><button type="button" data-testid="settings-nav-item-General" class="bg-sidebar-secondary"><span>General</span></button></div>
            <div class="group/nav-item"><button type="button" data-testid="settings-nav-item-Appearance"><span>Appearance</span></button></div>
          </div>
        </div>
      </div>
      <div>
        <div id="settings-right-host"><div id="native-general-pane">Native general content</div></div>
      </div>
    </div>
    <div id="step-stream-probe">
      <span id="p-compound">Explored file, edited files</span>
      <span id="p-count">Explored 3 files</span>
      <span id="p-active">Editing custom.js</span>
      <span id="p-runfor">Running for 4s</span>
      <span id="p-working">Working</span>
    </div>
  `,
    { dict: { General: '常规', Appearance: '外观', Working: '正在工作' } }
  );
  await settle(h);

  const navBtn = h.doc.querySelector('button[data-testid="settings-nav-item-ClaudeUX"]');
  assert.ok(navBtn, 'UI Enhancements nav button injected into settings-sidebar');
  assert.equal(navBtn.textContent.trim(), 'UI Enhancements', 'defaults to English');
  assert.equal(h.doc.documentElement.getAttribute('data-ag-ux-lang'), 'en');
  assert.equal(h.doc.querySelector('button[data-testid="settings-nav-item-General"]').textContent.trim(), 'General');
  assert.equal(h.doc.getElementById('p-compound').textContent, 'Explored file, edited files');
  assert.equal(h.doc.getElementById('p-working').textContent, 'Working');
  navBtn.click();

  const rightHost = h.doc.getElementById('settings-right-host');
  const panel = h.doc.getElementById('ag-claude-ux-settings-panel');
  assert.equal(rightHost.getAttribute('data-ag-claude-settings-open'), 'true');
  assert.ok(panel && !panel.hidden, 'Anti-Claude settings panel visible');

  /* Toggle Chinese UI localization ON -> translates native UI & enhancement panel live */
  const i18nSwitch = panel.querySelector('[data-ag-cux-switch="i18n"]');
  assert.ok(i18nSwitch, 'Chinese UI localization switch rendered');
  assert.equal(i18nSwitch.getAttribute('aria-checked'), 'false', 'i18n switch off by default');
  i18nSwitch.click();
  assert.equal(h.doc.documentElement.getAttribute('data-ag-ux-lang'), 'zh');
  assert.equal(navBtn.textContent.trim(), '界面增强');
  assert.equal(h.doc.querySelector('button[data-testid="settings-nav-item-General"]').textContent.trim(), '常规');
  assert.equal(h.doc.querySelector('button[data-testid="settings-nav-item-Appearance"]').textContent.trim(), '外观');
  assert.equal(h.doc.getElementById('p-compound').textContent, '已探索文件、已编辑文件');
  assert.equal(h.doc.getElementById('p-count').textContent, '已探索 3 个文件');
  assert.equal(h.doc.getElementById('p-active').textContent, '正在编辑 custom.js');
  assert.equal(h.doc.getElementById('p-runfor').textContent, '已运行 4s');
  assert.equal(h.doc.getElementById('p-working').textContent, '正在工作');
  assert.match(panel.textContent, /中文界面汉化/);
  assert.match(h.window.localStorage.getItem('ag_claude_ux_modules_v1') || '', /"i18n":true/);

  /* Toggle Chinese UI localization back OFF -> restores native English UI & enhancement panel live */
  panel.querySelector('[data-ag-cux-switch="i18n"]').click();
  assert.equal(h.doc.documentElement.getAttribute('data-ag-ux-lang'), 'en');
  assert.equal(navBtn.textContent.trim(), 'UI Enhancements');
  assert.equal(h.doc.querySelector('button[data-testid="settings-nav-item-General"]').textContent.trim(), 'General');
  assert.equal(h.doc.querySelector('button[data-testid="settings-nav-item-Appearance"]').textContent.trim(), 'Appearance');
  assert.equal(h.doc.getElementById('p-compound').textContent, 'Explored file, edited files');
  assert.equal(h.doc.getElementById('p-count').textContent, 'Explored 3 files');
  assert.equal(h.doc.getElementById('p-active').textContent, 'Editing custom.js');
  assert.equal(h.doc.getElementById('p-runfor').textContent, 'Running for 4s');
  assert.equal(h.doc.getElementById('p-working').textContent, 'Working');
  assert.match(h.window.localStorage.getItem('ag_claude_ux_modules_v1') || '', /"i18n":false/);

  const recentSwitch = panel.querySelector('[data-ag-cux-switch="claudeUxRecentSection"]');
  assert.equal(recentSwitch.getAttribute('aria-checked'), 'true');
  recentSwitch.click();
  assert.equal(recentSwitch.getAttribute('aria-checked'), 'false');
  assert.match(h.window.localStorage.getItem('ag_claude_ux_modules_v1') || '', /"claudeUxRecentSection":false/);

  h.doc.querySelector('button[data-testid="settings-nav-item-General"]').click();
  assert.equal(rightHost.hasAttribute('data-ag-claude-settings-open'), false, 'clicking native nav item restores native settings pane');
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('metrics slimming: keeps outer TTFT pill, renders minimalist two-section popover with TTFT & tiered Cache %, and stays idempotent', { skip }, () => {
  const h = mount(pane([]));
  const { parseAndSlimMetricsPayload, cacheTierForRate } = h.window.__t;

  assert.equal(cacheTierForRate(95.3), 'high');
  assert.equal(cacheTierForRate(87.0), 'mid');
  assert.equal(cacheTierForRate(80.0), 'low');

  const mkPayload = ({ turns, cacheRate, sessCacheRate, hold = false }) => ({
    cascadeId: 'abcd-1234',
    hasData: true,
    inlineHtml:
      `<span>162 tok/s</span><span class="ag-sep">·</span><span>${hold ? 'Hold 1.8s' : 'TTFT 2.5s'}</span>` +
      '<span class="ag-sep">·</span><span>Ctx 45k/512k <span class="">(9%)</span></span>' +
      '<span class="ag-sep">·</span><span>Out 4.6k</span>' +
      '<span class="ag-sep">·</span><span class="ag-sub-badge">+2 sub</span>',
    tooltipHtml:
      `<div class="ag-tt-hdr">本轮最新调用 (Gen #6)</div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">${hold ? '端到端（含等待） 148.8 tok/s' : '流式 162.1 tok/s | 端到端（含等待） 148.8 tok/s'}</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">${hold ? '等待 1.80s | 刷出 28.24s | 总计 30.04s' : 'TTFT 2.52s | 流式 28.24s | 总计 30.76s'}</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">45,226 (新增 2,125 + 缓存 43,101, ${cacheRate}%)</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">4,578 (思考链 3,064 + 正文/工具 1,514)</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">本轮合计 (6步)</span><span class="ag-tt-val">输出 11,365 (思考 5,964 + 响应 5,401) | 耗时 76.8s</span></div>` +
      `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (${turns} 轮提问 / 6 次有效调用)</div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">45k / 512k (9%) · 距压缩余 467k</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输入量</span><span class="ag-tt-val">新增 48k + 缓存读取 186k (命中率 ${sessCacheRate}%)</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">累计输出量</span><span class="ag-tt-val">总计 28k (思考链 12k + 正文/工具 16k)</span></div>`
  });

  const slim1 = parseAndSlimMetricsPayload(mkPayload({ turns: 1, cacheRate: '95.3', sessCacheRate: '79.6' }));
  assert.ok(slim1.inlineHtml.includes('TTFT 2.5s'), 'outer pill keeps TTFT');
  assert.equal(slim1.inlineHtml.includes('Cache'), false, 'outer pill does not replace TTFT with Cache');
  assert.equal(slim1.inlineHtml.includes('Ctx'), false);
  assert.equal(slim1.inlineHtml.includes('Out'), false);
  assert.equal(slim1.inlineHtml.includes('sub'), false);

  assert.ok(slim1.tooltipHtml.includes('class="ag-ux-tt"'));
  assert.ok(slim1.tooltipHtml.includes('This turn'));
  assert.ok(slim1.tooltipHtml.includes('TTFT') && slim1.tooltipHtml.includes('2.5s'));
  assert.ok(slim1.tooltipHtml.includes('1m 17s'));
  assert.ok(slim1.tooltipHtml.includes('11.4k'));
  assert.ok(slim1.tooltipHtml.includes('Session'));
  assert.ok(slim1.tooltipHtml.includes('data-cache-tier="high"'));
  assert.equal(slim1.tooltipHtml.includes('Gen #6'), false);
  assert.equal(slim1.tooltipHtml.includes('距压缩余'), false);
  assert.equal(slim1.tooltipHtml.includes('Total out'), false, 'turn 1 without subagent omits total output');

  const replayed = parseAndSlimMetricsPayload(slim1);
  assert.equal(replayed.inlineHtml, slim1.inlineHtml);
  assert.equal(replayed.tooltipHtml, slim1.tooltipHtml);

  const slimHold = parseAndSlimMetricsPayload(mkPayload({ turns: 3, cacheRate: '87.2', sessCacheRate: '82.1', hold: true }));
  assert.ok(slimHold.inlineHtml.includes('Hold 1.8s'), 'outer pill keeps Hold on buffered run');
  assert.ok(slimHold.tooltipHtml.includes('Hold') && slimHold.tooltipHtml.includes('1.8s'));
  assert.ok(slimHold.tooltipHtml.includes('data-cache-tier="mid"'));
  assert.ok(slimHold.tooltipHtml.includes('Total out') && slimHold.tooltipHtml.includes('28k'));

  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('historical incomplete or split-turn checklist never resurrects into an unrelated new live turn', { skip }, async () => {
  const h = mount(
    pane(
      [
        ul(li('排查发虚根因', 'in_progress'), li('修复设置侧栏'), li('融合遥测浮窗'), li('同步仓库提交')),
        '<p>异步任务汇总结果</p>',
        '<p>正在思考新问题</p>'
      ],
      { generating: true }
    )
  );
  const turns = h.doc.querySelectorAll('[data-testid="agent-response"]');
  turns[2].__reactFiber$t = {
    memoizedProps: { container: { steps: [{ step: { case: 'plannerResponse', value: { response: '正在思考新问题' } } }] } }
  };
  await settle(h);

  assert.equal(h.doc.querySelector('[data-ag-todo-dock]'), null, 'must never hijack an unrelated new live turn');
  const card = h.doc.querySelector('[data-ag-todo-mount]');
  assert.ok(card && card.getAttribute('data-ag-todo-paused') === 'true', 'historical incomplete card stays paused in place');

  /* Next sub-turn completes the checklist right after plain bullets in markdown */
  turns[1].__reactFiber$t = {
    memoizedProps: {
      container: {
        steps: [
          {
            step: {
              case: 'plannerResponse',
              value: {
                response:
                  '- 说明文字一行\n- 说明文字二行\n- [x] 排查发虚根因\n- [x] 修复设置侧栏\n- [x] 融合遥测浮窗\n- [x] 同步仓库提交'
              }
            }
          }
        ]
      }
    }
  };
  turns[1].appendChild(h.doc.createElement('span'));
  await settle(h);

  assert.equal(h.doc.querySelector('[data-ag-todo-dock]'), null, 'live dock still stays unmounted on unrelated Turn 2');
  const statuses = Array.from(card.querySelectorAll('.ag-claude-todo-row')).map((r) => r.getAttribute('data-status'));
  assert.deepEqual(statuses, ['completed', 'completed', 'completed', 'completed'], 'upgrades historical card via forward step scan');
  assert.equal(card.hasAttribute('data-ag-todo-paused'), false);
  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('context ring & quota popover: adds inline compact button and immediately clears post-/compact 94% red state', { skip }, async () => {
  const html = `
    <section>
      <div data-testid="autoscroll-viewport" id="vp">
        <div data-testid="user-input-step"><div data-testid="user-message-content">帮我分析代码</div></div>
        <div data-testid="agent-response"><p>分析完毕。</p></div>
      </div>
      <div id="antigravity.agentSidePanelInputBox">
        <div class="flex min-w-0 flex-1 items-center">
          <div><button type="button" data-testid="model-selector-trigger">Gemini 4 Carbon High</button></div>
          <div id="ag-live-metrics-pill"></div>
        </div>
      </div>
      <div id="ag-live-metrics-tooltip"></div>
    </section>
  `;
  const h = mount(html);
  let submittedArgs = null;
  let simRunning = false;
  const ib = h.doc.getElementById('antigravity.agentSidePanelInputBox');
  ib.__reactFiber$t = {
    memoizedProps: {
      get isRunning() {
        return simRunning;
      },
      slashCommandItems: [
        {
          title: 'compact',
          info: {
            $typeName: 'exa.codeium_common_pb.SlashCommandInfo',
            name: 'compact',
            modelFacingText: '',
            type: 1,
            icon: 'collapse_all',
            displayName: '',
            logo: ''
          }
        }
      ],
      handleSubmit: async (items, media, clearEditor) => {
        submittedArgs = { items, media, clearEditor };
        simRunning = true;
      }
    }
  };

  h.window.__ag_render_metrics = function (payload) {
    h.window.__ag_last_metrics = payload;
  };
  h.window.__t.syncStepStream();
  await settle(h);

  const mkHighPayload = (ctxShort, pct, outShort) => ({
    cascadeId: 'abcd-1234',
    hasData: true,
    inlineHtml:
      `<span>49 tok/s</span><span class="ag-sep">·</span><span>TTFT 29.6s</span>` +
      `<span class="ag-sep">·</span><span>Ctx ${ctxShort}/512k <span class="ag-ctx-crit">(${pct}%)</span></span>` +
      `<span class="ag-sep">·</span><span>Out ${outShort}</span>`,
    tooltipHtml:
      `<div class="ag-tt-hdr">本轮最新调用 (Gen #804)</div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">流式 48.7 tok/s | 端到端（含等待） 27.9 tok/s</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">TTFT 29.59s | 流式 39.61s | 总计 69.20s</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">当前上下文</span><span class="ag-tt-val">482,947 (新增 482,947 + 缓存 0, 0.0%)</span></div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">本步输出量</span><span class="ag-tt-val">1,931 (思考链 1,074 + 正文/工具 857)</span></div>` +
      `<div class="ag-tt-hdr ag-tt-sec">当前会话累计 (28 轮提问 / 804 次有效调用)</div>` +
      `<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">${ctxShort} / 512k (${pct}%) · 距压缩余 29k</span></div>`
  });

  /* 1. High context before compact -> ring is red (crit), popover shows urgent ready compact button */
  h.window.__ag_render_metrics(mkHighPayload('483k', 94, '1.9k'));
  const ring = h.doc.getElementById('ag-claude-ctx-ring');
  assert.ok(ring, 'context ring mounted');
  assert.equal(ring.getAttribute('data-level'), 'crit');

  ring.click();
  const pop = h.doc.getElementById('ag-claude-quota-popover');
  assert.equal(pop.getAttribute('data-open'), 'true');
  const compactBtn = pop.querySelector('[data-ag-qp-compact]');
  assert.ok(compactBtn, 'compact button rendered next to 当前上下文');
  assert.equal(compactBtn.getAttribute('data-state'), 'ready');
  assert.equal(compactBtn.getAttribute('data-urgent'), 'crit');
  assert.equal(compactBtn.textContent.trim(), 'Compact');

  /* 2. Clicking compact dispatches native slashCommand:compact without clearing draft & enters compacting state */
  compactBtn.click();
  await h.microtasks();
  assert.ok(submittedArgs, 'invoked native handleSubmit');
  assert.equal(submittedArgs.items[0].chunk.value.scopeItem.case, 'slashCommand');
  assert.equal(submittedArgs.items[0].chunk.value.scopeItem.value.info.name, 'compact');
  assert.equal(ring.getAttribute('data-level'), 'normal', 'ring leaves red crit immediately on compacting');
  assert.equal(ring.getAttribute('data-compact-state'), 'compacting');
  assert.equal(pop.querySelector('[data-ag-qp-compact]').getAttribute('data-state'), 'compacting');
  assert.match(pop.textContent, /Compacting…/);

  /* 3a. /compact finishes (checkpoint without hydrated metadata.modelUsage), while daemon still pushes 481k/94% + Out 574 */
  const vp = h.doc.getElementById('vp');
  simRunning = false;
  vp.__reactFiber$t = {
    memoizedProps: {
      trajectorySlice: {
        conversationId: 'abcd-1234',
        stepsInSlice: [
          { type: 14, status: 3, step: { case: 'userInput', value: { userResponse: '帮我分析代码' } } },
          { type: 15, status: 3, step: { case: 'plannerResponse', value: { response: '分析完毕。' } } },
          { type: 14, status: 3, step: { case: 'userInput', value: { userResponse: '/compact ' } } },
          { type: 23, status: 3, step: { case: 'checkpoint', value: { modelSummarizationFailed: false } } }
        ]
      }
    }
  };
  h.window.__ag_render_metrics(mkHighPayload('481k', 94, '574'));
  await settle(h);

  assert.equal(h.window.__t.detectCompactStatus('abcd-1234'), 'compacted');
  assert.equal(ring.getAttribute('data-level'), 'normal', 'ring stays normal instead of stale 94% red');
  assert.equal(ring.getAttribute('data-compact-state'), 'compacted');
  assert.equal(pop.querySelector('[data-ag-qp-compact]').getAttribute('data-state'), 'compacted');
  assert.match(pop.textContent, /Compacted/);
  assert.equal(pop.textContent.includes('574'), false, 'must never misread prior Out 574 as compact summary');
  assert.equal(pop.textContent.includes('→ 摘要'), false);
  assert.match(pop.textContent, /Compacted · refreshes next turn/);

  /* 3b. checkpoint hydrates metadata.modelUsage -> displays real 5.2k / 512k (1%) */
  vp.__reactFiber$t.memoizedProps.trajectorySlice.stepsInSlice[3].metadata = {
    modelUsage: {
      inputTokens: '3531',
      cacheReadTokens: '478996',
      outputTokens: '5443',
      responseOutputTokens: '5178'
    }
  };
  h.window.__ag_render_metrics(mkHighPayload('481k', 94, '574'));
  await settle(h);

  assert.match(pop.textContent, /5\.2k \/ 512k/);
  assert.match(pop.textContent, /1%/);
  assert.equal(pop.textContent.includes('574'), false);
  assert.equal(pop.textContent.includes('~5%'), false);
  assert.match(h.window.__ag_last_metrics.tooltipHtml, /5\.2k \/ 512k/);
  assert.match(h.window.__ag_last_metrics.tooltipHtml, /was 483k/);
  assert.equal(h.window.__ag_last_metrics.tooltipHtml.includes('94%'), false);

  /* 3c. Bottom metrics pill CSS centering & centered tooltip positioning in narrow window mode */
  const customCss = fs.readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  assert.match(
    customCss,
    /#ag-live-metrics-pill\[data-ag-row-mode="bottom"\][\s\S]*?justify-content:\s*center\s*!important/,
    'custom.css centers bottom-row metrics pill'
  );
  const pillEl = h.doc.getElementById('ag-live-metrics-pill');
  pillEl.setAttribute('data-ag-row-mode', 'bottom');
  const textEl = h.doc.createElement('span');
  textEl.id = 'ag-live-metrics-text';
  textEl.textContent = '110 tok/s · TTFT 10.9s';
  Object.defineProperty(textEl, 'offsetWidth', { value: 120, configurable: true });
  pillEl.getBoundingClientRect = () => ({ left: 40, top: 500, width: 420, height: 22, right: 460, bottom: 522 });
  textEl.getBoundingClientRect = () => ({ left: 190, top: 502, width: 120, height: 18, right: 310, bottom: 520 });
  pillEl.appendChild(textEl);
  const ttEl = h.doc.getElementById('ag-live-metrics-tooltip');
  ttEl.innerHTML = h.window.__ag_last_metrics.tooltipHtml;
  pillEl.dispatchEvent(new h.window.MouseEvent('mouseenter', { bubbles: true }));
  await h.microtasks();
  assert.equal(ttEl.style.left, '114px', 'tooltip centers horizontally over centered bottom text instead of flush-left pill edge');

  /* 4. Next user turn completes with fresh 35k (7%) metrics -> returns to live idle state & re-enables button */
  vp.__reactFiber$t.memoizedProps.trajectorySlice.stepsInSlice.push(
    { type: 14, status: 3, step: { case: 'userInput', value: { userResponse: '继续下一步' } } },
    { type: 15, status: 3, step: { case: 'plannerResponse', value: { response: '好的。' } } }
  );
  h.window.__ag_render_metrics(mkHighPayload('35k', 7, '1k'));
  await settle(h);

  assert.equal(h.window.__t.detectCompactStatus('abcd-1234'), 'idle');
  assert.equal(ring.hasAttribute('data-compact-state'), false);
  assert.equal(ring.getAttribute('data-level'), 'normal');
  assert.equal(pop.querySelector('[data-ag-qp-compact]').getAttribute('data-state'), 'ready');
  assert.match(pop.textContent, /35k \/ 512k · Out 1k/);

  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('inline pill CJK hygiene, slice marker TodoWrite recovery & fractional sub-1 tok/s metrics formatting', { skip }, async () => {
  const html = `
    <section>
      <div data-testid="autoscroll-viewport" id="vp">
        <div data-testid="agent-response">
          <div data-testid="planner-response-text" class="select-text">
            <p id="p1">第 24、25 张截图（ <bdi class="context-scope-mention"><button class="inline-pill">a.png</button></bdi> 、 <bdi class="context-scope-mention"><button class="inline-pill">b.png</button></bdi> ）：改成 <code>Extra</code> ，发布 <code>v2.3.4</code> 。</p>
            ${ul(li('改成 Extra', 'completed'), li('跑全量单测', 'completed'), li('推送 GitHub', 'completed'))}
          </div>
        </div>
        <div data-testid="agent-response">
          <div data-testid="planner-response-text">
            ${ul(li('普通完成一', 'completed'), li('普通完成二', 'completed'), li('普通完成三', 'completed'))}
          </div>
        </div>
      </div>
      <div id="antigravity.agentSidePanelInputBox"></div>
    </section>
  `;
  const h = mount(html);
  const vp = h.doc.getElementById('vp');
  vp.__reactFiber$t = {
    memoizedProps: {
      trajectorySlice: {
        stepsInSlice: [
          { step: { case: 'plannerResponse', value: { response: '推进第二步。<!-- todo:2/3 -->' } } },
          { step: { case: 'plannerResponse', value: { response: '推进第三步。<!-- todo:3/3 -->' } } },
          {
            step: {
              case: 'plannerResponse',
              value: { response: '- [x] 改成 Extra\n- [x] 跑全量单测\n- [x] 推送 GitHub' }
            }
          }
        ]
      }
    }
  };
  h.window.__t.syncStepStream();
  await settle(h);

  /* 1. Inline code & file pill boundary spaces stripped + U+2060 Word Joiner attached to CJK punctuation */
  const p1 = h.doc.getElementById('p1');
  const bdis = p1.querySelectorAll('bdi.context-scope-mention');
  const codes = p1.querySelectorAll('code');
  assert.equal(bdis[0].previousSibling.nodeValue, '第 24、25 张截图（\u2060');
  assert.equal(bdis[0].nextSibling.nodeValue, '\u2060、');
  assert.equal(bdis[1].nextSibling.nodeValue, '\u2060）：改成');
  assert.equal(codes[0].nextSibling.nodeValue, '\u2060，发布');
  assert.equal(codes[1].nextSibling.nodeValue, '\u2060。');

  /* 2. Slice <!-- todo:N/M --> + all-[x] list recovers bordered TodoWrite card once without matching unrelated next list */
  const cards = h.doc.querySelectorAll('.ag-claude-todo-card');
  assert.equal(cards.length, 1, 'recovers bordered card for the marker-backed completed list only');

  /* 3. Fractional 0.3 tok/s + Hold >= 60s formatted cleanly instead of "0 tok/s · Hold 264.5s" */
  const slim = h.window.__t.parseAndSlimMetricsPayload({
    cascadeId: 'abcd-1234',
    hasData: true,
    inlineHtml:
      '<span>0 tok/s</span><span class="ag-sep">·</span><span>Hold 264.5s</span>' +
      '<span class="ag-sep">·</span><span>Ctx 225k/512k <span>(44%)</span></span><span class="ag-sep">·</span><span>Out 75</span>',
    tooltipHtml:
      '<div class="ag-tt-hdr">本轮最新调用 (Gen #40)</div>' +
      '<div class="ag-tt-row"><span class="ag-tt-lbl">生成速度</span><span class="ag-tt-val">端到端（含等待） 0.3 tok/s</span></div>' +
      '<div class="ag-tt-row"><span class="ag-tt-lbl">响应耗时</span><span class="ag-tt-val">等待 264.51s | 刷出 0.41s | 总计 264.91s</span></div>' +
      '<div class="ag-tt-row"><span class="ag-tt-lbl">压缩水位线</span><span class="ag-tt-val">225k / 512k (44%) · 距压缩余 287k</span></div>'
  });
  assert.match(slim.inlineHtml, /0\.3 tok\/s/);
  assert.match(slim.inlineHtml, /Hold 4m 25s/);
  assert.equal(slim.inlineHtml.includes('>0 tok/s<'), false);
  assert.match(slim.tooltipHtml, /0\.3 tok\/s/);

  /* 4. dispose() restores exact original text nodes */
  h.cleanups.forEach((fn) => fn());
  assert.equal(bdis[0].previousSibling.nodeValue, '第 24、25 张截图（ ');
  assert.equal(bdis[0].nextSibling.nodeValue, ' 、 ');
  assert.equal(codes[0].nextSibling.nodeValue, ' ，发布 ');
  h.close();
});

test('dictation editor isolation, ask-question icon removal & Orchestrator model pass-through', { skip }, async () => {
  const customCss = fs.readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  const configJson = JSON.parse(fs.readFileSync(path.join(REPO, 'user', 'config.json'), 'utf8'));
  const i18nOverride = JSON.parse(fs.readFileSync(path.join(REPO, 'user', 'i18n.override.json'), 'utf8'));

  /* 1. Editable Lexical / textarea / input blocks isolate from @font-face size-adjust and force no-autospace + space-all */
  assert.match(customCss, /--font-editor-sans:/);
  assert.match(
    customCss,
    /\[data-lexical-editor="true"\][\s\S]*?font-family:\s*var\(--font-editor-sans\)\s*!important[\s\S]*?text-autospace:\s*no-autospace\s*!important[\s\S]*?text-spacing-trim:\s*space-all\s*!important/
  );
  assert.match(customCss, /\[data-testid="ask-question-header-icon"\]\s*\{\s*display:\s*none\s*!important;\s*\}/);

  /* 2. i18n config & override protect all Orchestrator model names */
  const ex = configJson.selectors && configJson.selectors.excludeI18n;
  for (const sel of [
    '[data-testid="model-selector-trigger"]',
    '[data-ag-i18n-ignore="1"]',
    '#ag-claude-model-popover',
    '#ag-claude-model-subpop'
  ]) {
    assert.ok(ex.includes(sel), `excludeI18n contains ${sel}`);
  }
  assert.equal(i18nOverride['Orchestrator (Neon)'], 'Orchestrator (Neon)');

  /* 3. syncModelTriggerDisplay restores accidentally translated Orchestrator text and maps XHigh -> Extra */
  const html = `
    <section>
      <div id="antigravity.agentSidePanelInputBox">
        <button type="button" data-testid="model-selector-trigger"><span>编排器 (Neon)</span></button>
      </div>
    </section>
  `;
  const h = mount(html);
  h.window.__t.syncStepStream();
  await settle(h);
  const btn = h.doc.querySelector('button[data-testid="model-selector-trigger"]');
  assert.equal(btn.getAttribute('data-ag-i18n-ignore'), '1');
  assert.equal(btn.textContent.trim(), 'Orchestrator (Neon)');

  btn.querySelector('span').textContent = 'Gemini 4 Carbon Extra High';
  h.window.__t.syncStepStream();
  assert.equal(btn.textContent.trim(), 'Gemini 4 Carbon Extra');

  /* 4. Primary list places Gemini 4 Neon above Argon (5 items) and omits Orch abbreviation on 更多模型 */
  btn.__reactFiber$m = {
    memoizedProps: {
      selectedModel: { label: 'Orchestrator (Neon)', value: 'orch-neon' },
      setSelectedModel: () => {},
      modelOptions: [
        { label: 'Gemini 4 Carbon (High)', value: 'c-h' },
        { label: 'Gemini 4 Argon (High)', value: 'a-h' },
        { label: 'Gemini 4 Hydrogen (High)', value: 'h-h' },
        { label: 'Gemini 3.8 Flash', value: 'f' },
        { label: 'Gemini 4 Neon (High)', value: 'n-h' },
        { label: 'Orchestrator (Neon)', value: 'orch-neon' },
        { label: 'Claude Opus 5.5', value: 'opus' }
      ]
    }
  };
  btn.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  const mainPop = h.doc.getElementById('ag-claude-model-popover');
  const primaryNames = [...mainPop.querySelectorAll('[data-ag-cm-family]')].map((el) =>
    el.getAttribute('data-ag-cm-family')
  );
  assert.deepEqual(primaryNames, [
    'Gemini 4 Carbon',
    'Gemini 4 Neon',
    'Gemini 4 Argon',
    'Gemini 4 Hydrogen',
    'Gemini 3.8 Flash'
  ]);
  const moreRow = mainPop.querySelector('[data-ag-cm-subtrigger="more"]');
  assert.ok(moreRow && moreRow.querySelector('.ag-cm-dot'), 'blue dot marks active model inside 更多模型');
  assert.equal(moreRow.textContent.includes('Orch'), false, 'no abbreviated label shown on 更多模型 row');

  h.cleanups.forEach((fn) => fn());
  h.close();
});

test('answered ask_question card hides speech-bubble ? icon and live TodoWrite stays spinning while drafting in composer', { skip }, async () => {
  const css = fs.readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  assert.match(css, /\.rounded-xl\.border\s*>\s*div\.border-b\s*>\s*svg:has\(>\s*path\[d\^="M477\.92-295\.77"\]\)/);

  /* Active turn with `<h6>Agent working</h6>` but NO `input-cancel-button` (user drafting a queued message mid-turn) */
  const html = `
    <section>
      <div data-testid="agent-response">
        <h6 class="sr-only">Agent working</h6>
        <div data-markdown-root="true">
          ${ul(li('Step one', 'completed'), li('Step two', 'in_progress'), li('Step three', 'pending'))}
        </div>
        <p>Working on step two...</p>
      </div>
      <div id="antigravity.agentSidePanelInputBox">
        <button type="button" data-testid="input-send-button">Send</button>
      </div>
    </section>
  `;
  const h = mount(html);
  h.window.__t.syncStepStream();
  await settle(h);

  const dock = h.doc.querySelector('[data-ag-todo-dock="true"]');
  assert.ok(dock, 'live dock stays mounted even when composer swaps cancel button for send button');
  const card = dock.querySelector('.ag-claude-todo-card');
  assert.ok(card && !card.hasAttribute('data-ag-todo-paused'), 'active turn is never marked Paused while Agent working');

  /* Localized Chinese heading (`Agent 正在执行`) also keeps card live */
  const h6 = h.doc.querySelector('[data-testid="agent-response"] > h6');
  h6.textContent = 'Agent 正在执行';
  h.window.__t.syncStepStream();
  assert.ok(h.doc.querySelector('[data-ag-todo-dock="true"]'), 'localized Agent 正在执行 keeps dock live');

  /* Once the turn finishes/cancels (`Agent said`), undock & show Paused if incomplete */
  h6.textContent = 'Agent said';
  h.window.__t.syncStepStream();
  await new Promise((r) => setTimeout(r, 340));
  h.window.__t.syncStepStream();
  const inlineCard = h.doc.querySelector('.ag-claude-todo-card[data-ag-todo-paused="true"]');
  assert.ok(inlineCard, 'incomplete turn becomes Paused once heading switches to Agent said');

  h.cleanups.forEach((fn) => fn());
  h.close();
});
