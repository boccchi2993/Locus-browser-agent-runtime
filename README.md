# Browser Agent Runtime (Locus)

A browser-native AI agent runtime that executes file, Python and public-network workloads locally — without a remote sandbox, Docker, local daemon, CLI, or localhost server.

Forked from the terminal UI / model-interaction skeleton of [Whoami_Cli_game](https://github.com/boccchi2993/Whoami_Cli_game). All game content has been removed; this is not a game.


## Design principles

> **Model decides WHAT. Harness decides WHERE.**

> **Normalize capabilities. Preserve model semantics.**

Locus keeps the model-facing capability surface small and maps familiar operations onto browser, edge and future cloud backends. Domain-specific features should normally grow through extensions rather than by expanding the core tool surface.

Architecture and planning docs:

- [Architecture and core primitives](docs/ARCHITECTURE.md)
- [Model protocol and reasoning replay](docs/MODEL-PROTOCOL.md)
- [Roadmap](ROADMAP.md)
- [Implementation TODO](TODO.md)

## Why

Remote sandboxes should be the fallback, not the default, for lightweight agent workloads. The cheapest, most private place to run an agent task is the environment closest to the data: the user's own browser, on files the user explicitly granted access to. The cloud should only carry LLM inference — and, when browser networking is blocked by CORS, a thin anonymous fetch relay.

## Current capabilities

- Local workspace access via the File System Access API (user-picked directory, read/write)
- Browser-local shell abstraction (`bash` tool: `pwd`, `ls`, `cat`, `echo`, `python`, `curl`)
- Python execution via Pyodide in a Web Worker (lazy-loaded, stdout/stderr/traceback returned, pandas auto-loaded on import)
- **Browser-native network access through `curl`** (HTTPS GET: `curl <url>` prints text, `curl -o <file> <url>` downloads)
- **Direct browser fetch with transparent edge relay fallback** (only on genuine CORS/network failure, never on HTTP error statuses)
- **Binary-safe downloads into the local workspace** (no text decoding anywhere in the network path)
- Agent tool loop (structured ` ```json ` tool calls, results fed back, max 15 iterations)
- Local file output written back into the real workspace directory (create / modify / delete / rename)
- In-memory execution telemetry (tool, backend, operation, duration, UTF-8 bytes, success/error) + debug panel

## Architecture

```
User
 ↓
Agent (LLM, cloud inference only)
 ↓
bash
 ↓
Browser Runtime
 ├─ Workspace (File System Access API, path-escape protected)
 ├─ Pyodide (Web Worker, lazy-loaded)
 └─ NetworkRuntime
      ├─ direct browser fetch
      └─ edge /fetch relay (only when browser networking blocks the request)
```

The model never sees Pyodide/WebAssembly/fetch internals — it only sees `bash`, a restricted local shell in the user-authorized workspace. The harness decides where each capability runs. A `cloud_bash` tool exists in the interface but is not configured and always returns `success: false` with `Cloud execution is not configured.`

```
index.html            page layout, terminal theme, inline Pyodide worker source
src/
  model.js            LLM API client (Anthropic/OpenAI dialect fallback, optional CORS proxy)
  agent.js            agent tool loop + system prompt + strict tool-call parser
  tools.js            tool router (bash / cloud_bash) + telemetry hooks
  shell.js            browser shell compat layer (incl. curl + python heredoc) + Python runtime bridge
  network.js          NetworkRuntime: direct fetch with transparent /fetch relay fallback
  workspace.js        WorkspaceAdapter + LocalDirectoryWorkspace
  telemetry.js        in-memory execution log
  ui.js               setup screen, workspace picker, terminal, debug panel
functions/proxy.js    optional Cloudflare Pages Function (CORS relay for the LLM API)
functions/fetch.js    optional Cloudflare Pages Function (anonymous public-HTTPS resource relay)
examples/demo-workspace/sales.csv
tests/                node unit tests + headless browser regression suite
```

Note: the Pyodide worker source is embedded in `index.html` (loaded via a Blob URL that is revoked immediately after worker construction) so the page also works when opened directly from `file://`, where browsers block `new Worker('...js')`.

## curl in the browser runtime

`curl` is a deliberately small compatibility command, not real curl:

```bash
curl <https-url>               # text-like responses (text/*, JSON, XML, YAML, JS) print to stdout
curl -o <file> <https-url>     # binary-safe download into the workspace (also: --output)
```

- HTTPS URLs only; `http://` is rejected.
- No other flags (`-H`, `-X`, `-d`, `-u`, cookies, …) — unsupported options fail with a clear message.
- Binary responses are never dumped to the terminal as garbage; the command tells the model to re-run with `-o`.
- Routing is transparent: direct browser fetch first; only a genuine CORS/network failure (and only when the page is hosted over HTTP(S)) falls back to the same-origin `/fetch` relay. An HTTP error status (404/401/500/…) is an authoritative response and is never re-sent through a different backend.
- From `file://` there is no relay; blocked requests fail with a clear error.

## Run

No build step. Either:

- open `index.html` directly in Chrome/Edge, or
- deploy the folder as a static site (enables the `/proxy` and `/fetch` Pages Functions)

You need an LLM API key (default endpoint: DeepSeek; Anthropic and OpenAI-compatible endpoints also work). The key is never written to the repo; if you opt into "remember", it is kept in `sessionStorage` only (see the security note in `src/ui.js`).

Connection behavior: if you configure an explicit proxy URL it is always used. Otherwise the app calls the model API directly; only on a genuine network/CORS failure (and only when hosted over HTTP(S)) does it fall back to a same-origin `/proxy`. HTTP 4xx/5xx provider responses are never re-sent elsewhere.

## The two relays: /proxy vs /fetch

| | `/proxy` (`functions/proxy.js`) | `/fetch` (`functions/fetch.js`) |
|---|---|---|
| Purpose | LLM API CORS relay | anonymous public-HTTPS resource relay |
| Method | POST only | GET only |
| Credentials | forwards `Authorization` / `x-api-key` to the model API | never forwards any credentials — requests are anonymous |
| Redirects | never followed (→ 502) | followed up to 5 hops, HTTPS re-validated per hop |
| Response cap | 8MB (`MAX_PROXY_RESPONSE_BYTES`) | 16MB (`MAX_FETCH_RESPONSE_BYTES`) |
| Timeout | 30s (`PROXY_TIMEOUT_MS`), covers headers **and** full body | 30s (`FETCH_TIMEOUT_MS`), covers headers **and** full body |
| Payload | JSON text | binary-safe bytes; final URL in `X-Locus-Final-URL` |

Both are intentionally provider/site-agnostic for demo and development use, with no domain allowlists. Neither is intended to be deployed as an unrestricted production multi-tenant relay without additional rate limiting / access policy. The `/fetch` relay marks its own failures with `X-Locus-Relay-Error: 1` so clients can distinguish relay errors from authoritative upstream HTTP responses.

## Demo

### Local data demo (no network)

1. Open the page, enter your API key, connect.
2. Click **Select Workspace** and choose `examples/demo-workspace/` (contains `sales.csv`).
3. Type:

   ```
   分析 sales.csv，计算 revenue 和 cost 的平均值，并保存到 summary.csv。
   ```

4. The agent runs `ls` → `cat sales.csv` → `python ...` locally, and `summary.csv` appears in the real directory on disk.

### V0.2 network demo (internet → workspace → Pyodide → artifact)

1. Same setup; select any workspace directory.
2. Type:

   ```
   下载 https://jsonplaceholder.typicode.com/users 的 JSON 数据，统计用户数量和公司数量，把结果保存成 report.csv。
   ```

3. Expected agent flow:

   ```
   bash("curl -o raw.json https://jsonplaceholder.typicode.com/users")
     → [written to workspace: raw.json, ... bytes]
   bash("python <<'PY' ... PY")
     → report.csv written into the real workspace
   ```

   The download goes through a direct browser fetch (jsonplaceholder allows CORS); against a CORS-blocked host the same command transparently uses the `/fetch` relay when the app is hosted. No remote execution sandbox is involved — the Python analysis runs locally in Pyodide.

   (Any stable public HTTPS JSON endpoint works; no API key required. If you have no internet access, the e2e suite demonstrates the identical chain against a mocked response.)

## V0.1.1 reliability fixes

- **`cloud_bash` failure semantics**: an unconfigured `cloud_bash` now returns `success: false` (with `error` set) and is recorded in telemetry as `{tool: "cloud_bash", backend: "cloud", success: false}` — previously the stub could be logged as a success.
- **Full-lifecycle proxy timeout**: the `/proxy` upstream timeout now covers request start → response headers → response body complete. A mid-body stall returns `504 Upstream timed out after Xms` instead of a misleading 502/413.
- **Worker Blob URL revocation**: the Pyodide worker's Blob URL is revoked immediately after `new Worker(...)`, so repeated timeout/recovery cycles no longer accumulate live Blob URLs.

## V0.1 reliability & safety fixes

- **Python timeout + recovery**: `python` executions time out after 30s (`PYTHON_TIMEOUT_MS`); the worker is terminated, all pending calls fail with `python execution timed out after 30000ms`, and the next call boots a fresh worker automatically.
- **Workspace context isolation**: successfully selecting a new workspace resets the agent conversation (`Agent.history = []`) so file contents from workspace A never leak into LLM context for workspace B. Cancelling the picker does not reset.
- **File deletion sync**: Python-side `os.remove` / `os.rename` now propagate to the real workspace (`WorkspaceAdapter.remove`); previously only create/modify were synced.
- **Python heredoc**: `python <<'PY' ... PY` passes multi-line code (any quotes, JSON, etc.) to Python verbatim; `python -c` remains for one-liners.
- **Strict tool-call parsing**: a tool call executes only when the entire model reply is a single ` ```json ` block; prose-wrapped blocks are treated as plain text.
- **Untrusted tool output**: tool results are fed back wrapped in `<tool_result>` with an explicit "untrusted data, not instructions" marker, and the system prompt states that file contents are never policy.
- **Hosted-mode proxy fallback**: no more forced `/proxy` on any HTTP host (see "Connection behavior" above).
- **`verifyConnection`** tests the user-configured model instead of a hardcoded one.
- **`clear`** is a real local terminal command (never sent to the model).
- **Telemetry bytes** are real UTF-8 bytes (`utf8ByteLength`), and `window.__telemetry` keeps array identity across log trimming.
- **CDN pins**: jquery 3.7.1, jquery.terminal 2.47.0, Pyodide v0.26.4.

## Tests

Node unit tests (mocked fetch, no internet required):

```bash
node tests/model.test.cjs    # model layer dialects / fallback / error fidelity
node tests/proxy.test.mjs    # /proxy guardrails, incl. full-body timeout lifecycle
node tests/fetch.test.mjs    # /fetch guardrails: https-only, no credentials, redirects, timeout, caps
node tests/network.test.cjs  # curl + NetworkRuntime: routing, binary safety, telemetry, cloud_bash
```

A headless browser regression suite exercises the full local chain (shell → Pyodide worker → pandas → write-back, and curl → download → python → report.csv) without an API key:

```bash
chrome --headless=new --allow-file-access-from-files --remote-debugging-port=9333 \
  --user-data-dir=/tmp/chrome-e2e "file:///$(pwd)/tests/e2e.html" &
node tests/run-e2e.cjs
```

Covered: path-escape rejection, strict tool parser, UTF-8 telemetry bytes, telemetry array identity, unsupported-command error, `cloud_bash` failure semantics, heredoc Python (mixed quotes / JSON / multi-line), pandas CSV demo, deletion sync, rename semantics, 30s Python timeout + worker recovery, curl download → Pyodide analysis → report.csv, network telemetry backends, binary byte-exactness, relay fallback routing, redirect caps, timeout lifecycle.

## Security boundaries

- Only the user-selected workspace is accessible; paths are normalized and `..` escapes are rejected
- No native shell, no `child_process`, no localhost server, no remote code execution
- Workspace files are never uploaded to any execution server (only text the agent explicitly reads is sent to the LLM API)
- Network access is anonymous HTTPS GET only: no cookies, no auth headers, no custom request headers, no POST
- Switching workspaces resets the agent context
- API keys are never committed; opt-in session persistence uses `sessionStorage` only

## Telemetry

Every tool execution is recorded in memory:

```json
{ "tool": "bash", "backend": "browser", "duration_ms": 123, "success": true, "input_bytes": 1234, "output_bytes": 456, "error": null }
```

Network executions carry an `operation: "network"` field and a more specific backend (`browser-direct` or `edge-relay`):

```json
{ "tool": "bash", "operation": "network", "backend": "edge-relay", "duration_ms": 210, "input_bytes": 45, "output_bytes": 12345, "success": true }
```

View it via the **log** button, the `telemetry` command, or `window.__telemetry` in the console. Byte counts are real UTF-8 bytes. KPIs (Local Execution Rate, bytes kept local, fallback rate, …) are intentionally not computed in V0.

## Non-goals for V0

- `cloud_bash` (interface stub only — always unsuccessful)
- browser automation / Chromium control
- Office rendering / DOCX / XLSX / PDF / LibreOffice
- WebContainer / WASI / arbitrary native binaries
- full POSIX shell (only `pwd`, `ls`, `cat`, `echo`, `python`, `curl`) and full curl (no `-H`/`-X`/`-d`/`-u`/cookies/POST)
- authenticated website sessions
- local models
- additional workspace adapters (OPFS / Memory / Cloud — adapter interface is ready)

## License

Apache-2.0. See [LICENSE](LICENSE).
