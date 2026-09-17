// ============================================================
//  MODEL LAYER
//  Adapted from Whoami_Cli_game: LLM API client over any HTTPS
//  endpoint, plus an optional CORS proxy.
//
//  Architecture (docs/MODEL-PROTOCOL.md):
//
//    AgentSession → callModel() → ProviderAdapter → transport
//
//  This file is the provider-neutral ModelClient: adapter selection,
//  transport (direct fetch + /proxy relay fallback), deadlines, size
//  caps and the error taxonomy. ALL provider-specific semantics —
//  endpoint shape, auth headers, request serialization, response
//  parsing, replay state — live in src/model-adapters.js behind the
//  ProviderAdapter interface. Provider identity ≠ API dialect: the
//  dialect is configured explicitly (auto/openai/anthropic), never
//  derived from a provider name list.
//
//  The response is a structured envelope:
//    { content, reasoning, reasoningType, toolCalls, rawMessage,
//      stopReason, usage, providerMetadata, truncated }
//  visible text is NOT the complete conversation state — rawMessage is
//  the provider-native assistant message used for replay.
//
//  Error taxonomy (fallback policy keys off these, never strings):
//    TypeError            — genuine network/CORS transport failure
//    HttpError (.status)  — authoritative HTTP answer from provider/relay
//    ParseError           — HTTP 200 but unusable body (never re-requested:
//                           the inference already happened and was billed)
//    TimeoutError         — client deadline hit (never blindly re-requested)
//    AbortError           — caller cancelled
// ============================================================
const Model = {
  apiKey: '',
  apiBase: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  proxy: '',
  dialect: 'auto', // auto | openai | anthropic — see getProviderAdapter()
  // Test/integration seam. Production leaves this null and uses fetch;
  // callers still pass through the real adapter, serializer and header
  // builder before the transport is invoked.
  transport: null,
};

// Model inference deadline: covers request start → headers → full body.
// Deliberately longer than ordinary download deadlines — reasoning models
// can legitimately think for over a minute.
const MODEL_TIMEOUT_MS = 180000;
const MODEL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function sanitizeKey(k) {
  return String(k || '').replace(/[^\x20-\x7E]/g, '').trim();
}

// ---------- error types ----------
// HTTP errors carry .status so fallback policy never parses strings.
// providerError keeps the minimal STRUCTURED provider error metadata
// (type/code/param — never headers, bodies or secrets) so adapters can
// classify request-validation rejections (e.g. tools unsupported).
function makeHttpError(status, message, providerError) {
  const err = new Error(message || ('HTTP ' + status));
  err.name = 'HttpError';
  err.status = status;
  if (providerError) err.providerError = providerError;
  return err;
}

// The response HEADERS already arrived but consuming the BODY failed
// (connection reset mid-stream, truncated transfer, …). The inference may
// already be running or billed — this is NOT a transport/CORS failure and
// must never trigger an automatic re-send to another endpoint.
function makeBodyReadError(status, cause) {
  const err = new Error('response body read failed after HTTP ' + status +
    ': ' + (cause && cause.message ? cause.message : String(cause)));
  err.name = 'BodyReadError';
  err.status = status;
  err.cause = cause;
  err.noFallback = true;
  return err;
}

// HTTP 200 but the body cannot be used (not JSON, wrong shape, empty
// visible content). The inference DID happen — re-sending the request to
// another endpoint would bill a second generation for the same prompt.
function makeParseError(message) {
  const err = new Error(message);
  err.name = 'ParseError';
  err.noFallback = true;
  return err;
}

function makeTimeoutError(message) {
  const err = new Error(message);
  err.name = 'TimeoutError';
  err.timeout = true;
  err.noFallback = true;
  return err;
}

function makeModelCancelledError() {
  const err = new Error('model request cancelled');
  err.name = 'AbortError';
  err.cancelled = true;
  return err;
}

// ---------- transport ----------
// Read a response body as text with a hard byte cap and deadline
// enforcement shared with the caller's AbortController.
function headerValue(res, name) {
  try {
    return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  } catch (e) {
    return null;
  }
}

