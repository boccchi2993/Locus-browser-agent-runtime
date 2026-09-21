# Locus Capability Boundaries

> This document defines what belongs in the browser runtime, what belongs in the harness, and what should stay outside the core.

## 1. The target machine

Locus is not trying to reproduce the Linux kernel or full POSIX ABI inside a browser tab.

The target is a **Unix-like agent userland** that is sufficient for the overwhelming majority of lightweight agent tasks.

From the model's point of view, the tab should feel like a small computer with familiar interfaces:

```
bash
edit
```

Inside `bash`, familiar userland commands and runtimes may include:

```
python
js
curl
cat
ls
grep
find
...
```

The model should not need to care whether those commands are implemented with Pyodide, WebAssembly, Web Workers, File System Access API, browser fetch, an edge relay, or a future cloud provider.

The implementation goal is not "Linux in JavaScript".

The goal is:

> **If a lightweight task can be expressed as computation + files + network, it should not require a cloud computer.**

## 2. Three runtime substrate capabilities

The browser runtime exists to make three underlying machine capabilities work reliably.

### 2.1 Execution

Execution runs local userland computation.

Current and target consumers include:

- Python through Pyodide,
- JavaScript in an isolated Worker,
- WebAssembly modules,
- future WASM ports of libraries or command-line programs.

Python and JavaScript are not separate architectural primitives. They are execution environments provided by the runtime.

### 2.2 Filesystem

The filesystem capability provides state.

It includes:

- the user-authorized workspace,
- reads and writes,
- path confinement,
- deterministic mutation,
- conflict detection,
- synchronization between local runtimes and the real workspace.

The model-facing `edit` capability is a reliable filesystem interface, not a separate storage system.

Likewise `cat`, `ls`, Python `open()`, JavaScript file APIs, and future Unix utilities should ultimately consume the same filesystem authority.

### 2.3 Network

The network capability provides Internet connectivity as bounded HTTP/HTTPS
request/response — nothing more.

`curl` is the Unix-facing frontend to this capability. It is not the
architectural primitive itself.

**v1 status:** the primitive now exists — `NetworkRuntime`
(src/network.js, docs/NETWORK-RUNTIME.md). It normalizes requests, enforces
scheme/method/size policy, routes between the browser fetch backend and the
edge relay, consumes the Approval Framework for side-effecting methods, and
reports an explicit error taxonomy. The model experiences ordinary HTTP;
CORS topology and backend routing are Harness-internal.

The long-term target is unchanged:

```
                     Network Runtime
                           |
          +----------------+----------------+
          |                |                |
        curl          Python HTTP         JS fetch
                       libraries
```

Examples of Python-side consumers may include:

- `requests`,
- `httpx`,
- `urllib`,
- `pyfetch`.

These consumers are NOT implemented in v1. The runtime should eventually
virtualize HTTP so they reuse the same Locus routing, policy, telemetry and
relay behavior instead of bypassing the harness.

The browser does not provide Linux raw sockets. Locus therefore virtualizes
useful Internet access at the HTTP/runtime layer rather than pretending to
expose a real TCP/IP stack. Arbitrary TCP/UDP, raw sockets and non-HTTP
protocols are unavailable, and the model-facing capability text never claims
otherwise.

## 3. Model-facing interface vs runtime substrate

These layers must not be confused.

A useful target is:

```
                Agent
                  |
           +------+------+
           |             |
         bash           edit
           |
   +-------+--------+
   |       |        |
 python    js      curl
   |       |        |
   +-------+--------+
           |
  Runtime Substrate
   execution / fs / network
```

The model-facing interface is deliberately Unix-like.

The internal substrate is deliberately browser-native.

This distinction lets implementation evolve without forcing the model to learn new tool schemas.

## 4. Runtime responsibilities

The runtime layer should provide the smallest reliable machine substrate necessary for the Unix-like interface.

It is responsible for:

- execution isolation,
- filesystem authority and synchronization,
- network routing and relay behavior,
- resource limits,
- cancellation,
- telemetry at the machine-capability boundary,
- backend/provider selection,
- transparent escalation where allowed.

It should not contain domain-specific business logic.

Examples that do **not** belong in the runtime core by default:

- Excel editing workflows,
- DOCX workflows,
- RAG pipelines,
- GitHub operations,
- email operations,
- ffmpeg-specific agent tools,
- LibreOffice-specific agent tools,
- compiler-specific agent tools,
- database-specific agent tools.

A runtime provider may implement a machine capability differently without changing the higher-level interface.

For example:

```
ShellService
  +-- BrowserShellProvider
  +-- future CloudShellProvider
```

or:

```
NetworkService
  +-- BrowserDirectProvider
  +-- EdgeRelayProvider
  +-- future other provider
```

## 5. Harness responsibilities

The harness composes capabilities into useful agent behavior.

It owns:

- the agent loop,
- model/provider protocol adaptation,
- capability discovery,
- tool and runtime orchestration,
- session state,
- permissions/approval boundaries,
- extension loading,
- Skills,
- Plugins,
- MCP integration,
- event delivery to the UI.

The harness should compose the machine; it should not continuously expand the machine's primitive set.

