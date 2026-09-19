# Locus NetworkRuntime v1

The unified, provider-neutral, tool-neutral HTTP/HTTPS execution substrate
(src/network.js). All future HTTP consumers go through one interface; the
first consumer is `curl`.

**Core model experience invariant:**

```
MODEL SHOULD EXPERIENCE ORDINARY HTTP,
NOT BROWSER CORS TOPOLOGY.
```

The model believes `curl https://example.com` is "this machine accessing the
internet". It never learns about CORS, browser origin policy, the edge relay,
direct-fetch fallbacks, or any Locus-specific network routing. The Harness
owns that reality; the model sees ordinary HTTP semantics (200/404/500,
connection failure, timeout).

> **MODEL DECIDES WHAT. HARNESS DECIDES WHERE.**
> READ REQUESTS MAY SAFELY FALL BACK.
> SIDE-EFFECTING REQUESTS MUST NEVER BE AMBIGUOUSLY RETRIED ACROSS BACKENDS.

## Position in the stack

```
curl CLI (src/shell.js)         — CLI parsing, stdout/stderr, -o, exit behavior
        ↓ NetworkRuntime.request(spec)
NetworkRuntime (src/network.js) — validate, classify, approve, route, bound
        ↓ backend chosen BEFORE the request starts
browser fetch  |  edge relay (/fetch, functions/fetch.js)
```

NetworkRuntime knows NOTHING about curl, shells, VFS or providers. The shell
never fetches, never sees backends, and never reasons about CORS. Future
consumers (Python HTTP bridge, JS fetch tools, plugins, MCP adapters) plug in
at the `request()` boundary — they are NOT implemented in v1.

## Interface

```js
NetworkRuntime.request({
  method,          // 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
  url,             // absolute http(s) URL
  headers,         // optional plain object
  body,            // optional string (UTF-8) | Uint8Array | ArrayBuffer
  signal,          // task AbortSignal
  policyContext,   // { approvals, conversationId, taskGeneration }
})
// → { status, statusText, headers, headerList, bytes, finalUrl, backend }
```

- `bytes` is always a `Uint8Array` — binary-safe; text decoding happens only
  in a presentation layer.
- `headers` is a lowercase-keyed object for simple lookups;
  `headerList` is the raw `[name, value]` pair list preserving duplicates
  (Set-Cookie style repeated headers are never silently overwritten).
- `backend` is `'browser-direct' | 'edge-relay'` — telemetry/debug only. It
  never appears in a model-facing tool result.
- `NetworkRuntime.fetch(url, options)` remains the read-like GET convenience
  wrapper (same routing rules as `request` with `method: 'GET'`).

## Principle

The model decides WHAT (method, URL, headers, body). The Harness decides
WHERE (which backend transports it) and WHETHER (approval for side effects).
Neither the shell nor the model chooses backends; nothing model-visible names
a backend.

## Supported

HTTP and HTTPS, nothing else. Bounded request/response — no streaming upload,
no WebSocket, no TCP/UDP/CONNECT, no cookie jar, no persistent cache, no
proxy discovery. This is NOT a full internet protocol stack; it is the
ordinary-HTTP surface a Unix `curl` user expects.

## Schemes (v1)

Only `http:` and `https:`. Everything else — `file:`, `ftp:`, `data:`,
`blob:`, `javascript:`, `ws:`, `wss:`, `chrome:`, `about:`, and any unknown
scheme — is rejected client-side with `network_unsupported_scheme` before any
backend is contacted (curl must never hand those to browser fetch).
Credentials embedded in the URL (`https://user:pass@host/`) are rejected;
requests are anonymous by construction.

URLs are parsed with `new URL(...)` only — never regex-split. The canonical
request identity is the WHATWG-canonicalized
`protocol // hostname : effective-port` (default ports canonicalize away, so
`https://api.example.com` and `https://api.example.com:443` are the same
origin; `https://api.example.com.evil.com` never matches). Fragments are
never sent: the request URL is the URL with the fragment removed.

## Method classification

| Class | Methods | Behavior |
|---|---|---|
| READ-LIKE | `GET`, `HEAD` | No approval. Direct first, relay fallback allowed. |
| SIDE-EFFECTING | `POST`, `PUT`, `PATCH`, `DELETE` | Approval required by default. Backend fixed before send. |
| ADVANCED (side-effecting) | `OPTIONS` | Approval required by default. |
| REJECTED | `TRACE`, `CONNECT`, custom verbs | `network_unsupported_method`. |

