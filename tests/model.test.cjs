// Model-layer regression tests (node, mocked fetch).
// Run: node tests/model.test.cjs

const fs = require('fs');
const path = require('path');

// --- browser stubs (model.js touches window only for the /proxy fallback) ---
global.window = { location: { protocol: 'file:' } };

// --- load the real model.js ---
const M = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'model.js'), 'utf8') +
  '\n;({ detectDialect, callModel, callModelText, verifyConnection, Model });'
);

// --- fetch mock: records requests, replays queued responses ---
// queued item: {status, json, headers?, typeError?, hang?}
let calls = [];
let queue = [];
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const next = queue.length ? queue.shift() : { status: 500, json: { error: { message: 'no mock queued' } } };
  if (next.typeError) throw new TypeError('Failed to fetch'); // genuine CORS/network failure
  if (next.hang) {
    await new Promise((resolve, reject) => {
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  }
  if (next.bodyStreamError) {
    // Headers arrive fine, then the BODY stream dies mid-read — the exact
    // shape of a truncated/reset connection after HTTP 200.
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (n) => (next.headers || {})[String(n).toLowerCase()] || null },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"partial":'));
          c.error(new TypeError('Failed to fetch'));
        },
      }),
      text: async () => { throw new TypeError('Failed to fetch'); },
    };
  }
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: { get: (n) => (next.headers || {})[String(n).toLowerCase()] || null },
    text: async () => (next.rawText !== undefined ? next.rawText : JSON.stringify(next.json)),
  };
};

const ANTHROPIC_OK = { status: 200, json: { content: [{ type: 'text', text: 'OK' }] } };
const OPENAI_OK = { status: 200, json: { choices: [{ message: { content: 'OK' } }] } };

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function reset(apiBase, apiKey) {
  M.Model.apiBase = apiBase;
  M.Model.apiKey = apiKey || 'sk-test-key';
  M.Model.proxy = '';
  calls = [];
  queue = [];
}

