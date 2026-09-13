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

Status: implemented (`src/agent.js` `AgentSession` + event adapter in `src/ui.js`; Node coverage in `tests/agent.test.cjs`).

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

## V0.4 — UI rebuild and runtime substrate completion

Goal: make the UI reflect an execution harness rather than a terminal-only demo, while finishing the target runtime substrate.

### Vue UI

Rebuild the presentation layer with Vue 3 + Vite after the runtime loop is UI-independent.

The UI should present:

- user messages,
- assistant output,
- collapsible reasoning when available,
- tool calls,
- tool results,
- execution backend,
- workspace state,
- errors and retries,
- telemetry/debug information.

The terminal aesthetic may remain, but terminal rendering should not define the runtime architecture.

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
