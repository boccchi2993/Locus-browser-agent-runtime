# Runtime, Harness, and Product: three-repository split

Status: agreed target architecture; migration not implemented by this document.
Decision date: 2026-09-28. Inspected baseline: `974e5ac11e104de15655c9061e620c84a6c58556`.

## 1. Decision and scope

Locus will have three independently maintained repositories:

| Repository role | Responsibility | Independence requirement |
|---|---|---|
| Runtime | Browser-local Unix-like execution substrate | Works without the Locus harness or product |
| Harness | Model-driven agent execution and orchestration | Works without the Locus runtime or product |
| Product | Locus application, composition, and integration adapters | Integrates the latest mainline runtime and harness and proves that they work together |

Keep the existing `Locus-browser-agent-runtime` repository as the product repository during migration. `locus-runtime` and `locus-harness` are proposed names, not repositories this document claims already exist. Renaming the product repository is not required for extraction.

Three repositories are the destination, not an optional follow-up to a permanent monorepo. Temporary in-repository seams are migration steps only. This change documents the decision; it does not create repositories, extract code, publish packages, or alter runtime behavior.

The product owns a family of explicit runtime/harness compatibility adapters. Neither core repository may import the other, depend on the product, read its globals, or require its source checkout to build and test. A fourth shared implementation repository is not required.

## 2. Responsibility and dependency boundaries

| Concern | Runtime | Harness | Product |
|---|---|---|---|
| Files and execution | VFS, mounts/providers, shell, workers, Python synchronization, resource limits | Requests execution through injected ports | Chooses mounts, storage backends, uploads and download UX |
| Lifecycle | Execution handles, interpreter instances, cancellation, disposal | Agent task/session lifecycle, budgets, tool sequencing | Binds conversations to tasks; maps task lifecycle to runtime contexts |
| Models | No model knowledge | Provider adapters, transport, native replay, context management, image-input gating | User configuration, credential provisioning and application storage |
| Authority | Enforces mount/network limits and execution policy; fails closed | Approval orchestration and tool authorization policy | Supplies grants and policy implementations; renders approval UI |
| Extensions | Verified runtime payload installation and isolation | Capability/Skill/MCP composition and extension requirements | Catalogs, user enablement, connections and concrete runtime-provider binding |
| Persistence | Filesystem storage mechanics through providers | Replay/checkpoint semantics through injected persistence ports | Browser database, migrations, conversation records, attachment storage and recovery wiring |
| Observability | Structured execution events and measurements | Structured task/model/tool/approval events | Correlation, persistence, projection and presentation |

Dependencies point from the product to the two public APIs. The harness owns the ports it consumes; the runtime owns the APIs it exposes. Product adapters map between them. Each owner documents and tests its contract; a copied shared type file must not become an undeclared synchronization mechanism.

Browser APIs are legitimate runtime dependencies. The runtime may need a CSP creator iframe, Workers and OPFS; it must not need a Locus status-bar element, Vue store, conversation object or HTML element containing worker source. Worker source and bootstrap assets belong to runtime packaging, with explicit embedding/CSP requirements.

The existing docs sometimes use “runtime” for the entire agent stack and “trusted harness” for privileged Python bootstrap code. For this split, those phrases do not determine repository ownership: privileged machine bootstrap belongs to Runtime; model orchestration belongs to Harness.

Perception is also split by responsibility: image/provider compatibility belongs to Harness, attachment storage and selection to Product. Calling perception a substrate capability in the current architecture does not place model-specific logic in the extracted Runtime.

## 3. Evidence and extraction map

These are observations at the pinned baseline, not claims about future code.

| Current source | Boundary to establish |
|---|---|
| `src/agent.js`, `src/model.js`, `src/model-adapters.js` | Harness; retain model/tool/persistence injection and replace remaining implicit global dependencies |
| `src/workspace.js`, `src/vfs.js` | Runtime filesystem primitives; extract application-specific conversation/persistence views as Product providers |
| `src/shell.js` | Runtime execution; separate Python bootstrap, shell and worker packaging without changing their behavior |
| `src/network.js` | Runtime bounded transport and routing mechanics; inject authorization and route configuration instead of requiring chat identities |
| `src/tools.js` | Split model-visible tool definitions/result adaptation from runtime execution and telemetry sinks |
| `src/approval.js` | Harness approval lifecycle with injected policy/presentation; enforcement stays at Runtime/provider boundaries |
| `src/extensions.js`, `src/capability-package.js` | Split portable composition/validation from storage, concrete runtime payload preparation and product catalogs |
| `src/persistence.js`, `src/attachments.js`, `src/capabilities.js` | Split portable replay/image-gating logic from browser storage and application configuration; do not move whole files by name |
| `src/ui/store.js` | Extract task orchestration and runtime preparation; leave UI projection and application wiring in Product |
| `index.html`, `vite.config.js` | Replace classic-script ordering and embedded worker sources with explicit package entry points and packaged runtime assets |

Concrete coupling to remove includes:

