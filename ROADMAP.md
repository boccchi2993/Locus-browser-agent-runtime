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
- [x] `ls -a/-l/-h` incl. combined flags; `find`/`grep`/`head`/`tail`/`wc`/`sort` subsets with explicit bounds and cancellation,
- [x] pipeline stdin consumers (`cat`/`grep`/`head`/`tail`/`wc`); piping into non-consumers fails loudly; 1 MiB inter-stage cap fails loudly; pipelines forward stdout only,
- [x] stdout/stderr separated inside the executor; generalized redirection (`>`, `>>`, `2>`, `2>>`, `2>&1`) applied left to right,
- [x] `mv` / `rm` as workspace-confined, cancellation-aware filesystem commands (`rm -rf /` hard-refused),
- [x] one canonical capability registry drives runtime dispatch, `help`, and the system prompt,
- [x] tool iteration budget raised 15 → 32.

Explicitly deferred: `&`, `$()`, backticks, subshells, variables/export, glob expansion, input redirects, arbitrary file descriptors, `sed`/`awk`/`xargs`/`jq` and many other Unix utilities.

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

The original V0.4 seams have since advanced: file uploads are mounted read-only at `/mnt/upload`; image attachments have a durable integrity-checked store and provider capability gate; conversations/provider-native replay state persist across reload through IndexedDB; `/home/locus` is durable through OPFS when available. The terminal drawer remains deliberately reserved and not wired.

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

## Core capability boundary

The current core boundary is intentionally small.

```
Model-visible tools:
  bash
  cloud_bash   (unconfigured legacy/escalation stub)

Browser substrate:
  Execution
  Filesystem
  Network
  Perception

Current local userland:
  Python
  curl / HTTP
  bounded Unix-like file/text commands

Extension/product layer:
  Capability
    -> Plugin (code)
    -> Skill (knowledge)
    -> MCP (authority)
```

There is **no current model-facing `edit` tool** and no JavaScript shell command. Deterministic editing and a JS userland runtime remain possible future providers, but documentation must not describe them as implemented.

A new core proposal must explain why it cannot be expressed through execution + filesystem + network + perception, a Plugin, a Skill, MCP, or another explicit provider boundary.

See `docs/ARCHITECTURE.md` and `docs/CAPABILITY-BOUNDARIES.md`.

## V0.5 — Extension layer

Goal: allow the system to grow without expanding the core tool surface.

### Capability composition runtime v1

Status: implemented (`src/extensions.js`; unit coverage in
`tests/capability-composition.test.cjs` and `tests/skill-instances.test.cjs`,
browser coverage in `tests/e2e-capabilities.cjs` and
`tests/e2e-skill-instances.cjs`).

The user-facing product concept is the **Capability**: a composition of Plugins
(code), Skills (knowledge) and MCP requirements (authority). Implemented:

- [x] descriptor validators + validated catalog sets (invalid trusted catalogs fail loudly at load),
- [x] CapabilityManager with enable/disable, shared-component dedupe (reference semantics, not naive booleans), and the four capability states (`disabled` / `needs-connection` / `ready` / `error`),
- [x] immutable TaskEnvironment snapshots bound per agent task (UI mutations affect only the next task),
- [x] SkillDefinition = immutable publisher METADATA (inline source fields rejected at validation); the default Markdown source lives in a separate SkillSourceStore, keyed by skillId + version,
- [x] durable capability-private SkillInstances at `/home/locus/.skills/<capability-id>/<skill-id>.skill` with a Harness-owned install marker (written last), rollback on partial installs, reload/re-enable reuse and Remove = reset; shared definitions materialize per capability and are NEVER deduped,
- [x] compact system-prompt capability index pointing at the capability-private instance paths (only present instances; bodies never pre-injected),
- [x] read-only introspection mounts: `/mnt/plugins/<id>/plugin.json`, `/usr/local/share/locus/capabilities/<id>/capability.json` (the old read-only skill body mount is gone — instances are the one working view),
- [x] SkillInstanceWorkspace: the task-bound approval-guarded view of `/home/locus/.skills` — reads free; every create/write/delete (echo redirect, `>>`, curl -o, rm, python write-back commit) suspends on a `confirmation` approval with a harness-built diff, TOCTOU re-verification and cancellation; `mv` involving a skill instance and `rm -r` of a capability skill directory are refused outright,
- [x] PluginRuntimeProvider seam + python plugin lifecycle (pre-READY install + smoke import; ordinary import afterwards, no lazy-install-on-import; F04a/b/c boundaries untouched),
- [x] MCP requirement semantics with explicit connection state (never auto-authorized, never disguised as ready),
- [x] Settings UI: Capabilities list with Add/Remove (two-step destructive confirm stating that removing deletes customized guidance and re-adding restores defaults), component counts, connection-required state.

