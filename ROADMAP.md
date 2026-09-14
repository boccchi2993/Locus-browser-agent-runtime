# Locus Roadmap

This roadmap describes architectural milestones, not every implementation task.

The project should prefer depth and semantic correctness over rapidly expanding the number of tools.

## V0.2 — Browser-native network execution

Status: implemented.

Completed:

- local workspace access,
- Python execution in Pyodide Worker,
- local file create/modify/delete/rename sync,
- browser-local curl compatibility command,
- direct browser fetch,
- transparent /fetch relay fallback,
- provider-agnostic model /proxy relay,
- execution telemetry,
- regression coverage for model/network/proxy/runtime behavior.

The V0.2 milestone proves:

> internet data -> browser/edge connectivity -> local workspace -> local compute -> local artifact

without requiring a remote execution sandbox.

## V0.2.1 — Network semantic cleanup

Status: implemented (completed in later commits; regression coverage in `tests/network.test.cjs`).

Goal: make direct browser networking obey the same resource semantics as the edge relay.

Completed:

- timeout on browser-direct network reads,
- browser-direct response-size cap,
- bounded streaming/reads instead of unbounded `arrayBuffer()`,
- `curl -o` fails before any network request when no workspace is selected,
- consistent direct/relay timeout and error semantics.

No new model-facing capability was introduced in this milestone.

## V0.3 — Architecture stabilization

Goal: separate the agent runtime from presentation and preserve model-native conversation semantics.

### Agent/UI separation

Status: implemented (`src/agent.js` `AgentSession`; terminal adapter removed in V0.4 — the Vue presentation store now consumes the event stream; Node coverage in `tests/agent.test.cjs`).

- [x] remove direct terminal/DOM dependencies from the agent loop,
- [x] replace runAgentTask(term, ...) style coupling,
- [x] introduce an AgentSession or equivalent runtime object,
- [x] expose structured runtime events,
- [x] inject workspace/model/execution dependencies rather than reading UI globals,
- [x] make the full agent loop testable without presentation code.

### Model protocol refactor

Status: implemented (`src/model-adapters.js` ProviderAdapter boundary + provider-neutral transport in `src/model.js`; Node coverage in `tests/model-adapters.test.cjs`).

- replace string-only callModelText semantics with structured model responses,
- separate visible assistant content from provider-native replay state,
- preserve reasoning/continuation state when required,
- keep opaque provider state intact,
- isolate provider-specific serialization/parsing/replay behind the ProviderAdapter interface,
- explicit API dialect override (auto/openai/anthropic) for arbitrary endpoints, provider identity decoupled from dialect,
- support reasoning presentation independently from transport,
- ensure workspace/session switching scopes all provider state.

See docs/MODEL-PROTOCOL.md.

### Unix compatibility shell baseline

Status: implemented (`src/shell.js` parser/executor + `SHELL_COMMANDS` registry; Node coverage in `tests/shell-compat.test.cjs`, browser coverage in `tests/e2e.html` section N).

Goal: accept the small Unix vocabulary capable models already speak, so telemetry records genuinely unknown capability gaps instead of known low-level compatibility gaps.

- [x] bounded command composition parsed by Locus itself (`;`, `&&`, `||`, `|`; no eval, no system shell),
- [x] invocation-local virtual cwd (`cd`), every bash call starts at the workspace root, confinement preserved,
- [x] `ls -a/-l/-h` incl. combined flags; `find`/`grep`/`head`/`tail`/`wc` subsets with explicit bounds and cancellation,
- [x] pipeline stdin consumers (`cat`/`grep`/`head`/`tail`/`wc`); piping into non-consumers fails loudly; 1 MiB inter-stage cap fails loudly; pipelines forward stdout only,
- [x] stdout/stderr separated inside the executor; generalized redirection (`>`, `>>`, `2>`, `2>>`, `2>&1`) applied left to right,
- [x] `mv` / `rm` as workspace-confined, cancellation-aware filesystem commands (`rm -rf /` hard-refused),
- [x] one canonical capability registry drives runtime dispatch, `help`, and the system prompt,
- [x] tool iteration budget raised 15 → 32.

Explicitly deferred: `&`, `$()`, backticks, subshells, variables/export, glob expansion, input redirects, arbitrary file descriptors, `sed`/`awk`/`xargs`/`jq`/`sort` and friends.

## V0.4 — UI rebuild and runtime substrate completion

Goal: make the UI reflect an execution harness rather than a terminal-only demo, while finishing the target runtime substrate.

### Vue UI

Status: implemented (Vue 3 + Vite; `src/main.js`, `src/App.vue`, `src/components/`, `src/ui/store.js` + pure projector `src/ui/projector.js`; Node coverage in `tests/presentation.test.cjs`, real-browser UI coverage in `tests/e2e-ui.cjs`).

