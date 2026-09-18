// Page-side script for the APPROVAL VIEWPORT MATRIX e2e (closure patch
// F-A29/F-A30). Injected by tests/e2e-approval.cjs once per viewport via
// CDP Emulation.setDeviceMetricsOverride — each run gets a fresh page at
// that viewport. Drives the REAL ApprovalCard with 2KB summary + 2KB
// detail + a 1500-char no-whitespace token and asserts the containment
// invariants: card inside the viewport, action buttons pointer-accessible
// without scrolling, body scrolls internally, Cancel task (composer)
// pointer-accessible during a running task's approval, no horizontal
// overflow, Escape still denies.
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
  const P = '[' + window.innerWidth + 'x' + window.innerHeight + '] ';
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  // Pointer accessibility = a real hit test at the element's center, not
  // just "element exists" (docs closure spec: elementFromPoint required).
  const pointerHit = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const noOverflow = () =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    && document.body.scrollWidth <= window.innerWidth + 1;
  const overflowDetail = () =>
    'docEl=' + document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth
    + ' body=' + document.body.scrollWidth + '/' + window.innerWidth;

  // Hostile content: 2KB summary (with a 1500-char no-whitespace token),
  // 2KB detail.
  const longToken = 't'.repeat(1500);
  const summary2kb = 'Run destructive command with an extremely long no-whitespace token: '
    + longToken + ' trailing-' + 'y'.repeat(500);
  const detail2kb = Array.from({ length: 17 }, (_, i) => 'detail-line-' + i + ' ' + 'd'.repeat(110)).join('\n');

  try {
    // ---------- V1: long-content card containment + pointer access ----------
    const p1 = L.approvals.requestTestPermission({
      policyKey: 'e2e:vp:contain',
      summary: summary2kb,
      detail: detail2kb,
    });
    check(P + 'card appears with 2KB summary + 2KB detail + 1500-char token', await waitFor(() => !!$('.approval-card')));
    const card = $('.approval-card');
    const rect = card.getBoundingClientRect();
    check(P + 'card fully inside the viewport (no clipping)',
      rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
      'top=' + rect.top.toFixed(1) + ' bottom=' + rect.bottom.toFixed(1) + ' vh=' + window.innerHeight);
    check(P + 'card height capped at min(60dvh, 520px)',
      rect.height <= Math.min(window.innerHeight * 0.6, 520) + 2,
      'height=' + rect.height.toFixed(1));
    const btns = Array.from(document.querySelectorAll('.approval-card .approval-btn'));
    check(P + 'three permission buttons rendered', btns.length === 3, btns.map((b) => b.textContent.trim()).join(','));
    check(P + 'actions pointer-accessible WITHOUT scrolling (pinned, body scrolls)',
      btns.length === 3 && btns.every(pointerHit),
      btns.map((b) => b.textContent.trim() + '=' + pointerHit(b)).join(' '));
    const body = $('.approval-card .approval-body');
    check(P + 'approval body is the scrollable region (content overflows it)',
      !!body && body.scrollHeight > body.clientHeight,
      body ? body.scrollHeight + '>' + body.clientHeight : 'no body');
    body.scrollTop = 99999;
    await sleep(40);
    check(P + 'body actually scrolls internally', body.scrollTop > 0, 'scrollTop=' + body.scrollTop);
    body.scrollTop = 0;
    check(P + 'no horizontal page overflow (1500-char token)', noOverflow(), overflowDetail());
    const allowBtn = btns.find((b) => /Allow once/.test(b.textContent));
    allowBtn.click(); // pointer click (hit-tested above) on the real card
    const d1 = await p1;
    check(P + 'pointer click Allow once resolves the SAME request',
      d1.outcome === 'allow' && d1.scope === 'once' && !!d1.requestId, JSON.stringify(d1));
    check(P + 'card closes after the pointer decision', await waitFor(() => !$('.approval-card')));

    // ---------- V2: Escape still Deny with long content ----------
    const p2 = L.approvals.requestTestPermission({ policyKey: 'e2e:vp:escape', summary: summary2kb, detail: detail2kb });
    await waitFor(() => !!$('.approval-card'));
    esc();
    const d2 = await p2;
    check(P + 'Escape still denies the approval', d2.outcome === 'deny' && d2.scope === 'once');
    check(P + 'card closed after Escape', await waitFor(() => !$('.approval-card')));

    // ---------- V3: Cancel task pointer-accessible during a running task ----------
    // The approval comes from the running task's tool consumer (the exact
    // future production shape) with the same hostile content; Cancel task
    // must stay pointer-reachable and cancel the approval without any side
    // effect.
    // The restored (persisted) conversation may be degraded/blocked after a
    // reload — submit refuses it by design. Start a fresh task so the V3
    // flow always runs on a clean conversation.
    L.actions.newTask();
    await sleep(100);
    window.__e2eApprovalDecisions = [];
    window.__e2eToolRuns = 0;
    window.__e2eToolExecutor = async (tool, input, ws, opts) => {
      const signal = opts && opts.signal;
      const decision = await L.approvals.request({
        kind: 'permission',
        action: { type: 'tool', summary: 'Run ' + tool + ': ' + input },
        policyKey: 'e2e:vp:task',
        conversationId: L.store.liveConversationId,
        taskGeneration: L.session.generation,
      }, { signal });
      window.__e2eApprovalDecisions.push(decision);
      if (decision.outcome !== 'allow') {
        return { output: 'not executed: ' + decision.outcome, success: false, backend: 'harness' };
      }
      if (signal && signal.aborted) {
        return { output: 'not executed: cancelled after allow (task no longer live)', success: false, backend: 'harness' };
      }
      window.__e2eToolRuns++;
      return { output: 'ran', success: true, backend: 'harness' };
    };
    window.__e2eReplies.push({ content: '```json\n{"tool":"bash","input":"rm -rf /tmp/vp-scratch ' + longToken.slice(0, 300) + '"}\n```' });
    const ta = $('.composer-input');
    ta.value = 'viewport cancel probe';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check(P + 'running task reaches the approval gate with long content',
      await waitFor(() => L.store.busy && !!$('.approval-card') && /vp-scratch/.test(($('.approval-card') || {}).textContent || '')));
    const cancelBtn = $('.composer .cancel-btn');
    check(P + 'Cancel task is pointer-accessible below the long card',
      !!cancelBtn && !cancelBtn.disabled && pointerHit(cancelBtn),
      cancelBtn ? 'present, hit=' + pointerHit(cancelBtn) : 'missing');
    cancelBtn.click();
    check(P + 'Cancel task closes the approval as cancelled',
      await waitFor(() => (window.__e2eApprovalDecisions[window.__e2eApprovalDecisions.length - 1] || {}).outcome === 'cancelled'
        && !$('.approval-card'), 4000));
    await waitFor(() => !L.store.busy, 8000);
    check(P + 'no side effect ran after Cancel task (no rollback pretense)',
      window.__e2eToolRuns === 0 && !L.session.task, 'runs=' + window.__e2eToolRuns);
    check(P + 'composer restored after Cancel task',
      $('.composer-input').placeholder !== 'Waiting for approval…');

    // ---------- hygiene ----------
    check(P + 'no console errors / unhandled rejections at this viewport',
      (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
  } catch (e) {
    out.push('FAIL approval viewport script threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'VP-FAIL' : 'VP-DONE');
  return out.join('\n');
})()
