// /fetch edge-relay regression tests (node, mocked global fetch).
// Run: node tests/fetch.test.mjs

import { onRequestGet } from '../functions/fetch.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const realFetch = globalThis.fetch;
let calls = [];
let routes = [];
function on(match, respond) { routes.push({ match, respond }); }
function installMock() {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    for (const r of routes) if (r.match(String(url))) return r.respond(String(url), opts || {});
    throw new Error('no mock route for ' + url);
  };
}
function reset() { calls = []; routes = []; installMock(); }

function req(query) {
  return new Request('https://pages.test/fetch' + (query || ''), { method: 'GET' });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80]);

async function run() {
  // ---------- F1. missing url → 400 ----------
  reset();
  const r1 = await onRequestGet({ request: req(''), env: {} });
  check('F1 missing url → 400', r1.status === 400 && r1.headers.get('x-locus-relay-error') === '1');

  // ---------- F2. http:// target is now supported (v1) ----------
  reset();
  on((u) => u === 'http://example.com/x', () => new Response('plain', { status: 200 }));
  const r2 = await onRequestGet({ request: req('?url=' + encodeURIComponent('http://example.com/x')), env: {} });
  check('F2 http target fetched', r2.status === 200 && calls.length === 1, 'status=' + r2.status + ' calls=' + calls.length);

  // ---------- F2b. private targets refused before any upstream call ----------
  reset();
  on(() => { throw new Error('no upstream fetch allowed'); });
  for (const host of ['127.0.0.1', 'localhost', '[::1]', '169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1']) {
    const rr = await onRequestGet({ request: req('?url=' + encodeURIComponent('http://' + host + '/x')), env: {} });
    const j = await rr.json();
    check('F2b private target refused: ' + host,
      rr.status === 403 && j.error.code === 'network_private_address_blocked' && calls.length === 0,
      'status=' + rr.status);
  }

  // ---------- F3. no credentials forwarded upstream ----------
  reset();
  on((u) => u === 'https://example.test/data', () => new Response('ok', { status: 200 }));
  const reqWithCreds = new Request('https://pages.test/fetch?url=' + encodeURIComponent('https://example.test/data'), {
    method: 'GET',
    headers: { cookie: 'session=secret', authorization: 'Bearer abc', 'x-api-key': 'k' },
  });
  await onRequestGet({ request: reqWithCreds, env: {} });
  const sent = calls[0].opts.headers || {};
  const sentKeys = Object.keys(sent instanceof Headers ? Object.fromEntries(sent) : sent);
  check('F3 no credentials forwarded', calls.length === 1
    && !sentKeys.some((k) => ['cookie', 'authorization', 'x-api-key'].includes(k.toLowerCase())),
    JSON.stringify(sentKeys));

  // ---------- F4. redirect followed, final URL exposed ----------
  reset();
  on((u) => u === 'https://example.test/old', () => new Response(null, { status: 302, headers: { location: '/new' } }));
  on((u) => u === 'https://example.test/new', () =>
    new Response('final', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const r4 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/old')), env: {} });
  check('F4 redirect followed (relative Location)', r4.status === 200 && (await r4.text()) === 'final'
    && r4.headers.get('x-locus-final-url') === 'https://example.test/new',
    'status=' + r4.status + ' final=' + r4.headers.get('x-locus-final-url'));

  // ---------- F5. redirect cap ----------
  reset();
  on(() => true, () => new Response(null, { status: 302, headers: { location: 'https://example.test/loop' } }));
  const r5 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/loop')), env: {} });
  check('F5 redirect cap → 508', r5.status === 508 && /Too many redirects/.test((await r5.json()).error.message),
    'status=' + r5.status + ' hops=' + calls.length);
  check('F5b cap bounds hop count', calls.length === 6, 'calls=' + calls.length); // initial + 5

  // ---------- F6. redirect to http:// is followed (v1); non-http refused ----------
  reset();
  on((u) => u === 'https://example.test/down', () =>
    new Response(null, { status: 302, headers: { location: 'http://insecure.test/x' } }));
  on((u) => u === 'http://insecure.test/x', () => new Response('downgraded', { status: 200 }));
  const r6 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/down')), env: {} });
  check('F6 http redirect target followed', r6.status === 200 && (await r6.text()) === 'downgraded'
    && r6.headers.get('x-locus-final-url') === 'http://insecure.test/x', 'status=' + r6.status);
  // a redirect to a NON-http(s) scheme is still refused
  reset();
  on((u) => u === 'https://example.test/ftp', () =>
    new Response(null, { status: 302, headers: { location: 'ftp://files.test/x' } }));
  const r6b = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/ftp')), env: {} });
  check('F6b ftp redirect target refused', r6b.status === 403
    && (await r6b.json()).error.code === 'network_unsupported_scheme', 'status=' + r6b.status);

  // ---------- F7. binary passthrough byte-perfect ----------
  reset();
  on((u) => u === 'https://example.test/i.png', () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
  const r7 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/i.png')), env: {} });
  const b7 = new Uint8Array(await r7.arrayBuffer());
  check('F7 binary byte-perfect', r7.status === 200 && b7.length === PNG_BYTES.length
    && b7.every((b, i) => b === PNG_BYTES[i])
    && r7.headers.get('content-type') === 'image/png',
    Array.from(b7).join(','));

  // ---------- F8. timeout covers the body, not just headers ----------
  reset();
  on(() => true, (u, opts) => {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"partial":'));
        opts.signal.addEventListener('abort', () => {
          ctrl.error(opts.signal.reason || new DOMException('aborted', 'AbortError'));
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const r8 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://example.test/hang')),
    env: { FETCH_TIMEOUT_MS: '300' },
  });
  const b8 = await r8.json();
  check('F8 hanging body → 504 timeout', r8.status === 504 && /Upstream timed out after 300ms/.test(b8.error.message),
    'status=' + r8.status + ' ' + JSON.stringify(b8));

  // ---------- F9. size cap ----------
  reset();
  on(() => true, () => new Response('x'.repeat(64), { status: 200, headers: { 'content-length': '64' } }));
  const r9 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://example.test/big')),
    env: { MAX_FETCH_RESPONSE_BYTES: '10' },
  });
  check('F9 oversized → 413', r9.status === 413, 'status=' + r9.status);

  // ---------- F10. upstream HTTP error passes through untouched ----------
  reset();
  on(() => true, () => new Response('{"error":"nope"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  const r10 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/missing')), env: {} });
  check('F10 upstream 404 passed through', r10.status === 404 && !r10.headers.get('x-locus-relay-error')
    && (await r10.text()) === '{"error":"nope"}', 'status=' + r10.status);

  // ---------- F11. null-body statuses must not throw ----------
  for (const [tag, status] of [['F11a', 204], ['F11b', 205], ['F11c', 304]]) {
    reset();
    on(() => true, () => new Response(null, { status }));
    const r = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/nobody')), env: {} });
    const buf = await r.arrayBuffer();
    check(tag + ' upstream ' + status + ' → ' + status + ', empty body', r.status === status && buf.byteLength === 0,
      'status=' + r.status + ' bytes=' + buf.byteLength);
  }

  // ---------- F12. mid-body stream error (not timeout) → 502 ----------
  reset();
  on(() => true, () => {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('partial'));
        ctrl.error(new Error('upstream reset'));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const r12 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://example.test/broken')),
    env: { FETCH_TIMEOUT_MS: '5000' },
  });
  const b12 = await r12.json();
  check('F12 mid-body stream error → 502 relay error', r12.status === 502
    && r12.headers.get('x-locus-relay-error') === '1'
    && /Upstream body read failed/.test(b12.error.message),
    'status=' + r12.status + ' ' + JSON.stringify(b12));

  // ---------- F13. active content gets CSP sandbox + nosniff ----------
  reset();
  on(() => true, () => new Response('<html><script>alert(1)</script></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const r13 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/page')), env: {} });
  check('F13 text/html → CSP sandbox + nosniff', r13.status === 200
    && r13.headers.get('content-security-policy') === 'sandbox'
    && r13.headers.get('x-content-type-options') === 'nosniff',
    'csp=' + r13.headers.get('content-security-policy') + ' nosniff=' + r13.headers.get('x-content-type-options'));

  // ---------- F14. passive content gets nosniff but no CSP sandbox ----------
  reset();
  on(() => true, () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const r14 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/data.json')), env: {} });
  check('F14 application/json → nosniff, no CSP sandbox', r14.status === 200
    && r14.headers.get('x-content-type-options') === 'nosniff'
    && !r14.headers.get('content-security-policy'),
    'csp=' + r14.headers.get('content-security-policy'));

  globalThis.fetch = realFetch;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { globalThis.fetch = realFetch; console.error('TEST RUNNER FAIL', e); process.exit(1); });
