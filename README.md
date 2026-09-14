# Browser Agent Runtime (Locus)

A Unix-like execution substrate for AI agents, implemented inside a browser tab. Locus aims to handle lightweight computation, files and Internet access locally without requiring a remote sandbox, Docker, local daemon, CLI, or localhost server.

Forked from the terminal UI / model-interaction skeleton of [Whoami_Cli_game](https://github.com/boccchi2993/Whoami_Cli_game). All game content has been removed; this is not a game.


## Design principles

> **Model decides WHAT. Harness decides WHERE.**

> **Normalize capabilities. Preserve model semantics.**

> **If a lightweight task can be expressed as computation + files + network, it should not require a cloud computer.**

Locus keeps the model-facing machine surface small and Unix-like. The browser runtime provides execution, filesystem and network substrate; the harness composes those capabilities and decides when an extension or heavier provider is required. Domain-specific features should normally grow through Plugins, Skills and MCP rather than by expanding the runtime core.

Architecture and planning docs:

- [Architecture](docs/ARCHITECTURE.md)
- [Capability boundaries](docs/CAPABILITY-BOUNDARIES.md)
- [Model protocol and reasoning replay](docs/MODEL-PROTOCOL.md)
- [Roadmap](ROADMAP.md)
- [Implementation TODO](TODO.md)

## Why

Remote computers should be escalation providers, not the default, for lightweight agent workloads. The cheapest, most private place to run ordinary computation is usually the environment closest to the data: the user's own browser, on files the user explicitly granted access to. Model inference, external authority, relays, authenticated services and genuinely heavyweight execution may remain remote; lightweight execution should not become cloud work merely because the caller is an agent.

## Current capabilities

- **Linux-like VFS**: the agent always sees one stable filesystem tree — `/home/locus` (writable home), `/tmp`, `/mnt/upload` (read-only user uploads), `/mnt/download` (writable, downloadable artifacts), `/usr/bin`+`/bin` (the live command registry) — with the user-picked folder mounted at `/mnt/workspace`. The filesystem exists with or without a mounted folder — see [docs/LINUX-LIKE-VFS.md](docs/LINUX-LIKE-VFS.md)
- Local workspace access via the File System Access API (user-picked directory mounted at `/mnt/workspace`, read/write)
- Unix-like compatibility shell (`bash` tool): `pwd`, `cd` (invocation-local), `ls` (`-a`/`-l`/`-h`), `cat`, `echo`, `find`, `grep`, `head`, `tail`, `wc`, `mv`, `rm`, `python`, `curl`, `help`, with `;`, `&&`, `||` and `|` command composition and `>`, `>>`, `2>`, `2>>`, `2>&1` redirection — see "The Unix compatibility shell" below
- Python execution via Pyodide in a Web Worker (lazy-loaded, stdout/stderr/traceback returned, pandas auto-loaded on import)
- **Browser-native network capability currently exposed through `curl`** (HTTPS GET: `curl <url>` prints text, `curl -o <file> <url>` downloads); long term, Python/JS networking should reuse the same runtime boundary
- **Direct browser fetch with transparent edge relay fallback** (only on genuine CORS/network failure, never on HTTP error statuses)
- **Binary-safe downloads into the local workspace** (no text decoding anywhere in the network path)
- Agent tool loop (structured ` ```json ` tool calls, results fed back, max 32 iterations)
- Local file output written back into the real workspace directory (create / modify / delete / rename), with external-edit conflict detection and staged (non-atomic) commit reporting
- Session boundaries that actually isolate: switching workspace or `reset` cancels the running task, clears history, and rebuilds the Python interpreter
- Structured model responses (visible content / reasoning / stop reason / usage / provider-native replay state) — HTTP 200 semantic errors never trigger a second paid request
- In-memory execution telemetry (tool, backend, operation, duration, UTF-8 bytes, success/error) + debug panel

## Architecture

Locus separates the Unix-like interface the model sees from the browser-native substrate that implements it:

```
                    Agent
                      |
               +------+------+
               |             |
             bash           edit
               |
       python / js / curl / Unix utilities
               |
        Runtime Substrate
     execution / filesystem / network
               |
             Browser
```

The current V0.3 implementation is a partial realization of that target:

```
Agent
  |
bash
  |
Browser Runtime
  +-- Workspace ------> File System Access API
  +-- Python ---------> Pyodide Worker
  +-- curl -----------> NetworkRuntime
                         +-- browser-direct
                         +-- edge /fetch relay
```

The model should not need to care whether Python is Pyodide, a command is backed by WASM, or HTTP required a relay. `bash` is the Unix-like execution facade; `edit` is the target deterministic mutation interface; execution/filesystem/network are the runtime substrate beneath them.

Plugins add code, Skills add knowledge, and MCP adds external authority. Capabilities such as Excel editing, RAG, ffmpeg, LibreOffice or compilers should normally be composed above the runtime rather than becoming new core tools.

A `cloud_bash` tool exists in the current interface but is not configured and always returns `success: false` with `Cloud execution is not configured.` It represents a future escalation provider for workloads that genuinely need a remote computer.

See [Capability boundaries](docs/CAPABILITY-BOUNDARIES.md) for the detailed layer model.

```
index.html            Vite entry page + inline Pyodide worker source; loads runtime classic scripts, then the Vue app
package.json          npm run dev / build / test / test:e2e
vite.config.js        Vue plugin + copies the un-bundled runtime scripts into dist/
src/
  model.js            LLM API client (Anthropic/OpenAI dialect fallback, optional CORS proxy)
  agent.js            AgentSession: UI-independent agent tool loop (runtime events, DI) + system prompt + strict tool-call parser
  tools.js            tool router (bash / cloud_bash) + telemetry hooks
  shell.js            browser shell compat layer (incl. curl + python heredoc) + Python runtime bridge
  network.js          NetworkRuntime: direct fetch with transparent /fetch relay fallback
  workspace.js        WorkspaceAdapter + LocalDirectoryWorkspace (File System Access API provider)
  vfs.js              Linux-like VFS: VirtualWorkspace mount table + MemoryWorkspace/UploadWorkspace/SystemBinWorkspace
  telemetry.js        in-memory execution log
  main.js             Vue bootstrap (+ ?e2e=1 / ?demo=… QA hooks)
  App.vue             three-region workspace shell
  components/         Sidebar (task history), Timeline + item renderers, Composer (+ context menu), ContextRail, SettingsPanel, TerminalPanel
  ui/store.js         presentation store: owns UI state, wires AgentSession events into the projector
  ui/projector.js     pure runtime-event → timeline projection (framework-independent, Node-tested)
  ui/markdown.js      markdown-lite renderer for assistant text (escape-first, XSS-safe)
  ui/theme.css        Cowork-style neutral theme (light + dark via prefers-color-scheme)
functions/proxy.js    optional Cloudflare Pages Function (CORS relay for the LLM API)
functions/fetch.js    optional Cloudflare Pages Function (anonymous public-HTTPS resource relay)
examples/demo-workspace/sales.csv
tests/                node unit tests + headless browser regression suites (runtime + presentation)
```

Note: the Pyodide worker source is embedded in `index.html` (loaded via a Blob URL that is revoked immediately after worker construction) so the page also works when opened directly from `file://`, where browsers block `new Worker('...js')`.

## The Unix compatibility shell

The `bash` tool is a **Unix-like compatibility shell, not full POSIX bash**. It exists so the small Unix vocabulary models already speak (`ls -la`, `find src -name '*.java' | grep builder`, `cd foo && cat foo.txt`) works locally. Everything is parsed by Locus itself — no `eval`, no system shell — and every simple command lands in an explicit, controlled handler.

- **Grammar**: `pipeline ((';' | '&&' | '||') pipeline)*` where `pipeline := simple_command ('|' simple_command)*`, left-associative. `;` always runs the next command, `&&` runs it only on success, `||` runs it only on failure, `|` feeds **stdout only** into the next command's stdin (`cat`/`grep`/`head`/`tail`/`wc` consume stdin; piping into anything else fails loudly). stderr is never piped unless explicitly merged with `2>&1`. Pipeline status is the last stage's status. Quoted operators are always data: `echo "a;b"` prints text.
- **stdout/stderr**: the executor keeps the two streams separated per command (`{success, stdout, stderr}`) and merges them only at the tool boundary for presentation. A failing `cat missing.txt` produces empty stdout and a `cat: ...` stderr — never one mixed bag.
- **Redirection** (generic execution-layer feature, applied left to right — order matters): `cmd > file` / `>> file` (stdout truncate / append), `cmd 2> file` / `2>> file` (stderr truncate / append), `cmd 2>&1` (stderr inherits stdout's *current* destination — so `cmd > all.txt 2>&1` merges both into the file, while `cmd 2>&1 > out.txt` keeps stderr captured and sends only stdout to the file). Redirection never changes a command's success: `cat missing 2> err.txt || echo fallback` still runs the fallback. Other file descriptors (`1>&2`, `3>`, `&>`, `<`, heredocs other than python's) are rejected with clear errors.
- **mv**: `mv <src>... <dest>` — file→file, file→directory, bounded recursive directory move, multiple sources into a directory, cross-mount moves included. An existing destination is a loud failure (no implicit overwrite, no `-f`). Implemented as copy → verify → delete: the source is never removed before the destination write has landed, and a read-only source mount (e.g. `/mnt/upload`) fails the move *before* the destination is touched, since the source could not be removed. Paths are ordinary VFS-absolute paths (`/foo` resolves against the virtual cwd's filesystem root).
- **rm**: `rm [-f] [-r|-R] <path>...` — files, multiple operands, `-f` ignores missing paths, `-r` for recursive directory removal. Protected roots (`/`, `/usr`, `/home`, `/home/locus`, `/mnt`, `/mnt/workspace`, `/mnt/upload`, `/mnt/download`, `/mnt/plugins`) are hard-refused for recursive delete; children obey their mount's authority (`/mnt/upload/*` is read-only). Recursive deletion checks cancellation before every removal and reports exactly what was already deleted — a cancel is never a fake rollback. There is no permission-prompt layer yet by design.
- **Virtual cwd**: every bash invocation starts at the default cwd — `/mnt/workspace` when a folder is mounted, otherwise `/home/locus`. `cd` changes the cwd only within that one invocation, and `cd` above the filesystem root is rejected. Relative paths in all commands resolve against the virtual cwd, and `python script.py` runs with Python's cwd equal to the shell cwd. Environment: `HOME=/home/locus`, `TMPDIR=/tmp`, `PATH=/usr/local/bin:/usr/bin:/bin`.
- **ls**: `-a` (show dotfiles; `.`/`..` are never synthesized — the File System Access API has no such entries), `-l` (type/size/modified — no fake uid/gid/permissions/inodes), `-h` (deterministic human sizes: `421 B`, `12.4 KiB`, `3.1 MiB`), combined short flags, multiple paths. Compatibility semantics, not bit-perfect GNU ls.
- **find** (bounded subset): `find [path...] [-name glob] [-type f|d] [-maxdepth N]`, glob supports `*`/`?` only. Deterministic order, workspace-confined, cancellation-aware, capped at 5000 visited entries / 1000 results with an explicit truncation note. No `-exec`/`-delete`/`-size`/boolean expressions.
- **grep** (bounded subset): `grep [-n] [-i] [-r|-R] [-E] <pattern> [path...]` — patterns are **JavaScript regexes** (invalid patterns fail with a clear error). Recursive search is capped (500 files / 2 MiB per file / 500 matches), skips non-UTF-8 files with a note, and is cancellation-aware. Zero matches are a successful empty answer, not an error.
- **head/tail**: `-n N` (default 10), `tail -n +N`; **wc**: `-l`/`-w`/`-c`, `-c` counts real UTF-8 bytes.
- **Bounds**: intermediate pipeline data is capped at 1 MiB (`SHELL_PIPE_MAX_BYTES`) and **fails loudly** rather than forwarding silently truncated input; terminal-facing reads stay under the existing 512 KiB file cap; recursive moves are capped at 1000 entries / 25 MiB.
- **Not supported** (clear errors naming the supported alternative): `&`, `$(...)`, backticks, subshells, variables/`export`, glob expansion (`*` stays literal — use `find -name` and iterate), input redirect (`<`), file descriptors beyond `2>&1`, `sed`/`awk`/`xargs`/`jq`/`sort`/…
- `help` prints the live contract. The runtime dispatch, `help` and the system prompt are all generated from one capability registry (`SHELL_COMMANDS` in `src/shell.js`), so the advertised surface cannot drift from what executes.
- A compound command that performs exactly one network fetch keeps its real backend telemetry (`browser-direct`/`edge-relay`); multiple network operations are honestly marked `operation: "compound"`.

## curl in the browser runtime

`curl` is currently the Unix-facing frontend to Locus network capability. It is a deliberately small compatibility command, not real curl:

```bash
curl <https-url>               # text-like responses (text/*, JSON, XML, YAML, JS) print to stdout
curl -o <file> <https-url>     # binary-safe download to any writable VFS path (e.g. /mnt/download) (also: --output)
```

- HTTPS URLs only; `http://` and URLs with embedded credentials (`user:pass@host`) are rejected.
- No other flags (`-H`, `-X`, `-d`, `-u`, cookies, …) — unsupported options fail with a clear message.
- Requests are anonymous by construction (`credentials: 'omit'`), carry a client deadline (60s direct / 45s relay, covering headers **and** body), and a 16MB response cap enforced while streaming.
- Redirects are followed by the browser, which enforces CORS per hop; the runtime does not claim per-hop visibility it does not have — hops the browser cannot validate fail as network errors and may go through the relay (which re-validates HTTPS per hop).
- Binary responses are never dumped to the terminal as garbage; the command tells the model to re-run with `-o`.
- Routing is transparent: direct browser fetch first; only a genuine CORS/network failure (and only when the page is hosted over HTTP(S)) falls back to the same-origin `/fetch` relay. An HTTP error status (404/401/500/…) is an authoritative response and is never re-sent through a different backend — and neither are timeouts, size-cap rejections or user cancellations.
- From `file://` there is no relay; blocked requests fail with a clear error.

## Run

```bash
npm install
npm run dev      # Vite dev server (http://localhost:5173)
npm run build    # static build into dist/ (deployable as-is)
```

The presentation layer is Vue 3 + Vite. It is a **projection of the AgentSession runtime event stream** (`task_start` / `reasoning` / `tool_call` / `tool_result` / `assistant_text` / `warning` / `error` / `task_end`): the runtime under `src/` stays framework-independent classic scripts, and the conversation timeline in the UI is **not** the provider history — provider history is owned by `AgentSession` / the provider adapters, the timeline is owned by the presentation store, and neither is ever reconstructed from the other.

You need an LLM API key — set it in the Settings panel. Defaults:

- Default endpoint: `https://api.deepseek.com/anthropic`
- Default model: DeepSeek V4.1 Flash (`deepseek-flash`)

Locus remains provider/model configurable — this is only the initial default; Anthropic and OpenAI-compatible endpoints and any custom model name work too. The key is never written to the repo; if you opt into "remember", it is kept in `sessionStorage` only (cleared when the tab closes).

Connection behavior: if you configure an explicit proxy URL it is always used. Otherwise the app calls the model API directly; only on a genuine network/CORS failure (and only when hosted over HTTP(S)) does it fall back to a same-origin `/proxy`. HTTP 4xx/5xx provider responses are never re-sent elsewhere.

## The two relays: /proxy vs /fetch

| | `/proxy` (`functions/proxy.js`) | `/fetch` (`functions/fetch.js`) |
|---|---|---|
| Purpose | LLM API CORS relay | anonymous public-HTTPS resource relay |
| Method | POST only | GET only |
| Credentials | forwards `Authorization` / `x-api-key` to the model API | never forwards any credentials — requests are anonymous |
| Redirects | never followed (→ 502) | followed up to 5 hops, HTTPS re-validated per hop |
| Response cap | 8MB (`MAX_PROXY_RESPONSE_BYTES`) | 16MB (`MAX_FETCH_RESPONSE_BYTES`) |
| Inbound limit | 1MB body (`MAX_PROXY_BODY_BYTES`): Content-Length pre-check + stream counting, 30s inbound deadline (`PROXY_INBOUND_TIMEOUT_MS` → 408) | GET only — no request body |
| Timeout | 30s (`PROXY_TIMEOUT_MS`), covers headers **and** full body | 30s (`FETCH_TIMEOUT_MS`), covers headers **and** full body |
| Null-body statuses | 204/205 answered with a null body | 204/205/304 answered with a null body |
| Payload | JSON text | binary-safe bytes; final URL in `X-Locus-Final-URL` |
| Markers | every response carries `X-Locus-Relay: 1` (distinguishes a missing function from an authoritative relay answer) | own failures carry `X-Locus-Relay-Error: 1` |
| Active content | n/a (model API JSON) | `X-Content-Type-Options: nosniff` on everything; `Content-Security-Policy: sandbox` on HTML/XHTML/SVG/JS so a navigated response renders in an opaque origin with scripting disabled |

Both are intentionally provider/site-agnostic for demo and development use, with no domain allowlists. Neither is intended to be deployed as an unrestricted production multi-tenant relay without additional rate limiting / access policy. The `/fetch` relay marks its own failures with `X-Locus-Relay-Error: 1` so clients can distinguish relay errors from authoritative upstream HTTP responses.

## V0.3 reliability, integrity and permission-boundary fixes

- **Real-directory stat fixed (F01)**: `stat()` no longer passes a boolean as the `getFileHandle`/`getDirectoryHandle` options argument (a WebIDL TypeError in real browsers that broke `cat`, Python snapshots and appends on real directories). `exists()` only converts an explicit `NotFoundError` to `false`; permission and other faults propagate — `echo >>` can no longer silently overwrite an existing file.
- **Write-back failure semantics (F04)**: if any file write-back fails, the delete phase is stopped and sources are preserved (a failed rename never loses the original). Results distinguish compute success, full commit, partial commit and not-persisted; multi-file commits are staged and reported, never claimed atomic. Files generated with no workspace selected are reported as not persisted.
- **External-edit conflicts (F11)**: before overwriting or deleting a file, the real file is compared against the sync-in snapshot. If it changed on disk during the run (user/editor), the commit is refused, the on-disk version kept, and a recoverable `[conflict: path: reason]` is returned.
- **Partial snapshots are honest (F10)**: files over the sync limits (200 files / 5 MiB per file / 25 MiB total) are reported by **path and reason**, Python is told they are not visible, and any file Python creates at an unsynced path is refused instead of clobbering the real one.
- **Workspace switch is a real session boundary (F02/F03)**: a running task binds its workspace and a session generation; switching workspace cancels the task and waits for it to stop before applying, late model responses/tool results are discarded, and the Pyodide worker is rebuilt — Python globals, imported modules and `/tmp` do not leak across sessions. `reset` starts a fresh session (history + Python) without unmounting the workspace; `cancel` aborts the running task.
- **Cancellation everywhere (F07)**: model requests, tool execution, Python runs, network fetches and write-back all honor one AbortSignal; cancelled work never commits afterwards. Cancellation is re-checked after every asynchronous pre-check (external-edit detection, delete validation, echo/curl write-back reads), and a workspace collection that finishes after a cancel never starts Python. While a task runs it can be cancelled from the composer **Cancel** button or the **Escape** key. A current-session cancel is NOT a rollback: if the tool already completed, its real result — including exactly what was written / deleted / not persisted — is shown to the user and recorded in history, and only then does the model loop stop. A session switch (workspace change / `reset`) is a different event: late results of the old session are discarded and never shown or recorded in the new one.
- **Model protocol envelope (F09)**: `callModel()` returns `{ content, reasoning, stopReason, usage, rawMessage, truncated }`; provider-native messages (incl. reasoning blocks) are replayed unchanged, reasoning is shown (dim) when the provider returns it, and truncated answers are flagged instead of treated as clean completions.
- **Error taxonomy (F08/F09)**: failures are classified by phase and type — pre-headers transport (TypeError) / post-headers body-read (`BodyReadError`, keeps HTTP status + cause) / HTTP status / parse / timeout / cancellation. Parse errors, timeouts and body-read failures after HTTP 200 never trigger endpoint re-probing or a second paid inference; automatic `/proxy` fallback preserves the relay's authoritative 401/402/429/5xx (marked via `X-Locus-Relay: 1`) instead of masking them with the original CORS error, and only a genuinely missing/unreachable relay resurfaces the direct error.
- **Network resource bounds (F07/F13)**: direct and relay fetches carry client deadlines covering headers **and** the full body (every body read races the deadline/cancel signal, so a stalled body still loses), a 16MB streaming cap, `credentials: 'omit'`, and URL-userinfo rejection; timeouts/caps/cancellations are never misread as CORS and retried. The direct and relay attempts carry separate deadline options (`timeoutMs`, default 60s; `relayTimeoutMs`, default 45s — just above the relay's own 30s upstream timeout). Stream cleanup on the timeout/cancel/size-cap exit path is best-effort and never awaited: a response stream whose `cancel()` hangs or rejects cannot block the caller's exit or produce unhandled rejections, and the original error classification (timeout / cancelled / too large) is preserved.
- **Python bounds (F07/F18)**: stdout/stderr capped in-worker at 1MB each, output files capped at 200 files / 25 MiB (enforced in the worker before posting results, sizes checked via `stat` before any `readFile`/base64). The worker reports a **structured** status: `stdoutTruncated`/`stderrTruncated` are warnings, while `uncollectedFiles` marks an incomplete change set — which blocks the deletion phase and reports partial-failure, so a rename past the output limit can no longer delete the source without writing the target.
- **Pyodide init recovery (F14)**: a failed first load no longer poisons the runtime — the loading promise is reset and the next run retries; fatal worker errors destroy the worker so it reboots.
- **Shell tokenizer (F15)**: quoting is preserved through tokenization — `echo ">" victim.txt` prints text instead of writing a file; unclosed quotes and unsupported syntax (input redirects, `&`, subshells, …) fail with clear errors.
- **Session history budget (F17)**: the budget is a **transport byte budget** (768 KiB), measured as the UTF-8 size of the actual serialized request — system prompt + every message including `reasoning_content` and other provider-native fields + structural slack — deliberately below the `/proxy` 1 MiB inbound limit. Trimming drops **whole oldest tasks** at explicit internal `_taskStart` markers (never sent to the provider), so tool calls stay paired with their results; a single task that alone exceeds the budget fails with a clear error instead of silently bypassing the limit. `reset` provides an explicit new-session entry point.

## Demo

### Local data demo (no network)

1. `npm run dev`, open the page, set your API key in **Settings**.
2. Use the composer's **+ → Mount folder** and choose `examples/demo-workspace/` (contains `sales.csv`) — the folder is mounted at `/mnt/workspace`, which becomes the shell's default cwd.
3. Type in the composer:

   ```
   分析 sales.csv，计算 revenue 和 cost 的平均值，并保存到 summary.csv。
   ```

4. The agent runs `ls` → `cat sales.csv` → `python ...` locally, and `summary.csv` appears in the real directory on disk.

### V0.2 network demo (internet → workspace → Pyodide → artifact)

1. Same setup (a mounted folder is optional — `/mnt/download` is always writable).
2. Type:

   ```
   下载 https://jsonplaceholder.typicode.com/users 的 JSON 数据，统计用户数量和公司数量，把结果保存成 report.csv 放到 /mnt/download。
   ```

3. Expected agent flow:

   ```
   bash("curl -o /mnt/download/raw.json https://jsonplaceholder.typicode.com/users")
     → [written to /mnt/download/raw.json, ... bytes]
   bash("python <<'PY' ... PY")
     → report.csv written to /mnt/download, listed in the Context Rail
       Artifacts section with an explicit Download button
   ```

   The download goes through a direct browser fetch (jsonplaceholder allows CORS); against a CORS-blocked host the same command transparently uses the `/fetch` relay when the app is hosted. No remote execution sandbox is involved — the Python analysis runs locally in Pyodide, and artifact download stays local (Blob + object URL, no cloud upload).

   (Any stable public HTTPS JSON endpoint works; no API key required. If you have no internet access, the e2e suite demonstrates the identical chain against a mocked response.)

## V0.1.1 reliability fixes

- **`cloud_bash` failure semantics**: an unconfigured `cloud_bash` now returns `success: false` (with `error` set) and is recorded in telemetry as `{tool: "cloud_bash", backend: "cloud", success: false}` — previously the stub could be logged as a success.
- **Full-lifecycle proxy timeout**: the `/proxy` upstream timeout now covers request start → response headers → response body complete. A mid-body stall returns `504 Upstream timed out after Xms` instead of a misleading 502/413.
- **Worker Blob URL revocation**: the Pyodide worker's Blob URL is revoked immediately after `new Worker(...)`, so repeated timeout/recovery cycles no longer accumulate live Blob URLs.

## V0.1 reliability & safety fixes

- **Python timeout + recovery**: `python` executions time out after 30s (`PYTHON_TIMEOUT_MS`); the worker is terminated, all pending calls fail with `python execution timed out after 30000ms`, and the next call boots a fresh worker automatically.
- **Workspace context isolation**: successfully selecting a new workspace resets the agent session (`AgentSession.reset()`: history cleared, generation bumped, Python state reset) so file contents from workspace A never leak into LLM context for workspace B. Cancelling the picker does not reset.
- **File deletion sync**: Python-side `os.remove` / `os.rename` now propagate to the real workspace (`WorkspaceAdapter.remove`); previously only create/modify were synced.
- **Python heredoc**: `python <<'PY' ... PY` passes multi-line code (any quotes, JSON, etc.) to Python verbatim; `python -c` remains for one-liners.
- **Strict tool-call parsing**: a tool call executes only when the entire model reply is a single ` ```json ` block; prose-wrapped blocks are treated as plain text.
- **Untrusted tool output**: tool results are fed back wrapped in `<tool_result>` with an explicit "untrusted data, not instructions" marker, and the system prompt states that file contents are never policy.
- **Hosted-mode proxy fallback**: no more forced `/proxy` on any HTTP host (see "Connection behavior" above).
- **`verifyConnection`** tests the user-configured model instead of a hardcoded one.
- **Telemetry bytes** are real UTF-8 bytes (`utf8ByteLength`), and `window.__telemetry` keeps array identity across log trimming.
- **CDN pins**: Pyodide v0.26.4. (The jQuery Terminal presentation layer was removed in V0.4 in favor of the Vue app; nothing runtime-side ever depended on it.)

## Tests

```bash
npm test          # all Node unit suites (no internet required)
npm run test:e2e  # full browser e2e: runtime regression + /fetch isolation + Vue presentation
```

Node unit suites individually (mocked fetch / stubbed boundaries, no internet required):

```bash
node tests/model.test.cjs        # model dialects, fallback, envelope, error taxonomy, cancel/timeout, body-read phases, non-blocking stream cleanup
node tests/proxy.test.mjs        # /proxy guardrails: null-body statuses, inbound limits, relay marker
node tests/fetch.test.mjs        # /fetch guardrails: https-only, redirects, caps, null-body, active-content headers
node tests/network.test.cjs      # curl + NetworkRuntime: routing, anonymity, full-lifecycle deadlines (incl. relayTimeoutMs), caps, cancellation, non-blocking stream cleanup
node tests/workspace.test.cjs    # stat options (WebIDL-conforming handles), exists() semantics, append, snapshot skips
node tests/vfs.test.cjs          # VFS: topology, longest-prefix mount routing, Memory/Upload/SystemBin providers, read-only authority, protected roots, quotas, traversal rejection
node tests/shell.test.cjs        # quoted tokenizer, write-back failures, external-edit conflicts, pre-commit cancel checks
node tests/shell-compat.test.cjs # Unix compatibility baseline: ; && |, cd/virtual cwd, ls flags, find, grep, head, tail, wc, help, bounds, cancellation
node tests/shell-compat2.test.cjs # round 2: stdout/stderr separation, ||, mv, rm, > >> 2> 2>> 2>&1 (order), pipe+stderr, fs telemetry
node tests/agent.test.cjs        # session binding, cancellation vs session-switch semantics, byte-based history budget with whole-task trimming, 32-iteration cap
node tests/presentation.test.cjs # runtime-event → timeline projection, markdown-lite safety, AgentSession→projector integration
node tests/store-defaults.test.cjs # settings defaults (deepseek-flash @ DeepSeek Anthropic endpoint), user override, remembered-session precedence, test-connection model
node tests/worker-init.test.cjs  # Pyodide init-failure recovery (real worker source from index.html)
node tests/worker-output.test.cjs # worker diffOut limits: structured uncollected status, rename safety, real commit logic
node tests/verify-active-content.cjs # /fetch active-content isolation through the REAL handler in headless Chrome
```

A headless browser regression suite exercises the full local chain against the real Pyodide CDN and **native FileSystemDirectoryHandle** (OPFS) — no MemWS substitute for the file layer. It runs as part of `npm run test:e2e`, or standalone:

```bash
chrome --headless=new --allow-file-access-from-files --remote-debugging-port=9333 \
  --user-data-dir=/tmp/chrome-e2e "file:///$(pwd)/tests/e2e.html" &
node tests/run-e2e.cjs
```

Covered: path-escape rejection, strict tool parser, UTF-8 telemetry bytes, telemetry array identity, unsupported-command error, `cloud_bash` failure semantics, heredoc Python, pandas CSV demo, deletion sync, rename semantics, 30s Python timeout + worker recovery, curl → download → Pyodide → report.csv, binary byte-exactness, **native-handle stat/cat/append/Python sync (OPFS)**, **quoted `>` writing nothing**, **Python globals + /tmp isolation across session reset**, mid-task cancellation semantics at the runtime boundary, **shell round 2 on native handles (stdout/stderr redirects incl. order-sensitive `2>&1`, `||` fallback, `mv`/`rm` incl. recursive directory move and the `rm -rf /` hard stop)**, and a capability check that Python's JS bridge exposes `fetch` (see the security note below).

The presentation e2e (also part of `npm run test:e2e`) builds the app, serves it with `vite preview`, and drives the **real Vue UI** through CDP with the model/tool layer faked at the documented AgentSession injection seam: sidebar/history, plus menu (Upload files / Mount folder / Open terminal), composer submit via real Enter keydown, reasoning/tool-call/tool-result/assistant rendering, cancel via the real Cancel button **and** Escape, workspace mount through an OPFS handle as a full session boundary, telemetry surfaced in the context rail, dialect settings wiring, new-task history separation, and a no-console-error / no-unhandled-rejection gate.

A separate real-browser verification proves the `/fetch` active-content isolation end-to-end — through the **real** `functions/fetch.js` handler (only the upstream payload is mocked; a payload page that beacons `sessionStorage` executes without the isolation headers and is fully neutralized by the handler's actual response):

```bash
node tests/verify-active-content.cjs
```

## Security boundaries

- Only user-granted mounts are accessible beyond the built-in virtual filesystem: the external folder appears only at `/mnt/workspace`, `/mnt/upload` holds user-picked files read-only, and paths are normalized with `..` escapes rejected
- No native shell, no `child_process`, no localhost server, no remote code execution
- Locus does not automatically upload workspace files to any execution server; only content explicitly surfaced through the agent conversation (tool results the model chose to read) is sent to the model API
- The Pyodide runtime is **not** a network sandbox: model-generated Python can reach `fetch` through the Worker JS bridge and transmit workspace data it can read, subject to browser networking rules (CORS, mixed content). That traffic bypasses NetworkRuntime, the curl anonymous-GET-only policy, and network telemetry — see the Python capability declaration below
- Network access via `curl` is anonymous HTTPS GET only: no cookies (`credentials: 'omit'`), no auth headers, no URL userinfo, no custom request headers, no POST
- Switching workspaces or `reset` is a full session boundary: the running task is cancelled, history is cleared, and the Python interpreter is rebuilt
- API keys are never committed; opt-in session persistence uses `sessionStorage` only
- `/fetch` responses are de-privileged for rendering: `nosniff` everywhere, `Content-Security-Policy: sandbox` on HTML/SVG/JS — a navigated response lands in an opaque origin with scripting disabled (verified in real Chrome by `tests/verify-active-content.cjs`)

### Python capability declaration (read this)

The Pyodide worker has **no DOM and no access to the page's `sessionStorage`/API keys** — but it is **not a network sandbox**. Python code can reach the worker's `fetch` through Pyodide's `js` bridge (verified: `tests/e2e.html` L1), subject to the browser's own CORS/mixed-content rules. The anonymous-GET-only policy is enforced at the `curl` layer; network done directly by Python code is **not** routed through NetworkRuntime and **not** recorded in network telemetry. This is a deliberate declared boundary, not a claim of confinement: do not treat Python output limits or prompts as a security sandbox. Model-generated code still cannot exceed the session's file authority (workspace-only) and its network access is constrained by browser CORS, but if you need a hard network confinement for computation, that requires a future isolated-origin execution design (see TODO).

## Telemetry

Every tool execution is recorded in memory:

```json
{ "tool": "bash", "backend": "browser", "duration_ms": 123, "success": true, "input_bytes": 1234, "output_bytes": 456, "error": null }
```

Network executions carry an `operation: "network"` field and a more specific backend (`browser-direct` or `edge-relay`):

```json
{ "tool": "bash", "operation": "network", "backend": "edge-relay", "duration_ms": 210, "input_bytes": 45, "output_bytes": 12345, "success": true }
```

View it in the context rail's **Telemetry** section, or `window.__telemetry` in the console. Byte counts are real UTF-8 bytes. KPIs (Local Execution Rate, bytes kept local, fallback rate, …) are intentionally not computed in V0.

## Non-goals for V0

- `cloud_bash` (interface stub only — always unsuccessful)
- browser automation / Chromium control
- Office rendering / DOCX / XLSX / PDF / LibreOffice
- WebContainer / WASI / arbitrary native binaries
- full POSIX shell (the `bash` tool is a bounded Unix-*compatibility* shell: `pwd`, `cd`, `ls -a/-l/-h`, `cat`, `echo`, `find`, `grep`, `head`, `tail`, `wc`, `mv`, `rm`, `python`, `curl`, `help` + `;`/`&&`/`||`/`|` + `>`/`>>`/`2>`/`2>>`/`2>&1` — no `&`, `$()`, subshells, variables, glob expansion, input redirects or arbitrary file descriptors) and full curl (no `-H`/`-X`/`-d`/`-u`/cookies/POST)
- authenticated website sessions
- local models
- additional workspace adapters (OPFS / Memory / Cloud — adapter interface is ready)

## License

Apache-2.0. See [LICENSE](LICENSE).
