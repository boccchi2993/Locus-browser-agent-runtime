// Cloudflare Pages Function: /fetch
//
// Anonymous public-HTTP(S) resource relay for NetworkRuntime v1
// (docs/NETWORK-RUNTIME.md). Semantically SEPARATE from /proxy: /proxy is
// the model-API relay (POST, JSON, auth headers forwarded); /fetch fetches
// ordinary public internet resources on behalf of the browser.
//
// Two request forms — one endpoint, no second proxy:
// - GET /fetch?url=<encoded>   legacy GET-only form (kept for compatibility)
// - POST /fetch                JSON envelope { method, url, headers,
//                              bodyBase64 } used by NetworkRuntime for
//                              header-bearing GET/HEAD and all
//                              side-effecting methods
//
// Guardrails:
// - methods: GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS only
//   (TRACE/CONNECT/custom → 405)
// - http/https targets only (file:/ftp:/data:/javascript:/ws: rejected);
//   URL userinfo rejected
// - private/loopback/link-local targets refused (SSRF): localhost,
//   127.0.0.0/8, ::1, 0.0.0.0/8, 169.254.0.0/16 (incl. metadata IPs),
//   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10
//   (incl. IPv4-mapped). Hostname-string validation only — a public name
//   that RESOLVES private is a documented limitation
//   (docs/NETWORK-RUNTIME.md).
// - no implicit credentials ever: the caller's own Cookie/Authorization
//   headers are never forwarded; envelope headers pass the same
//   forbidden-header filter as the client (Cookie/Sec-*/Proxy-*/hop-by-hop
//   dropped; a model-provided Authorization IS forwarded — the upstream
//   response's Set-Cookie is stripped, the relay never writes any cookie
//   jar)
// - upstream timeout (FETCH_TIMEOUT_MS, default 30s) → 504; it covers the
//   FULL lifecycle: request start → headers → body complete
// - request body cap (MAX_FETCH_REQUEST_BYTES, default 2MB) → 413
// - response size cap (MAX_FETCH_RESPONSE_BYTES, default 16MB) → 413
// - redirects followed up to MAX_FETCH_REDIRECTS (default 5), every hop
//   re-validated for scheme and private addresses: read-like requests
//   follow any origin; side-effecting requests follow SAME-ORIGIN hops
//   only (307/308 re-send method+body, 301/302/303 downgrade to a
//   body-less GET — the side effect is never replayed elsewhere) and a
//   cross-origin hop is refused
// - the final post-redirect URL is exposed via X-Locus-Final-URL
// - the relay's own errors carry X-Locus-Relay-Error: 1 and a JSON
//   {error:{code, message}} body so the client can distinguish relay
//   failures from authoritative upstream HTTP responses
// - responses are de-privileged for direct rendering: X-Content-Type-Options:
//   nosniff on every response, plus Content-Security-Policy: sandbox on
//   active content types
// - POST envelope: a present Origin header must match the deployment
//   origin (blocks other web pages from driving the relay; not an auth
//   system for non-browser clients — docs/NETWORK-RUNTIME.md, "Relay
//   openness")

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Locus-Final-URL, X-Locus-Relay-Error',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
};

// MIME main types (parameters stripped, lowercased) that a browser would
// execute or render as active content when navigated to directly.
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]);

// Statuses that must carry a null body; the Response constructor throws a
// TypeError if constructed with a body for any of these.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const RELAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// Mirror of src/network.js FORBIDDEN_HEADERS / prefixes (defense in
// depth: the client filters, the relay re-filters).
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'keep-alive', 'expect', 'via', 'date',
  'cookie', 'cookie2', 'dnt', 'origin', 'referer',
  'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
]);
const FORBIDDEN_HEADER_PREFIXES = ['proxy-', 'sec-'];

// Upstream response headers never copied onto the client-facing response:
// hop-by-hop machinery, the ambient-credential channel, and the recomputed
// length.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'proxy-connection', 'set-cookie', 'content-length',
]);
const STRIPPED_RESPONSE_HEADER_PREFIXES = ['proxy-', 'sec-'];