async function readTextCapped(res, maxBytes, signal) {
  const contentLength = Number.parseInt(headerValue(res, 'content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw makeParseError('response too large (>' + maxBytes + ' bytes)');
  }
  if (!res.body || !res.body.getReader) {
    const text = await raceSignal(res.text(), signal);
    if (text.length > maxBytes) throw makeParseError('response too large (>' + maxBytes + ' bytes)');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await raceSignal(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        cancelReaderQuietly(reader);
        throw makeParseError('response too large (>' + maxBytes + ' bytes)');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e && (e.cancelled || e.name === 'AbortError')) {
      cancelReaderQuietly(reader);
    }
    throw e;
  } finally {
    try { reader.releaseLock(); } catch (e) { /* already released */ }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(merged);
}

// Best-effort stream cleanup on the way out (timeout / cancel / size
// cap). NEVER awaited: the underlying source's cancel() may return a
// promise that never settles (a stalled stream need not react to
// cancellation), and awaiting it would block the caller's exit path
// indefinitely — after the race was already lost. The rejection handler
// is attached immediately so a failed cleanup never surfaces as an
// unhandled rejection.
function cancelReaderQuietly(reader) {
  try {
    const p = reader.cancel();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* synchronous cancel failure: ignore */ }
}

// Race a promise against the deadline/cancellation signal so a stalled
// body loses the race even if the underlying stream never reacts to abort.
function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeModelCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeModelCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

// One POST with full-lifecycle deadline (headers AND body), optional
// external cancellation, and a response size cap.
async function fetchJsonPost(fetchUrl, headers, body, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || MODEL_TIMEOUT_MS;
  const external = o.signal || null;
  if (external && external.aborted) throw makeModelCancelledError();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) external.addEventListener('abort', onExternalAbort, { once: true });

  let res;
  try {
    try {
      const transport = o.transport || Model.transport || fetch;
      res = await transport(fetchUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (external && external.aborted) throw makeModelCancelledError();
      if (timedOut) throw makeTimeoutError('model request timed out after ' + timeoutMs + 'ms (waiting for response headers)');
      throw e; // genuine network/CORS TypeError
    }

    let text;
    try {
      text = await readTextCapped(res, MODEL_MAX_RESPONSE_BYTES, controller.signal);
    } catch (e) {
      // Classify by failure PHASE: headers already arrived, so a failure
      // here is a body-read failure — never a CORS/transport candidate.
      if (external && external.aborted) throw makeModelCancelledError();
      if (timedOut) throw makeTimeoutError('model request timed out after ' + timeoutMs + 'ms (response body incomplete)');
      if (e && e.noFallback) throw e; // size-cap ParseError etc.
      if (e && (e.cancelled || e.name === 'AbortError')) throw makeModelCancelledError();
      throw makeBodyReadError(res.status, e);
    }

    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* handled below */ }
    if (!res.ok) {
      const msg = data && data.error ? (data.error.message || data.error.type) : ('HTTP ' + res.status);
      let providerError = null;
      if (data && data.error && typeof data.error === 'object') {
        for (const k of ['type', 'code', 'param']) {
          if (data.error[k] !== undefined && data.error[k] !== null) {
            if (!providerError) providerError = {};
            providerError[k] = data.error[k];
          }
        }
      }
      const err = makeHttpError(res.status, msg, providerError);
      // A relay that answered proves it exists (see tryFetch fallback policy).
      if (headerValue(res, 'x-locus-relay')) err.relaySeen = true;
      throw err;
    }
    if (!data) throw makeParseError('响应不是 JSON');
    return data;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

// fetch() rejects with TypeError only on genuine network/CORS failures.
// HTTP 4xx/5xx are authoritative provider answers and must NOT be
// re-sent to another backend.
function isNetworkError(e) {
  return e instanceof TypeError;
}

async function tryFetch(url, headers, body, parser, opts) {
  // 1. Explicit proxy configured → always use it.
  if (Model.proxy) {
    const proxy = Model.proxy.replace(/\/+$/, '');
    const data = await fetchJsonPost(proxy, Object.assign({}, headers, { 'X-Target-URL': url }), body, opts);
    return parser(data);
  }

  // 2. Direct fetch first.
  try {
    const data = await fetchJsonPost(url, headers, body, opts);
    return parser(data);
  } catch (e) {
    // 3. Only on genuine network/CORS failure, and only when hosted
    //    (non-file://), try the same-origin /proxy relay. Parse errors,
    //    timeouts, HTTP statuses and cancellations are NEVER relayed.
    if (!isNetworkError(e) || window.location.protocol === 'file:') throw e;
    const directError = e;
    try {
      const data = await fetchJsonPost('/proxy', Object.assign({}, headers, { 'X-Target-URL': url }), body, opts);
      return parser(data);
    } catch (e2) {
      // 4. The relay answered → its HTTP/parse error is the AUTHORITATIVE
      //    result of the request (401/402/429/5xx/quota/…). Never mask it
      //    with the original CORS error and never trigger further retries.
      //    Only when the relay itself is missing/unreachable (network
      //    failure, or a 404 from a deployment without the function) is
      //    the original direct error the more honest thing to show.
      if (isNetworkError(e2) || (e2 && e2.status === 404 && !e2.relaySeen)) {
        throw directError;
      }
      throw e2;
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
  if (!e) return true;
  // Parse errors, timeouts, cancellations: the request already reached a
  // working endpoint — trying another one cannot help and may double-bill.
  if (e.noFallback || e.timeout || e.cancelled || e.name === 'AbortError') return false;
  // Network/CORS failures (no status), and 404/405.
  return e.status === undefined || FALLBACK_STATUS.indexOf(e.status) !== -1;
}

// Structured model call. opts.signal cancels the request.
// The adapter (selected from Model.dialect + Model.apiBase) owns every
// provider-specific decision: endpoint URLs, auth headers, request
// serialization and response parsing. This function only orchestrates
// transport attempts and the fallback/error lifecycle.
// Returns the response envelope { content, reasoning, reasoningType,
// toolCalls, rawMessage, stopReason, usage, providerMetadata, truncated }.
async function runEndpointAttempts(adapter, headers, requestBody, opts) {
  const attempts = adapter.buildEndpoints(Model.apiBase).map((url) => ({
    url: url, h: headers, b: requestBody, p: adapter.parseResponse,
  }));
  let firstErr = null;
  for (const attempt of attempts) {
    try {
      return await tryFetch(attempt.url, attempt.h, attempt.b, attempt.p, opts);
    } catch (e) {
      if (isAuthoritativeError(e)) throw e;       // 401/402/403/429: stop now
      if (!isFallbackableError(e)) throw e;       // HTTP errors, parse errors, timeouts, cancellations
      if (!firstErr) firstErr = e;                // keep the most relevant error
    }
  }
  throw firstErr || new Error('连接失败');
}

async function callModel(body, opts) {
  const key = sanitizeKey(Model.apiKey);
  const adapter = getProviderAdapter({ dialect: Model.dialect, apiBase: Model.apiBase });
  const headers = adapter.buildHeaders({ apiKey: key, apiBase: Model.apiBase });

  try {
    return await runEndpointAttempts(adapter, headers, adapter.serializeRequest(body), opts);
  } catch (e) {
    // One-time tools downgrade: only when the adapter classifies the
    // error as an EXPLICIT request-validation rejection of the tools
    // payload (HTTP 400/422 naming tools/tool_choice/function schema).
    // Parse errors, timeouts, body-read failures, 401/402/403/429/5xx
    // and cancellations NEVER re-send — the inference may already have
    // happened and been billed. At most ONE downgrade per request.
    if (body && Array.isArray(body.tools) && body.tools.length &&
        typeof adapter.isToolingUnsupportedError === 'function' &&
        adapter.isToolingUnsupportedError(e)) {
      const reduced = Object.assign({}, body);
      delete reduced.tools;
      return await runEndpointAttempts(adapter, headers, adapter.serializeRequest(reduced), opts);
    }
    throw e;
  }
}

// Compatibility wrapper for callers that only need visible text
// (e.g. verifyConnection).
async function callModelText(body, opts) {
  const envelope = await callModel(body, opts);
  return envelope.content;
}

async function verifyConnection() {
  // Always test the model the user actually configured — never silently
  // substitute a different model for the connection check.
  const body = {
    model: Model.model || 'deepseek-flash',
    // 128: reasoning models may spend tokens on internal thinking before
    // emitting the visible text block; 8 was too small to ever see one.
    max_tokens: 128,
    system: '只回复 OK。',
    messages: [{ role: 'user', content: 'OK' }],
  };
  return callModelText(body);
}
