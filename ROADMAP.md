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

Goal: make direct browser networking obey the same resource semantics as the edge relay.

Tasks:

- add timeout to browser-direct network reads,
- add browser-direct response-size cap,
- stream/read with bounded memory where practical,
- check workspace availability before starting curl -o downloads,
- keep direct and relay error semantics consistent.

No new model-facing capability should be introduced in this milestone.

## V0.3 — Architecture stabilization

Goal: separate the agent runtime from presentation and preserve model-native conversation semantics.

### Agent/UI separation

- remove direct terminal/DOM dependencies from the agent loop,
- replace runAgentTask(term, ...) style coupling,
- introduce an AgentSession or equivalent runtime object,
- expose structured runtime events,
- inject workspace/model/execution dependencies rather than reading UI globals,
- make the full agent loop testable without presentation code.

### Model protocol refactor

- replace string-only callModelText semantics with structured model responses,
- separate visible assistant content from provider-native replay state,
- preserve reasoning/continuation state when required,
- keep opaque provider state intact,
- support reasoning presentation independently from transport,
- ensure workspace/session switching scopes all provider state.

See docs/MODEL-PROTOCOL.md.

## V0.4 — UI rebuild and core primitive completion

Goal: make the UI reflect an execution harness rather than a terminal-only demo, while finishing the target core primitive set.

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

### JavaScript primitive

Add isolated JavaScript execution.

Requirements:

- dedicated Web Worker,
- no model-controlled eval in the application UI context,
- no direct access to DOM, API keys, application globals, or session state,
- explicit bridge for permitted inputs/outputs,
- lifecycle timeout and recovery semantics comparable to Python.

### Edit primitive

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

After V0.4, the default core target is:

```
Compute:
  JavaScript
  Python

State:
  Workspace
  Edit

Connectivity:
  curl

Escalation:
  cloud_bash (future provider)
```

At this point, new domain-specific features should normally be implemented as extensions instead of new core primitives.

A new core proposal must explain why it cannot be expressed through:

- existing primitives,
- Plugin,
- MCP,
- Skill,
- or an execution backend/provider.

## V0.5 — Extension layer

Goal: allow the system to grow without expanding the core tool surface.

### Capability registry

Introduce a provider-neutral registry describing available capabilities and dependencies.

The registry should support:

- availability,
- required primitives,
- runtime/provider,
- authority level,
- optional dependencies,
- capability discovery.

### Plugins

Plugins add implementation code or libraries.

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

MCP adds external authority and structured access to remote systems.

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