## 6. Extension boundaries

A useful rule is:

> **Capability composes them for the user.**  
> **Plugin adds code.**  
> **Skill adds knowledge.**  
> **MCP adds authority.**

The user operates on **Capabilities**, never on the internal components. A Capability
is a named bundle of local code (Plugins), on-demand knowledge (Skills) and external
authority requirements (MCP). Advanced UI may expand the components for inspection,
but the components are the internal composition — not three separate user-facing
configuration systems.

### 6.1 Plugin: code

Plugins provide implementation code, libraries, packages or local runtime capabilities.

Examples:

- openpyxl,
- python-docx,
- Pillow,
- BeautifulSoup,
- DuckDB-WASM,
- ffmpeg.wasm,
- a WASM compiler,
- a local embedding library.

A Plugin should normally reuse the existing execution/filesystem/network substrate.

Installing a library should not automatically create a new domain-specific core tool.

### 6.2 Skill: knowledge

Skills teach the model how to compose existing capabilities.

Examples:

- safely edit an Excel workbook,
- modify a DOCX template,
- inspect a repository before editing,
- perform a research workflow,
- choose when to use Python vs JavaScript,
- validate an artifact after modification.

Skills do not grant authority.

A Skill can depend on Plugins and MCP capabilities.

### 6.3 MCP: authority

MCP is appropriate when the agent needs external authority, durable remote state, credentials, or an auditable external action boundary.

Examples:

- GitHub,
- Gmail,
- Slack,
- Jira,
- Notion,
- enterprise APIs,
- databases,
- durable vector stores,
- authenticated retrieval systems.

MCP should be a first-class harness capability. It may have a shell/CLI compatibility frontend, but it should not be forced through stringly-typed bash commands because credentials, schemas, approvals and side effects deserve structured handling.

## 7. RAG boundary

RAG is not a runtime primitive.

There are two useful cases.

### 7.1 Ephemeral local retrieval

If the task is local and temporary, retrieval can be assembled from ordinary machine capabilities.

Examples:

- grep/ripgrep-like search,
- BM25 over current workspace files,
- local chunking,
- a temporary embedding index,
- a Plugin-provided local vector library.

This belongs to Plugin + Skill composition over bash/filesystem/compute.

### 7.2 Durable or external retrieval

If retrieval uses:

- a persistent vector database,
- shared organizational knowledge,
- remote embeddings,
- authenticated data,
- durable cross-session indexes,
- enterprise permissions,

it belongs naturally behind MCP or another explicit external-authority provider.

In both cases, Locus core does not need a `rag_search` primitive.

## 8. Internet is a machine capability, not just a curl command

The current implementation exposes browser Internet access primarily through `curl`.

That is an implementation stage, not the final abstraction.

The target is for programs running under bash to reuse the same network capability where practical:

```
python script
  -> requests/httpx/urllib
  -> Locus network bridge
  -> direct browser request or relay

javascript
  -> fetch-compatible bridge
  -> Locus network bridge

curl
  -> Locus network bridge
```

This preserves the Unix illusion: a model may write a normal Python program with multiple HTTP requests instead of manually decomposing every request into separate outer tool calls.

If browser constraints require an internal RPC, HTTP shim or relay, that is a runtime implementation detail.

## 9. Escalation boundaries

Some workloads cannot be faithfully implemented inside a browser tab.

Examples may include:

- native Linux binaries with no practical WASM port,
- raw TCP/UDP requirements,
- heavyweight compilation,
- large memory/CPU workloads,
- CUDA/GPU workloads,
- long-running daemons,
- privileged OS APIs,
- some desktop rendering stacks,
- full browser automation with authenticated sessions.

These should trigger an explicit capability/provider boundary:

- Plugin/WASM where feasible,
- MCP for external authority/services,
- browser automation capability when appropriate,
- future `cloud_bash` for a genuine remote computer.

The 1% exception should not force the other 99% of lightweight tasks into a cloud sandbox.

## 10. Admission rule for new core capabilities

Before adding a new core capability, ask:

1. Can this be expressed as execution + filesystem + network?
2. Can a Plugin provide the missing code?
3. Can a Skill provide the missing workflow knowledge?
4. Is the missing piece actually external authority and therefore MCP?
5. Is it genuinely a machine capability unavailable in the current runtime?
6. Does it require a new permission boundary?

If the answer is simply "this domain would be convenient to have as a dedicated tool", it probably does not belong in core.

## 11. Capability composition runtime (v1, implemented)

The composition layer exists (`src/extensions.js`, `tests/capability-composition.test.cjs`,
`tests/e2e-capabilities.cjs`). It is architecture + mechanism only: the PRODUCTION
catalogs are deliberately empty, and no product capability (spreadsheet, DOCX, PDF,
GitHub, ...) is decided yet. Everything proven below uses TEST-ONLY synthetic
descriptors injected through the manager constructor / e2e seam.

### 11.1 Objects

