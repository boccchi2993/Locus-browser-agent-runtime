// /fetch edge-relay regression tests (node, mocked global fetch).
// Run: node tests/fetch.test.mjs

import { onRequestGet, onRequestPost } from '../functions/fetch.js';

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

function req(query, headers) {
  return new Request('https://pages.test/fetch' + (query || ''), { method: 'GET', headers: headers || {} });
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

  // ---------- F2c. private attack-vector table (N-F02/N-F07) ----------
  // The SAME table runs against the client classifier in
  // tests/network-runtime.test.cjs (S) — keep the two tables in sync.
  reset();
  on(() => { throw new Error('no upstream fetch allowed'); });
  const PRIVATE_TARGETS = [
    'localhost', 'localhost.', 'localhost.localdomain', 'sub.localhost.localdomain',
    '127.0.0.1', '0.1.2.3', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '[::1]',
    // IPv4-mapped IPv6, dotted and WHATWG-canonical hex spellings
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:192.168.1.1]', '[::ffff:169.254.169.254]',
    '[::ffff:7f00:1]', '[::ffff:a00:1]', '[::ffff:c0a8:101]', '[::ffff:a9fe:a9fe]',
    // WHATWG scalar normalizations
    '2130706433', '0x7f000001', '0177.0.0.1', '127.1',
  ];
  for (const host of PRIVATE_TARGETS) {
    const rr = await onRequestGet({ request: req('?url=' + encodeURIComponent('http://' + host + '/x')), env: {} });
    const j = await rr.json();
    check('F2c private target refused: ' + host,
      rr.status === 403 && j.error.code === 'network_private_address_blocked' && calls.length === 0,
      'status=' + rr.status);
  }
  // public regression: normal IPv4/IPv6/domain targets are NOT blocked
  reset();
  on((u) => u.startsWith('http://93.184.216.34') || u.startsWith('http://example.com')
    || u.startsWith('http://[2606:2800:220:1:248:1893:25c8:1946]'), () => new Response('ok', { status: 200 }));
  for (const host of ['93.184.216.34', 'example.com', '[2606:2800:220:1:248:1893:25c8:1946]']) {
    const rr = await onRequestGet({ request: req('?url=' + encodeURIComponent('http://' + host + '/x')), env: {} });
    check('F2d public target allowed: ' + host, rr.status === 200, 'status=' + rr.status);
  }

  // ---------- F15. redirect → mapped-private hop is re-validated ----------
  reset();
  on((u) => u === 'https://public.test/start', () =>
    new Response(null, { status: 302, headers: { location: 'http://[::ffff:7f00:1]:9/catch' } }));
  const r15 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://public.test/start')), env: {},
  });
  const j15 = await r15.json();
  check('F15 public → mapped-private redirect blocked, no private hop',
    r15.status === 403 && j15.error.code === 'network_private_address_blocked' && calls.length === 1,
    'status=' + r15.status + ' calls=' + calls.length);

  // ---------- F16. cross-origin redirect strips origin-bound credentials (N-F01) ----------
  {
    // R-CRED2: A → B, Authorization must NOT reach B (envelope form: the
    // legacy GET form has no header channel at all)
    reset();
    on((u) => u === 'https://origin-a.test/1', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED2 Authorization present on origin A', h === 'Bearer sekrit-A', String(h));
      return new Response(null, { status: 302, headers: { location: 'https://origin-b.test/2' } });
    });
    on((u) => u === 'https://origin-b.test/2', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED2b Authorization stripped on origin B', h == null, String(h));
      check('R-CRED2c Proxy-Authorization stripped on origin B',
        (opts.headers instanceof Headers ? opts.headers.get('proxy-authorization') : opts.headers['proxy-authorization']) == null);
      return new Response('final-at-b', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const envelope = new Request('https://pages.test/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'https://origin-a.test/1',
        headers: { authorization: 'Bearer sekrit-A', 'proxy-authorization': 'Basic pwa' } }),
    });
    const r16 = await onRequestPost({ request: envelope, env: {} });
    check('R-CRED2d cross-origin chain completes', r16.status === 200 && (await r16.text()) === 'final-at-b',
      'status=' + r16.status);
    check('R-CRED2e exactly two upstream hops', calls.length === 2, 'calls=' + calls.length);
  }
  {
    // R-CRED1: same-origin redirect keeps Authorization
    reset();
    on((u) => u === 'https://origin-a.test/1', () =>
      new Response(null, { status: 302, headers: { location: 'https://origin-a.test/2' } }));
    on((u) => u === 'https://origin-a.test/2', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED1 Authorization kept on a same-origin hop', h === 'Bearer keepme', String(h));
      return new Response('same-origin-final', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const envelopeReq = new Request('https://pages.test/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'https://origin-a.test/1',
        headers: { authorization: 'Bearer keepme' } }),
    });
    const r16b = await onRequestPost({ request: envelopeReq, env: {} });
    check('R-CRED1 same-origin chain completes', r16b.status === 200, 'status=' + r16b.status);
  }
  {
    // R-CRED3: A → B → A, the stripped credential never returns (monotonic)
    reset();
    on((u) => u === 'https://origin-a.test/1', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED3 Authorization present on first hop (A)', h === 'Bearer secret', String(h));
      return new Response(null, { status: 302, headers: { location: 'https://origin-b.test/2' } });
    });
    on((u) => u === 'https://origin-b.test/2', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED3b Authorization absent on B', h == null, String(h));
      return new Response(null, { status: 302, headers: { location: 'https://origin-a.test/3' } });
    });
    on((u) => u === 'https://origin-a.test/3', (u, opts) => {
      const h = opts.headers instanceof Headers ? opts.headers.get('authorization') : opts.headers.authorization;
      check('R-CRED3c Authorization NOT restored on return to A', h == null, String(h));
      return new Response('back-at-a', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const envelope = new Request('https://pages.test/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'https://origin-a.test/1',
        headers: { authorization: 'Bearer secret' } }),
    });
    const r16c = await onRequestPost({ request: envelope, env: {} });
    check('R-CRED3d A→B→A completes without the credential', r16c.status === 200
      && (await r16c.text()) === 'back-at-a', 'status=' + r16c.status);
    check('R-CRED3e exactly three hops', calls.length === 3, 'calls=' + calls.length);
  }
  {
    // R-CRED4: side-effecting cross-origin redirect stays BLOCKED (no strip loophole)
    reset();
    on((u) => u === 'https://origin-a.test/w', () =>
      new Response(null, { status: 307, headers: { location: 'https://origin-b.test/w' } }));
    on((u) => u === 'https://origin-b.test/w', () => {
      throw new Error('side effect must NOT be replayed on another origin');
    });
    const envelope = new Request('https://pages.test/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'POST', url: 'https://origin-a.test/w',
        headers: { authorization: 'Bearer secret' }, bodyBase64: btoa('payload') }),
    });
    const r16d = await onRequestPost({ request: envelope, env: {} });
    const j16d = await r16d.json();
    check('R-CRED4 side-effecting cross-origin redirect still blocked',
      r16d.status === 403 && j16d.error.code === 'network_redirect_blocked' && calls.length === 1,
      'status=' + r16d.status + ' calls=' + calls.length);
  }

  // ---------- F17. relay error wording is model-safe (N-F05) ----------
  reset();
  on(() => { throw new Error('socket hang up'); });
  const r17 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://example.test/fail')), env: {},
  });
  const j17 = await r17.json();
  check('F17 upstream failure message hides implementation words',
    r17.status === 502 && !/relay|browser|Cloudflare|CORS|edge/i.test(j17.error.message),
    JSON.stringify(j17));
  check('F17b machine-readable code still present', j17.error.code === 'network_relay_failed', j17.error.code);

  // ---------- F18. HEAD upstream → headers frame, empty body ----------
  reset();
  on((u) => u === 'https://example.test/h', () => new Response(null, {
    status: 200, headers: { 'content-type': 'text/plain', 'x-head': 'upstream' },
  }));
  const envHead = new Request('https://pages.test/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'HEAD', url: 'https://example.test/h', headers: {} }),
  });
  const r18 = await onRequestPost({ request: envHead, env: {} });
  check('F18 HEAD framed without a body read', r18.status === 200 && calls.length === 1
    && (await r18.text()) === '' && r18.headers.get('x-head') === 'upstream',
    'status=' + r18.status + ' calls=' + calls.length);

  // ---------- F19. duplicated upstream response headers are not collapsed ----------
  reset();
  on((u) => u === 'https://example.test/multi', () => {
    const res = new Response('dup', { status: 200, headers: { 'content-type': 'text/plain' } });
    res.headers.append('x-test', 'a');
    res.headers.append('x-test', 'b');
    return res;
  });
  const r19 = await onRequestGet({
    request: req('?url=' + encodeURIComponent('https://example.test/multi')), env: {},
  });
  check('F19 both duplicate values observable (append, not set)',
    r19.status === 200 && r19.headers.get('x-test') === 'a, b',
    JSON.stringify([...r19.headers.entries()]));

  // ---------- F20. legacy GET Origin enforcement (N-F03) ----------
  {
    const url = '?url=' + encodeURIComponent('https://example.test/data');
    // O1: no Origin → legacy compatibility preserved
    reset();
    on((u) => u === 'https://example.test/data', () => new Response('legacy-ok', { status: 200 }));
    const rO1 = await onRequestGet({ request: req(url), env: {} });
    check('O1 no Origin → legacy GET allowed', rO1.status === 200 && (await rO1.text()) === 'legacy-ok',
      'status=' + rO1.status);
    // O2: correct same-deployment Origin → allowed
    reset();
    on((u) => u === 'https://example.test/data', () => new Response('same-ok', { status: 200 }));
    const rO2 = await onRequestGet({
      request: req(url, { origin: 'https://pages.test' }), env: {},
    });
    check('O2 same deployment Origin → allowed', rO2.status === 200, 'status=' + rO2.status);
    // O3: hostile origin → denied, zero upstream calls
    reset();
    on(() => { throw new Error('hostile origin must not reach upstream'); });
    const rO3 = await onRequestGet({
      request: req(url, { origin: 'https://evil.test' }), env: {},
    });
    check('O3 evil Origin → 403', rO3.status === 403 && calls.length === 0, 'status=' + rO3.status);
    // O4: suffix lookalike host → denied
    reset();
    on(() => { throw new Error('lookalike origin must not reach upstream'); });
    const rO4 = await onRequestGet({
      request: req(url, { origin: 'https://pages.test.evil.com' }), env: {},
    });
    check('O4 suffix-lookalike Origin → 403', rO4.status === 403 && calls.length === 0, 'status=' + rO4.status);
    // O5: same host, wrong scheme → denied
    reset();
    on(() => { throw new Error('wrong-scheme origin must not reach upstream'); });
    const rO5 = await onRequestGet({
      request: req(url, { origin: 'http://pages.test' }), env: {},
    });
    check('O5 scheme-mismatch Origin → 403', rO5.status === 403 && calls.length === 0, 'status=' + rO5.status);
    // O6: same host, wrong port → denied
    reset();
    on(() => { throw new Error('wrong-port origin must not reach upstream'); });
    const rO6 = await onRequestGet({
      request: req(url, { origin: 'https://pages.test:8443' }), env: {},
    });
    check('O6 port-mismatch Origin → 403', rO6.status === 403 && calls.length === 0, 'status=' + rO6.status);
    // prefix lookalike → denied
    reset();
    on(() => { throw new Error('prefix lookalike must not reach upstream'); });
    const rO7 = await onRequestGet({
      request: req(url, { origin: 'https://evil.com/pages.test' }), env: {},
    });
    check('O7 prefix-lookalike Origin → 403', rO7.status === 403 && calls.length === 0, 'status=' + rO7.status);
  }

  globalThis.fetch = realFetch;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { globalThis.fetch = realFetch; console.error('TEST RUNNER FAIL', e); process.exit(1); });