- `preparePythonRuntimeForEnvironment()` in the UI store resets/configures the global interpreter. Task submission also forks the VFS and installs task-specific skill mounts there.
- Shell `mv` and `rm` know the literal `/home/locus/.skills` and capability management rules. Preserve those protections through an operation-aware policy/provider interface covering source, destination and recursive operations.
- Network approval requests carry `conversationId` and `taskGeneration`. Bind those identities in the product/harness adapter; the runtime receives execution-scoped authorization context.
- `PythonRuntime._setStatus()` updates `sb-python`, and worker creation reads source from page elements. Replace presentation writes with events and ship worker source with Runtime.
- Agent prompt construction reads global tool definitions and the shell prompt generator. Inject tool descriptions and runtime capability descriptions through the adapter.

Existing useful seams include AgentSession dependency injection, VFS providers/forks, immutable TaskEnvironment snapshots and independent agent/shell test fixtures. Preserve and extend them.

## 4. Public contracts and adapter obligations

Exact exported names and transport encoding will be decided during contract extraction. The following semantics are required; they do not prescribe a new RPC service or process boundary. In-process module calls are sufficient initially.

| Boundary | Required contract |
|---|---|
| Runtime discovery | Public API/contract version, supported commands/execution kinds, limits and supported policy mechanisms |
| Execution | Execution-scoped identity, bound filesystem context, input, cancellation, bounded output, terminal status and artifact/change information |
| Runtime lifecycle | Explicit create/prepare/reset/dispose ownership; no hidden dependency on a single product-global interpreter |
| Harness tools | Injected definitions and executor; results, errors and cancellation mapped without losing their meaning |
| Authorization | Operation/resource request, scoped decision, cancellation and liveness checks; denial is distinct from cancellation |
| Events | Correlation identity, ordering rules and a single terminal outcome; late events cannot attach to another task |
| Storage | Injected persistence methods with explicit required-write failure and recovery semantics |

Product adapters may translate parameters, capability descriptions, output formats, errors, events and lifecycle calls. They must not access private fields, patch core prototypes, reproduce the shell/agent loop, or claim an unsupported capability exists.

Adapter modules should cover execution/results, lifecycle/cancellation, authorization, capability/plugin preparation, filesystem/artifacts and observability. These are responsibility boundaries, not a requirement to create six packages.

Capabilities should be negotiated using declared support, with contract versions defining semantics. Unknown or incompatible mandatory semantics fail before starting a task, with an actionable compatibility error. Never silently downgrade authority, cancellation or persistence guarantees. Avoid version-string heuristics as substitutes for capability checks.

Core correctness belongs to its owner. An adapter cannot compensate for a runtime that continues writing after cancellation or a harness that drops provider-native replay state. Such defects must be fixed upstream and covered there.

## 5. Behavior and security invariants

Extraction must preserve these existing guarantees, without claiming transactionality the implementation does not provide:

- A task binds its filesystem routing, extension snapshot and authorization context for its lifetime. Switching conversations, mounts or capabilities cannot rebind an old task.
- Cancellation invalidates queued work and blocks later side effects at execution/commit boundaries. Already committed effects remain reported; cancellation is not rollback.
- Python state is isolated/reset at the intended session boundary. Reconfiguring plugins cannot mutate an interpreter serving a different active task.
- Read-only mounts remain read-only from both shell and Python. Skill mutation identity, confirmation, diff and TOCTOU checks survive the move out of hardcoded shell paths.
- Python user code retains browser-enforced network denial. Bootstrap assets and trusted plugin artifacts retain integrity checks, bounded acquisition and offline install behavior.
- Side-effecting network requests are not retried across backends after ambiguous dispatch failure. Authorization does not create filesystem/network authority.
- Truncation, skipped input files, incomplete output collection and partial filesystem commits remain explicit. Output adaptation must not turn partial failure into success.
- Provider-native continuation state, task generation, history budgeting and persistence failure behavior remain intact.
- Plugins add code, Skills add knowledge, and MCP connections supply external authority. Extraction grants none of these additional authority.

## 6. Tracking both upstream mainlines

The product continuously integrates the latest mainline commit from each core repository. Published or deployed product builds use exact, verified commit pairs, never floating `main` dependencies at runtime.

The product lock record must include both repository URLs, full commit SHAs, public contract versions, the product adapter revision, and integrity information for consumed build artifacts. A product release/commit records the complete tuple. Dependency/build-tool lockfiles remain part of reproducibility.

When either upstream advances:

1. Resolve both current upstream main heads to immutable SHAs and create an integration candidate.
2. Build each dependency from its pinned source or consume an integrity-verified artifact traceable to that source.
3. Run standalone contract checks and product compatibility/end-to-end gates against that exact pair.
4. Advance the product dependency lock only when the candidate passes. Retain the tested artifacts and test evidence.
5. If upstream changes during testing, retain the result for the tested tuple and queue the newer tuple; never relabel an old test as proof of the latest heads.
6. If the candidate fails, keep the last known-good product tuple usable, record the blocker and repair either the upstream defect or product adapter. A failed candidate remains outstanding integration work, not permission to permanently stop tracking upstream.