Idempotent ≠ no side effects: PUT/DELETE get **zero automatic retries** on
ambiguous failures. Only GET/HEAD may transparently retry on a different
backend (see fallback below).

## Authority vs approval

Approval Framework v1 layering is preserved (docs/APPROVALS.md): approval can
reduce autonomy but can never manufacture authority. A user clicking **Allow**
never enables a non-HTTP scheme, a refused method, or a bypass of any hard
boundary. Scheme/method/size/SSRF validation happens BEFORE and INDEPENDENT
of any approval decision.

## Approval integration (the first production consumer)

Side-effecting methods ask by default; GET/HEAD never ask (three web lookups
must not cost thirty clicks). The request shape:

```js
const decision = await approvals.request({
  kind: 'permission',
  action: { type: 'network-request',
            summary: 'POST https://api.example.com/v1/thing',
            detail: 'Request body size: 2.1 KB' },
  resource: { type: 'network-origin',
              key: canonicalOrigin, label: canonicalOrigin },
  policyKey: 'network-write:' + canonicalOrigin,
  conversationId, taskGeneration,
}, { signal });
```

- `policyKey` is ALWAYS Harness-canonicalized from the parsed URL:
  `network-write:<origin>`. Model/tool-provided strings are never used as
  policy scope; path, query, and model text never enter the key. Exact-match
  grants therefore cannot leak across origins.
- **Allow once** covers exactly one request. The next write to the same
  origin asks again.
- **Allow for this session** grants `network-write:<origin>` for the page
  session — POST/PUT/PATCH/DELETE/OPTIONS to that exact origin share the
  grant. Other origins still ask. GET/HEAD need no grant.
- The card reuses the existing ApprovalCard (no new UI component): the
  summary line, the optional body-size line, and the standard Deny /
  Allow once / Allow for this session buttons. Secret header values
  (Authorization and everything else) and body contents are never rendered.
- The approval provider is injected by the tool wiring (src/ui/store.js);
  a side-effecting request with NO wired provider fails closed
  (`network_approval_unavailable`) — it never silently sends.
- When the relay backend is selected for a private target, or the body
  exceeds the request cap, the request is refused BEFORE the ask: a user is
  never asked to approve something that cannot be sent.

### Deny / cancel semantics

- **Deny**: HTTP request count = 0, deterministic error `network_denied`
  ("network request denied by user"). Deny ≠ cancel task: the model may
  choose another route and the task continues.
- **Task cancel while pending**: the approval resolves `cancelled` and the
  request fails with `network_aborted`. Request count = 0. This is never
  reported as a user denial.

### Consumer execution contract (no TOCTOU)

```
parse + validate + backend route   ← all pure, BEFORE approval: nothing to
  (scheme, method, bounds, SSRF)      approve yet, and a request that cannot
                                      be sent is never offered for approval
approval → decision                ← 'allow' continues; deny/abort stop
safe preparation (bounds re-check)
signal.aborted → cancel            ← FINAL liveness check
// NO await after this point
request begins on the chosen backend ← exactly one send
```

## Backends

### browser-direct

`fetch(url, { credentials: 'omit', redirect: 'follow' | 'manual', … })` with
the composed deadline + task signal. Never sends ambient cookies. The
response is normalized ONCE (status, headers, bounded bytes, finalUrl) — the
browser Response object never leaks to consumers.

### edge relay (functions/fetch.js)

The relay represents the browser toward ordinary public HTTP(S) endpoints.
One endpoint, two request forms — no second proxy:

- `GET /fetch?url=<encoded>` — legacy GET-only form (kept for compatibility).
- `POST /fetch` — JSON envelope `{ method, url, headers, bodyBase64 }` used
  for header-bearing GET/HEAD and all side-effecting methods; the relay
  re-validates everything server-side (scheme, method, private targets,
  forbidden headers, caps) and returns the normalized upstream response
  (`X-Locus-Final-URL`, its own errors marked `X-Locus-Relay-Error: 1` with
  a JSON `{error:{code,message}}` body).

Relay guardrails (server-side mirror of the client policy, defense in depth):