function getMaxResponseBytes(env) {
  const configured = Number.parseInt(env.MAX_FETCH_RESPONSE_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 16 * 1024 * 1024;
}

function getMaxRequestBytes(env) {
  const configured = Number.parseInt(env.MAX_FETCH_REQUEST_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 2 * 1024 * 1024;
}

function getTimeoutMs(env) {
  const configured = Number.parseInt(env.FETCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getMaxRedirects(env) {
  const configured = Number.parseInt(env.MAX_FETCH_REDIRECTS || '', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

function relayError(status, message, code) {
  return Response.json(
    { error: { code: code || 'network_relay_failed', message } },
    { status, headers: { ...CORS_HEADERS, 'X-Locus-Relay-Error': '1' } },
  );
}

function parseTarget(rawTarget) {
  if (!rawTarget) return { error: relayError(400, 'Missing url parameter', 'network_invalid_url') };
  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return { error: relayError(400, 'Invalid url parameter', 'network_invalid_url') };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { error: relayError(403, 'Only HTTP(S) URLs are supported', 'network_unsupported_scheme') };
  }
  if (target.username || target.password) {
    return { error: relayError(403, 'Credentials in URLs are not allowed', 'network_invalid_url') };
  }
  if (isPrivateHostname(target.hostname)) {
    return { error: relayError(403, 'Private and loopback targets are not allowed', 'network_private_address_blocked') };
  }
  return { target };
}

// Hostname-string SSRF validation. Literal IPs arrive WHATWG-canonicalized
// (the URL parser reduced decimal/octal/hex IPv4 spellings), so obfuscated
// literals do not slip through. See the header comment for the documented
// DNS-rebinding limitation.
function isPrivateHostname(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 literal
  if (h.endsWith('.')) h = h.slice(0, -1); // FQDN trailing dot
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('::ffff:')) h = h.slice(7); // IPv4-mapped IPv6
  const v4 = h.split('.');
  if (v4.length === 4 && v4.every((p) => /^\d+$/.test(p) && Number(p) <= 255)) {
    const [a, b] = v4.map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (h.includes(':')) {
    const first = h.split(':')[0] || '0';
    const n = parseInt(first, 16);
    if (Number.isFinite(n)) {
      if ((n & 0xfe00) === 0xfc00) return true; // fc00-feff: unique local
      if ((n & 0xffc0) === 0xfe80) return true; // fe80-febf: link local
    }
  }
  return false;
}

// Envelope header filter — mirrors the client-side policy exactly.
function filterForwardHeaders(rawHeaders) {
  const out = {};
  for (const key of Object.keys(rawHeaders || {})) {
    const name = String(key).trim().toLowerCase();
    if (!name) continue;
    if (FORBIDDEN_HEADERS.has(name)
      || FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    const value = String(rawHeaders[key]);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      return { error: relayError(400, 'Invalid header value (control characters)', 'network_invalid_header') };
    }
    out[name] = value;
  }
  return { headers: out };
}

// Execute the upstream request with manual redirect handling: every hop
// is re-validated for scheme and private addresses. Read-like requests
// follow redirects to any origin; side-effecting requests follow
// same-origin hops only (307/308 keep method+body; 301/302/303 downgrade
// to a body-less GET — the side effect is never replayed against another
// origin) and a cross-origin hop is refused. `controller` is owned by the
// caller and governs fetch AND the body-read lifecycle.
async function executeUpstream({ method, target, headers, body, maxRedirects, sideEffecting, controller }) {
  let current = target.href;
  let currentMethod = method;
  let currentBody = body;
  let upstream = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      upstream = await fetch(current, {
        method: currentMethod,
        headers: headers,
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        return { error: relayError(504, 'Upstream timed out after ' + (controller._locusTimeoutMs || 30000) + 'ms', 'network_timeout') };
      }
      return { error: relayError(502, 'fetch: upstream request failed') };
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (!location) break; // redirect without Location: pass through as-is
      if (hop === maxRedirects) {
        return { error: relayError(508, 'Too many redirects (max ' + maxRedirects + ')', 'network_redirect_blocked') };
      }
      let next;
      try {
        next = new URL(location, current); // relative redirects resolve against the current hop
      } catch {
        return { error: relayError(502, 'Upstream returned an invalid redirect Location') };
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        return { error: relayError(403, 'Redirect target is not HTTP(S)', 'network_unsupported_scheme') };
      }
      if (isPrivateHostname(next.hostname)) {
        return { error: relayError(403, 'Private and loopback redirect targets are not allowed', 'network_private_address_blocked') };
      }
      if (sideEffecting && next.origin !== new URL(current).origin) {
        return { error: relayError(403, 'Cross-origin redirect blocked for side-effecting requests', 'network_redirect_blocked') };
      }
      if (sideEffecting && currentMethod !== 'GET' && currentMethod !== 'HEAD'
        && (upstream.status === 301 || upstream.status === 302 || upstream.status === 303)) {
        currentMethod = 'GET'; // method downgrade: the side effect is NOT replayed
        currentBody = undefined;
      }
      current = next.href;
      upstream = null;
      continue;
    }
    break; // final, authoritative HTTP response
  }

  if (!upstream) return { error: relayError(502, 'fetch: upstream request failed') };
  return { upstream, finalUrl: current };
}

// Read an upstream response body with a hard byte cap. The caller's
// AbortController governs the whole body lifetime: a mid-body stall
// aborted by the timer surfaces as `timedOut` (→ 504), never as a
// size-cap or generic error.
async function readResponseCapped(upstream, maxBytes, controller) {
  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: relayError(413, 'Upstream response too large', 'network_response_too_large') };
  }

  if (!upstream.body) {
    return { bytes: new Uint8Array(await upstream.arrayBuffer()) };
  }

  const reader = upstream.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: relayError(413, 'Upstream response too large', 'network_response_too_large') };
      }
      chunks.push(value);
    }
  } catch (e) {
    if (controller && controller.signal.aborted) return { timedOut: true };
    throw e;
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged };
}

