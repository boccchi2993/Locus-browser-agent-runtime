// Cloudflare Pages Function: POST /proxy
//
// Intentionally provider-agnostic HTTPS API relay for demo/development:
// it forwards to any HTTPS endpoint so Locus works with OpenAI-compatible,
// Anthropic-compatible, self-hosted and enterprise model gateways.
// NOT a production multi-tenant proxy (no rate limiting / access policy).
//
// Guardrails (chosen to not break provider compatibility):
// - POST only (+ OPTIONS preflight)
// - HTTPS upstream only
// - request body size limit (MAX_PROXY_BODY_BYTES), pre-checked via
//   Content-Length and enforced by stream counting otherwise
// - inbound read deadline (PROXY_INBOUND_TIMEOUT_MS, default 30s) → 408
// - upstream timeout (PROXY_TIMEOUT_MS, default 30s) → 504
// - redirects are NOT followed (redirect: 'manual') → 502
// - response size limit (MAX_PROXY_RESPONSE_BYTES, default 8MB), enforced
//   via Content-Length when present and by stream counting otherwise
// - only auth-related headers are forwarded; credentials and bodies are
//   never logged or echoed in error messages
// - every response carries X-Locus-Relay: 1 so the client can distinguish an
//   authoritative relay answer from a missing function (platform 404)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Locus-Relay',
  'Access-Control-Max-Age': '86400',
};

const FORWARDED_HEADERS = ['authorization', 'x-api-key', 'anthropic-version'];

// Statuses that must carry a null body; the Response constructor throws a
// TypeError if constructed with a body for any of these.
const NULL_BODY_STATUSES = new Set([204, 205]);

function getMaxBodyBytes(env) {
  const configured = Number.parseInt(env.MAX_PROXY_BODY_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1024 * 1024;
}

function getMaxResponseBytes(env) {
  const configured = Number.parseInt(env.MAX_PROXY_RESPONSE_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 8 * 1024 * 1024;
}

function getTimeoutMs(env) {
  const configured = Number.parseInt(env.PROXY_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function getInboundTimeoutMs(env) {
  const configured = Number.parseInt(env.PROXY_INBOUND_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 30000;
}

function json(status, payload) {
  return Response.json(payload, { status, headers: { ...CORS_HEADERS, 'X-Locus-Relay': '1' } });
}

function parseTarget(rawTarget) {
  if (!rawTarget) {
    return { error: json(400, { error: { message: 'Missing X-Target-URL header' } }) };
  }

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return { error: json(400, { error: { message: 'Invalid X-Target-URL header' } }) };
  }

  if (target.protocol !== 'https:') {
    return { error: json(403, { error: { message: 'Target URL must use HTTPS' } }) };
  }

  return { target };
}

// Read the inbound request body under a byte cap and a deadline. An
// over-limit Content-Length is rejected without touching the body; chunked
// bodies are counted per chunk and cancelled on overflow. A stalled client
// body surfaces as 408. AbortController cannot cancel a req.body read, so
// the deadline is a Promise.race followed by an explicit reader cancel.
async function readBody(req, maxBodyBytes, inboundTimeoutMs) {
  const contentLength = Number.parseInt(req.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return { error: json(413, { error: { message: 'Request body too large' } }) };
  }

  const timeoutError = new Error('inbound-timeout');
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), inboundTimeoutMs);
  });

  try {
    if (!req.body) {
      const body = await Promise.race([req.text(), deadline]);
      if (new TextEncoder().encode(body).length > maxBodyBytes) {
        return { error: json(413, { error: { message: 'Request body too large' } }) };
      }
      return { body };
    }

    const reader = req.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        received += value.byteLength;
        if (received > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          return { error: json(413, { error: { message: 'Request body too large' } }) };
        }
        chunks.push(value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
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
    return { body: new TextDecoder().decode(merged) };
  } catch (e) {
    if (e === timeoutError) {
      return { error: json(408, { error: { message: 'Client body read timed out after ' + inboundTimeoutMs + 'ms' } }) };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Read a response body with a hard byte cap, aborting mid-stream when the
// upstream uses chunked encoding and exceeds the limit. The caller's
// AbortController governs the whole body lifetime: if the upstream stalls
// mid-body and the controller fires, this surfaces as `timedOut` so the
// caller can answer 504 instead of a generic 502/413.
async function readResponseCapped(upstream, maxBytes, controller) {
  const contentLength = Number.parseInt(upstream.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: json(413, { error: { message: 'Upstream response too large' } }) };
  }

  if (!upstream.body) {
    return { body: await upstream.text() };
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
        return { error: json(413, { error: { message: 'Upstream response too large' } }) };
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
  return { body: new TextDecoder().decode(merged) };
}

// POST /proxy
export async function onRequestPost(context) {
  const req = context.request;
  const env = context.env || {};
  const { target, error: targetError } = parseTarget(req.headers.get('X-Target-URL'));
  if (targetError) return targetError;

  const { body, error: bodyError } = await readBody(req, getMaxBodyBytes(env), getInboundTimeoutMs(env));
  if (bodyError) return bodyError;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of FORWARDED_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const controller = new AbortController();
  const timeoutMs = getTimeoutMs(env);
  // The timeout covers the FULL upstream lifecycle: request start →
  // response headers → response body complete. Headers arriving quickly
  // must not disarm the timer while the body still hangs.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream;
  try {
    try {
      upstream = await fetch(target.href, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        return json(504, { error: { message: 'Upstream timed out after ' + timeoutMs + 'ms' } });
      }
      return json(502, { error: { message: 'proxy: upstream fetch failed' } });
    }

    // Do not follow redirects; an API endpoint that redirects is almost
    // certainly a misconfiguration or a protocol downgrade attempt.
    if (upstream.status >= 300 && upstream.status < 400) {
      return json(502, { error: { message: 'Upstream returned a redirect (HTTP ' + upstream.status + '); redirects are not followed' } });
    }

    let responseBody, responseError, timedOut;
    try {
      ({ body: responseBody, error: responseError, timedOut } =
        await readResponseCapped(upstream, getMaxResponseBytes(env), controller));
    } catch (e) {
      if (controller.signal.aborted) {
        return json(504, { error: { message: 'Upstream timed out after ' + timeoutMs + 'ms' } });
      }
      return json(502, { error: { message: 'Upstream body read failed' } });
    }
    if (timedOut) {
      return json(504, { error: { message: 'Upstream timed out after ' + timeoutMs + 'ms' } });
    }
    if (responseError) return responseError;

    const responseHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      ...CORS_HEADERS,
      'X-Locus-Relay': '1',
    };
    if (NULL_BODY_STATUSES.has(upstream.status)) {
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } finally {
    clearTimeout(timer);
  }
}

// OPTIONS /proxy (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