- Scheme allowlist http/https; userinfo rejected; per-hop re-validation.
- Method allowlist GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS. No CONNECT/TRACE.
- **Private-address refusal (SSRF)**: literal loopback / private / link-local
  targets refused — `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0/8`,
  `169.254.0.0/16` (incl. metadata IPs), `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `fc00::/7`, `fe80::/10` (incl. IPv4-mapped IPv6). The
  client pre-checks the same list before choosing the relay
  (`network_private_address_blocked`), so the model gets the same
  deterministic error without a wasted round-trip.
  - **Known limitation (documented, not hidden):** validation is on the
    HOSTNAME string, not the resolved IP. A public DNS name that resolves to
    a private address (DNS rebinding) is not currently detectable in the
    Pages runtime. Closing this fully requires resolve-and-verify upstream
    fetches (future work); v1 does not claim complete SSRF defense.
- Request body cap (2 MiB default) and response cap (16 MiB default), both
  enforced server-side; upstream timeout (30 s) covering headers AND body;
  redirect cap (5).
- Same-origin `Origin` check on the envelope form: a present Origin must
  match the deployment (browser callers always send it; other web pages
  cannot forge it). **Relay openness (known, bounded):** non-browser clients
  sending no Origin are accepted — v1 does not expand this surface beyond the
  GET relay's existing openness, and does not build a token system;
  deployment-level protection (Cloudflare WAF/rate limiting) is the intended
  mitigation, recorded here as a residual risk.
- Upstream response headers pass through minus hop-by-hop machinery and
  `Set-Cookie` (the relay never writes any cookie jar); active content types
  stay de-privileged (`nosniff` + `CSP: sandbox`).

## Safe fallback (GET/HEAD only)

```
direct browser fetch
    ↓ only on genuine network failure (TypeError), once
