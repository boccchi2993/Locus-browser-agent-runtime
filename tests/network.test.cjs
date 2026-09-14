// Network/curl/tool-routing regression tests (node, mocked fetch).
// Run: node tests/network.test.cjs
// No real internet access — global fetch is fully mocked.

const fs = require('fs');
const path = require('path');

// --- browser stubs ---
global.window = { location: { protocol: 'https:' } }; // hosted page → relay available

// --- load the real browser-layer sources in one shared scope ---
const src = ['telemetry.js', 'workspace.js', 'network.js', 'shell.js', 'tools.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ Telemetry, WorkspaceAdapter, normalizeWorkspacePath, NetworkRuntime, runShellCommand, executeTool, RELAY_CLIENT_TIMEOUT_MS });');

// Any unhandled rejection during the run is a test failure (cleanup paths
// must attach rejection handlers — see N25/N29).
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

// --- byte-exact in-memory workspace ---
class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) throw new Error('No such file: ' + p);
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async mkdir(p) { p = M.normalizeWorkspacePath(p); if (p && p in this.files) { const e = new Error('type mismatch'); e.name = 'TypeMismatchError'; throw e; } }
  async exists(p) { try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; } return p in this.files; }
  async stat(p) { p = M.normalizeWorkspacePath(p); if (!(p in this.files)) throw new Error('No such file: ' + p); return { kind: 'file', size: this.files[p].byteLength, modified: 0 }; }
}