The production catalogs are EMPTY by design: no product capability (spreadsheet,
DOCX, PDF, GitHub, ...) has been decided. All v1 proofs use TEST-ONLY synthetic
descriptors injected via the manager constructor / e2e seam.

### Documentation / terminology foundation

Status: implemented.

The repository now has a wiki-style documentation index and explicit design contracts for architecture, terminology, runtime lifecycle, security, extensions, and testing. `docs/` is the normative documentation source; audit snapshots and candidate plugin studies are explicitly non-normative.

### Trusted Plugin Runtime v1

Status: next extension-layer milestone.

Goal: replace the test-only source-string Python plugin proof with a real trusted artifact pipeline while preserving the closed Capability/Skill model.

Target contract:

- fixed trusted Plugin descriptors and artifacts;
- bounded acquisition by the trusted harness;
- exact size + SHA-256 verification before bytes enter the Python worker;
- no Plugin/Python network authority;
- offline installation into a fresh runtime before READY;
- smoke import before task execution;
- verified cache/rebuild semantics;
- synthetic wheel first; no production package/capability decision until the loader contract is proven;
- a deterministic synthetic wheel fixture already exists at
  `tests/fixtures/capability-package/minimal/plugins/locus-test-plugin/artifacts/`
  (regenerable via `tests/fixtures/capability-package/tools/build-wheel.py`,
  stdlib only) plus the bundle-side artifact identity (`size` + `sha256`)
  produced by the package core, ready for this milestone to consume;
- no marketplace, arbitrary remote manifests, PyPI resolver, or model-triggered install in v1.

### Capability package / authoring framework

Status: package core implemented (`src/capability-package.js`; coverage in
`tests/capability-package.test.cjs`); import UI, imported-package registry and runtime integration pending.

Goal: make a Capability an independently authorable/importable project rather
than something that requires source edits to Locus.

Planned contract:

- editable Capability Project layout;
- editable Capability Project layout; [implemented]
- strict validator over manifests/component graph/authority;
- strict validator over manifests/component graph/authority; [implemented]
- deterministic builder that generates size + SHA-256 lock metadata;
- deterministic builder that generates size + SHA-256 lock metadata; [implemented]
- page-session imported-package registry for v1;
- explicit user import/trust transition;
- no runtime source edits or test-only catalog injection;
- same authoring flow for humans and Locus.

### Reference Capability E2E

Status: pending after Trusted Plugin Runtime + authoring/import infrastructure.

Use a deliberately small deterministic local capability (working reference:
`reference-text-analysis`) to prove:

```
source -> validate -> build -> import -> enable
       -> read Skill -> import real Plugin -> complete task
       -> customize Skill -> next-task effect
       -> Remove -> re-add defaults
```

This is infrastructure proof, not the first product Capability.

### Capability Authoring Capability / self-hosting

Status: pending after Reference Capability closure.

Target: a `capability-authoring` Capability composed from a deterministic local
authoring SDK Plugin plus a Skill that explains the design workflow.

Final acceptance:

> Starting from a plain-language request and an empty Capability project
> directory, Locus produces a valid bundle. After explicit user import, a
> subsequent task uses it successfully with no manual runtime-source edits.

Self-hosting never grants the model authority to auto-install its own generated
code.

### Capability registry (resolved design)

Status: implemented as the Capability Composition v1 registry/manager model described above. It provides the provider-neutral description of available capabilities and dependencies.

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
The v1 data model is closed (see `docs/CAPABILITY-BOUNDARIES.md` section 11):

- **SkillDefinition** = the publisher's immutable metadata template
  (id, version, display name, description). No inline source, ever.
- **SkillSourceStore** = the trusted default Markdown per
  `(skillId, version)`; future production sources arrive via build-time
  bundling, never runtime fetches.
- **SkillInstance** = a capability-private durable working copy at
  `/home/locus/.skills/<capability-id>/<skill-id>.skill`. Definitions may
  be shared; instances are NEVER shared. Reads are free; every
  create/write/delete needs an explicit user confirmation (a behavior
  mutation), and removing a capability deletes its instances — re-adding
  restores the defaults.

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