edge relay
```

Max direct 1 + relay 1; no infinite retries. A REAL HTTP response — even
404/403/500 — is an authoritative application result and is NEVER re-sent
through the other backend. Timeouts, size caps and user cancellation are not
network failures and never trigger a relay retry.

The browser cannot distinguish CORS-blocked responses from DNS/TLS/offline
failures (both reject as `TypeError`). For GET/HEAD that ambiguity is
tolerable — reads duplicate harmlessly — and the relay retry makes CORS a
Harness problem the model never sees.

## Side-effecting requests

- The backend is chosen BEFORE the request starts: same-origin → direct;
  cross-origin → relay. After dispatch it is never switched.
- A failure after dispatch (TypeError, relay upstream failure, deadline) is
  reported as AMBIGUOUS: "the request may or may not have reached the
  server". It is NEVER retried — not on the other backend, not at all. There
  is no automatic "HTTP-idempotent" retry for PUT/DELETE either: real
  third-party APIs implement idempotency imperfectly, and a duplicate
  payment/delete is worse than a reported failure.

## Redirects

- GET/HEAD: followed; `finalUrl` reports the last URL; the final scheme is
  re-validated as http(s) by the Harness and per-hop by the relay.
- Side-effecting requests never follow a redirect: the direct backend uses
  `redirect: 'manual'` (the browser's opaque-redirect response cannot be
  inspected, so any redirect is blocked), and the relay follows SAME-ORIGIN
  hops only — 307/308 keep method+body (the approved origin is unchanged),
  301/302/303 downgrade to a body-less GET (the side effect is not replayed)
  — and a cross-origin hop is refused with `network_redirect_blocked`.
  An approved POST body can therefore never silently land on another origin.

## Bounds

- `MAX_NETWORK_RESPONSE_BYTES` — 16 MiB (client + relay). Content-Length
  over the cap is rejected before reading; otherwise the body is
  stream-read with a running cap and aborted mid-stream
  (`network_response_too_large`). Never an unbounded `arrayBuffer()`.
- `MAX_NETWORK_REQUEST_BYTES` — 2 MiB (client + relay). Checked BEFORE the
  approval ask and before any send (`network_request_too_large`); the shell
  additionally bounds `@file` bodies before materializing them.
- Deadlines cover headers AND body: direct 60 s, relay client 45 s (the
  relay's own upstream timeout is 30 s → its structured 504 arrives first).
  Deadline + task signal are composed; total time stays bounded; timeout on
  a side effect is ambiguous and never retried.
- Cancellation is not rollback: if a relayed side effect already reached the
  target when the task aborts, nothing claims to undo it.

## Credential / header handling

Never sent: `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`,
`Upgrade`, `TE`, `Trailer`, `Keep-Alive`, `Expect`, `Via`, `Date`, `Cookie`,
`Cookie2`, `DNT`, `Origin`, `Referer`, `Accept-Charset`, `Accept-Encoding`,
`Access-Control-Request-*`, any `Proxy-*` or `Sec-*` header, and any header
value containing CR/LF (`network_invalid_header`). The client and the relay
apply the same filter (defense in depth).

`Authorization` and application-defined headers ARE sent — calling an
authenticated API is ordinary curl usage. But credentials never appear in
approval cards, error strings, logs or telemetry. `credentials: 'omit'`
everywhere; the relay never attaches ambient browser cookies. Locus curl
behaves like an independent command-line client, not the user's logged-in
browser session.

## Error taxonomy

Every NetworkRuntime failure carries `e.networkCode`:

| Code | Meaning |
|---|---|
| `network_invalid_url` | URL failed to parse / userinfo |
| `network_unsupported_scheme` | scheme outside http/https |
| `network_unsupported_method` | TRACE/CONNECT/custom verb |
| `network_invalid_header` | CR/LF injection attempt |
| `network_request_too_large` | request body cap (before approval) |
| `network_approval_unavailable` | side-effecting request, no provider wired |
| `network_denied` | user denied the approval |
| `network_aborted` | task/signal cancellation (also `cancelled`) |
| `network_timeout` | deadline exceeded (also `timeout`) |
| `network_response_too_large` | response body cap (also `tooLarge`) |
| `network_direct_failed` | browser-direct dispatch failure |
| `network_relay_failed` | relay unreachable or relay-reported failure |
| `network_redirect_blocked` | redirect on a side-effecting request |
| `network_private_address_blocked` | loopback/private/link-local on the relay path |

Ambiguous post-dispatch failures carry `e.ambiguous === true`. The model
sees the deterministic message and, where useful, the target origin and HTTP
status. It never sees "CORS", "browser fetch", "relay", or advice to switch
tools. Debug/telemetry surfaces record the backend.

## curl migration (src/shell.js)

The shell is CLI-only: parsing, stdout/stderr, `-o`, exit semantics. It calls
`NetworkRuntime.request()` and formats the normalized result. Supported:
`curl <url>`, `-o/--output`, `-I/--head`, `-X/--request`,
`-H/--header` (repeatable), `-d/--data/--data-binary` (implies POST,
`@file` reads VFS bytes, parts joined with `&`), `--data-raw` (never reads
files). Everything else fails with the existing clear message. HTTP error
statuses keep the existing project semantics (`curl: HTTP 404 from …`).
Downloads are fully materialized (bounded) BEFORE the single VFS write, so a
failed download never leaves a partial destination file.

## Telemetry

Existing telemetry continues to record `operation: 'network'` with the
`backend`. No schema change in v1. Never recorded: bodies, Authorization,
Cookie, or sensitive query values (URLs are recorded as origin + path at
most).

## Model-facing capability text

The system prompt presents ordinary HTTP: this environment has HTTP/HTTPS
internet access via `curl`; GET/HEAD are anonymous reads; side-effecting
methods may trigger a user approval card (a denial means the request was not
made — continue another way); arbitrary TCP/UDP is unavailable. It never
mentions fetch/CORS/relays/fallbacks, and never suggests switching to
`cloud_bash` for network access.

## cloud_bash

Unchanged and NOT a network path. It remains the legacy/debug compatibility
tool ("Expensive remote execution fallback. It is currently NOT
configured"), and the prompt explicitly tells the model NOT to switch to it
when curl fails. NetworkRuntime owns routing; the model never needs to know
cloud_bash exists.

## Current v1 limitations

- Hostname-string SSRF validation only (no resolve-and-verify) — documented
  above, not hidden.
- The relay accepts unauthenticated no-Origin clients (bounded openness,
  residual risk documented above).
- Direct side-effecting requests block ALL redirects (the browser's manual
  redirect response is opaque), while the relay follows same-origin chains —
  both semantics never forward an approved body across origins.
- No cookie jar, no persistent cache, no streaming upload, no
  multipart encoding — `curl` flags for those are rejected.
- OPTIONS is treated as side-effecting (approval), matching the v1 spec.

## Future

- Python HTTP bridge (`requests`/`urllib`/`pyfetch` → NetworkRuntime).
- JS-side fetch tools, plugin network SDK, MCP network authority.
- Resolve-and-verify SSRF defense in the relay.
- Private-network / credential-bearing request policy, if ever needed.
