# Browser Agent Runtime (Locus)

A browser-native AI agent runtime that executes file and Python workloads locally — without a remote sandbox, Docker, local daemon, CLI, or localhost server.

Forked from the terminal UI / model-interaction skeleton of [Whoami_Cli_game](https://github.com/boccchi2993/Whoami_Cli_game). All game content has been removed; this is not a game.

## Why

Remote sandboxes should be the fallback, not the default, for lightweight agent workloads. The cheapest, most private place to run an agent task is the environment closest to the data: the user's own browser, on files the user explicitly granted access to. The cloud should only carry LLM inference.

## Current capabilities

- Local workspace access via the File System Access API (user-picked directory, read/write)
- Browser-local shell abstraction (`bash` tool: `pwd`, `ls`, `cat`, `echo`, `python`)
- Python execution via Pyodide in a Web Worker (lazy-loaded, stdout/stderr/traceback returned, pandas auto-loaded on import)
- Agent tool loop (structured ` ```json ` tool calls, results fed back, max 15 iterations)
- Local file output written back into the real workspace directory (create / modify / delete / rename)
- In-memory execution telemetry (tool, backend, duration, UTF-8 bytes, success/error) + debug panel

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
 └─ Pyodide (Web Worker, lazy-loaded)
```

The model never sees Pyodide/WebAssembly/JS internals — it only sees `bash`, a restricted local shell in the user-authorized workspace. A `cloud_bash` tool exists in the interface but returns `Cloud execution is not configured.`

```
index.html            page layout, terminal theme, inline Pyodide worker source
src/
  model.js            LLM API client (Anthropic/OpenAI dialect fallback, optional CORS proxy)
  agent.js            agent tool loop + system prompt + strict tool-call parser
  tools.js            tool router (bash / cloud_bash) + telemetry hooks
  shell.js            browser shell compat layer (incl. python heredoc) + Python runtime bridge
  workspace.js        WorkspaceAdapter + LocalDirectoryWorkspace
  telemetry.js        in-memory execution log
  ui.js               setup screen, workspace picker, terminal, debug panel
functions/proxy.js    optional Cloudflare Pages Function (CORS relay for the LLM API)
examples/demo-workspace/sales.csv
tests/                headless browser regression suite
```

Note: the Pyodide worker source is embedded in `index.html` (loaded via Blob URL) so the page also works when opened directly from `file://`, where browsers block `new Worker('...js')`.

## Run

No build step. Either:

- open `index.html` directly in Chrome/Edge, or
- deploy the folder as a static site

You need an LLM API key (default endpoint: DeepSeek; Anthropic and OpenAI-compatible endpoints also work). The key is never written to the repo; if you opt into "remember", it is kept in `sessionStorage` only (see the security note in `src/ui.js`).

Connection behavior: if you configure an explicit proxy URL it is always used. Otherwise the app calls the model API directly; only on a genuine network/CORS failure (and only when hosted over HTTP(S)) does it fall back to a same-origin `/proxy`. HTTP 4xx/5xx provider responses are never re-sent elsewhere.

## The /proxy relay

The bundled `/proxy` endpoint (`functions/proxy.js`, deployable on Cloudflare Pages) is intentionally provider-agnostic for demo and development use.

It accepts arbitrary HTTPS model/API endpoints so Locus can work with OpenAI-compatible, Anthropic-compatible, self-hosted and custom enterprise gateways.

It is not intended to be deployed as an unrestricted production multi-tenant proxy without additional rate limiting / access policy.

Built-in guardrails: POST only, HTTPS upstream only, 1MB request-body cap, 30s upstream timeout (`PROXY_TIMEOUT_MS`) → 504, redirects never followed, 8MB response cap (`MAX_PROXY_RESPONSE_BYTES`) enforced via Content-Length and stream counting, only auth headers forwarded, credentials/bodies never logged or echoed in errors.

## Demo

1. Open the page, enter your API key, connect.
2. Click **Select Workspace** and choose `examples/demo-workspace/` (contains `sales.csv`).
3. Type:

   ```
   分析 sales.csv，计算 revenue 和 cost 的平均值，并保存到 summary.csv。
   ```

4. The agent will run `ls` → `cat sales.csv` → `python ...` locally, and `summary.csv` will appear in the real directory on disk.

Expected terminal flow:

```
AGENT → bash("ls") → bash("cat sales.csv") → bash("python <<'PY' ...")
     → summary.csv 写入本地 workspace → AGENT 报告完成
```

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

A headless browser regression suite exercises the full local chain (shell → Pyodide worker → pandas → write-back) without an API key:

```bash
chrome --headless=new --allow-file-access-from-files --remote-debugging-port=9333 \
  --user-data-dir=/tmp/chrome-e2e "file:///$(pwd)/tests/e2e.html" &
node tests/run-e2e.cjs
```

Covered: path-escape rejection, strict tool parser, UTF-8 telemetry bytes, telemetry array identity, unsupported-command error, `cloud_bash` stub, heredoc Python (mixed quotes / JSON / multi-line), pandas CSV demo, deletion sync, rename semantics, 30s Python timeout + worker recovery.

## Security boundaries

- Only the user-selected workspace is accessible; paths are normalized and `..` escapes are rejected
- No native shell, no `child_process`, no localhost server, no remote code execution
- Workspace files are never uploaded to any execution server (only text the agent explicitly reads is sent to the LLM API)
- Switching workspaces resets the agent context
- API keys are never committed; opt-in session persistence uses `sessionStorage` only

## Telemetry

Every tool execution is recorded in memory:

```json
{ "tool": "bash", "backend": "browser", "duration_ms": 123, "success": true, "input_bytes": 1234, "output_bytes": 456, "error": null }
```

View it via the **log** button, the `telemetry` command, or `window.__telemetry` in the console. Byte counts are real UTF-8 bytes. KPIs (Local Execution Rate, bytes kept local, fallback rate, …) are intentionally not computed in V0.

## Non-goals for V0

- `cloud_bash` (interface stub only)
- browser automation
- Office rendering / DOCX / PDF
- WebContainer / WASI / arbitrary native binaries
- full POSIX shell (only `pwd`, `ls`, `cat`, `echo`, `python`)
- local models
- additional workspace adapters (OPFS / Memory / Cloud — adapter interface is ready)

## License

Apache-2.0. See [LICENSE](LICENSE).
