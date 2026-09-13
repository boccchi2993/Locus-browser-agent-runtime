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
- Local file output written back into the real workspace directory
- In-memory execution telemetry (tool, backend, duration, bytes, success/error) + debug panel

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
  agent.js            agent tool loop + system prompt
  tools.js            tool router (bash / cloud_bash) + telemetry hooks
  shell.js            browser shell compat layer + Python runtime bridge
  workspace.js        WorkspaceAdapter + LocalDirectoryWorkspace
  telemetry.js        in-memory execution log
  ui.js               setup screen, workspace picker, terminal, debug panel
functions/proxy.js    optional Cloudflare Pages Function (CORS proxy for the LLM API)
examples/demo-workspace/sales.csv
```

Note: the Pyodide worker source is embedded in `index.html` (loaded via Blob URL) so the page also works when opened directly from `file://`, where browsers block `new Worker('...js')`.

## Run

No build step. Either:

- open `index.html` directly in Chrome/Edge, or
- deploy the folder as a static site (e.g. Cloudflare Pages — `functions/proxy.js` then provides a CORS proxy at `/proxy`)

You need an LLM API key (default endpoint: DeepSeek; Anthropic and OpenAI-compatible endpoints also work). The key is never written to the repo; if you opt into "remember", it is kept in `sessionStorage` only (see the security note in `src/ui.js`).

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
AGENT → bash("ls") → bash("cat sales.csv") → bash("python -c ...")
     → summary.csv 写入本地 workspace → AGENT 报告完成
```

## Tests

A headless smoke test exercises the full local chain (shell → Pyodide worker → pandas → write-back) without an API key:

```bash
chrome --headless=new --allow-file-access-from-files --remote-debugging-port=9333 \
  --user-data-dir=/tmp/chrome-e2e "file:///$(pwd)/tests/e2e.html" &
node tests/run-e2e.cjs
```

## Security boundaries

- Only the user-selected workspace is accessible; paths are normalized and `..` escapes are rejected
- No native shell, no `child_process`, no localhost server, no remote code execution
- Workspace files are never uploaded to any execution server (only text the agent explicitly reads is sent to the LLM API)
- API keys are never committed; opt-in session persistence uses `sessionStorage` only

## Telemetry

Every tool execution is recorded in memory:

```json
{ "tool": "bash", "backend": "browser", "duration_ms": 123, "success": true, "input_bytes": 1234, "output_bytes": 456, "error": null }
```

View it via the **log** button, the `telemetry` command, or `window.__telemetry` in the console. KPIs (Local Execution Rate, bytes kept local, fallback rate, …) are intentionally not computed in V0.

## Non-goals for V0

- `cloud_bash` (interface stub only)
- browser automation
- Office rendering / DOCX / PDF
- WebContainer / WASI / arbitrary native binaries
- full POSIX shell (only `pwd`, `ls`, `cat`, `echo`, `python`)
- local models
- additional workspace adapters (OPFS / Memory / Cloud — adapter interface is ready)
