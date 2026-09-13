// /proxy timeout-lifecycle regression tests (node, mocked global fetch).
// Run: node tests/proxy.test.mjs
//
// Key invariant (V0.1.1): the upstream timeout must cover request start →
// response headers → response BODY COMPLETE. Headers arriving fast must not
// disarm the timer while the body still hangs; a mid-body stall must surface
// as 504 "Upstream timed out", never as 502/413.

import { onRequestPost } from '../functions/proxy.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const realFetch = globalThis.fetch;

function makeRequest() {
  return new Request('https://pages.test/proxy', {
    method: 'POST',
    headers: { 'X-Target-URL': 'https://api.upstream.test/v1/messages' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
}

// A response whose headers arrive instantly but whose body stream never
// completes on its own — it only errors when the abort signal fires.
function hangingBodyResponse(signal) {
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('{"partial":'));
      signal.addEventListener('abort', () => {
        ctrl.error(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

async function run() {
  // ---------- P1. mid-body stall → 504 (not 502, not 413) ----------
  globalThis.fetch = async (url, opts) => hangingBodyResponse(opts.signal);
  const t0 = Date.now();
  const res1 = await onRequestPost({ request: makeRequest(), env: { PROXY_TIMEOUT_MS: '300' } });
  const elapsed = Date.now() - t0;
  const body1 = await res1.json();
  check('P1 hanging body → 504', res1.status === 504, 'status=' + res1.status);
  check('P1 timeout message', body1.error && /Upstream timed out after 300ms/.test(body1.error.message),
    JSON.stringify(body1));
  check('P1 actually waited for the body phase', elapsed >= 250, elapsed + 'ms');

  // ---------- P2. normal complete body still works (timer cleared in finally) ----------
  globalThis.fetch = async () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const res2 = await onRequestPost({ request: makeRequest(), env: { PROXY_TIMEOUT_MS: '5000' } });
  check('P2 complete body passes through', res2.status === 200 && (await res2.text()) === '{"ok":true}');

  // ---------- P3. slow-but-complete body under the cap succeeds ----------
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      async start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"a":'));
        await new Promise((r) => setTimeout(r, 200));
        ctrl.enqueue(new TextEncoder().encode('1}'));
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res3 = await onRequestPost({ request: makeRequest(), env: { PROXY_TIMEOUT_MS: '2000' } });
  check('P3 slow body within timeout succeeds', res3.status === 200 && (await res3.text()) === '{"a":1}');

  // ---------- P4. oversize body still 413 (not masked as timeout) ----------
  globalThis.fetch = async () =>
    new Response('x'.repeat(64), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '64' } });
  const res4 = await onRequestPost({
    request: makeRequest(),
    env: { PROXY_TIMEOUT_MS: '5000', MAX_PROXY_RESPONSE_BYTES: '10' },
  });
  const body4 = await res4.json();
  check('P4 oversized → 413', res4.status === 413 && /too large/.test(body4.error.message),
    res4.status + ' ' + JSON.stringify(body4));

  // ---------- P5. redirect still 502, never followed ----------
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
  const res5 = await onRequestPost({ request: makeRequest(), env: {} });
  check('P5 redirect → 502', res5.status === 502, 'status=' + res5.status);

  globalThis.fetch = realFetch;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { globalThis.fetch = realFetch; console.error('TEST RUNNER FAIL', e); process.exit(1); });
