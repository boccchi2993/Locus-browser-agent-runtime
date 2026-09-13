// ============================================================
//  MODEL LAYER
//  Adapted from Whoami_Cli_game: multi-dialect LLM API client with
//  automatic fallback between Anthropic-style and OpenAI-style
//  endpoints, plus an optional CORS proxy.
// ============================================================
const Model = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-pro',
  proxy: '',
};

function sanitizeKey(k) {
  return String(k || '').replace(/[^\x20-\x7E]/g, '').trim();
}

function anthropicUrl() {
  return Model.apiBase.replace(/\/+$/, '') + '/v1/messages';
}

function openaiUrl() {
  return Model.apiBase.replace(/\/+$/, '').replace(/\/anthropic\/?$/, '') + '/chat/completions';
}

function openaiUrlV1() {
  return Model.apiBase.replace(/\/+$/, '').replace(/\/anthropic\/?$/, '') + '/v1/chat/completions';
}

function toOpenAIBody(body) {
  const messages = (body.messages || []).slice();
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  return { model: body.model, messages, max_tokens: body.max_tokens || 2000 };
}

function parseAnthropicResp(data) {
  if (data.content && data.content[0] && data.content[0].text) return data.content[0].text;
  if (data.error) throw new Error(data.error.message || data.error.type || JSON.stringify(data.error));
  throw new Error('响应格式不符合预期');
}

function parseOpenAIResp(data) {
  if (data.choices && data.choices[0]) {
    const msg = data.choices[0].message || data.choices[0].delta || {};
    if (msg.content) return msg.content;
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  throw new Error('响应格式不符合预期');
}

async function fetchJsonPost(fetchUrl, headers, body) {
  const res = await fetch(fetchUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) {}
  if (!res.ok) {
    const msg = data && data.error ? (data.error.message || data.error.type) : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  if (!data) throw new Error('响应不是 JSON');
  return data;
}

// fetch() rejects with TypeError only on genuine network/CORS failures.
// HTTP 4xx/5xx are authoritative provider answers and must NOT be
// re-sent to another backend.
function isNetworkError(e) {
  return e instanceof TypeError;
}

async function tryFetch(url, headers, body, parser) {
  // 1. Explicit proxy configured → always use it.
  if (Model.proxy) {
    const proxy = Model.proxy.replace(/\/+$/, '');
    const data = await fetchJsonPost(proxy, Object.assign({}, headers, { 'X-Target-URL': url }), body);
    return parser(data);
  }

  // 2. Direct fetch first.
  try {
    const data = await fetchJsonPost(url, headers, body);
    return parser(data);
  } catch (e) {
    // 3. Only on genuine network/CORS failure, and only when hosted
    //    (non-file://), try the same-origin /proxy relay.
    if (!isNetworkError(e) || window.location.protocol === 'file:') throw e;
    const directError = e;
    try {
      const data = await fetchJsonPost('/proxy', Object.assign({}, headers, { 'X-Target-URL': url }), body);
      return parser(data);
    } catch (e2) {
      // 4. /proxy missing or also failing → report the original error.
      throw directError;
    }
  }
}

async function callModelText(body) {
  const key = sanitizeKey(Model.apiKey);
  const isAnthropicHost = Model.apiBase.indexOf('api.anthropic.com') !== -1;
  const aUrl = anthropicUrl();
  const oUrl = openaiUrl();
  const oUrlV1 = openaiUrlV1();
  const oaiBody = toOpenAIBody(body);
  const hBearer = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
  const hNone = { 'Content-Type': 'application/json' };
  const hAnthropicXKey = isAnthropicHost
    ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : hBearer;
  const hAnthropicBearer = isAnthropicHost
    ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : hBearer;

  const attempts = isAnthropicHost ? [
    { url: aUrl, h: hAnthropicXKey, b: body, p: parseAnthropicResp },
    { url: aUrl, h: hAnthropicBearer, b: body, p: parseAnthropicResp },
    { url: aUrl, h: hNone, b: body, p: parseAnthropicResp },
  ] : [
    { url: aUrl, h: hBearer, b: body, p: parseAnthropicResp },
    { url: oUrl, h: hBearer, b: oaiBody, p: parseOpenAIResp },
    { url: oUrlV1, h: hBearer, b: oaiBody, p: parseOpenAIResp },
    { url: aUrl, h: hNone, b: body, p: parseAnthropicResp },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try { return await tryFetch(attempt.url, attempt.h, attempt.b, attempt.p); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('连接失败');
}

async function verifyConnection() {
  // Always test the model the user actually configured — never silently
  // substitute a different model for the connection check.
  const body = {
    model: Model.model || 'deepseek-v4-pro',
    max_tokens: 8,
    system: '只回复 OK。',
    messages: [{ role: 'user', content: 'OK' }],
  };
  return callModelText(body);
}
