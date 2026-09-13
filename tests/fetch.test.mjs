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

  // ---------- F2. http:// target → 403 ----------
  reset();
  const r2 = await onRequestGet({ request: req('?url=' + encodeURIComponent('http://example.com/x')), env: {} });
  check('F2 http target → 403', r2.status === 403 && calls.length === 0, 'status=' + r2.status + ' calls=' + calls.length);

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

  // ---------- F6. redirect to http → 403 ----------
  reset();
  on((u) => u === 'https://example.test/down', () =>
    new Response(null, { status: 302, headers: { location: 'http://insecure.test/x' } }));
  const r6 = await onRequestGet({ request: req('?url=' + encodeURIComponent('https://example.test/down')), env: {} });
  check('F6 http redirect target → 403', r6.status === 403 && calls.length === 1, 'status=' + r6.status);

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

  globalThis.fetch = realFetch;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { globalThis.fetch = realFetch; console.error('TEST RUNNER FAIL', e); process.exit(1); });
