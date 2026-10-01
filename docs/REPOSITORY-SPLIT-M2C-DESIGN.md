# Repository split M2c — Product integration adaptation and compatibility gate: symbol-level design

Status: M2c design record (written before implementation). Base: `refactor/repository-split-m2b` @ `506c96f1a15e7969558fde664eae2359fb8d17cd` (PR #6 head, verified OPEN and unchanged at branch creation; base `refactor/repository-split-m2a`; none of PRs #2/#3/#4/#5/#6 merged). Contract basis: [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) §5 (contract version + capability negotiation) and the §3.2/§3.5/§3.9 landed ports; inventory [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) §4 step 4/5.

M2c scope: the two cores' PUBLIC capability declarations, the Product-owned compatibility check wired into the production task entry, the production tool adapter as a shared (Vue-free) factory, the joint integration suites (real Harness → Product adapter → real Runtime → real VFS → tool result back to real Harness), and the real-browser joint gate over the packaged build. M2c is the closing sub-phase of M2 — it proves the two public entries work together and installs the pre-task compatibility check. It does NOT extract repositories (M3), does NOT create repositories, publish packages, deploy, install cross-repo automation, or fabricate dependency locks: every evidence tuple below is the SAME in-repo baseline. Task lifecycle (task-runner), prepare barriers, snapshot fidelity, relay capture and replay validation are NOT touched — no deterministic defect evidence against any of them.

## 0. audited reality this design builds on (symbols, not prose)

- `submit(text)` (store) → `taskRunner.submit(input)` → runner `prepare: prepareTask` → `PrepareOutcome`. `prepareTask` order today: bind `taskEventTargets` → (1) boot wait → (2) conversation rebind + `restoreInto` → (3) `buildImageUserContent` (attachment ingest = durable writes) → bind `runningConversationId`/`boundTaskId` → (4) required persistence (`ensureSession`, `persistConversation({required:true})`, `onUserMessage`) → (5) `capabilityManager.refreshSkillPresence()` + `buildTaskEnvironment()` + `preparePythonRuntimeForEnvironment` (Runtime `session.prepare`) + task fork/skill mounts → `run` (model requests, tool dispatch).
- Runtime assembly: store `whenRuntimeSession()` → ONE `createRuntime(...)` → host dropped, only `runtimeSessionResolved` kept. `host.capabilities()` currently declares `contractVersion/executionKinds/bootstrap.shaPinned/policyMechanisms`.
- Harness: `src/harness/index.js` resolves the declared `__LOCUS_HARNESS_CORE__` table (classic pages) or self-assembles. The table carries its own `contractVersion: 1` — an INTERNAL registry version. There is NO public harness capability declaration.
- Product ToolPort: `productToolPort` (store closure) = `AGENT_TOOL_DEFINITIONS.slice()` + hooks-seam/`executeTool` with `runtimeSession`/`mutationPolicy`/`authorization` injected. `src/tools.js` is the only tool adaptation path.
- Test hosting precedent: `tests/store-python-lifecycle.test.mjs` imports the REAL store in Node with seeded globals and the `window.__LOCUS_HOOKS__.runtimeSession` seam (fresh module graph per scenario via query-string imports).

## 1. D1 — public capability declarations

### 1.1 Runtime: `RuntimeHost.capabilities()` completed

```
capabilities() → frozen {
  contractVersion: 1,                       // PUBLIC runtime protocol version (unchanged)
  executionKinds: ['shell', 'python'],
  bootstrap: { shaPinned: true },
  policyMechanisms: ['mutationPolicy', 'authorization'],
  commands: Object.keys(core.SHELL_COMMANDS) sorted,   // NEW — the ACTUAL command registry
  limits: {                                            // NEW — REAL constants via the core registry
    shellPipeMaxBytes,        // SHELL_PIPE_MAX_BYTES
    headTailMaxOutputBytes,   // HEAD_TAIL_MAX_OUTPUT_BYTES
    pythonTimeoutMs,          // PYTHON_TIMEOUT_MS
  },
}
```

- `commands`/`limits` are read from the resolved core through the declared `__LOCUS_RUNTIME_CORE__` table: `shell.js` publishes a frozen `limits` entry holding ITS OWN constants (never retyped numbers) next to the existing `contract` entry. If the resolved core does not provide `SHELL_COMMANDS`/`limits`, the corresponding declaration is OMITTED — never fabricated (the same no-port-no-claim rule as `describeCommands()`).
- The core table's `contractVersion` (internal registry version) is NOT exposed as the public version; the public `contractVersion` on the host stays the protocol version. Same initial number, different concepts — documented in CONTRACTS §5.

### 1.2 Harness: new read-only `harnessCapabilities()`

New export on `src/harness/index.js` (same resolution rules as the factories — table first, self-assembly otherwise; call-time resolution):

```
harnessCapabilities() → frozen {
  contractVersion: 1,                       // PUBLIC harness protocol version
  registryVersion: <table.contractVersion>, // the INTERNAL registry version, declared under its OWN name
  ports: {
    taskLifecycle: { version: 1, outcomeReasons: TASK_OUTCOME_REASONS,   // new real constant from
                    maxToolIterations, historyBudgetBytes },             // src/harness/task-runner.js
    toolPort:       { version: 1, snapshot: 'per-task-frozen-transportable-json' },
    descriptionPort:{ version: 1, optional: true },
    modelClient:    { version: 1, configCaptured: true },
    approval:       { version: 1, kinds: <table APPROVAL_KINDS> },       // declared only when the table
                                                                         // carries a legal kinds array
    persistencePort:{ version: 1, replayValidators: 'harness-owned' },
  },
  capabilities: {
    nativeToolCalls: true, textFallbackStrict: true,     // harness-standalone H2/H3/H9
    taskEventIdentity: true, providerReplay: true,       // task-runner F2 / harness-replay
    imageInputGate: <table provides the gate trio>,      // declared from table presence
    capabilityComposition: <table provides the manager>,
  },
}
```

Rules honored:

1. Every declared item maps to a live implementation and an existing behavior suite (§4 gate mapping); nothing unimplemented is declared `true`.
2. Table-derived fields (`kinds`, `imageInputGate`, `capabilityComposition`, `registryVersion`) are declared from the RESOLVED table's actual content, shape-checked; a hostile table cannot make the declaration claim something its content does not support, and a broken field is omitted or shape-rejected — never guessed.
3. `outcomeReasons`/`maxToolIterations`/`historyBudgetBytes` come from the REAL constants (`TASK_OUTCOME_REASONS` new export in task-runner.js; table `MAX_TOOL_ITERATIONS`/`HISTORY_BUDGET_BYTES`), never hand-copied.
4. The two cores never import each other, never identify "Locus", and never judge each other's compatibility — `harnessCapabilities()` is a pure statement about THIS harness.

### 1.3 What is deliberately NOT done

- No `HarnessHost` wrapper (explicitly rejected in the task and by M2b's entry design).
- No version inference from package versions, function sources or arity.

## 2. D2 — the Product owns the compatibility check

### 2.1 `src/product/core-compatibility.js` (new Product module)

Pure ESM: no Vue, no DOM, no storage open, no worker start, no imports from either core. Exports:

- `CompatibilityError` — `code`, `core` ('runtime'|'harness'), `port?`, `capability?`, `required`, `provided`, `message`; frozen own fields. Codes:
  `declaration_missing` (no declaration available — an absent host is NOT "compatible"),
  `declaration_invalid` (declaration or required field present with an impossible shape),
  `contract_version_unsupported` (public protocol version outside the supported set),
  `registry_version_unsupported` (internal registry version outside the supported set),
  `port_version_unsupported`, `capability_missing`, `capability_value_mismatch`.
- `PRODUCT_CORE_REQUIREMENTS` — the frozen, explicit Product requirement table (below).
- `checkCoreCompatibility({ runtime, harness, requirements })` → frozen result `{ compatible: true, runtime: { contractVersion, registryVersion? }, harness: { contractVersion, registryVersion? }, optional: { runtime: { missing: [...] }, harness: { missing: [...] } } }`, or THROWS the `CompatibilityError`. `undefined`/missing required fields are reported (never defaulted to compatible).

Check semantics (task rules 1–7): supported versions + all required capabilities → pass; unsupported mandatory version → `*_version_unsupported`; missing required capability → `capability_missing`; invalid declaration shape → `declaration_invalid`; unknown EXTRA optional capabilities → ignored (never a rejection); missing OPTIONAL capability → listed in `result.optional[…].missing` for the Product's explicit rules, never a silent authority/persistence/approval downgrade; no historical-version adaptation framework — only the actual protocol is supported, unknown mandatory versions are rejected.

### 2.2 The Product requirement table (explicit, owned by Product)

```
runtime: {
  supportedContractVersions: [1],
  requiredCapabilities: {
    executionKindsMustInclude: ['shell'],
    policyMechanismsMustInclude: ['mutationPolicy', 'authorization'],  // approval + skill rules are
    bootstrapShaPinned: true,                                          // authority, not conveniences
    commandsNonEmpty: true,
  },
  optionalCapabilities: [
    { capability: 'executionKinds.python',
      rule: 'the product tools call kind "shell" only; the direct python kind is unused' },
  ],
}
harness: {
  supportedContractVersions: [1],
  supportedRegistryVersions: [1],          // distinct from the protocol version on purpose
  requiredPorts: { taskLifecycle: 1, toolPort: 1, modelClient: 1,
                   approval: 1, persistencePort: 1 },
  requiredCapabilities: ['taskEventIdentity', 'providerReplay'],
  optionalCapabilities: [
    { capability: 'nativeToolCalls',       rule: 'strict text-fallback protocol remains functional' },
    { capability: 'imageInputGate',        rule: 'image attachments degrade to text-only with an explicit warning' },
    { capability: 'capabilityComposition', rule: 'capability features disabled (existing null-manager guards)' },
  ],
}
```

### 2.3 Production wiring — the gate sits at the head of `prepareTask`

`prepareTask` gains step (0) BEFORE the boot wait, conversation rebind, image build, required persistence, capability refresh/environment build, Runtime prepare and any model request:

1. Skip entirely when `task.signal.aborted` (a dead task's honest terminal is its existing cancellation classification).
2. `await whenRuntimeSession()` — the ONE lazy assembly (module resolution + session wrapper only; no worker, no Python boot, no storage). Resolving the assembly here is "reading static declarations", not a task side effect; the liveness re-check follows the await.
3. Declarations: runtime — from the RETAINED host (the store now keeps the host reference: new module-level `runtimeHostResolved`, accessor `runtimeHost()`; never re-derived from private session/interpreter objects). When the session came from the `window.__LOCUS_HOOKS__.runtimeSession` seam, the declaration comes from the EXPLICIT `hooks.runtimeCapabilities` — test hooks must assemble declarations; there is NO "skip the check in test mode". Harness — `harnessCapabilities()` from the entry.
4. `checkCoreCompatibility(...)`: on `CompatibilityError` → `return { status: 'blocked', code: 'core_incompatible', message }` — the RUNNER'S EXISTING structured-rejection mechanism (`error {code,message}` + one `task_end`, slot released through `complete()`); no second task_end path, no new release path. The structured fields ride in the message (`code/core/port/capability/required/provided`), and the frozen error is attached as `error` on the blocked outcome for programmatic consumers.
5. A declared-optional capability's absence applies its documented product rule only (the store implements the imageInputGate rule: `imageInputGateAvailable()` mirrors the missing capability into the existing text-only attachment degrade with its explicit warning — the same user-visible behavior as a missing attachment store, no silent guarantee change).

### 2.4 Effects on the audited chain (none beyond step 0)

The boot wait, rebind/restore, image build, required persistence, capability refresh, interpreter prepare, fork/mounts and run ordering are untouched. `cancelTask`, `quiesceAndRun`, `onTaskEnd`, adoption and classification are untouched.

## 3. D3 — the production tool adapter as a shared factory + joint suites

### 3.1 `src/product/tool-adapter.js` (new, Vue-free)

```
createLocusToolPort({ definitions, execute, resolveRuntimeSession, mutationPolicy, authorization }) 
  → { definitions(), execute(call) }
```

The EXACT composition extracted from the store's `productToolPort` (context read from `call.context`, `runtimeSession` resolved through the async one-time resolution, `mutationPolicy`/`authorization` injected). Deps differ per host: the store passes its closures (definitions from the registry, the hooks-seam/`executeTool` executor, `productNetworkAuthorization`); the joint tests pass the REAL `executeTool` and their real authorization adapter. `src/tools.js` `executeTool` remains the only tool adaptation path — the factory does not re-implement it.

### 3.2 `tests/product-integration.test.mjs` — joint gates I1–I7

Hosted like `store-python-lifecycle` (fresh real-store module graph per scenario; real harness entry self-assembly `ensureHarnessCore()`; real runtime entry + real VFS via `createWorkspace`; real `tools.js`/`mutation-policy.js`/`projector.js` sources; scripted fake MODEL only — provider-shaped responses injected at `Model.transport`, so requests traverse the real client → real adapter serialization; never a fake two-core shortcut; the two independent host pages remain separate gates and are not counted as joint evidence):

- **I1** normal chain: native OpenAI `tool_calls` bash `echo m2c > … && cat` → real Runtime shell writes/reads the real VFS; the NEXT transport call's body contains the tool result; final answer; conversation `completed`.
- **I2** failure propagation: a failing shell command produces `success:false` in the harness-visible result and the next request body; the task still terminates honestly (never a converted success).
- **I3** cancel + boundary: a transport parked on an event barrier; `cancelTask()` settles the task `cancelled` with the dispatched state reported; a `session.reset()` boundary (`newTask`) ends the old task `session_changed` and the old task cannot dispatch further side effects (execution counters on the REAL runtime session, event barriers — no fixed sleeps as ordering proof).
- **I4** session isolation: the old task's late tool_result/events route to THEIR bound conversation (taskEventTargets) and cannot touch the successor's VFS or timeline.
- **I5** permission: model requests `curl` against a probe URL; `globalThis.fetch` is replaced by a recording stub; the approval is DENIED through the real controller → zero fetch dispatch (offline oracle — no real network), deny ≠ cancel.
- **I6** compatibility negatives through `store.submit` (real entry, real checker): (a) the retained host's `capabilities()` patched to `contractVersion: 999`; (b) a fresh graph whose seeded harness table declares `registryVersion: 999` (a genuinely different harness generation → the real `harnessCapabilities()` reports it); (c) `policyMechanisms` missing `authorization`; (d) a hostile declaration shape (non-array `APPROVAL_KINDS` → shape-invalid declaration). Each: zero transport calls, zero Runtime prepare/execute (counted on the real session object), zero required persistence writes, zero tool dispatch; `task_end` published through the runner; the slot is released and the NEXT legal task runs. Pure-checker-only rejection does NOT count — these go through `submit()`.
- **I7** replay + required persistence: in-memory persistence stub; a full tool task writes frames/checkpoints; restore with the REAL harness validators (provider-session defaults) replays; a corrupted checkpoint and an uncheckpointed suffix reject replay with ZERO tool re-execution and zero model requests; a required-write failure keeps `persistence_error` with zero subsequent model requests.

### 3.3 Suite registration

`tests/core-compatibility.test.mjs` (checker unit battery) + `tests/product-integration.test.mjs` register in `tests/run-unit.cjs`. Existing suites that inject a hooks runtime session gain the explicit `runtimeCapabilities` declaration (required by §2.3 — no skipped checks anywhere).

## 4. D4 — real-browser joint gate

New `tests/e2e-product-joint.cjs`, registered in the `tests/e2e.cjs` presentation block (shares that block's build + preview lifecycle), driving the PACKAGED product page at `?e2e=1&wire=1` — the production adapter path with the scripted fake living at `Model.transport` (below the real model boundary, the wire-suite pattern):

- J1 full chain: scripted native tool_calls → real productToolPort → real RuntimeSession → real shell/VFS write+read-back → tool result in the next provider request → final answer projected; tool card/telemetry attribution asserted.
- J2 real Python: bash `python <<PY` heredoc through the SAME chain → real worker asset assembly + REAL verified Pyodide bootstrap (the existing verified bootstrap assets and budget method; the asset download is recorded as REAL network, distinct from every faked model hop).
- J3 cancel: parked transport → composer cancel → honest cancelled terminal, `busy=false`.
- J4 permission denial: `curl` through the real chain → real ApprovalCard → Deny → zero `window.fetch` dispatch (recording stub installed by the driver).
- J5 compatibility failure: `window.__locus.runtimeHost()` (new ?e2e=1 seam) → capabilities patched to an unsupported version → `submit` → `core_incompatible` error projected, zero model calls; restore → next legal task runs.
- J6 zero page errors / unhandled rejections.

The runtime-host and harness-host pages stay untouched. Deterministic CDP assertions carry the proof; screenshots are auxiliary. An interactive human pass is supplementary only and is recorded honestly if not performed.

## 5. Gate mapping (every declared item → its evidence)

| Declared item | Implementation | Behavior evidence |
|---|---|---|
| runtime `commands` | `SHELL_COMMANDS` registry via the core table | shell suites; new runtime-capabilities checks in `runtime-standalone` |
| runtime `limits` | shell.js constants via the new table `limits` | same, plus equality-with-source assertion |
| runtime `executionKinds`/`policyMechanisms`/`bootstrap` | existing entry (M2a) | runtime-standalone |
| harness `ports.taskLifecycle.outcomeReasons` | new `TASK_OUTCOME_REASONS` (task-runner.js real enum) | task-runner suite + compatibility suite equality |
| harness `ports.approval.kinds` | table `APPROVAL_KINDS` | approval suite + equality |
| harness `nativeToolCalls`/`textFallbackStrict` | agent.js loop | harness-standalone H2/H3/H9, harness-host browser gate |
| harness `taskEventIdentity` | task-runner stamping | task-runner F2 suite, submit-presentation |
| harness `providerReplay` | replay-validation + provider-session | harness-replay, provider-session suites |
| harness `imageInputGate`/`capabilityComposition` | table presence (capabilities.js / extension-composition.js) | image/capability suites; product rule wired in the store |
| compat check semantics | src/product/core-compatibility.js | tests/core-compatibility.test.mjs |
| production wiring + I1–I7 | store step (0) + tool-adapter factory | tests/product-integration.test.mjs |
| browser joint gate | packaged build + production adapter | tests/e2e-product-joint.cjs |

## 6. Deliberate deviations recorded up front

1. Compatibility rejections use the runner's `blocked` outcome (structured `code` + `message` + one `task_end('interrupted')`) instead of `{status:'failed'}` — the blocked path exists exactly for "preparation decided the task must not run" and keeps a SPECIFIC machine-readable code in the event stream; the outcome reason stays the runner's own semantics. The structured CompatibilityError travels on the outcome object for programmatic consumers and in the message text for the UI.
2. The harness declaration exposes the internal `registryVersion` UNDER ITS OWN NAME (distinct from `contractVersion`) so a genuinely different harness generation is detectable and honestly testable through the real entry — the two numbers stay different concepts (CONTRACTS §5).
3. A deployment whose runtime assembly resolves to NOTHING (no workable core) now fails every task at step (0) with `declaration_missing` instead of letting bash fail per-call while text-only tasks silently "work" — the fail-closed reading of "undefined must not default to compatible".

## 7. Review round 1 addendum (written after the review; §§1–6 above are the pre-implementation record)

The first review confirmed three gaps against this design: (F1) §2.3's step 5 rule was documented but not consumed — `imageInputGateAvailable()` read the RUNTIME declaration for the HARNESS capability `imageInputGate` (the runtime declares no `capabilities` section, so the guard could never fire), the gate discarded `checkCoreCompatibility`'s result, and `capabilityComposition:false` still built a full task environment behind the null-manager guards; (F2) the joint suites had no execution-phase lifecycle evidence and their `waitFor` treated a pending Promise as truthy (async barriers were no-ops); the compatibility negatives had no public-port-version case and no required-write counting oracle.

Additions on top of §§1–6 (no change to the declared surfaces or the check semantics):

1. **Per-task frozen decision (§2.3 amendment).** The gate keeps the frozen check result as THIS task's decision (`taskCompatibilityDecision` in the store — `Object.freeze`, one object per task). Consumers read the decision; they never re-read declarations mid-task and never consult page-level mutable state. Consumers: `buildImageUserContent` (imageInputGate rule), the capability environment block (capabilityComposition rule: zero refresh/build/payload/mounts; user-enabled capabilities → `blocked` with `capability_composition_unavailable` BEFORE any side effect), and the runtime core-only prepare (null payload) on the disabled path.
2. **Harness declaration seam (§2.3 amendment).** `harnessDeclaration()` mirrors `runtimeCapabilitiesDeclaration()`: `hooks.harnessCapabilities` may host a genuinely different-declaring harness generation (tests-as-hosts / a self-assembling standalone host). The seam substitutes the DECLARATION only — the same `checkCoreCompatibility` always runs; there is no skip mode.
3. **Rule texts are normative behavior, not prose.** `PRODUCT_CORE_REQUIREMENTS` optional rules were rewritten to the implemented rules; the joint OPT blocks are their evidence (image degrade with a live store + per-task re-check; composition disable counters + enabled-capability refusal; nativeToolCalls fenced-JSON round trip; shell-only executionKinds). If a future rule cannot be supported, it moves to `requiredCapabilities` and rejects early — that is the recorded policy.
4. **Joint suite upgrades.** `waitFor` awaits async conditions (with a self-test of the barrier itself); I4 delivers an ACTUAL late response (manual park released after the boundary and the successor conversation were established); I6 gains the public port-version negative and a required-vs-optional persistence-write counting oracle; I8 parks the real chain inside a VFS provider write for cancel/reset/dispose lifecycle evidence (slot occupancy, honest settlement of dispatched operations, no fake success, reuse after reset, refusal after dispose).

## 8. Review round 2 addendum — historical images obey the frozen per-task decision (written after the review; §§1–7 above are the pre-implementation + round-1 record)

The review found the round-1 wiring incomplete: the frozen `taskCompat` governed NEW attachment construction only. `AgentSession.run` checked the ENTIRE history for image parts and consulted the SESSION-level `imageInput` gate (`ensureCapability`) plus `_materializeImageContent` regardless of the task's decision — so in the real product chain (available AttachmentStore + in-memory persistence), a normal image task leaves image references in history, and the NEXT task with a frozen `imageInputGate:false` decision still raised the capability approval and, once confirmed, still sent `image_url` for the historical references. Confirmed against the unmodified implementation before any fix: `product-integration` IMG-1's degrade submit never settles (the task suspends on the image-capability ask; `unsettled top-level await`), and the standalone `agent-image` run-binding cases fail 5/5 (the session-level gate answers, the image goes out).

Design (the task's recommended general seam, parameter named after the session dep it overrides):

1. **Harness — `AgentSession.run(input, { imageInput })`.** One optional run option, the SAME port shape as the session-level `imageInput` dep (`ensureCapability` / `resolveAttachment` / `unavailableNotice?`). Captured ONCE at run entry (`const runImageInput = o.imageInput || this.imageInput`) BEFORE any model request; the gate consultation and `_materializeImageContent(requestMessages, gate, runImageInput)` both use the captured object, so the current input, the in-memory session history and persistence-restored history all flow through ONE frozen binding per task; a mid-task change to whatever produced the caller's decision cannot re-bind a running task, a task's binding can never leak into the next one, and the default (no override) is byte-identical standalone behavior. The Harness never reads a taskCompat structure, never imports Runtime/Product, never swaps `session.imageInput` temporarily, and holds no page-level "current decision".
2. **Product — the binding is built from the frozen decision.** `prepareTask`'s ready block builds `taskImageInput = (taskCompat && !taskCompat.imageInputGate) ? taskImageInputDenial(runningConversationId) : null` from the ALREADY-frozen per-task decision (no re-read; a null decision — task dead at the gate — keeps the pre-existing path, and the run body never executes for such tasks). `taskImageInputDenial` is a plain port object: `ensureCapability` resolves `{ state: 'unsupported', source: 'task' }` without touching the real gate (no approval ask, no probe, no registry write); `resolveAttachment` resolves null without ever reading attachment bytes (materialization consults the resolver only on `supported`); `unavailableNotice` returns the deterministic task-level notice ("Image input is disabled for this task …"), projected through the EXISTING unavailable-image request mechanism — copy-on-write, never an in-place history edit, never string surgery on serialized provider requests. The user warning (`image_input_unavailable`) is raised once per run — keyed through the run's own askCache — and only when images were actually about to enter a request (a pure-text history never warns). No file is deleted; frames, normalized history and attachment bytes are untouched.
3. **Decision lifetime.** One binding per task, every model request of the task uses it (askCache shared across the run's loop); the next task re-checks the declaration and re-binds; when the capability is back, the original history images cross normally again (the durable references were never degraded).
4. **I8d (the evidence gap I8c left).** dispose WHILE the dispatched provider operation is unsettled: the real chain parks inside the VFS provider write, `session.dispose()` strikes mid-execution — the task must not end early, admission stays closed, the released write settles honestly (bytes stay), the run reports FAILED (telemetry `success:false`, never a fake success), zero further provider dispatch, and the disposal permanently refuses execute/prepare and every later product task. The existing I8c (dispose after a clean boundary) is kept; it does not substitute for this.
5. **Browser seam.** `window.__locus.harnessCapabilities` (?e2e=1) exposes the REAL entry declaration so the packaged-browser gate derives its variant from the live declaration (only `imageInputGate` flipped) through the same narrow `hooks.harnessCapabilities` seam the store reads per task — never a hand-written shape, never a skip mode.

Deliberately NOT done: no gate/registry/probe code path learns about the degrade (the deny binding is an ordinary port value); no new port or version bump (the run option is an optional argument of the existing taskLifecycle/toolPort contract surface — absent means the old behavior).
