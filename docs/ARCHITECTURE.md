# Locus Architecture

> Status: architecture target for the post-V0.2 line.  
> This document defines the invariants of Locus. Implementation may lag behind it; changes to these invariants should be deliberate.

## 1. What Locus is

Locus is a browser-native execution harness for AI agents.

It presents familiar computer interfaces to the model while routing each operation to the cheapest, closest, least-privileged environment that can reliably complete it.

Two short rules summarize the project:

> **Model decides WHAT. Harness decides WHERE.**

> **Normalize capabilities. Preserve model semantics.**

Locus is not trying to emulate a full Linux machine inside the browser. It is trying to expose a small, stable capability surface that models already understand, then map those capabilities onto browser, edge, external-service, or future cloud execution backends.

## 2. Core invariants

### 2.1 Execution placement

Prefer, in order:

1. execution next to the user's data,
2. the least privileged environment that can complete the task,
3. the cheapest reliable backend,
4. transparent escalation only when the current environment cannot complete the task.

A lightweight file or data task should not require a remote sandbox merely because the caller is an AI agent.

### 2.2 Stable model-facing interfaces

The model should not need to know whether a capability is implemented with:

- JavaScript,
- Web Workers,
- Pyodide,
- WebAssembly,
- File System Access API,
- direct browser fetch,
- an edge relay,
- or a future remote sandbox.

Those are harness decisions.

### 2.3 Minimal core

Domain-specific features should not become core primitives merely because they are useful.

Excel, DOCX, image processing, scraping helpers, archive formats, database clients, SDKs, and similar capabilities should normally be expressed by combining core primitives with extensions.

A proposed new core primitive must first answer:

> Why can this not be expressed reliably through the existing primitives plus a Plugin, MCP integration, or Skill?

### 2.4 No silent authority expansion

Execution placement may change transparently, but authority must not.

Moving work from browser-local execution to an external service or cloud backend must not silently grant access to data, credentials, or side effects that the original capability did not have.

## 3. Target core primitives

The target core capability surface is intentionally small.

### Compute

- **Python** — currently implemented with Pyodide in a dedicated Web Worker.
- **JavaScript** — target primitive; should run in an isolated Worker, not via model-controlled eval in the application UI context.

### State

- **Workspace** — user-authorized local filesystem boundary.
- **Edit** — deterministic file mutation primitive. It should support precise operations such as read, write, replace-exact, and insert without requiring a heavyweight compute runtime.

### Connectivity

- **curl** — public HTTPS connectivity exposed through the local shell abstraction.
  - direct browser fetch first,
  - edge relay only when browser networking prevents the request,
  - binary-safe downloads,
  - no hidden escalation to remote execution.

### Escalation

- **cloud_bash** — reserved future fallback for workloads that cannot be completed by the local/browser capability set.
- It is not part of the current execution path and must fail explicitly while unconfigured.

The intended end state is roughly:

```
Agent
  |
  +-- bash
  |    +-- js      -> isolated JS runtime
  |    +-- python  -> Pyodide
  |    +-- curl    -> NetworkRuntime
  |    +-- file commands -> Workspace
  |
  +-- edit         -> deterministic workspace mutation
  |
  +-- cloud_bash   -> future escalation backend
```

Whether `edit` remains a shell command or becomes a structured model-facing tool is an implementation decision to be validated with real model behavior. The semantic capability is the important part.

## 4. Current execution layers

As of V0.2:

```
User
  |
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

Model API connectivity is separate:

```
Model adapter
  +-- direct provider API
  +-- /proxy relay only on network/CORS failure
```

The `/proxy` and `/fetch` relays are intentionally separate because they carry different authority and protocol semantics.

## 5. Extension model

Locus extensions should fall into three distinct categories.

> **Plugin adds code.**  
> **MCP adds authority.**  
> **Skill adds knowledge.**

### 5.1 Plugins

Plugins extend implementation capability without necessarily adding new model-facing tools.

Examples:

- openpyxl
- python-docx
- Pillow
- BeautifulSoup
- DuckDB-WASM
- ffmpeg.wasm
- a future compiler compiled to WASM

A plugin should declare the primitives it requires and the runtime capability it provides.

Example direction:

```json
{
  "name": "openpyxl",
  "requires": ["python"],
  "provides": ["python-package"],
  "packages": ["openpyxl"]
}
```

Installing an Excel library should not automatically create an `excel_edit` tool. The model can continue using familiar Python and edit capabilities.

### 5.2 MCP

MCP integrations connect Locus to external authority and remote state.

Examples:

- GitHub
- Gmail
- Slack
- Jira
- Notion
- databases
- enterprise internal APIs

MCP is appropriate when a capability involves credentials, remote permissions, structured external actions, or authority that should be explicit and auditable.

An MCP server is not merely a substitute for `curl`.

### 5.3 Skills

Skills teach the model how to compose capabilities safely and effectively.

Examples:

- edit an Excel workbook while preserving formulas,
- modify a DOCX template and validate the result,
- inspect a repository before editing,
- choose between JS and Python for a workload.

Skills do not grant new authority.

A Skill may depend on core primitives, Plugins, and MCP capabilities.

## 6. Capability registry direction

Future extension work should converge on a capability registry rather than an ever-growing list of special-case tools.

A capability can describe:

- identifier,
- required primitives,
- provider/backend,
- authority level,
- availability,
- optional dependencies,
- presentation metadata.

The registry should support multiple providers for the same semantic capability without forcing the model to care which provider is active.

This is a capability seam, not a plugin marketplace requirement.

## 7. Model protocol is a separate boundary

Execution normalization must not destroy provider/model semantics.

The model layer must preserve provider-native continuation state when required for correct multi-turn behavior, including reasoning state, opaque blocks, tool-call state, or provider metadata.

Visible assistant text is not the complete conversation state.

See [MODEL-PROTOCOL.md](MODEL-PROTOCOL.md).

## 8. UI is not the agent loop

The agent runtime must not depend on Vue, jQuery Terminal, DOM nodes, spinners, or presentation components.

The target shape is an event-producing session/runtime:

```
user input
  -> AgentSession
  -> model response
  -> reasoning/tool/final events
  -> execution
  -> provider-native history update
```

Possible consumers:

- Vue UI,
- CLI UI,
- tests,
- embedded integrations,
- debugging tools.

The UI consumes runtime events; it does not define agent semantics.

## 9. What does not belong in core by default

The following are not automatically core features:

- Excel-specific tools,
- DOCX-specific tools,
- PDF-specific tools,
- ffmpeg-native integration,
- LibreOffice desktop integration,
- compiler-specific tools,
- GitHub-specific tools,
- email-specific tools,
- browser automation,
- authenticated website sessions,
- provider-specific model features exposed as generic execution primitives.

Some of these may later be implemented as Plugins, MCP integrations, Skills, browser capabilities, or cloud providers.

The absence of a native implementation today is not a reason to put a domain-specific abstraction into core.

## 10. Core freeze criterion

The core capability surface can be considered ready to freeze when all of the following are true:

- Python compute is reliable and isolated.
- JavaScript compute is reliable and isolated.
- deterministic edit/state mutation exists.
- public HTTPS connectivity through curl is reliable.
- workspace authority boundaries are explicit.
- browser/edge routing semantics are consistent.
- model protocol preserves provider-native continuation semantics.
- the agent loop is UI-independent and testable without DOM presentation.
- extension capabilities can be registered without modifying the agent loop.

After this point, additions to core should require a substantially higher bar than additions to the extension layer.
