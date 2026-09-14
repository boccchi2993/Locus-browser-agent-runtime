// Page-side script for the Vue presentation e2e. Injected into the real
// built app (served by vite preview, ?e2e=1) via CDP Runtime.evaluate.
// Drives the REAL UI: DOM clicks, keydown events, the composer — with the
// model/tool layer faked at the documented AgentSession injection seam
// (window.__LOCUS_HOOKS__, installed by src/main.js in e2e mode).
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + detail : ''));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, timeoutMs) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      if (cond()) return true;
      await sleep(60);
    }
    return false;
  };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const L = window.__locus;

  try {
    // ---------- structure ----------
    check('U01 app mounted', !!$('.app-shell'));
    check('U02 history sidebar present', !!$('.sidebar'));
    check('U03 New task entry', $$('.sidebar .new-task-btn').length === 1);
    check('U04 recents list present', !!$('.sidebar .recents'));
    check('U05 context rail sections', $$('.context-rail .rail-section').length >= 4,
      $$('.context-rail .rail-section').length + ' sections');
    check('U06 composer present', !!$('.composer .composer-input'));
    check('U07 empty state visible before first task', !!$('.empty-state'));

    // ---------- plus menu ----------
    $('.plus-btn').click();
    await sleep(60);
    const plusTexts = $$('.plus-menu .plus-item').map((b) => b.textContent);
    check('U08 plus menu: Upload files', plusTexts.some((t) => /Upload files/.test(t)), plusTexts.join('/'));
    check('U09 plus menu: Mount folder', plusTexts.some((t) => /Mount folder/.test(t)));
    check('U10 plus menu: Open terminal', plusTexts.some((t) => /Open terminal/.test(t)));
    // Open terminal → reserved drawer, honestly marked
    $$('.plus-menu .plus-item').find((b) => /Open terminal/.test(b.textContent)).click();
    await sleep(60);
    check('U11 terminal drawer opens as reserved seam',
      !!$('.terminal-drawer') && /not wired/.test($('.terminal-drawer').textContent));
    $('.terminal-drawer .icon-btn').click();
    await sleep(60);

    // ---------- task flow: reasoning → tool call → tool result → assistant ----------
    window.__e2eReplies.push(
      {
        content: '```json\n{"tool":"bash","input":"ls"}\n```',
        reasoning: 'e2e reasoning: ' + 'x'.repeat(600), // long enough to start collapsed
        reasoningType: 'raw',
      },
      { content: 'e2e final answer: two files found.' }
    );
    window.__e2eToolExecutor = async (tool, input) => ({
      output: 'file-a.csv\nfile-b.csv',
      success: true,
      backend: 'browser-direct',
      operation: 'shell',
    });

    // real composer path: set textarea value, dispatch input, press Enter
    const ta = $('.composer-input');
    ta.value = 'list my files';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('U12 composer submit starts task', await waitFor(() => L.store.busy || $('.item-user'), 3000));
    await waitFor(() => !L.store.busy, 8000);

    check('U13 user message rendered', ($('.item-user') || {}).textContent === undefined ? false
      : $('.item-user').textContent.includes('list my files'));
    check('U14 reasoning stored complete in projection (never truncated)',
      (() => {
        const conv = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
        const r = conv.items.find((i) => i.kind === 'reasoning');
        return !!r && r.content.includes('x'.repeat(600));
      })());
    check('U15 long reasoning starts collapsed',
      !!$('.item-reasoning .disclosure') && !$('.item-reasoning .reasoning-body'));
    // expand reasoning — full content must be reachable
    $('.item-reasoning .disclosure').click();
    await sleep(60);
    check('U16 reasoning expands to full content',
      ($('.item-reasoning .reasoning-body') || { textContent: '' }).textContent.includes('x'.repeat(600)));
    check('U17 tool call rendered', $$('.item-tool').length === 1
      && $('.item-tool').textContent.includes('bash'));
    check('U18 tool result rendered', $$('.item-tool .result-output, .item-tool .result-preview').length === 1);
    const badge = $('.item-tool .backend-badge');
    check('U19 backend badge from event metadata', !!badge && badge.textContent.trim() === 'browser-direct',
      badge && badge.textContent);
    check('U20 assistant final rendered', ($('.assistant-text') || { textContent: '' }).textContent
      .includes('e2e final answer: two files found.'));
    check('U21 conversation status completed', L.store.conversations.find((c) => c.id === L.store.liveConversationId).status === 'completed');

    // ---------- cancel via REAL UI button ----------
    window.__e2eReplies.push((body, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p1 = L.actions.submit('hang for cancel-button');
    await waitFor(() => L.store.busy, 3000);
    const cancelBtn = $('.cancel-btn');
    check('U22 cancel button while busy', !!cancelBtn && /Cancel/.test(cancelBtn.textContent));
    cancelBtn.click();
    await p1;
    await sleep(80);
    check('U23 button cancel ends task cancelled',
      L.store.conversations.find((c) => c.id === L.store.liveConversationId).status === 'cancelled');
    check('U24 cancel warning visible',
      $$('.item-warning').some((el) => /取消|cancel/i.test(el.textContent)));

    // ---------- cancel via REAL Escape keydown ----------
    window.__e2eReplies.push((body, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p2 = L.actions.submit('hang for escape');
    await waitFor(() => L.store.busy, 3000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p2;
    await sleep(80);
    check('U25 Escape cancels running task',
      L.store.conversations.find((c) => c.id === L.store.liveConversationId).status === 'cancelled');

    // ---------- workspace mount (OPFS handle via test hook) + session boundary ----------
    const convCountBefore = L.store.conversations.length;
    const genBefore = L.session.generation;
    await L.actions.mountFolder();
    await sleep(80);
    check('U26 mount folder sets workspace name', L.store.workspaceName === 'e2e-workspace', L.store.workspaceName);
    check('U27 workspace chip in composer', ($('.ws-chip') || { textContent: '' }).textContent.includes('e2e-workspace'));
    check('U28 mount = session boundary (generation bumped, history cleared)',
      L.session.generation === genBefore + 1 && L.session.history.length === 0);
    check('U29 mount starts new conversation (timeline separation)',
      L.store.conversations.length === convCountBefore + 1
      && L.store.conversations[0].items.length === 0
      && L.store.conversations[1].items.length > 0);
    check('U30 sidebar recents list conversations that ran', $$('.recent-item').length === 1,
      $$('.recent-item').length + ' items');

    // ---------- real tool execution → telemetry surfaced in rail ----------
    window.__e2eToolExecutor = null; // fall back to the REAL executeTool
    window.__e2eReplies.push(
      { content: '```json\n{"tool":"bash","input":"ls"}\n```' },
      { content: 'real tool run done' }
    );
    const teleBefore = Telemetry.records.length;
    await L.actions.submit('real ls on mounted folder');
    check('U31 real tool execution recorded in telemetry', Telemetry.records.length > teleBefore,
      'records=' + Telemetry.records.length);
    $('.rail-head') && null;
    // expand telemetry section
    const teleHead = $$('.rail-head').find((b) => /Telemetry/.test(b.textContent));
    teleHead.click();
    await sleep(60);
    check('U32 telemetry rail shows record', ($$('.tele-item').length > 0), $$('.tele-item').length + ' items');
    const teleBadge = $('.tele-item .backend-badge');
    check('U33 telemetry backend badge', !!teleBadge && teleBadge.textContent.trim() === 'browser',
      teleBadge && teleBadge.textContent);

    // ---------- settings / dialect wiring ----------
    L.store.settings.dialect = 'anthropic';
    L.actions.applySettings();
    check('U34 dialect setting reaches Model', Model.dialect === 'anthropic');
    L.store.settings.dialect = 'auto';
    L.actions.applySettings();
    L.store.settingsOpen = true;
    await sleep(60);
    check('U35 settings panel fields', !!$('#set-api-key') && !!$('#set-dialect') && !!$('#set-proxy'));
    check('U47 fresh settings model is deepseek-flash', $('#set-model').value === 'deepseek-flash',
      $('#set-model').value);
    $('.modal-head .icon-btn').click();
    await sleep(60);

    // ---------- new task: presentation vs provider history separation ----------
    const liveBefore = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
    const itemsBefore = liveBefore.items.length;
    $('.new-task-btn').click();
    await sleep(80);
    check('U36 new task resets provider history', L.session.history.length === 0);
    check('U37 new task keeps old timeline intact', liveBefore.items.length === itemsBefore);
    check('U38 new task opens fresh empty conversation',
      L.store.conversations[0].items.length === 0 && !!$('.empty-state'));

    // ---------- cross-conversation event isolation (P3.1 race) ----------
    // Old task's tail events must follow the OLD conversation even after
    // New task made a new conversation live/active.
    window.__e2eReplies.push((body, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const convA = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
    const pA2 = L.actions.submit('isolation task A');
    await waitFor(() => L.store.busy, 3000);
    // real UI event: New task button click
    $('.new-task-btn').click();
    await sleep(80);
    const convB = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
    check('U40 new task creates B while A settles', convB && convB.id !== convA.id
      && L.store.activeConversationId === convB.id);
    await pA2;
    await sleep(80);
    check('U41 A tail events (session_changed) stay in A',
      convA.status === 'session_changed'
      && convA.items.some((i) => i.kind === 'warning' && i.code === 'session_changed'));
    check('U42 B untouched by A tail events',
      convB.items.length === 0 && convB.status === 'idle');
    check('U43 busy released only after A settled', L.store.busy === false);

    // B runs its own task; A must receive none of it — and viewing A
    // mid-task must not reroute B's events.
    window.__e2eReplies.push(
      { content: '```json\n{"tool":"bash","input":"ls"}\n```', reasoning: 'B reasoning', reasoningType: 'raw' },
      (body, opts) => new Promise((resolve) => { window.__e2eGate = () => resolve({ content: 'B final answer', reasoning: null, reasoningType: 'raw', rawMessage: { role: 'assistant', content: 'B final answer' }, stopReason: 'end_turn', usage: null, providerMetadata: null, truncated: false }); }),
    );
    window.__e2eToolExecutor = async () => ({ output: 'b-file', success: true, backend: 'browser', operation: 'shell' });
    const aItemCount = convA.items.length;
    const pB2 = L.actions.submit('isolation task B');
    await waitFor(() => convB.items.some((i) => i.kind === 'tool'), 5000);
    // user browses history (real recents click) while B's task is mid-flight
    $$('.recent-item').find((el) => el.textContent.includes('isolation task A')).click();
    await sleep(60);
    check('U44 viewing A while B runs', L.store.activeConversationId === convA.id
      && L.store.liveConversationId === convB.id);
    window.__e2eGate();
    await pB2;
    await sleep(80);
    check('U45 B events all landed in B despite view switch',
      convB.status === 'completed'
      && convB.items.some((i) => i.kind === 'assistant' && i.content === 'B final answer')
      && convB.items.some((i) => i.kind === 'reasoning' && i.content === 'B reasoning'));
    check('U46 A received none of B events', convA.items.length === aItemCount
      && !convA.items.some((i) => i.content === 'B final answer'));

    // ---------- hygiene ----------
    check('U39 no console errors / unhandled rejections',
      (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
  } catch (e) {
    out.push('FAIL e2e-ui threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-UI-FAIL' : 'E2E-UI-DONE');
  return out.join('\n');
})()
