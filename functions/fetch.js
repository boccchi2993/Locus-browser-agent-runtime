// Cloudflare Pages Function: GET /fetch?url=<https-url>
//
// Anonymous public-HTTPS resource relay for the browser `curl` command.
// Semantically SEPARATE from /proxy: /proxy is the model-API relay
// (POST, JSON, auth headers forwarded); /fetch fetches ordinary public
// internet resources (GET only, no credentials ever forwarded).
//
// Guardrails:
// - GET only (+ OPTIONS preflight)
// - HTTPS targets only (http:/file:/ftp:/data:/javascript: rejected)
// - no Cookie / Authorization / x-api-key forwarding — requests are
//   anonymous by construction
// - upstream timeout (FETCH_TIMEOUT_MS, default 30s) → 504; the timeout
//   covers the FULL lifecycle: request start → headers → body complete
// - response size cap (MAX_FETCH_RESPONSE_BYTES, default 16MB)
// - redirects followed up to MAX_FETCH_REDIRECTS (default 5), each hop
//   re-validated as HTTPS
// - Content-Type / Content-Length passed through; the final post-redirect
//   URL is exposed via X-Locus-Final-URL
// - the relay's own errors carry X-Locus-Relay-Error: 1 so the client can
//   distinguish relay failures from authoritative upstream HTTP responses

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Locus-Final-URL, X-Locus-Relay-Error',
  'Access-Control-Max-Age': '86400',
};

function getMaxResponseBytes(env) {
  const configured = Number.parseInt(env.MAX_FETCH_RESPONSE_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 16 * 1024 * 1024;
}

function getTimeoutMs(env) {
  const configured = Number.parseInt(env.FETCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getMaxRedirects(env) {
  const configured = Number.parseInt(env.MAX_FETCH_REDIRECTS || '', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5;
}

function relayError(status, message) {
  return Response.json(
    { error: { message } },
    { status, headers: { ...CORS_HEADERS, 'X-Locus-Relay-Error': '1' } },
  );
}

function parseTarget(rawTarget) {
  if (!rawTarget) return { error: relayError(400, 'Missing url query parameter') };
  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return { error: relayError(400, 'Invalid url query parameter') };
  }
  if (target.protocol !== 'https:') {
    return { error: relayError(403, 'Only HTTPS URLs are supported') };
  }
  return { target };
}

// Read a response body with a hard byte cap. The caller's AbortController
// governs the whole body lifetime: a mid-body stall aborted by the timer
// surfaces as `timedOut` (→ 504), never as a size-cap or generic error.
async function readResponseCapped(upstream, maxBytes, controller) {
  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: relayError(413, 'Upstream response too large') };
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
        return { error: relayError(413, 'Upstream response too large') };
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

// GET /fetch
export async function onRequestGet(context) {
  const req = context.request;
  const env = context.env || {};

  const pageUrl = new URL(req.url);
  const { target, error: targetError } = parseTarget(pageUrl.searchParams.get('url'));
  if (targetError) return targetError;

  const timeoutMs = getTimeoutMs(env);
  const maxBytes = getMaxResponseBytes(env);
  const maxRedirects = getMaxRedirects(env);

  // Anonymous by construction: only method and URL go upstream, never the
  // caller's Cookie / Authorization / x-api-key.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = target.href;
    let upstream = null;

    // Follow redirects manually, re-validating HTTPS on every hop.
    for (let hop = 0; hop <= maxRedirects; hop++) {
      try {
        upstream = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms');
        }
        return relayError(502, 'fetch: upstream request failed');
      }

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        if (!location) break; // redirect without Location: pass through as-is
        if (hop === maxRedirects) {
          return relayError(508, 'Too many redirects (max ' + maxRedirects + ')');
        }
        let next;
        try {
          next = new URL(location, current); // relative redirects resolve against the current hop
        } catch {
          return relayError(502, 'Upstream returned an invalid redirect Location');
        }
        if (next.protocol !== 'https:') {
          return relayError(403, 'Redirect target is not HTTPS');
        }
        current = next.href;
        upstream = null;
        continue;
      }
      break; // final, authoritative HTTP response
    }

    if (!upstream) return relayError(502, 'fetch: upstream request failed');

    const { bytes, error: bodyError, timedOut } = await readResponseCapped(upstream, maxBytes, controller);
    if (timedOut) return relayError(504, 'Upstream timed out after ' + timeoutMs + 'ms');
    if (bodyError) return bodyError;

    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    headers.set('Content-Length', String(bytes.byteLength));
    headers.set('X-Locus-Final-URL', current);
    return new Response(bytes, { status: upstream.status, headers });
  } finally {
    clearTimeout(timer);
  }
}

// OPTIONS /fetch (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
