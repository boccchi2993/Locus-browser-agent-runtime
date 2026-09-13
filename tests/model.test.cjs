// Model-layer regression tests (node, mocked fetch).
// Run: node tests/model.test.cjs

const fs = require('fs');
const path = require('path');

// --- browser stubs (model.js touches window only for the /proxy fallback) ---
global.window = { location: { protocol: 'file:' } };

// --- load the real model.js ---
const M = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'model.js'), 'utf8') +
  '\n;({ detectDialect, callModelText, verifyConnection, Model });'
);

// --- fetch mock: records requests, replays queued responses ---
let calls = [];
let queue = [];
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const next = queue.length ? queue.shift() : { status: 500, json: { error: { message: 'no mock queued' } } };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => JSON.stringify(next.json),
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
  check('J-E no visible text error', jeErr && jeErr.message === '响应中没有可见文本内容', jeErr && jeErr.message);

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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
