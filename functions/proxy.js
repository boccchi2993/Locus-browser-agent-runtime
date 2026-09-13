// Cloudflare Pages Function
// Deploy path: functions/proxy.js maps to POST /proxy.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function getMaxBodyBytes(env) {
  const configured = Number.parseInt(env.MAX_PROXY_BODY_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 1024 * 1024;
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

// POST /proxy
export async function onRequestPost(context) {
  const req = context.request;
  const env = context.env || {};
  const { target, error: targetError } = parseTarget(req.headers.get('X-Target-URL'));
  if (targetError) return targetError;

  const { body, error: bodyError } = await readBody(req, getMaxBodyBytes(env));
  if (bodyError) return bodyError;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['authorization', 'x-api-key', 'anthropic-version']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  try {
    const upstream = await fetch(target.href, {
      method: 'POST',
      headers,
      body,
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return json(502, { error: { message: 'proxy: ' + e.message } });
  }
}

// OPTIONS /proxy (CORS preflight)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