```
CapabilityRegistry / PluginRegistry / SkillRegistry
      (one validated catalog set per CapabilityManager; invalid trusted
       catalogs FAIL LOUDLY at load — never skip-and-continue)
CapabilityManager
      enable / disable / setMcpState / listCapabilities
      resolves + dedupes components by id (shared components stay
      active while ANY enabled capability references them)
TaskEnvironment
      immutable per-task snapshot built by the harness at task start:
      { capabilities, plugins (+ prepared payloads), skills, mcps,
        pythonExtensionKey } — deeply frozen
```

```
User enables Capability
        |
CapabilityManager.resolve
        |
Plugins + Skills + MCP requirements   (deduped by id)
        |
TaskEnvironment snapshot (frozen)
        |
AgentSession (per task: workspace binding + TaskEnvironment binding)
```

Capability states: `disabled` (not added), `needs-connection` (enabled locally, an
MCP authority is not connected), `ready` (all required components available),
`error` (local resolution failed — e.g. a plugin runtime whose provider is missing).
`needs-connection` is never disguised as `ready`.

### 11.2 Plugin semantics (v1)

- Descriptor authority is ALWAYS `none`; any other authority is rejected at
  validation. Plugins never gain network, browser-credential, DOM, API-key,
  arbitrary parent-RPC or MCP authority.
- `PluginRuntimeProvider` is the generic runtime seam
  (`prepare(plugin, context) -> { files, imports }`); python / javascript / wasm
  are recognized runtimes, but v1 exercises exactly one provider kind (python,
  tests only). A future verified wheel loader plugs in here without touching the
  Capability / Skill / Agent model.
- Python plugin lifecycle: TaskEnvironment snapshot -> harness configures the
  payload -> Python worker boots -> all enabled plugin modules installed into
  site-packages -> smoke import -> READY. After that, `import <module>` works
  like any preinstalled package. There is NO lazy-install-on-import, no runtime
  download, no retry loop. A broken payload fails the boot closed.
- Plugin payloads ride the bootstrap MESSAGE (post-`loadPackage`, pre-lockdown);
  the F04c `PYTHON_BOOTSTRAP_MANIFEST` trust boundary is untouched.

### 11.3 Skill semantics (v1)

- Skills are trusted harness content: descriptor + guide body supplied by the
  catalog, mounted read-only (`system-read-only`) at the FIXED path
  `/usr/local/share/locus/skills/<skill-id>/SKILL.md`. Workspace files, uploads
  and URLs can never shadow or supply a skill.
- The system prompt carries the capability INDEX only: display names, guide paths,
  honest availability phrasing. NEVER a skill body, plugin id, package manifest,
  hash or Locus-internal API name. The model reads a guide with `cat` when — and
  only when — the task needs it; the body then enters history as ordinary tool
  output inside the existing `HISTORY_BUDGET_BYTES` accounting (lazy loading is
  the token-budget feature).

### 11.4 MCP semantics (v1)

- A capability references MCP requirements by id; the requirement state
  (`connected` / `needs-connection` / `unavailable`) lives in the manager.
- Enabling a capability NEVER authorizes anything. Until an explicit connection
  decision, requirements are `needs-connection`; the system prompt says the
  authority is NOT available. No connector, transport, OAuth or credential
  storage exists in v1.

### 11.5 Snapshot + VFS semantics

- `AgentSession.run(text, { workspace, taskEnvironment })` binds BOTH immutably
  per task. UI enable/disable mutates the manager only; a running task keeps
  its snapshot; changes apply to the NEXT `buildTaskEnvironment()`.
- Per-task VFS forks mount: skill guides, `/mnt/plugins/<id>/plugin.json`
  (safe descriptor introspection) and
  `/usr/local/share/locus/capabilities/<id>/capability.json` (resolved safe
  metadata + state) — all read-only, no payload bytes, secrets or internal
  references. An empty environment mounts nothing.

### 11.6 Deliberately not in v1

No real product capabilities, no marketplace / remote manifests / plugin store,
no MCP connector or OAuth, no PyPI / micropip / wheel-solver commitment, no
persistent capability preferences (page-session only; reload resets), no new
model-facing tools (`AGENT_TOOL_DEFINITIONS` stays bash + cloud_bash).

## 12. Summary

The intended architecture is:

```
+---------------------------------------------------+
|                      Agent                        |
+---------------------------------------------------+
|                   Harness Layer                   |
|                                                   |
|       Skills        Plugins          MCP          |
|       knowledge     code             authority    |
|                                                   |
|        composition / session / agent loop         |
+---------------------------------------------------+
|               Unix-like Interface                 |
|                                                   |
|                    bash      edit                  |
|                     |                              |
|       python / js / curl / Unix utilities         |
+---------------------------------------------------+
|                Runtime Substrate                  |
|                                                   |
|          Execution   Filesystem   Network          |
|              |           |          |             |
|          Pyodide/    Workspace   fetch/relay      |
|          WASM/Worker APIs       /internal RPC     |
+---------------------------------------------------+
|                    Browser                        |
+---------------------------------------------------+
```

Locus is not a collection of browser tools.

> **Locus is a Unix-like execution substrate for agents, implemented inside a browser tab.**

The browser is the default machine. The harness composes it. Extensions add code, knowledge and authority. Heavier computers are escalation providers, not the starting point.