Use authenticated cross-repository triggers with minimal permissions when available, plus reconciliation/manual retry for missed events. This document specifies that workflow; it does not install an automation.

The required compatibility target is the latest mainline pair and the recorded last known-good product pair. Support for arbitrary historical cross-products is not promised. Do not accumulate permanent adapters for every past commit. Contract-breaking upstream changes must document the change and trigger product integration work.

Rollback selects the previous complete product tuple, including adapters/assets. It does not independently roll back one dependency. Storage/schema changes require their own migration/recovery plan; binary rollback must not be assumed to reverse persisted data changes.

## 7. Migration sequence and gates

Each step is a reviewable change with passing relevant tests. Keep the product usable between steps. Do not combine the split with new shell syntax, new model protocols or expanded plugin authority.

### M0 — Record the baseline and contracts

- Inventory runtime/harness/product globals, ownership and cross-boundary lifecycle calls.
- Record the exact source commit, current public behavior and browser baseline.
- Define ports, result/error semantics, capability descriptions and packaging/CSP requirements.
- Exit: ownership and contract tests identify every supported cross-layer interaction.

### M1 — Extract task assembly from the UI store

- Move portable task orchestration to Harness and concrete environment preparation to Product adapters.
- Replace global Python/session access with explicit lifecycle handles and immutable task bindings.
- Move skill-specific policy out of shell commands while retaining operation-aware enforcement.
- Exit: task setup/run/cancel/reset can be exercised without Vue or a Locus page; existing routing, approval and filesystem behavior is preserved.

### M2 — Establish explicit modules and standalone entry points

- Replace implicit classic-script dependencies with declared public module interfaces.
- Package worker sources/assets and remove status-element writes from Runtime.
- Split mixed files by responsibility; use explicit runtime instances and injected model/tool/storage ports.
- Update source-evaluating tests to exercise public entries where they assert independence.
- Exit: both cores build and run their own tests without the product source tree or each other.

### M3 — Extract the two core repositories

- Create Runtime and Harness repositories with public API documentation, minimal examples, tests, CI, license and source provenance.
- Preserve relevant history where practical; record the original commit/path mapping and retain license/copyright notices in all extracted distributions.
- Build reproducible consumable artifacts or pinned source dependencies; a public package-registry release is not required.
- Remove duplicated authoritative implementations from Product when its imports switch. Temporary shims delegate and have removal gates.
- Exit: clean checkouts independently build/test, and the product consumes exact external revisions.

### M4 — Integrate and maintain the three repositories

- Land the product adapters, dependency lock, compatibility tests and upstream-main integration workflow.
- Validate real browser execution through the integrated product, not just fake ports.
- Document the tested tuple, unresolved limits and rollback procedure.
- Exit: both independence proofs and all product integration gates below pass; remaining classic-global access across repositories is rejected by CI.

## 8. Acceptance matrix

| Gate | Evidence required |
|---|---|
| Runtime independence | Clean Runtime checkout builds/tests without Harness/Product; minimal browser terminal or scripted host performs real VFS/shell/Python operations without a model |
| Harness independence | Clean Harness checkout builds/tests without Runtime/Product; deterministic model fixture plus a non-Locus executor completes tool-result feedback, cancellation and replay |
| Dependency direction | No core imports the other core, Product, Vue or Product globals; consumers use public package exports |
| Product integration | Real browser task reaches the pinned runtime via the pinned harness, changes files and returns results/artifacts |
| Lifecycle races | Cancel/reset/workspace switch/plugin change during execution cannot redirect writes or events to a later task |
| Authority | Read-only mounts, skill mutation policy, Python egress denial, integrity verification and network dispatch semantics retain adversarial tests |
| Persistence | Native replay and required-write failures survive reload/recovery without stale task resurrection |
| Contract mismatch | Missing capabilities or unsupported mandatory contract versions reject before side effects; no silent fallback |
| Packaging | Worker URLs, CSP, assets and optional relay configuration work in the deployed browser build, not only Node fixtures |
| Mainline integration | Either upstream advance creates a pinned candidate; passing advances the lock, failing preserves and reports the known-good tuple |

Node tests alone do not prove browser isolation or packaging. Runtime browser suites and Product end-to-end suites are required for the migration gates that depend on them. Test counts from the baseline are not proof that the extraction is complete.

## 9. Documentation ownership after extraction

Runtime owns execution/filesystem/network contracts and enforcement documentation. Harness owns agent/model/tool/approval/persistence-port contracts. Product owns user-facing behavior, concrete bindings, compatibility mappings and tested dependency tuples.

Keep links to the authoritative upstream documents instead of maintaining divergent copies. Update the current architecture, boundary, security, testing and roadmap pages with each completed migration step. Until then, their descriptions of existing behavior remain valid; this document is authoritative for the target repository topology and migration acceptance, not a claim that the target has shipped.