The presentation is a Cowork-style agent workspace — a left task-history sidebar (New task / search / recents), a quiet centered timeline, a bottom composer with a `+` context menu (Upload files / Mount folder / Open terminal), and a collapsible right rail for progress / working folder / context / telemetry. Everything rendered is projected from AgentSession runtime events; the timeline is never used to rebuild provider history.

The UI presents:

- user messages,
- assistant output (markdown-lite, escape-first),
- collapsible reasoning when available (full content preserved; `summary` presentation labeled),
- tool calls (collapsible, long inputs folded),
- tool results (with backend badge taken only from event metadata: browser / browser-direct / edge-relay / cloud),
- workspace state (composer chip + rail, mount = real session boundary),
- errors and warnings,
- busy/cancel state (composer Cancel button + Escape),
- telemetry in the context rail.

Deferred seams, honestly marked in the UI rather than faked: file-upload attachments (no runtime pipeline yet), the terminal drawer (reserved, not wired), durable cross-reload conversation persistence (recents live for the page session only).

### JavaScript userland runtime

Add isolated JavaScript execution.

Requirements:

- dedicated Web Worker,
- no model-controlled eval in the application UI context,
- no direct access to DOM, API keys, application globals, or session state,
- explicit bridge for permitted inputs/outputs,
- lifecycle timeout and recovery semantics comparable to Python.

### Deterministic edit capability

Add deterministic file editing/state mutation.

Initial semantic operations may include:

- read,
- write,
- replace exact text,
- insert,
- delete/rename where appropriate.

Deterministic edits should fail clearly when a requested match is absent or ambiguous.

The final decision on whether edit is exposed as a shell compatibility command or a structured tool should be based on model reliability, not aesthetics.

## Core Capability Freeze

After V0.4, the default runtime target is:

```
Runtime substrate:
  Execution
  Filesystem
  Network

Unix-like interface:
  bash
  edit

Userland examples:
  Python
  JavaScript
  curl
  file/Unix utilities

Escalation:
  cloud_bash (future provider)
```

Python/JavaScript are execution environments and `curl` is a network frontend; they are not separate architectural primitives.

At this point, new domain-specific features should normally be implemented as extensions instead of new runtime primitives.

A new core proposal must explain why it cannot be expressed through:

- execution + filesystem + network,
- Plugin,
- MCP,
- Skill,
- or an execution backend/provider.

See `docs/CAPABILITY-BOUNDARIES.md`.

## V0.5 — Extension layer

Goal: allow the system to grow without expanding the core tool surface.

### Capability registry

Introduce a provider-neutral registry describing available capabilities and dependencies.

The registry should support:

- availability,
- required substrate capabilities,
- runtime/provider,
- authority level,
- optional dependencies,
- capability discovery.

### Plugins

Plugins add implementation code or libraries above the runtime substrate.

Examples:

- openpyxl,
- python-docx,
- Pillow,
- BeautifulSoup,
- DuckDB-WASM,
- ffmpeg.wasm,
- future WASM compilers.

The first plugin system should be intentionally small. Do not start with a marketplace.

### Skills

Skills add task knowledge and composition guidance without adding authority.

Examples:

- safe Excel editing,
- document template workflows,
- repository modification workflow,
- validation strategies.

### MCP

MCP adds external authority, durable remote state, credentials, or structured access to remote systems. Durable/shared RAG belongs naturally here; ephemeral local retrieval may remain Plugin + Skill composition.

Examples:

- GitHub,
- email,
- Slack,
- Jira,
- Notion,
- databases,
- enterprise APIs.

MCP credentials and permissions must remain explicit.

## Later milestones

These are deliberately not scheduled into the current core work.

### Cloud execution provider

Implement cloud_bash only when there is a real workload that cannot be expressed by the browser/local runtime.

The cloud backend should be an escalation provider, not the default execution environment.

### Rendering and visual QA

Document/image rendering may become a capability provider or plugin-backed workflow.

Potential uses:

- DOCX/PDF visual verification,
- screenshot-based artifact QA,
- chart/document layout validation.

### Browser automation

Authenticated browser interaction, DOM control, cookies, and user-session automation form a different authority boundary from public curl access.

If implemented, it should be treated as its own capability seam rather than quietly added to curl.

### Native/WASM ecosystem

Native tools such as ffmpeg, LibreOffice, or compilers should not become core simply because they are useful.

Possible future implementations include:

- WASM plugins,
- WebContainer-style providers,
- MCP services,
- cloud execution providers,
- community-maintained adapters.

The core should keep the path open without implementing every environment itself.
