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
// - request body size limit (MAX_PROXY_BODY_BYTES)
// - upstream timeout (PROXY_TIMEOUT_MS, default 30s) → 504
// - redirects are NOT followed (redirect: 'manual') → 502
// - response size limit (MAX_PROXY_RESPONSE_BYTES, default 8MB), enforced
//   via Content-Length when present and by stream counting otherwise
// - only auth-related headers are forwarded; credentials and bodies are
//   never logged or echoed in error messages

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const FORWARDED_HEADERS = ['authorization', 'x-api-key', 'anthropic-version'];

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

function json(status, payload) {
  return Response.json(payload, { status, headers: CORS_HEADERS });
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

async function readBody(req, maxBodyBytes) {
  const body = await req.text();
  if (new TextEncoder().encode(body).length > maxBodyBytes) {
    return { error: json(413, { error: { message: 'Request body too large' } }) };
  }
  return { body };
}

// Read a response body with a hard byte cap, aborting mid-stream when the
// upstream uses chunked encoding and exceeds the limit.
async function readResponseCapped(upstream, maxBytes) {
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

  const { body, error: bodyError } = await readBody(req, getMaxBodyBytes(env));
  if (bodyError) return bodyError;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of FORWARDED_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const controller = new AbortController();
  const timeoutMs = getTimeoutMs(env);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream;
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
  } finally {
    clearTimeout(timer);
  }

  // Do not follow redirects; an API endpoint that redirects is almost
  // certainly a misconfiguration or a protocol downgrade attempt.
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { error: { message: 'Upstream returned a redirect (HTTP ' + upstream.status + '); redirects are not followed' } });
  }

  const { body: responseBody, error: responseError } = await readResponseCapped(upstream, getMaxResponseBytes(env));
  if (responseError) return responseError;

  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// OPTIONS /proxy (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