async function run() {
  // ---------- A. dialect detection ----------
  check('A1 api.anthropic.com → anthropic', M.detectDialect('https://api.anthropic.com') === 'anthropic');
  check('A2 deepseek /anthropic → anthropic', M.detectDialect('https://api.deepseek.com/anthropic') === 'anthropic');
  check('A3 third-party /v1/anthropic → anthropic', M.detectDialect('https://example.com/v1/anthropic') === 'anthropic');
  check('A4 api.deepseek.com → openai', M.detectDialect('https://api.deepseek.com') === 'openai');
  check('A5 example.com/v1 → openai', M.detectDialect('https://example.com/v1') === 'openai');

  const body = { model: 'm', max_tokens: 8, system: 's', messages: [{ role: 'user', content: 'hi' }] };

  // ---------- B. DeepSeek anthropic-compatible: x-api-key, no Bearer ----------
  reset('https://api.deepseek.com/anthropic');
  queue.push(ANTHROPIC_OK);
  const bRes = await M.callModelText(body);
  check('B1 request URL', calls[0].url === 'https://api.deepseek.com/anthropic/v1/messages', calls[0].url);
  check('B2 x-api-key sent', calls[0].headers['x-api-key'] === 'sk-test-key');
  check('B3 anthropic-version sent', calls[0].headers['anthropic-version'] === '2023-06-01');
  check('B4 NO Authorization Bearer', !('Authorization' in calls[0].headers));
  check('B5 NO dangerous-direct header for third-party', !('anthropic-dangerous-direct-browser-access' in calls[0].headers));
  check('B6 anthropic response parsed', bRes === 'OK');
  check('B7 single attempt only', calls.length === 1);

  // ---------- B-official. api.anthropic.com keeps direct-browser header ----------
  reset('https://api.anthropic.com');
  queue.push(ANTHROPIC_OK);
  await M.callModelText(body);
  check('B8 official anthropic keeps dangerous-direct header',
    calls[0].headers['anthropic-dangerous-direct-browser-access'] === 'true');

  // ---------- C. OpenAI-compatible: Bearer + converted body ----------
  reset('https://api.deepseek.com');
  queue.push(OPENAI_OK);
  const cRes = await M.callModelText(body);
  check('C1 Authorization Bearer sent', calls[0].headers['Authorization'] === 'Bearer sk-test-key');
  check('C2 NO x-api-key', !('x-api-key' in calls[0].headers));
  check('C3 openai body shape (system hoisted)', calls[0].body.messages[0].role === 'system' && !('system' in calls[0].body));
  check('C4 openai response parsed', cRes === 'OK');

  // ---------- D/E/F. 401 / 402 / 429 never fall back ----------
  for (const [name, status, msg] of [['D 401', 401, 'Invalid API key'], ['E 402', 402, 'Insufficient balance'], ['F 429', 429, 'Rate limited']]) {
    reset('https://api.deepseek.com');
    queue.push({ status, json: { error: { message: msg } } }, OPENAI_OK);
    let err = null;
    try { await M.callModelText(body); } catch (e) { err = e; }
    check(name + ' stops fallback (1 call, status kept, message kept)',
      calls.length === 1 && err && err.status === status && err.message === msg,
      'calls=' + calls.length + ' err=' + (err && err.status + '/' + err.message));
  }

  // ---------- G. 404 falls back to next endpoint path ----------
  reset('https://api.deepseek.com');
  queue.push({ status: 404, json: { error: { message: 'unknown path' } } }, OPENAI_OK);
  const gRes = await M.callModelText(body);
  check('G1 404 → fallback succeeds', gRes === 'OK' && calls.length === 2);
  check('G2 fallback order', calls[0].url.endsWith('/chat/completions') && calls[1].url.endsWith('/v1/chat/completions'),
    calls.map((c) => c.url).join(' , '));

  // ---------- H. error fidelity: first meaningful error survives ----------
  reset('https://api.deepseek.com');
  queue.push(
    { status: 404, json: { error: { message: 'path A not here' } } },
    { status: 404, json: { error: { message: 'path B missing' } } },
  );
  let hErr = null;
  try { await M.callModelText(body); } catch (e) { hErr = e; }
  check('H1 first error preserved over last', hErr && hErr.message === 'path A not here', hErr && hErr.message);

  // 402 mid-sequence is never masked by a later attempt (it stops immediately)
  reset('https://api.deepseek.com/anthropic');
  queue.push({ status: 402, json: { error: { message: 'Insufficient balance' } } });
  let h2Err = null;
  try { await M.callModelText(body); } catch (e) { h2Err = e; }
  check('H2 402 surfaces as-is', h2Err && h2Err.status === 402 && h2Err.message === 'Insufficient balance',
    h2Err && h2Err.status + '/' + h2Err.message);

  // ---------- I. proxy receives identical auth headers ----------
  reset('https://api.deepseek.com/anthropic');
  M.Model.proxy = 'https://proxy.example.com';
  queue.push(ANTHROPIC_OK);
  await M.callModelText(body);
  check('I1 proxy URL used', calls[0].url === 'https://proxy.example.com');
  check('I2 X-Target-URL set', calls[0].headers['X-Target-URL'] === 'https://api.deepseek.com/anthropic/v1/messages');
  check('I3 auth headers forwarded via proxy', calls[0].headers['x-api-key'] === 'sk-test-key'
    && calls[0].headers['anthropic-version'] === '2023-06-01');

  // ---------- J. Anthropic response parsing: visible text blocks only ----------
  reset('https://api.deepseek.com/anthropic');

  // J-A: plain text block
  queue.push({ status: 200, json: { content: [{ type: 'text', text: 'OK' }] } });
  check('J-A plain text block', await M.callModelText(body) === 'OK');

  // J-B: thinking + text → thinking must not leak
  queue.push({ status: 200, json: { content: [
    { type: 'thinking', thinking: 'internal reasoning' },
    { type: 'text', text: 'OK' },
  ] } });
  const jb = await M.callModelText(body);
  check('J-B thinking excluded, text returned', jb === 'OK' && !jb.includes('internal reasoning'), JSON.stringify(jb));

  // J-C: multiple text blocks joined in order, thinking in between ignored
  queue.push({ status: 200, json: { content: [
    { type: 'text', text: 'hello ' },
    { type: 'thinking', thinking: 'secret' },
    { type: 'text', text: 'world' },
  ] } });
  check('J-C multiple text blocks joined', await M.callModelText(body) === 'hello world');

  // J-D: unknown block types ignored
  queue.push({ status: 200, json: { content: [
    { type: 'server_tool_use' },
    { type: 'text', text: 'OK' },
  ] } });
  check('J-D unknown blocks ignored', await M.callModelText(body) === 'OK');

  // J-E: no visible text → clear error
  queue.push({ status: 200, json: { content: [{ type: 'thinking', thinking: '...' }] } });
  let jeErr = null;
  try { await M.callModelText(body); } catch (e) { jeErr = e; }
  check('J-E no visible text error', jeErr && jeErr.message.includes('响应中没有可见文本内容'), jeErr && jeErr.message);

  // J-E2: no visible text + stop_reason max_tokens → hint included
  queue.push({ status: 200, json: { content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' } });
  let je2Err = null;
  try { await M.callModelText(body); } catch (e) { je2Err = e; }
  check('J-E2 max_tokens hint', je2Err && je2Err.message.includes('token 上限'), je2Err && je2Err.message);

  // J-F: string content compatibility
  queue.push({ status: 200, json: { content: 'OK' } });
  check('J-F string content', await M.callModelText(body) === 'OK');

  // ---------- K. OpenAI parser: reasoning_content never leaks ----------
  reset('https://api.deepseek.com');
  queue.push({ status: 200, json: { choices: [{ message: { reasoning_content: 'internal', content: 'OK' } }] } });
  const kRes = await M.callModelText(body);
  check('K reasoning_content excluded', kRes === 'OK' && !kRes.includes('internal'), JSON.stringify(kRes));

  // ---------- L. verifyConnection token budget ----------
  reset('https://api.deepseek.com/anthropic');
  queue.push(ANTHROPIC_OK);
  await M.verifyConnection();
  check('L verifyConnection max_tokens is 128', calls[0].body.max_tokens === 128, 'max_tokens=' + calls[0].body.max_tokens);

  // ---------- M. auto /proxy fallback preserves authoritative relay errors (F08) ----------
  global.window.location.protocol = 'https:'; // hosted → relay fallback available
  reset('https://api.deepseek.com');
  queue.push(
    { typeError: true }, // direct: CORS
    { status: 429, json: { error: { message: 'quota exhausted' } }, headers: { 'x-locus-relay': '1' } }, // relay answers
  );
  let mErr = null;
  try { await M.callModelText(body); } catch (e) { mErr = e; }
  check('M1 relay 429 preserved (not masked by CORS)', mErr && mErr.status === 429 && mErr.message === 'quota exhausted',
    mErr && mErr.status + '/' + mErr.message);
  check('M1b exactly 2 requests (direct + relay), no endpoint probing', calls.length === 2, 'calls=' + calls.length);

  // relay missing (404 without the relay marker) → original direct error wins
  reset('https://api.deepseek.com/anthropic');
  queue.push(
    { typeError: true },
    { status: 404, json: { error: { message: 'not found' } } }, // no x-locus-relay header
  );
  let m2Err = null;
  try { await M.callModelText(body); } catch (e) { m2Err = e; }
  check('M2 missing relay → original CORS error', m2Err && m2Err instanceof TypeError && calls.length === 2,
    (m2Err && m2Err.message) + ' calls=' + calls.length);

  // ---------- N. HTTP 200 semantic errors never trigger another paid request (F09) ----------
  reset('https://api.deepseek.com');
  queue.push({ status: 200, json: { choices: [{ message: { content: null, reasoning_content: 'thinking' }, finish_reason: 'length' }] } });
  let nErr = null;
  try { await M.callModelText(body); } catch (e) { nErr = e; }
  check('N1 reasoning-only + length → parse error mentioning token limit',
    nErr && nErr.message.includes('token 上限'), nErr && nErr.message);
  check('N1b exactly 1 request (no second endpoint attempt)', calls.length === 1, 'calls=' + calls.length);

  reset('https://api.deepseek.com');
  queue.push({ status: 200, json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } });
  let n2Err = null;
  try { await M.callModelText(body); } catch (e) { n2Err = e; }
  check('N2 empty content + stop → no retry', n2Err && calls.length === 1, 'calls=' + calls.length);

  // non-JSON body on HTTP 200 is a parse error, not an endpoint error
  reset('https://api.deepseek.com');
  queue.push({ status: 200, rawText: '<html>not json</html>' });
  let n3Err = null;
  try { await M.callModelText(body); } catch (e) { n3Err = e; }
  check('N3 non-JSON 200 → parse error, no retry', n3Err && n3Err.message === '响应不是 JSON' && calls.length === 1,
    (n3Err && n3Err.message) + ' calls=' + calls.length);

  // ---------- O. structured envelope (MODEL-PROTOCOL) ----------
  reset('https://api.deepseek.com');
  queue.push({ status: 200, json: { choices: [{ message: { content: 'visible', reasoning_content: 'raw thinking' }, finish_reason: 'stop' }], usage: { total_tokens: 42 } } });
  const oEnv = await M.callModel(body);
  check('O1 openai envelope: content/reasoning/stopReason/usage separated',
    oEnv.content === 'visible' && oEnv.reasoning === 'raw thinking' && oEnv.stopReason === 'stop'
    && oEnv.usage && oEnv.usage.total_tokens === 42 && oEnv.truncated === false, JSON.stringify(oEnv));
  check('O1b rawMessage preserves provider-native reasoning_content',
    oEnv.rawMessage && oEnv.rawMessage.reasoning_content === 'raw thinking');

  reset('https://api.deepseek.com/anthropic');
  queue.push({ status: 200, json: { content: [
    { type: 'thinking', thinking: 'chain' },
    { type: 'text', text: 'answer' },
  ], stop_reason: 'end_turn', usage: { input_tokens: 3 } } });
  const o2Env = await M.callModel(body);
  check('O2 anthropic envelope: thinking preserved, blocks replayable',
    o2Env.content === 'answer' && o2Env.reasoning === 'chain' && o2Env.stopReason === 'end_turn'
    && Array.isArray(o2Env.rawMessage.content) && o2Env.rawMessage.content[0].type === 'thinking',
    JSON.stringify(o2Env));

  reset('https://api.deepseek.com');
  queue.push({ status: 200, json: { choices: [{ message: { content: 'partial answer' }, finish_reason: 'length' }] } });
  const o3Env = await M.callModel(body);
  check('O3 truncated non-empty content kept with truncated flag',
    o3Env.content === 'partial answer' && o3Env.truncated === true && o3Env.stopReason === 'length');

  // ---------- P. cancellation & timeout ----------
  reset('https://api.deepseek.com');
  const ac = new AbortController();
  ac.abort();
  let pErr = null;
  try { await M.callModel(body, { signal: ac.signal }); } catch (e) { pErr = e; }
  check('P1 pre-aborted signal cancels before any request', pErr && pErr.name === 'AbortError' && calls.length === 0,
    (pErr && pErr.name) + ' calls=' + calls.length);

  reset('https://api.deepseek.com');
  queue.push({ hang: true });
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 20);
  let p2Err = null;
  try { await M.callModel(body, { signal: ac2.signal }); } catch (e) { p2Err = e; }
  check('P2 mid-flight abort → cancelled, no retry', p2Err && p2Err.name === 'AbortError' && calls.length === 1,
    (p2Err && p2Err.name) + ' calls=' + calls.length);

  reset('https://api.deepseek.com');
  queue.push({ hang: true });
  let p3Err = null;
  try { await M.callModel(body, { timeoutMs: 30 }); } catch (e) { p3Err = e; }
  check('P3 client deadline → timeout error, no endpoint retry',
    p3Err && p3Err.timeout === true && p3Err.message.includes('timed out') && calls.length === 1,
    (p3Err && p3Err.message) + ' calls=' + calls.length);

  // ---------- Q. body-read failure AFTER headers is not a CORS fallback (Finding 6) ----------
  global.window.location.protocol = 'https:';
  // Q1: HTTP 200, body stream dies mid-read → BodyReadError, NO /proxy re-send
  reset('https://model.test');
  queue.push({ status: 200, bodyStreamError: true });
  let q1Err = null;
  try { await M.callModel(body); } catch (e) { q1Err = e; }
  check('Q1 200 body interruption → BodyReadError (not TypeError/CORS)',
    q1Err && q1Err.name === 'BodyReadError' && q1Err.noFallback === true,
    q1Err && q1Err.name + '/' + q1Err.message);
  check('Q1b status and cause preserved', q1Err && q1Err.status === 200 && q1Err.cause instanceof TypeError,
    q1Err && String(q1Err.status) + '/' + (q1Err.cause && q1Err.cause.message));
  check('Q1c no second request (no double-billed inference)', calls.length === 1,
    'calls=' + calls.length + ' ' + calls.map((c) => c.url).join(','));

  // Q2: error status, body dies before the error JSON can be read → still no fallback
  reset('https://model.test');
  queue.push({ status: 500, bodyStreamError: true });
  let q2Err = null;
  try { await M.callModel(body); } catch (e) { q2Err = e; }
  check('Q2 500 body interruption → BodyReadError keeps HTTP status, no retry',
    q2Err && q2Err.name === 'BodyReadError' && q2Err.status === 500 && calls.length === 1,
    (q2Err && q2Err.name + '/' + q2Err.status) + ' calls=' + calls.length);

  // Q3: genuine pre-headers CORS failure still falls back to /proxy (regression guard)
  reset('https://model.test');
  queue.push({ typeError: true }, OPENAI_OK);
  const q3 = await M.callModelText(body);
  check('Q3 pre-headers TypeError still relays to /proxy', q3 === 'OK' && calls.length === 2
    && calls[1].url === '/proxy', calls.map((c) => c.url).join(','));

  global.window.location.protocol = 'file:';

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
