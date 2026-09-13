// ============================================================
//  NETWORK RUNTIME
//  Thin browser-native network execution layer behind `curl`.
//  Routing is decided HERE, not by the model and not by the shell:
//
//    direct browser fetch
//        ↓ only on genuine network/CORS failure (TypeError)
//    same-origin edge relay (/fetch)
//
//  An HTTP response — even 404/500 — is an authoritative application
//  result and is NEVER re-sent through a different backend (same rule
//  as the model layer). Payloads are binary-safe: `bytes` is always a
//  Uint8Array, never a decoded string.
//
//  Resource semantics (aligned with the edge relay):
//  - anonymous by construction: credentials: 'omit', URL userinfo rejected
//  - every request has a client deadline covering headers AND body
//  - response bodies are stream-read with a hard byte cap
//  - timeouts / size-cap / user cancellation are NOT network failures:
//    they never trigger a relay retry of the same request
//  - redirects: the browser follows them and enforces CORS per hop;
//    cross-origin hops the page cannot read simply fail as network
//    errors (and may then go through the relay, which re-validates
//    HTTPS per hop). We do not claim per-hop visibility we do not have.
// ============================================================

// Ordinary download deadline (distinct from the model inference deadline).
const DIRECT_TIMEOUT_MS = 60000;
// Slightly longer than the relay's own 30s upstream timeout, so the
// relay's structured 504 arrives before the client gives up.
const RELAY_CLIENT_TIMEOUT_MS = 45000;
// Aligned with the relay's MAX_FETCH_RESPONSE_BYTES default.
const NETWORK_MAX_BYTES = 16 * 1024 * 1024;

const NetworkRuntime = {
  relayPath: '/fetch',

  // fetch(url, {signal, timeoutMs}) → {
  //   status, statusText, headers: {lowercase: value},
  //   bytes: Uint8Array, finalUrl, backend: 'browser-direct' | 'edge-relay'
  // }
  // Throws Error with a clear message when the request cannot complete.
  async fetch(url, options) {
    const opts = options || {};
    const parsed = parseHttpsUrl(url); // throws on non-HTTPS / userinfo

    try {
      return await this._direct(parsed.href, opts.signal, opts.timeoutMs || DIRECT_TIMEOUT_MS);
    } catch (e) {
      if (!isNetworkFailure(e)) throw e; // timeout/cap/cancel/HTTP-layer: no retry
      if (!isHostedPage()) {
        throw new Error(
          'network access blocked by the browser (CORS) and no edge relay is available ' +
          'when the page is opened from ' + pageProtocol() + ' — host the app over HTTP(S) to enable the relay');
      }
      return await this._relay(parsed.href, opts.signal);
    }
  },

  async _direct(url, externalSignal, timeoutMs) {
    const res = await fetchWithDeadline(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit', // anonymous by construction — never send cookies
    }, timeoutMs, externalSignal);
    const bytes = await readBytesCapped(res, NETWORK_MAX_BYTES);
    return {
      status: res.status,
      statusText: res.statusText || '',
      headers: headersToObject(res.headers),
      bytes,
      finalUrl: res.url || url,
      backend: 'browser-direct',
    };
  },

  async _relay(url, externalSignal) {
    let res;
    try {
      res = await fetchWithDeadline(this.relayPath + '?url=' + encodeURIComponent(url), {
        method: 'GET',
        credentials: 'omit',
      }, RELAY_CLIENT_TIMEOUT_MS, externalSignal);
    } catch (e) {
      if (isNetworkFailure(e)) {
        throw new Error('edge relay unreachable: ' + (e && e.message ? e.message : String(e)));
      }
      throw e; // timeout / cancellation: surfaced as-is, never retried
    }
    // The relay's OWN failures (bad URL, non-HTTPS target, timeout, size
    // cap, redirect cap) are marked with X-Locus-Relay-Error and carry a
    // JSON {error:{message}} body — surface the message, don't treat them
    // as upstream content.
    if (res.headers.get('x-locus-relay-error')) {
      let msg = 'edge relay error (HTTP ' + res.status + ')';
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (e) {}
      throw new Error('edge relay: ' + msg);
    }
    const bytes = await readBytesCapped(res, NETWORK_MAX_BYTES);
    return {
      status: res.status,
      statusText: res.statusText || '',
      headers: headersToObject(res.headers),
      bytes,
      finalUrl: res.headers.get('x-locus-final-url') || url,
      backend: 'edge-relay',
    };
  },
};

// fetch + deadline covering response headers, with optional external
// cancellation. Body reading is bounded separately by readBytesCapped
// under the same deadline semantics (callers read immediately after).
async function fetchWithDeadline(url, init, timeoutMs, externalSignal) {
  if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (e) {
    if (externalSignal && externalSignal.aborted) throw makeNetCancelledError();
    if (timedOut) throw makeNetTimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// Read a response body with a hard byte cap (streaming when possible, so
// oversized responses are cut off mid-stream instead of after a full
// unbounded read into memory).
async function readBytesCapped(res, maxBytes) {
  let contentLength = NaN;
  try {
    contentLength = Number.parseInt(res.headers && res.headers.get
      ? (res.headers.get('content-length') || '') : '', 10);
  } catch (e) { /* ignore */ }
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw makeNetTooLargeError(maxBytes);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw makeNetTooLargeError(maxBytes);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw makeNetTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e && e.tooLarge) throw e;
    if (e && (e.cancelled || e.name === 'AbortError')) throw makeNetCancelledError();
    if (e instanceof TypeError) throw e; // genuine mid-body network failure
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
  return merged;
}

function makeNetTimeoutError(timeoutMs) {
  const e = new Error('network request timed out after ' + timeoutMs + 'ms');
  e.name = 'NetworkTimeoutError';
  e.timeout = true;
  return e;
}

function makeNetTooLargeError(maxBytes) {
  const e = new Error('response too large (limit ' + maxBytes + ' bytes)');
  e.name = 'NetworkTooLargeError';
  e.tooLarge = true;
  return e;
}

function makeNetCancelledError() {
  const e = new Error('network request cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

// Only HTTPS URLs are accepted; credentials embedded in the URL
// (https://user:pass@host/…) are rejected — requests must be anonymous.
// Returns a URL or throws.
function parseHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (e) {
    throw new Error('invalid URL: ' + url);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('only HTTPS URLs are supported');
  }
  if (parsed.username || parsed.password) {
    throw new Error('credentials in URLs are not allowed (anonymous requests only)');
  }
  return parsed;
}

// Genuine network/CORS failures reject fetch() with a TypeError in every
// browser. HTTP error statuses resolve normally and never reach here;
// our own timeout/cap/cancellation errors carry explicit markers and are
// deliberately NOT TypeErrors, so they can never be misread as CORS.
function isNetworkFailure(e) {
  return e instanceof TypeError;
}

function pageProtocol() {
  try {
    return (typeof window !== 'undefined' && window.location && window.location.protocol) || '';
  } catch (e) {
    return '';
  }
}

function isHostedPage() {
  const p = pageProtocol();
  return p === 'http:' || p === 'https:';
}

function headersToObject(headers) {
  const out = {};
  try {
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } catch (e) {}
  return out;
}
