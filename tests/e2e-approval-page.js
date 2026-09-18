// Page-side script for the approval e2e. Injected into the real built app
// (?e2e=1) via CDP Runtime.evaluate. Drives the REAL ApprovalCard /
// ApprovalController through DOM clicks, keyboard events and the composer,
// with approvals triggered by the documented test-only seam
// window.__locus.approvals.requestTestPermission (no production consumer).
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : ''));
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
  const L = window.__locus;
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  const cardText = () => ($('.approval-card') || {}).textContent || '';
  const cardButtons = () => Array.from(document.querySelectorAll('.approval-card .approval-btn')).map((b) => b.textContent.trim());

  try {
    // ---------- round 1: synthetic request → card → Allow once ----------
    const p1 = L.approvals.requestTestPermission({
      policyKey: 'e2e:perm:round1',
      summary: 'Delete stale drafts in /mnt/workspace',
    });
    check('A01 ApprovalCard appears for a pending request', await waitFor(() => !!$('.approval-card')));
    check('A02 card shows fixed title and lead', /Approval required/.test(cardText()) && /Locus wants permission to:/.test(cardText()));
    check('A03 action summary displayed', cardText().includes('Delete stale drafts in /mnt/workspace'));
    check('A04 fixed permission button set',
      JSON.stringify(cardButtons()) === JSON.stringify(['Deny', 'Allow once', 'Allow for this session']),
      JSON.stringify(cardButtons()));
    check('A05 summary rendered as TEXT (no injected HTML)', !$('.approval-card .approval-summary')?.firstElementChild);
    check('A06 focus starts on the card container (never on an Allow button)',
      document.activeElement && document.activeElement.classList.contains('approval-card'),
      document.activeElement && document.activeElement.className);
    check('A07 store mirrors pendingApproval', !!L.store.pendingApproval && L.store.pendingApproval.policyKey === 'e2e:perm:round1');
    check('A08 request bound to the live conversation', L.store.pendingApproval.conversationId === L.store.liveConversationId);

    // Enter on the focused card must NOT approve anything.
    enter(document.activeElement);
    await sleep(80);
    check('A09 Enter on focused card does not approve', !!$('.approval-card') && !!L.store.pendingApproval);

    $('.approval-card .approval-btn.primary').click(); // Allow once
    const d1 = await p1;
    check('A10 Allow once resolves allow/once to the SAME promise',
      d1.outcome === 'allow' && d1.scope === 'once' && !!d1.requestId, JSON.stringify(d1));
    check('A11 card disappears after decision', await waitFor(() => !$('.approval-card') && !L.store.pendingApproval));

    // ---------- round 2: same policy asks again; Deny ----------
    const p2 = L.approvals.requestTestPermission({ policyKey: 'e2e:perm:round1', summary: 'Delete stale drafts again' });
    check('A12 allow-once did not mint a grant — card appears again', await waitFor(() => !!$('.approval-card')));
    $('.approval-card .approval-btn.deny').click(); // Deny
    const d2 = await p2;
    check('A13 Deny resolves deny/once', d2.outcome === 'deny' && d2.scope === 'once');
    check('A14 card closes after Deny', await waitFor(() => !$('.approval-card')));

    // ---------- round 3: Allow for this session auto-allows ----------
    const p3 = L.approvals.requestTestPermission({ policyKey: 'e2e:perm:session', summary: 'Read the calendar cache' });
    await waitFor(() => !!$('.approval-card'));
    $('.approval-card .approval-btn.secondary').click(); // Allow for this session
    const d3 = await p3;
    check('A15 Allow for session resolves allow/session', d3.outcome === 'allow' && d3.scope === 'session');
    const granted = await L.approvals.requestTestPermission({ policyKey: 'e2e:perm:session', summary: 'Read the calendar cache again' });
    check('A16 same policy auto-allows WITHOUT a card',
      granted.outcome === 'allow' && granted.scope === 'session' && granted.viaGrant === true
      && !$('.approval-card') && !L.store.pendingApproval, JSON.stringify(granted));
    const p4 = L.approvals.requestTestPermission({ policyKey: 'e2e:perm:other', summary: 'Send usage statistics' });
    check('A17 different policy still asks', await waitFor(() => !!$('.approval-card')));
    esc(); // Escape = Deny (priority over every other Escape behavior)
    const d4 = await p4;
    check('A18 Escape denies the approval', d4.outcome === 'deny' && d4.scope === 'once');
    check('A19 no card after Escape', await waitFor(() => !$('.approval-card')));

    // ---------- stale decision protection ----------
    const staleP = L.approvals.requestTestPermission({ policyKey: 'e2e:perm:stale', summary: 'Old request' });
    await waitFor(() => !!$('.approval-card'));
    const staleId = L.store.pendingApproval.id;
    esc(); // resolve the stale request via deny
    await staleP;
    const newerP = L.approvals.requestTestPermission({ policyKey: 'e2e:perm:newer', summary: 'New request' });
    await waitFor(() => !!$('.approval-card'));
    const newerId = L.store.pendingApproval.id;
    const staleAttempt = L.actions.resolveApproval(staleId, { outcome: 'allow', scope: 'session' });
    check('A20 stale requestId resolve is rejected', staleAttempt === false);
    check('A21 newer request untouched by stale decision',
      !!L.store.pendingApproval && L.store.pendingApproval.id === newerId);
    esc();
    await newerP;
    check('A22 stale id differs from newer id', staleId !== newerId);

    // ---------- running task: composer behavior + cancel semantics ----------
    window.__e2eReplies.push(
      { content: '```json\n{"tool":"bash","input":"rm -rf /tmp/scratch"}\n```' },
      { content: 'should never be reached when cancelled' }
    );
    window.__e2eApprovalDecisions = [];
    window.__e2eToolExecutor = async (tool, input, ws, opts) => {
      const decision = await L.approvals.request({
        kind: 'permission',
        action: { type: 'tool', summary: 'Run ' + tool + ': ' + input },
        policyKey: 'e2e:tool:' + tool,
        conversationId: L.store.liveConversationId,
        taskGeneration: L.session.generation,
      }, { signal: opts && opts.signal });
      window.__e2eApprovalDecisions.push(decision);
      if (decision.outcome === 'allow') return { output: 'ran', success: true, backend: 'harness' };
      return { output: 'not executed: ' + decision.outcome, success: false, backend: 'harness' };
    };
    const lastDecision = () => window.__e2eApprovalDecisions[window.__e2eApprovalDecisions.length - 1] || {};
    const ta = $('.composer-input');
    ta.value = 'clean the scratch directory';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('A23 task submits and hits the approval gate',
      await waitFor(() => L.store.busy && !!$('.approval-card') && /rm -rf \/tmp\/scratch/.test(cardText())));
    check('A24 placeholder says Waiting for approval…',
      $('.composer-input').placeholder === 'Waiting for approval…', $('.composer-input').placeholder);

    // Submitting over a pending approval must be impossible.
    const convBefore = L.store.conversations.map((c) => c.id).join(',');
    ta.value = 'sneaky second task';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(150);
    check('A25 composer cannot submit a new task while approval pending',
      L.store.conversations.map((c) => c.id).join(',') === convBefore && !!L.store.pendingApproval,
      'conversations unchanged=' + (L.store.conversations.map((c) => c.id).join(',') === convBefore)
      + ' pending=' + !!L.store.pendingApproval);
    ta.value = '';

    // Escape during the running task's approval denies the ACTION, not the task.
    check('A26a gate pending with the task still alive',
      L.store.busy === true && !!L.store.pendingApproval, 'busy=' + L.store.busy);
    esc();
    check('A26 Escape denies the approval (card closes)',
      await waitFor(() => lastDecision().outcome === 'deny' && !L.store.pendingApproval && !$('.approval-card'), 4000),
      'decision=' + JSON.stringify(lastDecision()));
    await waitFor(() => !L.store.busy, 8000);
    const liveConv = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
    check('A27 task completed after denial (deny ≠ cancel)',
      !L.store.busy && L.session.task === null
      && liveConv.items.some((i) => i.kind === 'assistant' && /should never be reached when cancelled/.test(i.content || '')),
      'busy=' + L.store.busy);

    // Now cancel the TASK while its approval is pending.
    window.__e2eReplies.push(
      { content: '```json\n{"tool":"bash","input":"rm -rf /tmp/scratch2"}\n```' },
      { content: 'unreachable' }
    );
    const ta2 = $('.composer-input');
    ta2.value = 'clean it again';
    ta2.dispatchEvent(new Event('input', { bubbles: true }));
    ta2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('A28 second task reaches the approval gate', await waitFor(() => !!$('.approval-card')));
    const cancelBtn = $('.composer .cancel-btn');
    check('A29 Cancel task remains available during approval', !!cancelBtn && !cancelBtn.disabled);
    cancelBtn.click();
    check('A30 cancel task closes the approval immediately',
      await waitFor(() => lastDecision().outcome === 'cancelled' && !$('.approval-card') && !L.store.pendingApproval, 4000));
    await waitFor(() => !L.store.busy, 8000);
    check('A31 task ended cancelled; no dangling runtime state',
      !L.store.busy && !L.session.task, 'busy=' + L.store.busy);
    check('A32 composer placeholder restored after everything settles',
      $('.composer-input').placeholder !== 'Waiting for approval…');

    // ---------- hard requirement: no poisoned history / no fake turns ----------
    const finalConv = L.store.conversations.find((c) => c.id === L.store.liveConversationId);
    check('A33 approval never entered the presentation timeline',
      !finalConv.items.some((i) => /Approval required|Allow once|Allow for this session/.test(i.content || '')));
    check('A34 provider history has no approval-derived turns',
      L.session.history.every((m) => !String(m.content || '').includes('Approval required')));

    // ---------- console / rejection hygiene ----------
    check('A35 no console errors / unhandled rejections',
      (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
  } catch (e) {
    out.push('FAIL approval e2e threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'APPR-FAIL' : 'APPR-DONE');
  return out.join('\n');
})()
