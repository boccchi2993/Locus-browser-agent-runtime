// Page-side script for the RESPONSIVE presentation e2e. Injected into the
// real built app (?e2e=1) once per viewport by tests/e2e-responsive.cjs,
// which sets the viewport via CDP Emulation.setDeviceMetricsOverride.
//
// Every viewport gets a FILLED conversation first (long token, long URL,
// long bash input, long JSON output, attachment chip, artifact) — empty
// pages never overflow; real content does. Assertions then depend on the
// tier derived from window.innerWidth:
//   < 700   mobile — sidebar + rail are fixed overlay drawers
//   700–1099 tablet — sidebar in flow, rail is a drawer
//   >= 1100 desktop — all three columns in flow
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 220) : ''));
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
  const W = window.innerWidth;
  const tier = W < 700 ? 'mobile' : (W < 1100 ? 'tablet' : 'desktop');
  const P = '[' + W + 'px ' + tier + '] ';
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const tab = (shiftKey) => document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', shiftKey: !!shiftKey, bubbles: true, cancelable: true,
  }));

  try {
    // ---------- hostile-content fixture (all viewports) ----------
    const longToken = 'x'.repeat(300);
    const longUrl = 'https://example.com/' + 'path-segment/'.repeat(24) + 'file.csv?q=' + 'q'.repeat(120);
    const longJson = '{"result":"' + 'z'.repeat(400) + '"}';
    window.__e2eReplies.push(
      {
        content: '```json\n{"tool":"bash","input":"cat ' + longUrl + '"}\n```',
        reasoning: 'overflow probe reasoning ' + 'r'.repeat(800),
        reasoningType: 'raw',
      },
      { content: 'Done. ' + longUrl + '\n\n`' + longToken + '`' }
    );
    window.__e2eToolExecutor = async () => ({
      output: longJson + '\n' + longUrl + '\n' + longToken,
      success: true, backend: 'browser', operation: 'shell',
    });
    await L.actions.submit('overflow probe ' + longToken);
    await waitFor(() => !L.store.busy, 10000);
    L.actions.addUploadFiles([new File(['a'], 'a-very-long-file-name-' + 'n'.repeat(60) + '.txt')]);
    await L.vfs.write('/mnt/download/reports-2026-' + 'p'.repeat(40) + '.txt', 'x');
    await L.actions.refreshArtifacts();
    await sleep(100);
    // Expand every disclosure so the full long content is actually laid out.
    $$('.item-reasoning .disclosure, .item-tool .tool-head').forEach((b) => b.click());
    await sleep(100);

    const noOverflow = () =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      && document.body.scrollWidth <= window.innerWidth + 1;
    const overflowDetail = () =>
      'docEl=' + document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth
      + ' body=' + document.body.scrollWidth + '/' + window.innerWidth;

    check(P + 'no horizontal page overflow (filled conversation)', noOverflow(), overflowDetail());

    const sidebar = $('.sidebar');
    const rail = $('.context-rail');
    const main = $('.main-workspace');
    const mainRect = main.getBoundingClientRect();
    const clientW = document.documentElement.clientWidth;

    // ---------- tier-independent: composer reachable, console clean ----------
    const c = $('.composer').getBoundingClientRect();
    check(P + 'composer fully inside viewport',
      c.left >= -1 && c.right <= W + 1 && c.bottom <= window.innerHeight + 1 && c.width > 0,
      JSON.stringify({ l: c.left, r: c.right, b: c.bottom, w: c.width }));
    const send = $('.send-btn, .cancel-btn');
    check(P + 'send/cancel reachable', !!send && send.getBoundingClientRect().right <= W + 1);

    // plus menu must land fully inside the viewport
    $('.plus-btn').click();
    await sleep(80);
    const pm = $('.plus-menu');
    const pmr = pm.getBoundingClientRect();
    check(P + 'plus menu inside viewport',
      pmr.left >= -1 && pmr.right <= W + 1 && pmr.top >= -1,
      JSON.stringify({ l: pmr.left, r: pmr.right, t: pmr.top }));
    esc();
    await sleep(60);
    check(P + 'Escape closes plus menu', !L.store.plusMenuOpen);

    // attachment chip: real final name, real VFS path, no layout blowout
    const chip = $('.attach-chip');
    check(P + 'upload chip shows final name + real /mnt/upload path',
      !!chip && chip.getAttribute('title').indexOf('/mnt/upload/a-very-long-file-name-') === 0,
      chip && chip.getAttribute('title'));
    check(P + 'no overflow after upload chip', noOverflow(), overflowDetail());

    if (tier === 'mobile') {
      // ---------- mobile: drawers out of flow, main full width ----------
      check(P + 'sidebar is a fixed overlay', getComputedStyle(sidebar).position === 'fixed');
      check(P + 'context rail is a fixed overlay', getComputedStyle(rail).position === 'fixed');
      check(P + 'main spans the full viewport', Math.abs(mainRect.width - clientW) <= 2,
        'main=' + mainRect.width + ' client=' + clientW);
      check(P + 'nav trigger visible', getComputedStyle($('.nav-toggle')).display !== 'none');
      check(P + 'context trigger visible', getComputedStyle($('.rail-toggle')).display !== 'none');
      check(P + 'context trigger label says Open while drawer is closed',
        $('.rail-toggle').getAttribute('aria-label') === 'Open context',
        $('.rail-toggle').getAttribute('aria-label'));
      check(P + 'closed sidebar drawer not tabbable', getComputedStyle(sidebar).visibility === 'hidden');

      // sidebar drawer: open / focus trap / backdrop / reopen / New task / Escape
      $('.nav-toggle').click();
      await waitFor(() => getComputedStyle(sidebar).visibility === 'visible', 2000);
      check(P + 'sidebar drawer opens from nav trigger', L.store.sidebarDrawerOpen);
      check(P + 'open sidebar drawer causes no overflow', noOverflow(), overflowDetail());
      const sf = Array.from(sidebar.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((el) => {
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
      });
      if (sf.length >= 2) {
        sf[0].focus();
        tab(true);
        await sleep(40);
        check(P + 'sidebar focus trap wraps Shift+Tab first→last', document.activeElement === sf[sf.length - 1]);
        tab(false);
        await sleep(40);
        check(P + 'sidebar focus trap wraps Tab last→first', document.activeElement === sf[0]);
      } else {
        check(P + 'sidebar focus trap has focusable controls', false, 'count=' + sf.length);
      }
      $('.drawer-backdrop').click();
      await sleep(250);
      check(P + 'sidebar drawer closes on backdrop', !L.store.sidebarDrawerOpen);

      $('.nav-toggle').click();
      await sleep(250);
      const recentsBefore = L.store.conversations.length;
      $('.sidebar .new-task-btn').click();
      await sleep(250);
      check(P + 'New task inside drawer works and closes it',
        !L.store.sidebarDrawerOpen && L.store.conversations.length === recentsBefore + 1);

      $('.nav-toggle').click();
      await sleep(250);
      esc();
      await sleep(250);
      check(P + 'sidebar drawer closes on Escape', !L.store.sidebarDrawerOpen);

      // context drawer: open / artifacts reachable / Escape
      $('.rail-toggle').click();
      await waitFor(() => getComputedStyle(rail).visibility === 'visible', 2000);
      await sleep(350); // let the slide-in transform finish before measuring
      check(P + 'context drawer opens from rail trigger', L.store.contextDrawerOpen);
      check(P + 'context trigger label says Close while drawer is open',
        $('.rail-toggle').getAttribute('aria-label') === 'Close context',
        $('.rail-toggle').getAttribute('aria-label'));
      const art = $('.context-rail .rail-section').find((el) => /Artifacts/.test(el.textContent));
      check(P + 'artifacts visible in context drawer',
        !!art && art.textContent.indexOf('reports-2026-') !== -1,
        art && art.textContent.slice(0, 120));
      const dl = art && art.querySelector('.artifact-download');
      const dlr = dl ? dl.getBoundingClientRect() : { right: 1e9, left: -1, width: 0 };
      check(P + 'artifact Download button reachable',
        !!dl && dlr.width > 0 && dlr.left >= -1 && dlr.right <= W + 1,
        JSON.stringify(dlr));
      check(P + 'open context drawer causes no overflow', noOverflow(), overflowDetail());
      esc();
      await sleep(250);
      check(P + 'context drawer closes on Escape', !L.store.contextDrawerOpen);
      check(P + 'context trigger label returns to Open after close',
        $('.rail-toggle').getAttribute('aria-label') === 'Open context',
        $('.rail-toggle').getAttribute('aria-label'));

      // Escape priority: drawer first, running task second
      window.__e2eReplies.push((body, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      const p1 = L.actions.submit('escape priority probe');
      await waitFor(() => L.store.busy, 3000);
      $('.nav-toggle').click();
      await sleep(250);
      esc();
      await sleep(120);
      check(P + 'Escape closes drawer before cancelling task',
        !L.store.sidebarDrawerOpen && L.store.busy);
      esc();
      await p1;
      await sleep(80);
      const conv1 = L.store.conversations.find((cv) => cv.id === L.store.liveConversationId);
      check(P + 'Escape still cancels task once drawers are closed',
        conv1.status === 'cancelled', conv1.status);

      // mobile drawer selection only changes the VIEWED conversation
      const convCount = L.store.conversations.length;
      $('.nav-toggle').click();
      await sleep(250);
      const items = $$('.recent-item');
      if (items.length > 1) {
        items[items.length - 1].click();
        await sleep(200);
        check(P + 'drawer conversation switch closes drawer, keeps live routing',
          !L.store.sidebarDrawerOpen
          && L.store.activeConversationId !== L.store.liveConversationId
          && L.store.conversations.length === convCount);
      }
      check(P + 'no overflow after mobile flows', noOverflow(), overflowDetail());
    } else if (tier === 'tablet') {
      // ---------- tablet: sidebar in flow, rail is a drawer ----------
      check(P + 'sidebar stays in the flex row', getComputedStyle(sidebar).position !== 'fixed');
      check(P + 'context rail is a fixed overlay', getComputedStyle(rail).position === 'fixed');
      check(P + 'sidebar visible', sidebar.getBoundingClientRect().width > 100);
      check(P + 'main keeps real width', mainRect.width >= 400, 'main=' + mainRect.width);
      check(P + 'nav trigger hidden (no mobile top bar)', getComputedStyle($('.nav-toggle')).display === 'none');
      check(P + 'tablet context trigger label says Open while closed',
        $('.rail-toggle').getAttribute('aria-label') === 'Open context',
        $('.rail-toggle').getAttribute('aria-label'));
      $('.rail-toggle').click();
      await waitFor(() => getComputedStyle(rail).visibility === 'visible', 2000);
      check(P + 'context drawer opens on tablet', L.store.contextDrawerOpen);
      check(P + 'tablet context trigger label says Close while open',
        $('.rail-toggle').getAttribute('aria-label') === 'Close context',
        $('.rail-toggle').getAttribute('aria-label'));
      check(P + 'open drawer causes no overflow', noOverflow(), overflowDetail());
      esc();
      await sleep(250);
      check(P + 'context drawer closes on Escape', !L.store.contextDrawerOpen);
      check(P + 'tablet context trigger label returns to Open',
        $('.rail-toggle').getAttribute('aria-label') === 'Open context',
        $('.rail-toggle').getAttribute('aria-label'));
    } else {
      // ---------- desktop: unchanged three columns ----------
      check(P + 'sidebar static and visible',
        getComputedStyle(sidebar).position !== 'fixed' && sidebar.getBoundingClientRect().width > 200);
      check(P + 'context rail static and visible',
        getComputedStyle(rail).position !== 'fixed' && rail.getBoundingClientRect().width > 200);
      check(P + 'nav trigger hidden', getComputedStyle($('.nav-toggle')).display === 'none');
      check(P + 'desktop context trigger label says Hide while rail is visible',
        $('.rail-toggle').getAttribute('aria-label') === 'Hide context panel',
        $('.rail-toggle').getAttribute('aria-label'));
      $('.rail-toggle').click();
      await sleep(80);
      check(P + 'desktop context trigger label says Show while rail is collapsed',
        $('.rail-toggle').getAttribute('aria-label') === 'Show context panel',
        $('.rail-toggle').getAttribute('aria-label'));
      $('.rail-toggle').click();
      await sleep(80);
      check(P + 'desktop context trigger label returns to Hide after restore',
        $('.rail-toggle').getAttribute('aria-label') === 'Hide context panel',
        $('.rail-toggle').getAttribute('aria-label'));
      const sr = sidebar.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      check(P + 'three columns in order (sidebar | main | rail)',
        sr.left === 0 && mainRect.left >= sr.right - 1 && rr.left >= mainRect.right - 1,
        JSON.stringify({ s: sr.right, m: mainRect.left, mR: mainRect.right, r: rr.left }));
    }

    check(P + 'no console errors / unhandled rejections',
      (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
  } catch (e) {
    out.push('FAIL ' + P + 'threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'RESP-FAIL' : 'RESP-DONE');
  return out.join('\n');
})()