// Frame the authoritative upstream response for the client: filtered
// headers, byte-exact body, final-URL exposure, de-privileged rendering.
async function buildUpstreamResponse(upstream, finalUrl, maxBytes, controller, timeoutMs) {
  let bytes, bodyError, timedOut;
  try {
    ({ bytes, error: bodyError, timedOut } = await readResponseCapped(upstream, maxBytes, controller));
  } catch (e) {
    if (controller.signal.aborted) {
      return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms', 'network_timeout');
    }
    return relayError(502, 'Upstream body read failed');
  }
  if (timedOut) return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms', 'network_timeout');
  if (bodyError) return bodyError;

  const headers = new Headers(CORS_HEADERS);
  headers.set('X-Locus-Final-URL', finalUrl);
  // Pass the upstream's own headers through (minus hop-by-hop machinery,
  // the ambient-credential channel and the recomputed length) so the
  // client sees ordinary HTTP response headers.
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(n)
      || STRIPPED_RESPONSE_HEADER_PREFIXES.some((p) => n.startsWith(p))) {
      return;
    }
    headers.set(name, value);
  });
  if (NULL_BODY_STATUSES.has(upstream.status)) {
    return new Response(null, { status: upstream.status, headers });
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (ACTIVE_CONTENT_TYPES.has(mime)) {
    headers.set('Content-Security-Policy', 'sandbox');
  }
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(bytes, { status: upstream.status, headers });
}

// Shared pipeline for both request forms. One AbortController governs the
// whole lifecycle: fetch start → headers → body complete.
async function handleRelayRequest({ method, target, headers, body, env }) {
  const timeoutMs = getTimeoutMs(env);
  const maxBytes = getMaxResponseBytes(env);
  const maxRedirects = getMaxRedirects(env);
  const sideEffecting = method !== 'GET' && method !== 'HEAD';

  const controller = new AbortController();
  controller._locusTimeoutMs = timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const executed = await executeUpstream({
      method, target, headers, body, maxRedirects, sideEffecting, controller,
    });
    if (executed.error) return executed.error;
    return await buildUpstreamResponse(executed.upstream, executed.finalUrl, maxBytes, controller, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

// Read a request body with a hard byte cap (Content-Length is checked
// first; a chunked body is bounded by the stream loop).
async function readRequestCapped(request, maxBytes) {
  const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: relayError(413, 'Relay request body too large', 'network_request_too_large') };
  }
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: relayError(413, 'Relay request body too large', 'network_request_too_large') };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged };
}

function decodeBase64(b64) {
  try {
    const bin = atob(String(b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
//  GET /fetch (legacy form: GET-only, no header/body channel)
// ------------------------------------------------------------
export async function onRequestGet(context) {
  const req = context.request;
  const env = context.env || {};

  const pageUrl = new URL(req.url);
  const { target, error: targetError } = parseTarget(pageUrl.searchParams.get('url'));
  if (targetError) return targetError;

  return await handleRelayRequest({ method: 'GET', target, headers: undefined, body: undefined, env });
}

// ------------------------------------------------------------
//  POST /fetch (NetworkRuntime v1 envelope)
// ------------------------------------------------------------
export async function onRequestPost(context) {
  const req = context.request;
  const env = context.env || {};

  // Same-origin enforcement for the envelope form: a present Origin must
  // match the deployment (browser callers always send it on POST; other
  // web pages cannot forge it). Non-browser clients sending no Origin are
  // the documented, bounded openness of this relay.
  const origin = req.headers.get('origin');
  if (origin) {
    let deploymentOrigin = null;
    try {
      deploymentOrigin = new URL(req.url).origin;
    } catch { /* request URL is always absolute in Pages */ }
    if (deploymentOrigin && origin !== deploymentOrigin) {
      return relayError(403, 'Cross-origin relay use is not allowed', 'network_relay_failed');
    }
  }

  const maxRequestBytes = getMaxRequestBytes(env);
  let raw;
  {
    const { bytes, error } = await readRequestCapped(req, maxRequestBytes);
    if (error) return error;
    raw = new TextDecoder().decode(bytes);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return relayError(400, 'Invalid JSON envelope', 'network_invalid_url');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return relayError(400, 'Invalid JSON envelope', 'network_invalid_url');
  }

  const method = String(envelope.method || '').trim().toUpperCase();
  if (!RELAY_METHODS.has(method)) {
    return relayError(405, 'Unsupported relay method: ' + (method || '(empty)'), 'network_unsupported_method');
  }

  const { target, error: targetError } = parseTarget(envelope.url);
  if (targetError) return targetError;

  const { headers, error: headerError } = filterForwardHeaders(envelope.headers);
  if (headerError) return headerError;

  let body;
  if (envelope.bodyBase64 != null) {
    if (method === 'GET' || method === 'HEAD') {
      return relayError(400, 'GET/HEAD requests cannot carry a body', 'network_invalid_url');
    }
    body = decodeBase64(envelope.bodyBase64);
    if (!body) return relayError(400, 'Invalid base64 body', 'network_invalid_url');
    if (body.byteLength > maxRequestBytes) {
      return relayError(413, 'Relay request body too large', 'network_request_too_large');
    }
  }

  return await handleRelayRequest({ method, target, headers, body, env });
}

// OPTIONS /fetch (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
