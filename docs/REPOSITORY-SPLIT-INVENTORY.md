# Repository split M0 — ownership inventory

Status: M0 audit deliverable. Target architecture and gates: [REPOSITORY-SPLIT.md](REPOSITORY-SPLIT.md). Interface drafts: [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md). Verification results: [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md).

Inspected baseline: `d25f30ea75e54989393230cb6c7695359d4c0815` (merge of PR #1). Code content at this commit is identical to `974e5ac1` (the baseline named by the target document); `d25f30e` adds only the split documents. All file/symbol references below resolve at that SHA. Line numbers are avoided where they would drift; symbols and adjacent code are the stable anchor.

## 1. How the codebase is wired today

### 1.1 Classic-script global registry

`index.html` loads 17 framework-independent classic scripts in a fixed order before the Vue module. Every file exports plain globals; nothing uses ES modules outside `src/main.js`, `src/ui/store.js`, and the Vue components.

| Order | File | Globals contributed | Globals consumed (implicit) |
|---|---|---|---|
| 1 | `src/telemetry.js` | `utf8ByteLength`, `Telemetry`, `window.__telemetry` | — |
| 2 | `src/persistence.js` | `PersistenceServiceInstance`, `LOCUS_HOME_SKELETON`, `validateReplayPrefix`, `validateNormalizedPrefix` (M2b review round: one-way delegates to `src/harness/replay-validation.js`), `persistenceClone` | — |
| 3 | `src/model-adapters.js` | `OpenAIAdapter`, `AnthropicAdapter`, `getProviderAdapter`, `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory` | `getProviderAdapter` (deferred) |
| 4 | `src/model.js` | `Model`, `callModel`, `callModelText`, `verifyConnection`, error constructors | `getProviderAdapter`, `Model.transport` seam, `window.location` |
| 5 | `src/workspace.js` | `WorkspaceAdapter`, `normalizeWorkspacePath`, `LocalDirectoryWorkspace`, `OPFSWorkspace`, `ConversationHistoryWorkspace`, `ensureWorkspacePermission` | — |
| 6 | `src/vfs.js` | `normalizeVfsPath`, `vfsError`, `VirtualWorkspace`, `MemoryWorkspace`, `UploadWorkspace`, `SystemBinWorkspace` | `WorkspaceAdapter`, `normalizeWorkspacePath`, `LOCUS_HOME_SKELETON` (typeof-guarded) |
| 7 | `src/extensions.js` | `EXTENSION_ID_PATTERN`, `EXTENSION_PY_MODULE_PATTERN`, catalogs, `CapabilityManager`, `SkillSourceStore`, `SkillInstanceStorage`, `SkillInstanceWorkspace`, `StaticFileWorkspace`, `pythonExtensionKeyOf`, … | `WorkspaceAdapter` |
| 8 | `src/capability-package.js` | `LocusCapabilityPackage` | `SKILL_INSTANCE_MAX_BYTES` (extensions.js) |
| 9 | `src/attachments.js` | `AttachmentStore`, `isAttachmentIntegrityError`, `imageContentPart`, `textContentPart` | `PersistenceServiceInstance` (fallback) |
| 10 | `src/capabilities.js` | `ModelCapabilityRegistry`, `createImageInputGate`, `runImageInputProbe`, `classifyImageProviderError`, `imageInputUnavailableNotice` | `callModel` (probe), `PersistenceServiceInstance` (fallback) |
| 11 | `src/network.js` | `NetworkRuntime`, taxonomy helpers | `window.location`, `ApprovalController` (injected per-request) |
| 12 | `src/shell.js` | `SHELL_COMMANDS`, `SHELL_ALIASES`, `runShellCommand`, `PythonRuntime`, `GrepRegexRuntime`, `shellSystemPromptSection`, `shellHelpText` | `vfsError`, `VirtualWorkspace`, `NetworkRuntime`, `Telemetry`, `utf8ByteLength`, `EXTENSION_ID_PATTERN`, `EXTENSION_PY_MODULE_PATTERN`, DOM (`py-worker-src`, `grep-worker-src`, `sb-python`) |
| 13 | `src/tools.js` | `AGENT_TOOL_DEFINITIONS`, `executeTool` | `runShellCommand`, `Telemetry`, `utf8ByteLength`, `performance` |
| 14 | `src/approval.js` | `ApprovalController`, `APPROVAL_KINDS` | — |
| 15 | `src/agent.js` | `AgentSession`, `buildSystemPrompt`, `HISTORY_BUDGET_BYTES`, `MAX_TOOL_ITERATIONS` | `AGENT_TOOL_DEFINITIONS` (typeof-guarded), `shellSystemPromptSection` (typeof-guarded) |
| 16 | `src/ui/projector.js` | `LocusProjector` | — |
| 17 | `src/ui/markdown.js` | `markdownLite` | — |
| — | `src/main.js` (module) | `window.__LOCUS_HOOKS__`, `window.__locus` (e2e only) | everything above + `./ui/store.js` |

`src/ui/store.js` (module) additionally reads at call time: `Model`, `callModel`, `executeTool`, `buildSystemPrompt`, `AgentSession`, `VirtualWorkspace`, `SHELL_COMMANDS`, `LocalDirectoryWorkspace`, `OPFSWorkspace`, `ConversationHistoryWorkspace`, `ensureWorkspacePermission`, `PythonRuntime`, `Telemetry`, `LocusProjector`, `CapabilityManager` + the four catalogs, `SkillInstanceStorage`, `SkillInstanceWorkspace`, `PersistenceServiceInstance`, `getProviderAdapter`, `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory`, `AttachmentStore`, `ModelCapabilityRegistry`, `createImageInputGate`, `runImageInputProbe`, `classifyImageProviderError`, `imageInputUnavailableNotice`, `textContentPart`, `imageContentPart`, `verifyConnection`, `HISTORY_BUDGET_BYTES` (the eslint `/* global */` block at the top of the file is the honest registry; M2b review round: the store no longer reads `validateReplayPrefix`/`validateNormalizedPrefix` — the harness defaults apply).

`vite.config.js` (`copyRuntimeScripts`) copies these files verbatim into `dist/src/`; they are never bundled. The two inline worker sources (`index.html` script blocks `#py-worker-src` and `#grep-worker-src`) are extracted at runtime by `src/shell.js` via `document.getElementById`.

### 1.2 Page-lifetime singletons

| Singleton | Defined at | Nature |
|---|---|---|
| `vfs` | `src/ui/store.js` (module scope, `new VirtualWorkspace(...)`) | One VFS per page; tasks get `vfs.fork()` |
| `session` | `src/ui/store.js` (`new AgentSession({...})`) | One agent session per page; conversation switch = `session.reset()` + history swap |
| `approvals` | `src/ui/store.js` (`new ApprovalController({...})`) | One approval controller per page |
| `capabilityManager` | `src/ui/store.js` (`new CapabilityManager({...})`) | Page-session capability state |
| `PythonRuntime` — **removed in M1b** | `createPythonRuntime()` (`src/shell.js`): the interpreter is an INSTANCE; the Product (store) owns the ONE canonical page instance (contract §3.1 M1b form) |
| `PersistenceServiceInstance` | `src/persistence.js` | IDB/OPFS service instance |
| `Model` | `src/model.js` | Mutable provider config (key/base/model/proxy/dialect/transport) |
| `Telemetry` | `src/telemetry.js` | In-memory records (500 cap) |

### 1.3 Test loading model

41 Node suites (`npm test`, registry in `tests/run-unit.cjs`) read sources with `readFileSync` and `eval` them in dependency order, destructuring the globals they need (e.g. `tests/shell.test.cjs` evals workspace+vfs+telemetry+shell+tools; `tests/agent.test.cjs` evals tools+agent only; `tests/approval.test.cjs` evals approval.js alone). Browser suites (`npm run test:e2e`, 16 suite entries) drive real Chrome via CDP against `tests/e2e.html` (file://) or a built Vite preview (`?e2e=1` seams: `window.__LOCUS_HOOKS__`, `window.__locus`). This loading model is itself a product of the classic-script design: tests that "prove independence" today do so by choosing which files to eval, not by importing packages.

## 2. Ownership inventory (file by file, symbol by symbol)

Legend: **R** = Runtime repo, **H** = Harness repo, **P** = Product repo. "Interface after migration" names the port defined in [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md).

### 2.1 `src/workspace.js` — mostly Runtime; one Product provider hides inside

| Symbol | Owner | Notes |
|---|---|---|
| `normalizeWorkspacePath` | R | Path safety for provider-relative paths |
| `WorkspaceAdapter` | R | The provider contract both cores and Product build against |
| `LocalDirectoryWorkspace` | R | File System Access API provider (`/mnt/workspace`) |
| `OPFSWorkspace` | R | OPFS provider (durable home, plugin storage) |
| `isNotFoundOrTypeMismatch` | R | Error classification helper |
| `ensureWorkspacePermission` | R | Browser permission mechanics; Product decides *when* to call it |
| `ConversationHistoryWorkspace` | **P** | Reads `service.loadConversations/loadNormalizedMessages/loadProviderSession/loadProviderFrames` and the private `service._byIndex` (`src/workspace.js`, `read()`); it is a Product persistence view shaped as a provider. Move with persistence wiring; out of Runtime |

Callers today: `VirtualWorkspace` mounts (store.js `mountExternalHandle`, `mountDurableStorage`), `SkillInstanceStorage.resolveHome`. Behavior to preserve: adapter error taxonomy (`NotFoundError` names), `exists()` fault propagation, byte-exact read/write. Tests: `tests/workspace.test.cjs`, `tests/opfs-workspace.test.cjs`. Gap: no test pins `ConversationHistoryWorkspace` against a *mocked* service boundary (it is exercised via e2e-persistence only).

### 2.2 `src/vfs.js` — Runtime core with one Product injection seam

| Symbol | Owner | Notes |
|---|---|---|
| `normalizeVfsPath`, `vfsError` | R | Path normalization + error taxonomy |
| `MemoryWorkspace` | R | Quota-bounded in-memory provider |
| `UploadWorkspace` | R | Read-only browser-File provider; `addFile/removeFile` are user-action paths, never agent paths |
| `SystemBinWorkspace` | R | Virtual `/usr/bin`,`/bin` view over an injected command list |
| `VirtualWorkspace` | R | Mount table, `fork()` task binding, `resolveMount`, `assertWritable`, `dataMounts`, `authorityOf`, `defaultCwd`, `getEnv`, protected roots, `resetHome`, `resetEphemeral` |
| `VFS_HOME_SKELETON` | R **(input is P)** | Reads global `LOCUS_HOME_SKELETON` from `src/persistence.js` via a typeof guard — the Product persistence module injects the durable home layout into the Runtime VFS through script order. Must become a constructor/`mount` argument |

Callers: store.js (the page VFS + per-task forks), shell.js (`asVfs`, `resolveShellPath`, python `dataMounts`), tests. Behavior to preserve: read-only enforcement from both shell and Python commit path; fork isolation; longest-prefix routing; protected-root refusals. Tests: `tests/vfs.test.cjs`, `tests/vfs-audit.test.cjs`, e2e runtime. Gap: home-skeleton injection has no dedicated test (it is covered implicitly by skill-instances suites).

### 2.3 `src/shell.js` — Runtime execution; four non-Runtime concerns embedded

| Region / symbol | Owner | Notes |
|---|---|---|
| Cancellation errors (`makeCancelledError`, `isCancelledError`, `throwIfCancelled`) | R | |
| Bootstrap manifest, budgets, asset fetch/verify (`PYTHON_BOOTSTRAP_MANIFEST`, `readBodyBounded`, `sha256Hex`, budget clocks, `openBootstrapAbort`) | R | F04c integrity boundary; keep manifest the single source of bootstrap URLs |
| Wheel artifact validation (`validateWheelArtifact`, `PYTHON_PLUGIN_WHEEL_*`) | R | Main-thread half of TPR v1A |
| `PythonRuntime` → `createPythonRuntime()` (**M1b**: instance factory) | R | Creator iframe + worker lifecycle, queue serialization, `_runOnce` mirror/commit phases, `prepare`/`reset`/`dispose`/`snapshot` lifecycle, `extensionKey()`, `buildExtensions`/`configureExtensions()`. All mutable state per instance; the page-global singleton is gone (consumers: store wiring + `opts.pythonRuntime`) |
| `PythonRuntime._setStatus` | R **(defect)** | Writes `document.getElementById('sb-python')` — Runtime→DOM presentation write; must become a status event (see BASELINE §4, D1) |
| `PythonRuntime.configureExtensions` id validation | R | Uses globals `EXTENSION_ID_PATTERN`/`EXTENSION_PY_MODULE_PATTERN` from extensions.js — a Runtime file validating against Harness-owned identity rules via script order. Must receive the pattern/validator as part of the payload port |
| Worker source acquisition (`_ensureWorker` reads `#py-worker-src`; `GrepRegexRuntime.createWorker` reads `#grep-worker-src`) | R **(packaging)** | Runtime reads its own worker sources out of Product page DOM. Must ship as Runtime assets (contract §3.6) |
| `collectWorkspaceFiles`, sync constants, `detectExternalChange`, b64 helpers | R | Python mirror-in/commit machinery |
| Tokenizer/parser (`shellTokenize`, `extractPythonHeredoc`, `parseShellLine`) | R | |
| `SHELL_COMMANDS`, `SHELL_ALIASES`, `SHELL_OPERATORS`, `SHELL_REDIRECTS`, `shellHelpText`, `shellSystemPromptSection` | R | `shellSystemPromptSection` is the *capability description port* the Harness prompt consumes (today via a global read in agent.js) |
| VFS bridge (`asVfs`, `resolveShellPath`, `statShellPath`, `checkParentDir`, `writableErrMsg`) | R | |
| Handlers `shPwd` … `shSort`, `shWhich` | R | |
| `underSkillInstances` / `SKILL_*` / `isSkillMutationError` — **moved out in M1b** | **P policy** (`src/mutation-policy.js`, Product) | The `/home/locus/.skills` layout knowledge and refusal texts now live in `LocusMutationPolicy`, injected into every bash execution via `opts.mutationPolicy`; shell.js consumes the operation-aware port (checkMove/checkRemove/isPolicyRefusal) with byte-stable refusal texts. A missing product policy fails the bash call loudly |
| Grep worker session (`GrepRegexRuntime`, `createGrepRegexSession`, `shGrep`) | R | Fail-closed containment; `_workerFactory` is a TEST-ONLY seam |
| `shMv`, `shRm`, `mvFile`, `mvDirectory`, `rmRecursive`, `throwMutationCancelled` | R | Keep committed-entry reporting on cancel (not rollback) |
| Executor (`runShellCommand`, `runPipeline`, `runSimpleCommand`) | R | Backend/operation attribution (`browser`/`browser-direct`/`edge-relay`/compound) is Runtime routing state |
| `runPython`, `pythonOpts`, `runPythonCode` | R | Honest partial-commit reporting (`[written:]`, `[conflict:]`, `[not persisted:]`, …) |
| `runCurl` + `shCurl` | R (CLI half) | Transport/approval/bounds live in NetworkRuntime; curl is a CLI adapter |

Callers: `executeTool` (tools.js), e2e `window.executeTool` seam, tests. Behavior to preserve: everything in REPOSITORY-SPLIT §5 that touches execution — read-only mounts, sync conflict/skip/uncollected accounting, session-boundary interpreter reset, browser-level Python egress denial, bootstrap integrity, offline plugin install. Tests: `tests/shell*.test.cjs` (4 suites), `tests/grep-worker.test.cjs`, `tests/worker-init.test.cjs`, `tests/worker-output.test.cjs`, `tests/python-authority.test.cjs`, `tests/python-bootstrap-integrity.test.cjs`, `tests/python-plugin-runtime.test.cjs`; browser: runtime, grep, python-authority, python-browser-authority, python-bootstrap-integrity, trusted-plugin-runtime. Gaps: no test drives `PythonRuntime` *without* `Telemetry`/`tools.js` in scope (independence of the Runtime subset is proven only by file choice, see §1.3); no test asserts the DOM writes (`sb-python`) — they are invisible to the suites, which is exactly why they can be replaced by events in M2 safely.

### 2.4 `src/network.js` — Runtime substrate; identity fields are the seam

| Symbol | Owner | Notes |
|---|---|---|
| `NetworkRuntime.request/_perform/_direct/_relay`, method sets, header filters, SSRF checks, deadlines/caps, `DirectTransportFailure`, `mapWriteDispatchError` | R | Dispatch-once semantics for side-effecting methods; GET/HEAD one-shot fallback |
| `policyContext` handling inside `request()` (`{ approvals, conversationId, taskGeneration }`) | R port + **P/H identity** | The `approvals` consumer injection is the correct port. `conversationId`/`taskGeneration` are chat-layer identities flowing into Runtime — carried today only as informational context on the approval request (docs/APPROVALS.md F-A34); after the split the Runtime must receive execution-scoped authorization context instead (contract §3.5) |
| `isHostedPage`, `pageOrigin` | R | Reads `window.location`; becomes injected hosting context so Node tests and non-browser hosts don't window-sniff |

Callers: `runCurl`, e2e-network. Behavior to preserve: no ambiguous retry across backends; approval before dispatch; deny ≠ cancel; SSRF relay policy; anonymous-by-construction requests. Tests: `tests/network.test.cjs`, `tests/network-runtime.test.cjs`, `tests/runtime-visibility.test.cjs`, `tests/proxy.test.mjs`, `tests/fetch.test.mjs`; browser: network, active-content. Gap: `conversationId` propagation is asserted only indirectly through approval payloads (e2e-approval); fine today, but the field's ownership must be settled before M2 or the Runtime repo will import a chat concept.

### 2.5 `src/agent.js` — Harness core with two Runtime reads

| Symbol | Owner | Notes |
|---|---|---|
| `AgentSession` (run/reset/cancel/generation, `_persist`, history budget, image gate boundary, native batch handling, staleness rules) | H | **M2b**: consumes the injected ToolPort with per-task definition snapshots; publishes `globalThis.AgentSession`/`buildSystemPrompt` and assembles the declared `__LOCUS_HARNESS_CORE__` table (the one ESM-mode seam, deleted at M3) |
| `buildSystemPrompt`, `capabilityPromptSection` | H | **M2b**: the global reads are GONE — the tool list renders from the task's frozen snapshot, the runtime description arrives through the injected descriptionPort (`RuntimeSession.describeCommands()`), and Locus product notes through the injected `environmentNotes` (src/ui/product-prompt.js); no port → no capability claims (H2 pinned) |
| `HISTORY_BUDGET_BYTES`, `stripInternalFields`, `parseToolCall`, `nativeResultContent`, `truncateFor` | H | `HISTORY_BUDGET_BYTES` is additionally read by `src/ui/store.js` (`buildImageUserContent` pre-check) via a typeof global — a P→H constant dependency to make an exported getter |
| Persistence failure classification (`agentPersistenceFailure`, `isAgentPersistenceFailure`) | H | Port semantics, not Product logic |

Callers: store.js (`session`), tests. Behavior to preserve: one-active-task guard; session-switch vs cancel distinction; committed-tool-result reporting on cancel; provider-native replay (`rawMessage`); budget trim at task boundaries; image integrity fail-closed before any provider call. Tests: `tests/agent.test.cjs`, `tests/agent-approval.test.cjs`, `tests/agent-image.test.cjs`, `tests/native-tools.test.cjs`; browser: presentation, wire, image. Gap: the `shellSystemPromptSection` fallback text is asserted only in agent.test (registry-less harness); no test pins the *content parity* between prompt section and actual Runtime commands outside shell.test's own `shellSystemPromptSection` checks — acceptable, but the M2 port must keep both derivations from one registry.

### 2.6 `src/tools.js` — split three ways

| Symbol | Owner | Notes |
|---|---|---|
| `AGENT_TOOL_DEFINITIONS`, `AGENT_TOOL_NAMES`, `TOOL_NOT_FOUND` | **P registry** (**M2b re-scoped from H**) | The product tool registry (bash/cloud_bash names, descriptions, schemas, refusals) — the Product's ToolPort `definitions()` serves it; the Harness carries NO registry (the H-scoping in the M0 draft would have put product tool names in the extracted Harness; the M2b split keeps the registry with its executor on the Product side) |
| `executeTool` | **P adapter** | Routes `bash` through `opts.runtimeSession.execute` (M2a) and delivers the measurement through the explicit contained `opts.telemetry` sink (**M2b**). The store's `productToolPort` composes `{ definitions, execute }` over it (contract §3.2) |
| `Telemetry.record` call | via injected sink (**M2b LANDED**) | Explicit optional sink with contained delivery; the `renderDebugPanel` Product-UI reverse dependency is deleted from `telemetry.js`; no core reads the Telemetry global |

Tests: indirectly via agent/shell suites + `tests/shell.test.cjs` (evals tools.js). Gap: no dedicated tools.test; routing + telemetry attribution rely on shell tests.

### 2.7 `src/model.js`, `src/model-adapters.js` — Harness

| Symbol | Owner | Notes |
|---|---|---|
| `Model` config singleton | H (state) / P (source of values) | `store.applySettings()` mutates it today; post-split Product supplies a config object per client construction (contract §3.9) |
| `fetchJsonPost`, `readTextCapped`, `raceSignal`, `cancelReaderQuietly`, error taxonomy (`HttpError`, `BodyReadError`, `ParseError`, `TimeoutError`, cancelled) | H | `window.location.protocol === 'file:'` check in `tryFetch` becomes injected hosting context |
| `tryFetch` relay fallback policy, `runEndpointAttempts`, `callModel` tools downgrade | H | Never re-send after authoritative/ambiguous failures |
| `verifyConnection` | H | Used by Product settings |
| Adapters `OpenAIAdapter`/`AnthropicAdapter`, `getProviderAdapter`, identity helpers, `projectNormalizedHistory`, `rawReplayIdentityCompatible` | H | Pure logic, already Node-tested |

Tests: `tests/model.test.cjs`, `tests/model-adapters.test.cjs`, `tests/model-adapters-image.test.cjs`, `tests/image-probe.test.cjs`, `tests/provider-replay-persistence.test.cjs`; browser: wire. Gap: none material for the split; the `file:`-protocol branch is covered by proxy/fetch suites.

### 2.8 `src/approval.js` — Harness

`ApprovalController`, `APPROVAL_KINDS`, error constructors: approval lifecycle with injected observers. `conversationId`/`taskGeneration` ride on requests as informational context (F-A34) — post-split these remain Harness-side fields; Runtime receives only an execution-scoped authorization port (contract §3.5). Tests: `tests/approval.test.cjs`, `tests/agent-approval.test.cjs`; browser: approval. No split-driven gaps.

### 2.9 `src/extensions.js` — split by function, not by file — **SPLIT in M2b**

**M2b update:** the composition CORE (identity patterns, bounds constants, descriptor validators, `SkillSourceStore`, the plugin-runtime provider registry, `validatePluginPayload`, `pythonExtensionKeyOf`, `sha256Hex`, `CapabilityManager`, the frozen empty production catalogs, state enums) moved to `src/extension-composition.js` — a Harness-owned file with NO workspace.js/vfs.js dependency (explicit globalThis publishes for the ESM mode). `src/extensions.js` keeps the PRODUCT adapter half (`StaticFileWorkspace`, `SkillInstanceStorage`, `SkillInstanceWorkspace`) plus `productTaskVfsMounts` (maps the manager's pure mount SPECS onto StaticFileWorkspace providers). Two boundary changes: `CapabilityManager` validates the instance storage as the NARROW port it calls (`readBytes`/`writeBytes`/`removeDir`/`stat` — no `instanceof`), and `taskVfsMounts(env)` became `taskVfsMountSpecs(env)` returning pure `{ path, name, files, authority }` data (no VFS class is constructed in the composition core). Load order: composition → extensions → capability-package (classic lexical chain unchanged).

| Symbol group | Owner | Notes |
|---|---|---|
| Identity/pattern constants (`EXTENSION_ID_PATTERN`, `EXTENSION_PY_MODULE_PATTERN`, roots, `SKILL_INSTANCE_*` bounds) | H | Also consumed by Runtime `configureExtensions` (see §2.3) — must be shared as *contract data* in the payload port, not as a global |
| Descriptor validators (plugin/skill/mcp/capability, `validateCatalogSet`) | H | |
| `SkillSourceStore` | H | Immutable default sources |
| `CapabilityManager` (enable/disable/materialize/presence/`buildTaskEnvironment`/`pythonExtensionPayload`/`taskVfsMounts`) | H | Composition core; snapshot is deep-frozen. `pythonExtensionPayload` output shape is the **plugin payload preparation port** consumed by Runtime `configureExtensions` (contract §3.7) |
| `SkillInstanceStorage` | **P** | Durable instance files via `resolveHome` provider (OPFS through the live VFS); storage implementation behind a Harness-defined port |
| `SkillInstanceWorkspace` | **P** | Approval-guarded, diff/TOCTOU-checked mutation view mounted on task forks (`store.js` wires it with `approvals`, `conversationId`, generation-pinned `getSignal`). Policy implementation per the authority row of REPOSITORY-SPLIT §2 |
| `StaticFileWorkspace` | R | Generic read-only provider (Runtime) used by Harness `taskVfsMounts` |
| Production catalogs (frozen empty) | P | Product selection lives in Product |

Callers: store.js, agent prompt (`capabilityPromptSection` reads the TaskEnvironment), python bootstrap. Behavior to preserve: identity protection (path = capabilityId/skillId), confirmation + diff + TOCTOU on mutations, marker lifecycle, snapshot immutability. Tests: `tests/capability-composition.test.cjs`, `tests/skill-instances.test.cjs`, `tests/python-plugin-runtime.test.cjs`; browser: capabilities, skill-instances, trusted-plugin-runtime. Gap: `SkillInstanceWorkspace`'s `getSignal` generation pinning is proven in skill-instances suites via the storage-mutation gate, but no test pins "old fork guard fails closed after session switch" in isolation — it inherits from store wiring; keep as an M1 acceptance item.

### 2.10 `src/capability-package.js` — validation to Harness, storage to Product

`LocusCapabilityPackage.validateProject/buildProject/inspectBundle`, manifest validators, `CapabilityBundle`: portable project validation and bundle semantics → **H** (operates over an injected `WorkspaceAdapter`). Durable plugin artifact storage (`/mnt/plugins` via `PersistenceService.writePlugin/readPlugin`) → **P**. Tests: `tests/capability-package.test.cjs` (+ e2e trusted-plugin-runtime for wheel payload reality). Gap: inspect/valid semantics are pinned in unit tests; storage wiring is pinned by plugin suites.

### 2.11 `src/persistence.js` — split semantics from storage

| Symbol group | Owner | Notes |
|---|---|---|
| `validateReplayPrefix`, `validateNormalizedPrefix`, replay-validation errors | **H** (M2b review round: the algorithms live in `src/harness/replay-validation.js`, re-exported by the entry; `persistence.js` keeps one-way delegates through the published `__LOCUS_HARNESS_REPLAY_VALIDATION__` table) | Replay/checkpoint semantics behind the persistence port; `createProviderSessions` defaults to them — the Product injects only storage/config/projection |
| `PersistenceService` (IDB stores, OPFS dirs, settings/credential storage with redaction, conversations, provider frames/normalized messages, workspace handles, attachments bytes, reset/clear) | **P** | Browser database + migrations + records |
| `LOCUS_HOME_SKELETON` | P (value) | Injected into Runtime VFS via global today (§2.2) |
| `PersistenceServiceInstance` global | P | Consumers today: store.js, attachments.js, capabilities.js (fallback), ConversationHistoryWorkspace |

Tests: `tests/persistence.test.cjs`, `tests/persistence-audit.test.cjs`, `tests/provider-replay-persistence.test.cjs`; browser: persistence (+ reload-e2e inside that suite). Gap: none material.

### 2.12 `src/attachments.js`, `src/capabilities.js` — perception split

| Symbol | Owner | Notes |
|---|---|---|
| `AttachmentStore` (ingest/verify/resolve, integrity errors) | **P** | Attachment storage; Harness consumes `resolveAttachment` through the imageInput port |
| `imageContentPart`, `textContentPart`, `base64WireBytes` | H | Semantic content-part shapes |
| `ModelCapabilityRegistry` | H | Provider/model image capability evidence (persistence injected; falls back to the Product global today — must be constructor-required post-split) |
| `createImageInputGate` | H | Ask/probe/registry gate |
| `runImageInputProbe` (+ PNG encoder) | H | Uses production `callModel` path |
| `classifyImageProviderError`, `imageInputUnavailableNotice` | H | Store.js `wiredModelClient` records provider rejections through it |

Tests: `tests/attachments.test.cjs`, `tests/capabilities.test.cjs`, `tests/image-probe.test.cjs`, `tests/model-adapters-image.test.cjs`, `tests/agent-image.test.cjs`; browser: image. Gap: the `PersistenceServiceInstance` typeof-fallback in both constructors has no negative test (registry-less + persistence-undefined is untested) — make it a required dependency in M2.

### 2.13 `src/telemetry.js` — sink port

`utf8ByteLength` (util, shared), `Telemetry` records + `window.__telemetry`. **M2b**: the `renderDebugPanel` legacy call is DELETED (no reverse dependency into Product UI); the recording sink is injected at the Product tool adapter (`opts.telemetry`, contained delivery); `store.telemetryVersion` bump on `tool_result` is the Product projection. Tests: exercised everywhere + `tests/harness-prompt-parity.test.mjs` H8 (throw/reject containment, one record per execution, no unhandled rejections).

### 2.14 `src/ui/store.js` — Product; the M1 extraction donor

**M1b update:** the store now OWNS the canonical python interpreter instance (lazily resolved: `window.__LOCUS_HOOKS__.pythonRuntime` seam → `createPythonRuntime` factory → null), drives it from `preparePythonRuntimeForEnvironment` (instance.prepare) and `onSessionReset` (instance.reset), and injects the SAME instance (`opts.pythonRuntime`) plus the Locus mutation policy (`opts.mutationPolicy`, loud failure when unavailable) into every bash call. `main.js` mirrors instance status; `?e2e=1` exposes `window.__locus.pythonRuntime()`.

**M1a update (post-extraction state):** the task lifecycle (admission, task controller, prepare→run→settle, pre-run cancel, quiesce gate) now lives in `src/harness/task-runner.js`, and the provider-session machinery in `src/harness/provider-session.js` — both ESM modules with injected ports, tested without Vue or the store (`tests/task-runner.test.mjs`, `tests/provider-session.test.mjs`). What remains in the store is the Product side: `prepareTask()` (conversation rebind, image build, VFS fork + skill mounts, python payload prep), the lazy `providerSessionsAdapter()` (the ONE place classic-script persistence/adapter globals map onto harness ports — M1b/M2 elimination point), UI projection, settings, storage controls and boot. Couplings that REMAIN after M1a: store still reads `session`/`vfs`/`PythonRuntime`/`SkillInstanceWorkspace`/`PersistenceServiceInstance` globals directly inside `prepareTask` and the adapter block; `agent.js` still reads `AGENT_TOOL_DEFINITIONS`/`shellSystemPromptSection` globals; worker sources still ship in page DOM. Historical disposition table (pre-M1a target, kept for reference):

| Region | Disposition |
|---|---|
| Module-scope `vfs`, `capabilityManager`, `session`, `approvals` construction | P (composition), but construction args become adapter-mediated in M1 |
| `preparePythonRuntimeForEnvironment` | **M1 → H/R boundary**: compares `env.pythonExtensionKey` with `PythonRuntime.extensionKey()`, resets + `configureExtensions(pythonExtensionPayload(env))`. This is task-assembly logic driving a Runtime global; becomes the lifecycle port call (contract §3.1/§3.7) |
| `wiredModelClient`, `wiredToolExecutor` | P adapters (inject `approvals`, `conversationId`, `taskGeneration`, hooks) |
| Provider-session machinery (`ensureProviderSession`, `restoreSessionForConversation`, `makePersistenceContext`, `providerConfig`, `sessionCompatible`) | **M1a → DONE** (`src/harness/provider-session.js`) |
| `submit` (rebind, image build, persistence-first ordering, task fork, skill mount, `session.run`) | **M1a → runner + `prepareTask`**; conversation identity stays P |
| `handleRuntimeEvent` + projector | P projection |
| `cancelTask` (incl. pre-run `pendingCancel`), `quiesceRuntimeForStorageMutation`, `withStorageMutation` | **M1a → DONE** (runner cancel/quiesce; `pendingCancel` deleted) |
| Settings (`applySettings`, `persistSettingsIfNeeded`, `testConnection`) | P (config provisioning) |
| Conversations, workspace mount/restore, uploads/artifacts, storage controls, boot | P |

Tests: `tests/store-defaults.test.cjs`, `tests/conversation-routing.test.mjs`, `tests/submit-presentation.test.mjs`, plus the new harness suites; browser: presentation, responsive, persistence. Gap closed by M1a: submit-path ordering and the pre-run cancel window are now pinned BOTH at the harness layer (S1–S9) and through the store suites.

### 2.15 Vue components, `src/main.js`, `src/App.vue`, `functions/`, `vite.config.js`

All **P**. `main.js` e2e/demo hooks are Product test seams; the `setInterval` poll of `PythonRuntime.status` (main.js end) is replaced by the Runtime status event in M2. `functions/fetch.js` (edge relay) + `functions/proxy.js` (model relay) are Product deployment infrastructure, referenced by Runtime/Harness only as configuration (relay path, `/proxy` base).

## 3. Coupling catalog (ranked; fix in this order)

Each entry: **evidence** (symbol + file at `d25f30e`) → **why it blocks the split** → **target seam**.

1. **Product page DOM is the Runtime's worker/package source of truth.** — **RESOLVED in M2a**
   `PythonRuntime._ensureWorker` read `document.getElementById('py-worker-src')`; `GrepRegexRuntime.createWorker` read `#grep-worker-src`; `tests/e2e.html` re-extracted worker sources from `../index.html` by regex to keep parity. Landed: `src/runtime/worker-assets.js` (`PY_WORKER_SOURCE`, `GREP_WORKER_SOURCE` — migrated verbatim from `index.html`, CRLF normalized); `createPythonRuntime({ pyWorkerSource })` and `createGrepRegexSession(pattern, flags, workerSource)` take the source explicitly and fail closed without one; `index.html` carries no worker elements; the e2e harness imports the same modules instead of re-extracting the product page; gate B runs the PACKAGED bundle (`dist/tests/runtime-host.html`, a real vite build input).

2. **Harness prompt generation reads a Runtime global.**
   `buildSystemPrompt` calls `shellSystemPromptSection()` via `typeof` guard (`src/agent.js`). Blocks: Harness cannot build prompts without shell.js. Target: injected `runtimeCapabilities.describeCommands()` (contract §3.7). Same pattern, lower risk: `agentToolDefinitions()` reading `AGENT_TOOL_DEFINITIONS` (stays inside Harness after §2.6). **M2a note:** shell.js exports `shellSystemPromptSection`/`SHELL_COMMANDS` through the declared core registry so the ENTRY can reach them; the injected description port itself stays M2b.

3. **Runtime execution writes Product DOM and is polled.** — **RESOLVED in M2a**
   `PythonRuntime._setStatus` wrote `#sb-python`; `main.js` polled `PythonRuntime.status` every second. Landed: per-instance status listener set + `RuntimeSession.onStatus` (immediate snapshot on subscribe, edge events after, contained observer exceptions, unsubscribe; instance-scoped so a stale instance cannot pollute another consumer); `main.js` subscribes once at boot and projects `snapshot.interpreter` into `store.pythonStatus`; the poll and the DOM write are gone (structurally enforced by the boundary gate's DOM-id scan of src and dist).

4. **Product persistence injects the home layout into the VFS by script order.** — **RESOLVED in M2a**
   `VFS_HOME_SKELETON` read the `LOCUS_HOME_SKELETON` global. Landed: `VirtualWorkspace({ homeSkeleton })` constructor argument (remembered for `resetHome`/`resetEphemeral` rebuilds); the generic default is the neutral `['.config', '.cache']`; the store passes `LOCUS_HOME_SKELETON` explicitly (Product→Product). vfs suites pin both the product-shaped skeleton and the neutral default.

5. **Shell commands embed capability/skill layout policy.** — **RESOLVED in M1b**
   `shMv`/`shRm` refused operations via `underSkillInstances('/home/locus/.skills')` + `SKILL_IDENTITY_BOUNDARY_MSG`. Landed: `src/mutation-policy.js` (Product) owns the rules and the byte-stable refusal texts; shell.js consumes `opts.mutationPolicy` (checkMove / checkRemove / isPolicyRefusal) — a missing product policy fails the bash call loudly (contract §3.7 M1b landed rules).
6. **Chat identities flow into Runtime network authorization.** — **RESOLVED in M2a**
   `wiredToolExecutor` passed `conversationId` + `session.generation` into `executeTool` → `runCurl` → `NetworkRuntime.request(spec.policyContext)`. Landed: the Runtime consumes the execution-authorization PORT (`spec.authorization = { request(req, opts) }` with a plain `{ kind, action, resource, policyKey }` request — contract §3.5); the chat-identity field names appear in NO Runtime source (structurally enforced by boundary gate G3); the Product adapter (`productNetworkAuthorization`) adds identity on its side when forwarding to the ApprovalController — downstream approval payloads unchanged; deny ≠ cancel and dispatch-once semantics unchanged.

7. **Runtime Python payload validation depends on Harness identity rules via globals.** — **RESOLVED in M2a**
   `configureExtensions` validated ids against `EXTENSION_ID_PATTERN`/`EXTENSION_PY_MODULE_PATTERN` from extensions.js. Landed: the Runtime validates against its OWN declared contract data (`RUNTIME_PLUGIN_ID_PATTERN`/`RUNTIME_PY_MODULE_PATTERN` in src/shell.js, exported via the core registry as `contract`); extensions.js keeps its Harness copy; `tests/runtime-boundary.test.cjs` G4 pins the two regex sources EQUAL and the byte-stable refusal message through the real configure gate.

8. **The tool router and telemetry are globals inside the executor.** — **RESOLVED in M2b**
   `executeTool` read `runShellCommand`, `Telemetry`, `utf8ByteLength` (`src/tools.js`). Landed in M2a: executeTool REQUIRES `opts.runtimeSession` and routes bash through `RuntimeSession.execute`. Landed in M2b: the Harness consumes the injected ToolPort (`AgentSession` requires `{ definitions(), execute({ name, input, context }) }`; the `AGENT_TOOL_DEFINITIONS` global read is deleted from agent.js) — `src/tools.js` is the Product adapter (`productToolPort` in the store composes it over the unchanged registry + executeTool), the per-task definition snapshot is frozen inside the session, and the execution measurement goes through an explicit contained `opts.telemetry` sink with the `renderDebugPanel` reverse dependency deleted; neither core reads the Telemetry global (harness-boundary B2 + runtime gate G).

9. **Product reads a Harness budget constant via global.** — **RESOLVED in M2b**
   `store.buildImageUserContent` reads `HISTORY_BUDGET_BYTES` (`src/ui/store.js`, typeof guard). Landed: the store imports `historyBudgetBytes()` from the Harness public entry (the declared table's constant); the typeof-global read is gone.

10. **Page-global single interpreter, reset from two places.** — **RESOLVED in M1b; wrapper LANDED in M2a**
    `PythonRuntime` was a plain-object singleton reset from `onSessionReset` and reconfigured per task by `preparePythonRuntimeForEnvironment`. M1b landed: `createPythonRuntime()` instance factory with an explicit prepare/run/reset/dispose/snapshot lifecycle. M2a landed the wrapper: the store resolves ONE host+session through the PUBLIC entry (`createRuntime` → `createSession`) and drives prepare/reset on it; `executeTool` requires `opts.runtimeSession`, so preparation and execution cannot split and no second execution path exists.
11. **`ConversationHistoryWorkspace` reaches into a private service method.** — **MOVED to Product in M2a**
    `read('provider-frames.jsonl')` path used `service._byIndex` (`src/workspace.js`). Landed: the class moved verbatim to `src/conversation-history-workspace.js` (Product classic script; build copy list + index.html order). `workspace.js` is Runtime-only. The `_byIndex` read is now Product-internal (same owner on both sides) — no longer a cross-repository reach; a public query method on the persistence port remains available as M3 cleanup.

12. **`typeof PersistenceServiceInstance` fallbacks.** — **capabilities.js RESOLVED in M2b**
    `capabilities.js` `ModelCapabilityRegistry` now REQUIRES its `persistence` dependency (loud constructor error; the store injects the service) and `runImageInputProbe` takes an explicit `callModelFn`/`model` (the Product passes its production client — no `callModel`/`Model` global fallback). `attachments.js` keeps its fallback — it is a PRODUCT file (attachment storage), so the fallback is Product-internal wiring, not a core boundary; revisit only if attachments.js moves.

Non-issues worth recording: `vfs.js` never references `SHELL_COMMANDS` directly (command list injected — keep); `capabilities.js` must not depend on `model-adapters.js` (script-order rule, holds today); `agent.test.cjs` proves agent.js runs registry-less.

## 4. Extraction order

The order below sequences M1–M2 so that each step keeps the product usable and gates each change. It refines REPOSITORY-SPLIT §7 with the file-level facts above.

1. **M1a — task assembly out of the store.** Move `submit/cancelTask/quiesce/persistence-context/provider-session` logic behind constructor-injected ports (files: `src/ui/store.js` → new harness-side module, still in-repo). No behavior change; `submit-presentation`, `conversation-routing`, `e2e-persistence` must stay green. Precondition: none.
2. **M1b — interpreter lifecycle behind an explicit handle.** — **DONE** on `refactor/repository-split-m1b`: `createPythonRuntime()` instances with prepare/run/reset/dispose/snapshot (contract §3.1 M1b form), the product-owned canonical instance wired through prepare/onSessionReset/executor opts; skill-path policy moved behind the mutation-policy port (`src/mutation-policy.js`). Gates: skill-instances + python-plugin suites unchanged (see [REPOSITORY-SPLIT-M1B-VERIFICATION.md](REPOSITORY-SPLIT-M1B-VERIFICATION.md)).
3. **M2a — Runtime packaging.** — **DONE** on `refactor/repository-split-m2a` (stacked on M1b @ `83fdfbb`): worker sources as Runtime-owned string modules (`src/runtime/worker-assets.js`; the `#py-worker-src`/`#grep-worker-src` elements are gone); `_setStatus` became status EVENTS (`RuntimeSession.onStatus`; `#sb-python` and the 1s poll removed); `LOCUS_HOME_SKELETON` became a constructor argument; `ConversationHistoryWorkspace` moved to Product files; the public entry `createRuntime → RuntimeHost → RuntimeSession` landed (`src/runtime/index.js`) with the session-layer prepare barrier; `EXTENSION_*` patterns became Runtime contract data; the network authorization port replaced chat identities; the Product chain routes through the entry (`executeTool` requires `opts.runtimeSession`). Gates: independence suites A–G (`tests/runtime-standalone.test.mjs`, `tests/runtime-boundary.test.cjs`, `tests/e2e-runtime-host.cjs` over the packaged `dist/tests/runtime-host.html`) + full e2e green (see [REPOSITORY-SPLIT-M2A-VERIFICATION.md](REPOSITORY-SPLIT-M2A-VERIFICATION.md)).
4. **M2b — Harness independentization.** — **DONE** on `refactor/repository-split-m2b` (stacked on M2a @ `ce471b0`): the public Harness entry (`src/harness/index.js` + `core.js` self-assembly over the declared `__LOCUS_HARNESS_CORE__` table); the ToolPort split with per-task definition snapshots (`src/agent.js`; the Product adapter composes `src/tools.js`); the description port (`RuntimeSession.describeCommands()` + `src/ui/product-prompt.js` environment notes); `createModelClient` with captured configuration (legacy `Model`/`callModel` wrappers delegate); explicit `capabilities.js` dependencies; the extensions ownership split (`src/extension-composition.js`); the contained telemetry sink. Gates: H1–H11 (`tests/harness-standalone.test.mjs`, `tests/harness-boundary.test.cjs`, `tests/harness-prompt-parity.test.mjs`) + full unit gate + full browser e2e (see [REPOSITORY-SPLIT-M2B-VERIFICATION.md](REPOSITORY-SPLIT-M2B-VERIFICATION.md)). **M2b review round (closed)**: the F1/F2 findings are fixed (deep definition snapshots; request-scoped relay/transport capture in `createModelClient`), the replay validators moved into the Harness (`src/harness/replay-validation.js`; `persistence.js` keeps one-way delegates), and the standalone harness host browser gate landed (`tests/harness-host.html` as a real build input + `tests/e2e-harness-host.cjs`) — the earlier "validators stay in persistence.js until M3" deviation is superseded.
5. **M3 — repository extraction** in dependency order: Runtime first (workspace/vfs/shell/network + worker assets + manifest), then Harness (agent/model/adapters/approval/extensions-composition/persistence-ports/attachments-parts), then Product adapters + lock. Precondition: M2a/M2b independence gates passing at the exact source SHA recorded for extraction.

The heaviest risk concentration is step 1+2 (store extraction) and step 3 (packaging): both touch behavior that only browser suites prove (Python bootstrap, skill mutations, persistence reload). The baseline results in [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md) are the reference set for those gates.
