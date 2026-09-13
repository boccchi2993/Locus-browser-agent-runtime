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

function getProxyEndpoint() {
  if (Model.proxy) return Model.proxy.replace(/\/+$/, '');
  if (window.location.protocol !== 'file:') return '/proxy';
  return '';
}

async function tryFetch(url, headers, body, parser) {
  const proxy = getProxyEndpoint();
  const fetchUrl = proxy || url;
  const fetchHeaders = proxy ? Object.assign({}, headers, { 'X-Target-URL': url }) : headers;
  const res = await fetch(fetchUrl, {
    method: 'POST',
    headers: fetchHeaders,
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
  return parser(data);
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
  const isDeepSeek = /api\.deepseek\.com/i.test(Model.apiBase || '');
  const body = {
    model: isDeepSeek ? 'deepseek-chat' : (Model.model || 'deepseek-v4-pro'),
    max_tokens: 8,
    system: '只回复 OK。',
    messages: [{ role: 'user', content: 'OK' }],
  };
  return callModelText(body);
}