// --- fetch mock ---
let calls = []; // every fetch() invocation: {url}
let routes = []; // [{match: (url)=>bool, respond: (url)=>Response|throw}]
function on(match, respond) { routes.push({ match, respond }); }
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts: opts || {} });
  for (const r of routes) {
    if (r.match(String(url))) return r.respond(String(url));
  }
  throw new Error('no mock route for ' + url);
};
function jsonResponse(body, headers) {
  return new Response(body, { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80]);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function reset() { calls = []; routes = []; M.Telemetry.records.length = 0; }
function lastRec() { return M.Telemetry.records[M.Telemetry.records.length - 1]; }

async function run() {
  const ws = new MemWS();

  // ---------- 1. curl text → stdout ----------
  reset();
  on((u) => u === 'https://example.test/data.json', () => jsonResponse('{"hello":"world"}'));
  const t1 = await M.executeTool('bash', 'curl https://example.test/data.json', ws);
  check('N1 curl text stdout', t1.success && t1.output.includes('{"hello":"world"}'), JSON.stringify(t1.output));
  check('N1b backend browser-direct', t1.backend === 'browser-direct', t1.backend);
  check('N1c telemetry operation=network', lastRec().operation === 'network' && lastRec().backend === 'browser-direct'
    && lastRec().success === true, JSON.stringify(lastRec()));

  // ---------- 2. curl -o text file → workspace bytes ----------
  reset();
  on((u) => u === 'https://example.test/data.json', () => jsonResponse('{"hello":"world"}'));
  const t2 = await M.executeTool('bash', 'curl -o raw.json https://example.test/data.json', ws);
  check('N2 curl -o text written', t2.success && t2.output === '[written to workspace: raw.json, 17 bytes]',
    JSON.stringify(t2.output));
  check('N2b workspace content exact', new TextDecoder().decode(ws.files['raw.json'] || []) === '{"hello":"world"}');

  // ---------- 3. curl -o binary → byte-perfect ----------
  reset();
  on((u) => u === 'https://example.test/i.png', () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
  const t3 = await M.executeTool('bash', 'curl -o image.png https://example.test/i.png', ws);
  const written = ws.files['image.png'];
  check('N3 curl -o binary written', t3.success && !!written, JSON.stringify(t3.output));
  check('N3b bytes byte-perfect', !!written && written.length === PNG_BYTES.length
    && written.every((b, i) => b === PNG_BYTES[i]),
    written ? Array.from(written).join(',') : 'missing');

  // ---------- 4. binary to stdout → no garbage, hint to use -o ----------
  reset();
  on((u) => u === 'https://example.test/i.png', () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }));
  const t4 = await M.executeTool('bash', 'curl https://example.test/i.png', ws);
  check('N4 binary stdout hint', t4.output.includes('binary response') && t4.output.includes('image/png')
    && t4.output.includes('use curl -o') && !t4.output.includes('PNG\r\n'),
    JSON.stringify(t4.output));

  // ---------- 5. only HTTPS ----------
  reset();
  const t5 = await M.executeTool('bash', 'curl http://example.com', ws);
  check('N5 http rejected', !t5.success && t5.output.includes('only HTTPS URLs are supported'), t5.output);
  check('N5b no fetch attempted', calls.length === 0);

  // ---------- 6. unsupported option ----------
  reset();
  const t6 = await M.executeTool('bash', 'curl -H "X-Test: 1" https://example.com', ws);
  check('N6 -H rejected', !t6.success && t6.output === 'curl: option not supported in local browser runtime: -H', t6.output);
  const t6b = await M.executeTool('bash', 'curl -X POST https://example.com', ws);
  check('N6b -X rejected', !t6b.success && t6b.output.includes('option not supported'), t6b.output);

  // ---------- 7/8. network/CORS failure → transparent edge relay ----------
  reset();
  on((u) => u === 'https://blocked.test/data.json', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), (u) => {
    check('N8 relay URL encodes target', u === '/fetch?url=' + encodeURIComponent('https://blocked.test/data.json'), u);
    return jsonResponse('{"via":"relay"}', { 'x-locus-final-url': 'https://blocked.test/data.json' });
  });
  const t7 = await M.executeTool('bash', 'curl https://blocked.test/data.json', ws);
  check('N7 CORS failure falls back to relay', t7.success && t7.output.includes('{"via":"relay"}'), JSON.stringify(t7.output));
  check('N7b backend edge-relay', t7.backend === 'edge-relay' && lastRec().backend === 'edge-relay', t7.backend);
  check('N7c exactly 2 fetches (direct + relay)', calls.length === 2, calls.map((c) => c.url).join(','));

  // ---------- 8b. file:// + CORS failure → clear error, no relay ----------
  reset();
  global.window.location.protocol = 'file:';
  on((u) => u === 'https://blocked.test/x', () => { throw new TypeError('Failed to fetch'); });
  const t8 = await M.executeTool('bash', 'curl https://blocked.test/x', ws);
  check('N8b file:// clear error', !t8.success && t8.output.includes('no edge relay is available'), t8.output);
  check('N8c no relay attempted from file://', calls.length === 1, calls.map((c) => c.url).join(','));
  global.window.location.protocol = 'https:';

  // ---------- 9. HTTP 404 is authoritative — never relayed ----------
  reset();
  on((u) => u === 'https://example.test/missing', () =>
    new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called'); });
  const t9 = await M.executeTool('bash', 'curl https://example.test/missing', ws);
  check('N9 404 reported, not relayed', !t9.success && t9.output.includes('HTTP 404')
    && calls.length === 1 && t9.backend === 'browser-direct',
    t9.output + ' | calls=' + calls.length + ' | backend=' + t9.backend);

  // ---------- 10. relay binary safety ----------
  reset();
  on((u) => u === 'https://blocked.test/i.png', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png', 'x-locus-final-url': 'https://blocked.test/i.png' } }));
  const t10 = await M.executeTool('bash', 'curl -o r.png https://blocked.test/i.png', ws);
  const wb = ws.files['r.png'];
  check('N10 relay binary byte-perfect', t10.success && t10.backend === 'edge-relay' && !!wb
    && wb.length === PNG_BYTES.length && wb.every((b, i) => b === PNG_BYTES[i]),
    t10.output + ' | backend=' + t10.backend);

  // ---------- relay's own errors surface clearly ----------
  reset();
  on((u) => u === 'https://blocked.test/slow', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () =>
    new Response(JSON.stringify({ error: { message: 'Upstream timed out after 30000ms' } }),
      { status: 504, headers: { 'content-type': 'application/json', 'x-locus-relay-error': '1' } }));
  const t11 = await M.executeTool('bash', 'curl https://blocked.test/slow', ws);
  check('N11 relay error surfaced', !t11.success && t11.output.includes('Upstream timed out after 30000ms'), t11.output);

  // ---------- 13. cloud_bash still unsuccessful ----------
  reset();
  const t13 = await M.executeTool('cloud_bash', 'curl https://example.com', ws);
  check('N13 cloud_bash success=false', t13.success === false && t13.output === 'Cloud execution is not configured.'
    && lastRec().backend === 'cloud' && lastRec().success === false);

  // ---------- ordinary commands keep backend=browser ----------
  reset();
  const t14 = await M.executeTool('bash', 'echo hi', ws);
  check('N14 non-network bash keeps backend=browser', t14.backend === 'browser' && lastRec().backend === 'browser'
    && !lastRec().operation, JSON.stringify(lastRec()));

  // ---------- 15. direct requests are anonymous by construction (F13) ----------
  reset();
  on((u) => u === 'https://example.test/anon', () => jsonResponse('{"ok":1}'));
  await M.executeTool('bash', 'curl https://example.test/anon', ws);
  check('N15 direct fetch omits credentials', calls[0].opts.credentials === 'omit', JSON.stringify(calls[0].opts));

  reset();
  const t15b = await M.executeTool('bash', 'curl https://user:pass@example.test/x', ws);
  check('N15b URL userinfo rejected', !t15b.success && t15b.output.includes('credentials in URLs')
    && calls.length === 0, t15b.output);

  // ---------- 16. client deadline: timeout is NOT a CORS failure, never relayed ----------
  reset();
  on((u) => u === 'https://slow.test/x', () => new Promise((resolve, reject) => {
    // hangs until the runtime's own deadline aborts it
    const sig = calls[calls.length - 1].opts.signal;
    if (sig) sig.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on timeout'); });
  let t16Err = null;
  try { await M.NetworkRuntime.fetch('https://slow.test/x', { timeoutMs: 30 }); } catch (e) { t16Err = e; }
  check('N16 timeout reported, not relayed', t16Err && t16Err.timeout === true && t16Err.message.includes('timed out')
    && calls.length === 1, (t16Err && t16Err.message) + ' | calls=' + calls.length);

  // ---------- 17. oversized response rejected by client cap ----------
  reset();
  on((u) => u === 'https://example.test/huge', () =>
    new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': String(20 * 1024 * 1024) } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on size cap'); });
  const t17 = await M.executeTool('bash', 'curl https://example.test/huge', ws);
  check('N17 oversized response rejected, not relayed', !t17.success && t17.output.includes('too large')
    && calls.length === 1, t17.output + ' | calls=' + calls.length);

  // ---------- 18. curl -o without workspace performs NO network request ----------
  reset();
  on((u) => true, () => { throw new Error('no fetch allowed'); });
  const t18 = await M.executeTool('bash', 'curl -o file.bin https://example.test/x', null);
  check('N18 curl -o without workspace: no fetch', !t18.success && t18.output.includes('no workspace selected')
    && calls.length === 0, t18.output + ' | calls=' + calls.length);

  // ---------- 19. pre-aborted cancellation is not misread as CORS ----------
  reset();
  const ac = new AbortController();
  ac.abort();
  let cancelErr = null;
  try { await M.NetworkRuntime.fetch('https://example.test/x', { signal: ac.signal }); } catch (e) { cancelErr = e; }
  check('N19 cancelled request → AbortError, no fetch, no relay',
    cancelErr && cancelErr.name === 'AbortError' && calls.length === 0,
    (cancelErr && cancelErr.name) + ' | calls=' + calls.length);

  // ---------- 20. deadline covers the BODY, not just headers (Finding 2) ----------
  // headers arrive immediately, body never completes → must still time out
  reset();
  on((u) => u === 'https://stall.test/x', () => new Response(
    new ReadableStream({ start() { /* never enqueues, never closes */ } }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  on((u) => u.startsWith('/fetch?'), () => { throw new Error('relay must NOT be called on timeout'); });
  let t20Err = null;
  const t20start = Date.now();
  try { await M.NetworkRuntime.fetch('https://stall.test/x', { timeoutMs: 40 }); } catch (e) { t20Err = e; }
  check('N20 body stall times out', t20Err && t20Err.timeout === true && t20Err.message.includes('timed out'),
    (t20Err && t20Err.message) + ' after ' + (Date.now() - t20start) + 'ms');
  check('N20b body-stall timeout is not relayed', calls.length === 1, 'calls=' + calls.length);

  // ---------- 21. external cancel during body read ----------
  reset();
  on((u) => u === 'https://slowbody.test/x', () => new Response(
    new ReadableStream({
      start(ctrl) { ctrl.enqueue(new TextEncoder().encode('chunk1')); /* then stalls */ },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const ac21 = new AbortController();
  setTimeout(() => ac21.abort(), 30);
  let t21Err = null;
  try { await M.NetworkRuntime.fetch('https://slowbody.test/x', { signal: ac21.signal, timeoutMs: 5000 }); } catch (e) { t21Err = e; }
  check('N21 cancel during body read → AbortError', t21Err && t21Err.name === 'AbortError',
    t21Err && t21Err.name + '/' + t21Err.message);

  // ---------- 22. slow body INSIDE the deadline completes fine ----------
  reset();
  on((u) => u === 'https://trickle.test/x', () => new Response(
    new ReadableStream({
      async start(ctrl) {
        for (let i = 0; i < 5; i++) {
          ctrl.enqueue(new TextEncoder().encode('c' + i));
          await new Promise((r) => setTimeout(r, 15));
        }
        ctrl.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const t22 = await M.NetworkRuntime.fetch('https://trickle.test/x', { timeoutMs: 5000 });
  check('N22 slow body within deadline completes', new TextDecoder().decode(t22.bytes) === 'c0c1c2c3c4'
    && t22.backend === 'browser-direct', new TextDecoder().decode(t22.bytes));

  // ---------- 23. relay body stall times out at the PASSED relay deadline ----------
  // relayTimeoutMs is a supported fetch() option: it must actually reach
  // the relay attempt. Proof is the elapsed time (40ms deadline vs the
  // 45000ms default), not merely that some timeout is eventually thrown.
  reset();
  on((u) => u === 'https://blocked2.test/x', () => { throw new TypeError('Failed to fetch'); });
  on((u) => u.startsWith('/fetch?'), () => new Response(
    new ReadableStream({ start() { /* stalls */ } }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t23Err = null;
  const t23start = Date.now();
  try { await M.NetworkRuntime.fetch('https://blocked2.test/x', { timeoutMs: 40, relayTimeoutMs: 40 }); } catch (e) { t23Err = e; }
  const t23elapsed = Date.now() - t23start;
  check('N23 relay body stall → timeout error (not unreachable, not retry loop)',
    t23Err && t23Err.timeout === true && !t23Err.message.includes('unreachable'),
    t23Err && t23Err.message);
  check('N23b the PASSED 40ms deadline was actually used (not the 45s default)',
    t23elapsed < 5000, 'elapsed=' + t23elapsed + 'ms');
  check('N23c default relay deadline retained', M.RELAY_CLIENT_TIMEOUT_MS === 45000,
    'RELAY_CLIENT_TIMEOUT_MS=' + M.RELAY_CLIENT_TIMEOUT_MS);

  // ---------- 24. stream cleanup must not block the timeout exit (cancel never settles) ----------
  reset();
  on((u) => u === 'https://hangcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return new Promise(() => {}); }, // cleanup hangs forever
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t24Err = null;
  const t24start = Date.now();
  try { await M.NetworkRuntime.fetch('https://hangcancel.test/x', { timeoutMs: 40 }); } catch (e) { t24Err = e; }
  const t24elapsed = Date.now() - t24start;
  check('N24 hanging reader.cancel() does not block the timeout exit',
    t24Err && t24Err.timeout === true && t24elapsed < 5000,
    (t24Err && t24Err.message) + ' after ' + t24elapsed + 'ms');

  // ---------- 25. stream cleanup rejection is swallowed (no unhandled rejection) ----------
  reset();
  on((u) => u === 'https://rejectcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return Promise.reject(new Error('cleanup blew up')); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t25Err = null;
  try { await M.NetworkRuntime.fetch('https://rejectcancel.test/x', { timeoutMs: 40 }); } catch (e) { t25Err = e; }
  check('N25 rejecting reader.cancel() keeps the timeout classification',
    t25Err && t25Err.timeout === true, t25Err && t25Err.message);

  // ---------- 26. normal cleanup still works (cancel resolves) ----------
  reset();
  let t26cancelled = false;
  on((u) => u === 'https://okcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { t26cancelled = true; return Promise.resolve(); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  let t26Err = null;
  try { await M.NetworkRuntime.fetch('https://okcancel.test/x', { timeoutMs: 40 }); } catch (e) { t26Err = e; }
  check('N26 resolving reader.cancel() → timeout error, cleanup ran',
    t26Err && t26Err.timeout === true && t26cancelled === true,
    (t26Err && t26Err.message) + ' cancelled=' + t26cancelled);

  // ---------- 27. size-cap exit is also not blocked by hanging cleanup ----------
  reset();
  on((u) => u === 'https://bigcancel.test/x', () => new Response(
    new ReadableStream({
      start(ctrl) {
        const mb = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 17; i++) ctrl.enqueue(mb); // 17 MiB > 16 MiB cap
      },
      cancel() { return new Promise(() => {}); }, // cleanup hangs forever
    }),
    { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  let t27Err = null;
  const t27start = Date.now();
  try { await M.NetworkRuntime.fetch('https://bigcancel.test/x', { timeoutMs: 5000 }); } catch (e) { t27Err = e; }
  const t27elapsed = Date.now() - t27start;
  check('N27 too-large exit not blocked by hanging reader.cancel()',
    t27Err && t27Err.tooLarge === true && t27elapsed < 5000,
    (t27Err && t27Err.message) + ' after ' + t27elapsed + 'ms');

  // ---------- 28. external cancel + hanging cleanup → AbortError promptly ----------
  reset();
  on((u) => u === 'https://extcancel.test/x', () => new Response(
    new ReadableStream({
      start() { /* read stalls */ },
      cancel() { return new Promise(() => {}); },
    }),
    { status: 200, headers: { 'content-type': 'text/plain' } }));
  const ac28 = new AbortController();
  setTimeout(() => ac28.abort(), 30);
  let t28Err = null;
  const t28start = Date.now();
  try { await M.NetworkRuntime.fetch('https://extcancel.test/x', { signal: ac28.signal, timeoutMs: 60000 }); } catch (e) { t28Err = e; }
  const t28elapsed = Date.now() - t28start;
  check('N28 external cancel + hanging cleanup → AbortError, not blocked',
    t28Err && t28Err.name === 'AbortError' && t28elapsed < 5000,
    (t28Err && t28Err.name) + ' after ' + t28elapsed + 'ms');

  await new Promise((r) => setTimeout(r, 50)); // let any stray rejection surface
  check('N29 no unhandled rejections from stream cleanup', unhandled.length === 0,
    unhandled.map((e) => String(e)).join(' | '));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
