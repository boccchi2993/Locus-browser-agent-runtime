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
// ============================================================

const NetworkRuntime = {
  relayPath: '/fetch',

  // fetch(url) → {
  //   status, statusText, headers: {lowercase: value},
  //   bytes: Uint8Array, finalUrl, backend: 'browser-direct' | 'edge-relay'
  // }
  // Throws Error with a clear message when the request cannot complete.
  async fetch(url, options) {
    const opts = options || {};
    const parsed = parseHttpsUrl(url); // throws on non-HTTPS

    try {
      return await this._direct(parsed.href);
    } catch (e) {
      if (!isNetworkFailure(e)) throw e;
      if (!isHostedPage()) {
        throw new Error(
          'network access blocked by the browser (CORS) and no edge relay is available ' +
          'when the page is opened from ' + pageProtocol() + ' — host the app over HTTP(S) to enable the relay');
      }
      return await this._relay(parsed.href);
    }
  },

  async _direct(url) {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      statusText: res.statusText || '',
      headers: headersToObject(res.headers),
      bytes,
      finalUrl: res.url || url,
      backend: 'browser-direct',
    };
  },

  async _relay(url) {
    let res;
    try {
      res = await fetch(this.relayPath + '?url=' + encodeURIComponent(url), { method: 'GET' });
    } catch (e) {
      throw new Error('edge relay unreachable: ' + (e && e.message ? e.message : String(e)));
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
    const bytes = new Uint8Array(await res.arrayBuffer());
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

// Only HTTPS URLs are accepted. Returns a URL or throws.
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
  return parsed;
}

// Genuine network/CORS failures reject fetch() with a TypeError in every
// browser. HTTP error statuses resolve normally and never reach here.
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
