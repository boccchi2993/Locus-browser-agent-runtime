// ============================================================
//  MODEL LAYER
//  Adapted from Whoami_Cli_game: LLM API client supporting two API
//  dialects (Anthropic-compatible and OpenAI-compatible) over any
//  HTTPS endpoint, plus an optional CORS proxy.
//
//  Core distinction: provider identity ≠ API dialect. Dialect is
//  detected from the endpoint shape, never from a provider name list.
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

// API dialect is determined by the endpoint form:
// - api.anthropic.com            → anthropic
// - any base ending in /anthropic → anthropic (e.g. api.deepseek.com/anthropic)
// - everything else               → openai
function detectDialect(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (/api\.anthropic\.com/i.test(base) || /\/anthropic$/i.test(base)) {
    return 'anthropic';
  }
  return 'openai';
}

function isOfficialAnthropic(apiBase) {
  return /api\.anthropic\.com/i.test(String(apiBase || ''));
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
  // content is a block array; only visible text blocks count.
  // thinking / reasoning / tool-use / unknown blocks are ignored —
  // internal reasoning must never reach the agent loop or history.
  if (Array.isArray(data.content)) {
    const text = data.content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text) return text;

    if (data.stop_reason === 'max_tokens') {
      throw new Error('响应中没有可见文本内容（可能在生成最终回答前达到 token 上限）');
    }
    throw new Error('响应中没有可见文本内容');
  }

  if (typeof data.content === 'string' && data.content) {
    return data.content;
  }

  if (data.error) {
    throw new Error(data.error.message || data.error.type || JSON.stringify(data.error));
  }
  throw new Error('响应中没有可见文本内容');
}

function parseOpenAIResp(data) {
  if (data.choices && data.choices[0]) {
    const msg = data.choices[0].message || data.choices[0].delta || {};
    if (msg.content) return msg.content;
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  throw new Error('响应格式不符合预期');
}

// HTTP errors carry .status so fallback policy never parses strings.
function makeHttpError(status, message) {
  const err = new Error(message || ('HTTP ' + status));
  err.status = status;
  return err;
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
    throw makeHttpError(res.status, msg);
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

// Auth/quota/permission/rate-limit answers are authoritative: switching
// dialect or endpoint path can never fix them. Stop immediately.
const AUTHORITATIVE_STATUS = [401, 402, 403, 429];

// Only these plausibly mean "wrong endpoint path / dialect mismatch"
// and justify trying the next compatible endpoint.
const FALLBACK_STATUS = [404, 405];

function isAuthoritativeError(e) {
  return e && AUTHORITATIVE_STATUS.indexOf(e.status) !== -1;
}

function isFallbackableError(e) {
  // Network/CORS failures (no status), non-JSON responses, and 404/405.
  return !e || e.status === undefined || FALLBACK_STATUS.indexOf(e.status) !== -1;
}

async function callModelText(body) {
  const key = sanitizeKey(Model.apiKey);
  const dialect = detectDialect(Model.apiBase);

  let attempts;
  if (dialect === 'anthropic') {
    // Anthropic-compatible: x-api-key + anthropic-version.
    // anthropic-dangerous-direct-browser-access is only for the official
    // API's direct browser access; third-party compatible endpoints are
    // not required to recognize it.
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    };
    if (isOfficialAnthropic(Model.apiBase)) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    attempts = [
      { url: anthropicUrl(), h: headers, b: body, p: parseAnthropicResp },
    ];
  } else {
    // OpenAI-compatible: Bearer auth, tolerate both endpoint layouts.
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    const oaiBody = toOpenAIBody(body);
    attempts = [
      { url: openaiUrl(), h: headers, b: oaiBody, p: parseOpenAIResp },
      { url: openaiUrlV1(), h: headers, b: oaiBody, p: parseOpenAIResp },
    ];
  }

  let firstErr = null;
  for (const attempt of attempts) {
    try {
      return await tryFetch(attempt.url, attempt.h, attempt.b, attempt.p);
    } catch (e) {
      if (isAuthoritativeError(e)) throw e;       // 401/402/403/429: stop now
      if (!isFallbackableError(e)) throw e;       // 400/422/5xx etc: don't retry blindly
      if (!firstErr) firstErr = e;                // keep the most relevant error
    }
  }
  throw firstErr || new Error('连接失败');
}

async function verifyConnection() {
  // Always test the model the user actually configured — never silently
  // substitute a different model for the connection check.
  const body = {
    model: Model.model || 'deepseek-v4-pro',
    // 128: reasoning models may spend tokens on internal thinking before
    // emitting the visible text block; 8 was too small to ever see one.
    max_tokens: 128,
    system: '只回复 OK。',
    messages: [{ role: 'user', content: 'OK' }],
  };
  return callModelText(body);
}
