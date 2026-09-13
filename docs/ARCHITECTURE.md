# Locus Architecture

> Status: architecture target for the post-V0.2 line.  
> This document defines the invariants of Locus. Implementation may lag behind it; changes to these invariants should be deliberate.

## 1. What Locus is

Locus is a browser-native execution harness for AI agents.

More precisely:

> **Locus is a Unix-like execution substrate for agents, implemented inside a browser tab.**

It presents familiar computer interfaces to the model while routing operations to the cheapest, closest, least-privileged environment that can reliably complete them.

Three short rules summarize the project:

> **Model decides WHAT. Harness decides WHERE.**

> **Normalize capabilities. Preserve model semantics.**

> **If a lightweight task can be expressed as computation + files + network, it should not require a cloud computer.**

Locus is not trying to emulate the Linux kernel or a full POSIX ABI. It is trying to reproduce enough Unix-like userland semantics that an agent can treat a browser tab as its default lightweight computer.

See [CAPABILITY-BOUNDARIES.md](CAPABILITY-BOUNDARIES.md) for the detailed runtime / harness / extension boundary.

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

Domain-specific features should not become runtime capabilities merely because they are useful.

Excel, DOCX, image processing, RAG, scraping helpers, archive formats, database clients, SDKs, and similar capabilities should normally be expressed by combining execution, filesystem and network with extensions.

A proposed new core capability must first answer:

> Why can this not be expressed reliably through the existing runtime substrate plus a Plugin, MCP integration, or Skill?

### 2.4 No silent authority expansion

Execution placement may change transparently, but authority must not.

Moving work from browser-local execution to an external service or cloud backend must not silently grant access to data, credentials, or side effects that the original capability did not have.

## 3. Runtime substrate and Unix-like interface

The runtime layer exists to make three machine capabilities reliable inside a browser tab:

### Execution

Execution runs local userland computation.

Current and target environments include Python through Pyodide, JavaScript through an isolated Worker, WebAssembly modules, and future WASM ports of useful command-line programs.

Python and JavaScript are execution environments, not independent architectural primitives.

### Filesystem

Filesystem provides state and local authority.

It includes the user-authorized workspace, path confinement, reads and writes, synchronization, conflict detection, resource bounds, and deterministic mutation.

The model-facing `edit` capability is a reliable interface to this same filesystem authority.

### Network

Network provides Internet connectivity.

The current implementation exposes this primarily through `curl`, but `curl` is a Unix-facing consumer of the network capability, not the network primitive itself.

The target is for `curl`, Python HTTP libraries, and JavaScript networking to reuse the same Locus network boundary where practical.

The model-facing machine should remain small:

```
Agent
  |
  +-- bash
  |    +-- python
  |    +-- js
  |    +-- curl
  |    +-- file/userland commands
  |
  +-- edit
  |
  +-- cloud_bash   (future escalation provider)
```

`bash` is the Unix-like execution facade. `edit` exists because deterministic structured mutation is particularly useful for agents. `cloud_bash` is a future escalation provider, not another local primitive.

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

The current implementation has not yet fully virtualized Python-originated networking through NetworkRuntime. Pyodide can still reach Worker `fetch` through the JS bridge. That is a declared implementation gap, not the target architecture.

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

A plugin should declare the runtime capabilities it requires and the code/library capability it provides.

Example direction:

```json
{
  "name": "openpyxl",
  "requires": ["execution:python", "filesystem"],
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

A Skill may depend on runtime capabilities, Plugins, and MCP capabilities.

## 6. Capability registry direction

Future extension work should converge on a capability registry rather than an ever-growing list of special-case tools.

A capability can describe:

- identifier,
- required substrate capabilities,
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
- provider-specific model features exposed as generic core tools.

Some of these may later be implemented as Plugins, MCP integrations, Skills, browser capabilities, or cloud providers.

The absence of a native implementation today is not a reason to put a domain-specific abstraction into core.

## 10. Core freeze criterion

The core capability surface can be considered ready to freeze when all of the following are true:

- the browser runtime reliably provides execution,
- the browser runtime reliably provides filesystem/state,
- the browser runtime reliably provides network connectivity through a common capability boundary,
- Python and JavaScript behave as userland execution environments rather than special architectural cases,
- deterministic edit/state mutation exists,
- workspace authority boundaries are explicit,
- browser/edge routing semantics are consistent,
- model protocol preserves provider-native continuation semantics,
- the agent loop is UI-independent and testable without DOM presentation,
- extension capabilities can be registered without modifying the agent loop,
- workloads outside browser capability have an explicit escalation/provider path.

After this point, additions to runtime/core should require a substantially higher bar than additions to the extension layer.
