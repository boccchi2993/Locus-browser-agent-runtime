# Repository split M0 — interface contracts (drafts)

Status: M0 deliverable, **revised in M1a** (corrections: §3.5 authorization direction — each core defines its own side, Product bridges; §4 model-retry row — current behavior, not a non-delivery guarantee; §3.1/§3.4 current-vs-target lifecycle distinction — single live session + lazy interpreter today; §3.4-Q1 — internal execution-layer cancellation controllers are legitimate when cascading the task signal). **M1a landed** the §2 task lifecycle and the §3.9 persistence-context port as real modules (`src/harness/task-runner.js`, `src/harness/provider-session.js`, product wiring in `src/ui/store.js`; verification in [REPOSITORY-SPLIT-M1A-VERIFICATION.md](REPOSITORY-SPLIT-M1A-VERIFICATION.md)). **M1b landed** the §3.1 interpreter lifecycle (as `createPythonRuntime()` instances with prepare/run/reset/dispose/snapshot — no page-global `PythonRuntime` remains) and the §3.7 `MutationPolicy` port (as `src/mutation-policy.js` product policy consumed via `opts.mutationPolicy`; verification in [REPOSITORY-SPLIT-M1B-VERIFICATION.md](REPOSITORY-SPLIT-M1B-VERIFICATION.md)). Everything naming RuntimeHost/RuntimeSession/ExecutionAuthorization/worker packaging remains a draft for M2. These are implementable drafts for M1/M2, written against the audited baseline (`d25f30e`, see [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md)). They are documentation, not shipped code: TypeScript-like notation describes shapes for the JavaScript implementations; no migration to TypeScript is implied. In-process module calls are sufficient — no RPC, service, or message bus is introduced.

Design rule (from the task and REPOSITORY-SPLIT §4): no single boundless `RuntimeContext`/`AppContext`. Each concern below is its own small port with its own owner. Ports are plain parameters, exactly like the existing seams they formalize (`AgentSession` deps, `policyContext.approvals`, `imageInput`).

## 1. Port map and owners

| # | Port | Owner defines | Implementations |
|---|---|---|---|
| 3.1 | `RuntimeHost` / `RuntimeSession` lifecycle + execution | Runtime | Runtime; Product constructs |
| 3.2 | `ToolPort` (definitions + executor) | Harness | Product adapter (today `executeTool`) |
| 3.3 | `FileSystemContext` | Runtime | Runtime (`VirtualWorkspace` fork) |
| 3.5 | `ExecutionAuthorization` (Runtime-defined consumer interface) / `ApprovalController` (Harness-defined approval semantics) | each core defines its own side | Product adapter bridges the two |
| 3.6 | Worker/bootstrap packaging | Runtime | Runtime |
| 3.7 | Description + mutation-policy + plugin-payload ports | split per section | |
| 3.8 | Event sinks (`RuntimeEventSink`, harness task events) | each emitter | Product projects |
| 3.9 | `PersistencePort` + product adapter map | Harness (semantics) | Product (storage) |
| §4 | Error/retry taxonomy | each owner | |
| §5 | Contract version + capability negotiation | both cores | Product checks |

## 2. Task lifecycle (state machine, owner: Harness task runner)

**M1a implementation status: LANDED** as `src/harness/task-runner.js` (`createTaskRunner`, `submit`, `activeTask`, `observeEvent`, `quiesceAndRun`; TaskHandle with id/signal/idempotent cancel/adoptEpoch/ended/outcome). Deviations from the draft below, all intentional: the outcome enum adds `interrupted` (blocked raw replay) and `rejected` (silent product-side refusal). **Revised after the M1a lifecycle review (PR #3 follow-up)** — the corrections below supersede the earlier wording ("signal → epoch → failure-class priority", "observeEvent settles on task_end after its own task_start"):

1. **Real completion boundary.** Observing a terminal `task_end` EVENT never settles a task. The run body hands `task_end` to its task-bound `ctx.emit`, which records the termination *intent*; the runner publishes the single final `task_end` itself only once the run body has returned or thrown (pre-run paths complete immediately at their decision). `ended` resolves after publication and after must-await cleanup; admission (`submit`) and the storage quiesce gate key off this same boundary — a terminal event alone never reopens admission.
2. **Task event identity.** Every lifecycle event carries the task's unforgeable `taskId`, captured at EXECUTION START — the runner stamps its own emissions, and the run body emits through the per-task sink the runner hands it as `ctx.emit` (the Product passes it into `AgentSession.run({ emit })`). Nothing is stamped with "whoever is active when the event arrives". `observeEvent` and the Product's `handleRuntimeEvent` filter/route by that identity BEFORE projection: a late tail (task_start/task_end/warning/tool_result) of an already-released task is dropped and can neither settle nor pollute the active task's state or UI. The marker lives on the event envelope only — provider messages are untouched and `toolCallId` semantics are preserved.
3. **One classification table for thrown AND structured failures** (`{status:'failed', error}` classifies identically to a throw, and BEFORE the liveness guards): `persistence_error` > `error` (an honest independent failure) > `session_changed` (epoch change, explicit `cancel('session_changed')`) > `cancelled`. A thrown `AbortError` IS the cancellation, never an independent error. A necessary persistence failure surfacing after a termination intent but before publication overrides the recorded reason and is never silently lost.
4. **Synchronous quiesce admission close.** `quiesceAndRun` closes admission SYNCHRONOUSLY at the call itself (pending-mutation counter, not a flag set after an await) and keeps it closed for as long as ANY queued mutation is pending — no reopening window between queued storage actions. A timeout neither executes the action nor pretends the old task ended.
5. **Effective-epoch classification at ANY phase** (second lifecycle round). Failure classification compares against the task's EFFECTIVE binding — the pinned epoch once the ready result adopted it, the submit-time generation before that — never the CURRENT epoch read at failure time (that would compare the session with itself and mask a real boundary). A preparation-phase epoch change IS an external session boundary (thrown or structured AbortError, with or without a concurrent plain cancel → `session_changed`). A legitimate Product-internal rebind adopts its generation explicitly via `handle.adoptEpoch(epoch)` AT the rebind point and is therefore not misread as a boundary, while a real boundary after the adoption is still detected. The ready result's epoch remains authoritative (it subsumes any preparation-phase adoption; `adoptEpoch` is refused once preparation is over). Persistence keeps priority 1 over all of this.
6. **Staged termination publication** (second lifecycle round). The completion boundary is staged, one task_end, one truth: (1) the run body returned/threw (or a pre-run decision) — the termination intent is collected; (2) NECESSARY finalize runs — the optional `finalizeTask(handle, outcome)` dep, awaited BEFORE the outcome is fixed: a persistence failure there REPLACES the outcome with `persistence_error` (never downgraded to a warning), any other failure is contained; (3) the single final `task_end` publishes the final outcome — the Product task→conversation map is still ALIVE for this projection (its release is stage 4); (4) `onTaskEnd` releases bindings / notifies — awaited so admission and the storage gate cover it, but a throw/rejection never changes the published outcome (`task_cleanup_failed`); (5) admission is released and `ended` resolves; quiesce and the next task wait for this whole necessary-completion boundary. No code path publishes a second `task_end`. Register `finalizeTask` only for a PROVEN necessary completion write — telemetry and optional UI saves are never necessary writes (the Product currently registers none; its completion-path writes are failure-tolerant optional saves, and required writes classify through the failure table inside prepare/run).

`finalizeTask` vs `onTaskEnd` roles are explicit: `finalizeTask` (optional) is the only phase whose failure may still CHANGE the outcome (necessary persistence → `persistence_error`); it runs before publication and is covered by `ended`, admission and the gate. `onTaskEnd` is the post-publication release/notification: a thenable return is MUST-AWAIT cleanup (covered by `ended`, admission and the gate); a throw (or rejected cleanup promise) is contained, surfaced as a `task_cleanup_failed` warning, and `ended` still resolves — the published outcome stands. Formalizes what `submit()`/`cancelTask()`/`quiesceRuntimeForStorageMutation()` did in `src/ui/store.js`:

```
submitted → preparing → running → settling → ended
                │           │
                └── cancel ─┘        (cancel allowed from submitted until ended)

TaskHandle (Harness) = {
  id: string                    // today: implicit runningConversationId + generation pair
  signal: AbortSignal           // ONE controller per task, see §3.4-Q1
  cancel(reason): void          // idempotent; sets terminal intent
  adoptEpoch(epoch): boolean    // explicit adoption of a Product-internal rebind's
                                //   generation DURING preparation (§2 rule 5); refused
                                //   once preparation is over; the ready epoch wins
  ended: Promise<TaskOutcome>   // resolves exactly once, at the staged completion
                                //   boundary: finalize + terminal published + release done
  outcome: TaskOutcome          // { reason: 'completed'|'cancelled'|'session_changed'|
                                //            'error'|'persistence_error'|'iteration_limit'|
                                //            'interrupted', committedEffectsReported: boolean }
}
```

Rules (all already enforced somewhere today; the contract makes them one place):

- The handle is created at `submitted` — **before** any preparation or `AgentSession.run`. A cancel in `preparing` aborts `signal` and the runner records the terminal outcome without any provider request (today: `pendingCancel` + `finishPreRunSessionSwitch`, `src/ui/store.js`).
- A session boundary (conversation switch, workspace remount, reset) sets `outcome.reason = 'session_changed'` on every live handle; their tail events still project into *their own* conversation — routed by the event's `taskId` → conversation binding captured at execution start (`taskEventTargets` in `src/ui/store.js`), never by whichever conversation is live when the event arrives.
- Exactly one terminal event per task (`task_end`), published by the runner at the real completion boundary. Nothing may attach to an ended handle (§3.8).
- Required persistence failure during the first user frame or any checkpoint transitions the task to `ended(persistence_error)`; no provider request follows a failed required write that precedes it (today: durable-ordering block in `submit`).

## 3. Port reference

### 3.1 Runtime lifecycle and execution (Runtime-owned) — **M1b form landed; RuntimeHost/RuntimeSession remain the target interface**

Current reality (must not be blurred): today there is **one** live agent session and **one** interpreter per page (`session` and `PythonRuntime` are singletons; `src/ui/store.js`, `src/shell.js`). The `RuntimeHost`/`RuntimeSession` shapes below are the *target* extraction interface; introducing them must not be read as supporting multiple concurrent sessions or retaining multiple interpreters. The interpreter also boots **lazily** — the first Python execution fetches/boots it; preparation only *configures* the payload for a future boot, so a text-only task downloads and starts nothing.

M1b status: **LANDED** in the M1b form — `createPythonRuntime()` (`src/shell.js`) builds interpreter instances with all mutable state owned per instance (worker facade, boot promise/timers, pending-request map, request sequence, execution queue, plugin payload, disposed flag, reset generation). Explicitly shared: only the frozen bootstrap manifest and stateless helpers; the VERIFIED ASSET CACHE is per instance by decision. There is NO page-global `PythonRuntime` anymore; the Product (store) creates the ONE canonical instance per page, drives it with prepare/reset, and injects the SAME instance into every shell execution (`opts.pythonRuntime`) — preparation and execution cannot split onto two interpreters. The interface below (RuntimeHost/RuntimeSession/createSession over worker asset bundles) remains the M2 target shape.

M1b landed semantics (implementing the draft above where the code chose names):

```
createPythonRuntime() → PythonRuntimeInstance   // per-instance state; lazy boot preserved

PythonRuntimeInstance = {
  // Between tasks. Compares the wanted plugin payload key with the live
  // one; same key = no-op ({rebuiltInterpreter:false}); key change =
  // validate-then-swap. Validation (the exact configureExtensions shape
  // gates) happens BEFORE the teardown: a failure leaves the old payload
  // fully intact — never a half-applied reset. A prepare whose signal is
  // already aborted is refused and applies nothing. prepare is
  // SYNCHRONOUS by construction (no awaits between compare and commit),
  // so no stale/cancelled caller can interleave; callers cannot assume
  // async completion because there is none.
  prepare(req: { signal?: AbortSignal, python?: PluginPayload | null })
    → { rebuiltInterpreter: boolean }

  // The execution port (shell python lands here via opts.pythonRuntime;
  // serialized queue, mirror/commit phases unchanged). Missing injection
  // fails the tool call loudly — there is no global fallback.
  run(code, vfs, opts) → Promise<ExecutionReport>

  // Session/rebuild boundary. SYNCHRONOUS effect: aborts the in-flight
  // boot, fails every pending request, drains queued-but-unstarted runs,
  // tears the worker stack down to cold. Callers must NOT assume their
  // own in-flight run() promise has settled when reset() returns — it
  // settles at that run's next await boundary (with the reset reason as
  // its error, or as a cancellation if the task signal aborted). The
  // instance stays REUSABLE afterwards. A boundary landing while a run is
  // suspended between seat acquisition and the worker post is caught by
  // the reset generation: the run rejects with the boundary reason and
  // never reaches the next generation's interpreter.
  reset(reason?: string): void

  // Terminal. Everything reset does, plus permanent refusal of
  // prepare/run/configureExtensions (throws with the disposal reason).
  // IDEMPOTENT — a second dispose keeps the first reason. Late worker
  // messages cannot revive the instance (creator destroyed; the disposed
  // flag blocks new work). Returns nothing; disposal is synchronous.
  dispose(reason?: string): void

  // Canonical state read: { interpreter: 'cold'|'loading'|'ready',
  // busyExecutions, extensionKey, disposed }.
  snapshot(): RuntimeSnapshot
}
```

Deviations from the draft, all intentional at M1b: names follow the code (`run` is the execute port; `reset`/`dispose` take a reason string); the session-level wrapper types (`RuntimeHost.createSession`, `execute(req: ExecutionRequest)`, `cancelActiveExecutions`) are NOT introduced yet — the product injects the instance directly, and M2 wraps it; `prepare` does not wait for in-flight executions (the storage-mutation quiesce gate owns that, per the note below); the status DOM write (`#sb-python`) remains until M2 replaces it with the status event.

Formalizes `preparePythonRuntimeForEnvironment` + `AgentSession.onSessionReset` (store) and the shell's python execution entry into instance-scoped lifecycle. No page-global interpreter remains reachable across the boundary.

```
createRuntime(opts: {
  workerAssets: WorkerAssetBundle        // §3.6 — sources, never DOM ids
  hosting: { relayPath?: string, isHostedPage(): boolean }   // replaces window sniffing
  events: RuntimeEventSink               // §3.8 — status changes, NOT task events
  limits?: Partial<RuntimeLimits>        // overridable for tests only
}) → RuntimeHost

RuntimeHost = {
  contractVersion: 1
  capabilities(): RuntimeCapabilities    // §5 — declared, not version-guessed
  createSession(opts: {
    filesystem: FileSystemContext        // §3.3 — session's base context (durable mounts)
    authorization: ExecutionAuthorization  // §3.5 — Runtime-defined consumer interface,
                                            //   bridged by Product to the Harness approvals
    mutationPolicy?: MutationPolicy      // §3.7 — skill-path rules etc.
  }) → RuntimeSession
}

RuntimeSession = {
  // Between tasks ONLY. Compares desired interpreter payload with the live
  // one (today: PythonRuntime.extensionKey()); rebuilds when different.
  //
  // CURRENT behavior this must preserve (M1a audit): prepare only RESETS and
  // RECONFIGURES when the extension key changed — it does NOT proactively
  // boot the interpreter. Python boots lazily on the first execution, so a
  // text-only task performs zero Python asset acquisition. The "in-flight
  // executions settle first" wording below is the target contract for the
  // instance API; today the equivalent guarantee comes from preparation
  // running between tasks plus the storage-mutation quiesce gate.
  prepare(req: { signal: AbortSignal, python?: PluginPayload | null })
    → Promise<{ rebuiltInterpreter: boolean }>

  execute(req: ExecutionRequest): Promise<ExecutionResult>
  executeSync?: ...                      // not needed in v1; commands are async

  status(): { interpreter: 'cold'|'booting'|'ready'|'failed', busyExecutions: number }

  cancelActiveExecutions(reason: string): void   // invalidates queued work; commits stay
  reset(reason: string): void                     // session boundary: drop interpreter +
                                                  //   drain queue (today: PythonRuntime.reset)
  dispose(reason: string): void                   // terminal: terminate workers/frames;
                                                  //   later events are dropped, not delivered
}

ExecutionRequest = {
  kind: 'shell' | 'python' | 'grep-regex'
  input: string                          // command line / python code / pattern+flags
  context: TaskExecutionContext          // §3.3 — the task-frozen binding
  signal: AbortSignal                    // the task controller's signal (§3.4-Q1)
  stdin?: Uint8Array                     // pipeline data (internal use)
  io: { maxOutputBytes?: number }        // defaults from RuntimeLimits
}
```

`ExecutionResult` (one shape for every kind; keeps today's honest partial-commit reporting, `runShellCommand` + `PythonRuntime._runOnce`):

```
ExecutionResult = {
  ok: boolean                       // compute AND commit success (commitFailed ⇒ false)
  output: string                    // merged presentation text, bounded
  backend?: 'browser' | 'browser-direct' | 'edge-relay'
  operation?: 'filesystem' | 'network' | 'compound'
  io: { in: number, out: number }   // UTF-8 bytes, telemetry-shaped
  // Execution mutation report (present when the command wrote):
  commit?: {
    written: string[]               // ABS paths committed
    deleted: string[]               // files AND directories
    mkdirs: string[]
    conflicts: { path, reason }[]   // refused: read-only mount, external change,
                                    //   unsynced path, type change, policy refusal
    writeFailed: string[]           // attempted, failed
    notPersisted: string[]          // cancelled/incomplete changeset, with reason suffix
    skipped: { path, reason }[]     // never mirrored into the interpreter
    uncollected: string[]           // over output caps ⇒ changeset incomplete
  }
  truncated: { stdout: boolean, stderr: boolean }
  cancelled?: boolean               // cancellation observed; commit.report is still true
}
```

Semantics that must not regress: partial failure is never rewritten as success; `notPersisted`/`uncollected` stay explicit; cancellation reports committed entries and is never a rollback.

### 3.2 Harness tool port (Harness-defined, Product-implemented)

Today: `AgentSession` deps `toolExecutor` + global `AGENT_TOOL_DEFINITIONS` (`src/tools.js`). Contract:

```
ToolPort = {
  definitions(): ToolDefinition[]      // name, description, inputSchema — the ONLY
                                       // model-visible registry; adapters serialize it
  execute(call: {
    name: string
    input: string
    context: HarnessTaskContext        // { filesystem, authorization, signal, events,
                                       //   taskEnvironment }  — bounded, no UI refs
  }) → Promise<{ output, success, backend?, operation? }>
}
```

- The harness never learns how a tool ran (browser? which substrate?) beyond the optional routing metadata it already emits (`backend` is Harness routing state and never provider-visible — `nativeResultContent`, `src/agent.js`).
- Unknown tool or invalid arguments becomes a failed tool result for the model (never an exception, never executed) — today `normalizeNativeCall`.
- The Product adapter implements `execute` by calling `RuntimeSession.execute` with the task's frozen context and maps the result.

### 3.3 Filesystem and execution-context binding

`FileSystemContext` **is** the current `VirtualWorkspace` public surface, made task-immutable:

```
FileSystemContext = {
  list/read/readBytes/write/remove/mkdir/exists/stat(path)
  resolveMount(path): { path, provider, authority, rel } | null
  assertWritable(path): void | throws ReadOnlyError/NotMountedError
  authorityOf(path): 'read-only' | 'read-write' | 'external-read-write'
                   | 'system-read-only' | 'not-mounted' | 'none'
  defaultCwd(): '/mnt/workspace' | '/home/locus'
  dataMounts(): { root, authority }[]     // interpreter mirror set
}

TaskExecutionContext = {
  filesystem: FileSystemContext          // = session base .fork() + task mounts,
                                         //   frozen at task start
  cwdBase: string                        // invocation-local cwd still resets per execute
  policy: MutationPolicy                 // §3.7
  authorization: ExecutionAuthorization  // §3.5 — task-scoped VIEW: a task cannot consume
                                         //   a later task's grants (§3.4-Q4)
}
```

Binding rules (current behavior, restated as contract): providers are captured at fork time; a mid-task workspace remount on the session base never rebinds a live task's routing; skill-instance views and capability introspection mounts are attached to the *fork*, with a generation-pinned signal getter (today: `SkillInstanceWorkspace` wiring in `submit`, `src/ui/store.js`).

### 3.4 Ownership and concurrency — explicit answers

- **Q1 — who creates and owns the AbortController?** The Harness task runner creates exactly ONE task-lifetime controller per task at `submitted` time (before preparation). It is passed, never re-created: to `prepare`, to every `execute`, to the model client (today `AgentSession.run` creates it at run-start; M1a moves creation to submit so the pre-run window is covered — this is the `pendingCancel` pattern generalized). The execution layer MAY keep its own *internal* deadline/cancellation controllers (e.g. the Python worker kill timer and per-run abort wiring in `PythonRuntime._runOnce`) — that is not a second task controller as long as they cascade the task signal and cannot outlive the task's own abort semantics.
- **Q2 — how do you cancel before `AgentSession.run`?** `TaskHandle.cancel()` aborts the same controller; the runner checks `signal.aborted` at each phase boundary (after image build, after provider-session ensure, after first-frame persistence) and records `ended(cancelled)` with zero provider requests (today: `finishPreRunSessionSwitch`).
- **Q3 — who owns the Runtime instance, and how does its lifetime map to tasks/sessions?** Target: Product constructs ONE `RuntimeHost` per page; each agent session gets ONE `RuntimeSession` over the page's durable `FileSystemContext`; tasks own only a frozen `TaskExecutionContext`. Current reality: a single live session and a single lazy interpreter exist per page (`session`, `PythonRuntime` singletons) — the instance API is the extraction goal, not a claim that concurrent sessions or interpreter pools exist today.
- **Q4 — how is a cancelled old task prevented from writing into a new workspace or consuming new-task authority?** Three independent guards, as today: (a) routing isolation — providers captured in the task's fork cannot be replaced by later mounts; (b) liveness — every commit boundary re-checks the task `signal`, and post-cancel `execute` calls reject with `task_expired` before dispatch; (c) authority isolation — the authorization port handed to a task is a task-scoped view whose grant lookups and pending requests are pinned to that task's identity; a session switch cancels pending approvals (`cancelAll('session_boundary')`) and grants survive only at the session level, never borrowed across tasks (generation-pinned `getSignal` today).
- **Q5 — when the plugin set changes, who decides to rebuild the interpreter, and how are old executions handled?** The Harness decides (it owns `TaskEnvironment`): at the next `prepare()` it passes the new `PluginPayload`; the Runtime compares extension keys and resets/reconfigures when they differ. Current behavior: this happens *between* tasks (the previous task has already ended), reconfiguration precedes any boot, and the plugin set installs during the bootstrap window before READY — no lazy install-on-import; the interpreter itself stays lazily booted (first Python execution). Waiting for in-flight executions is, today, the storage-mutation quiesce gate's job (`withStorageMutation`), not `prepare`'s (see §3.1 note).
- **Q6 — which errors are retryable, and which have committed side effects?** See §4. Summary: nothing with a possible side effect is ever automatically re-dispatched by the platform layers.
- **Q7 — who maintains persisted data and provider-native replay?** Replay semantics (raw frames, checkpoints, `validateReplayPrefix`/`validateNormalizedPrefix`, uncheckpointed-suffix rejection) are Harness-owned behind `PersistencePort` (§3.9). Storage mechanics (IDB/OPFS/schema/migrations, conversation records, attachment bytes) are Product-owned. Runtime persists only through providers (OPFS home/plugin dirs). No layer may swallow a required-write failure (§4.4).
- **Q8 — how does the UI get state without reading private fields?** Three channels only: (1) the harness task event stream (`task_start … task_end`, consumed via `LocusProjector`); (2) `RuntimeEventSink` status events (replacing the `sb-python` DOM write and the 1s `PythonRuntime.status` poll); (3) canonical getters on controllers (`ApprovalController.pending`, `TaskHandle.outcome`). The store's `pendingApproval` mirror pattern stays the model: UI state is a projection, never a second owner.

### 3.5 Authorization — two sides, bridged by Product

Direction (corrected in M1a): **each core defines its own side of the authorization boundary.** The Runtime defines the execution-authorization interface *it needs*; the Harness defines the approval controller and approval semantics; a Product adapter connects them. Neither core imports the other's types or implementation.

```
ExecutionAuthorization (Runtime-defined; what Runtime code may call) = {
  request(req: {
    action:   { type, summary, detail? }        // plain text, constructed by the
                                                //   Runtime consumer (e.g. network write)
    resource: { type, key, label? }
    policyKey: string                            // canonical key, e.g. 'network-write:<origin>'
    executionId: string                          // §3.8 correlation; NO chat identities
  }, { signal: AbortSignal })
    → Promise<{ outcome: 'allow'|'deny'|'cancelled', scope: 'once'|'session' }>
}

ApprovalController (Harness-defined; src/approval.js today) = {
  // kinds ('permission'|'capability'|'confirmation'), decision schemas, grants,
  // pending-state ownership, observer containment — semantics owned by Harness.
  // Chat-layer identities (conversationId, taskGeneration) ride on harness-side
  // requests only; they never enter the Runtime interface.
}

ProductAuthorizationAdapter = {
  // Translates ExecutionAuthorization requests into ApprovalController requests
  // (supplying harness-side identity context) and delivers decisions back.
  // Must not widen authority: a granted approval never enables a non-HTTP
  // scheme, method, or mount the Runtime did not already allow.
}
```

Boundary rules (unchanged from docs/APPROVALS.md, restated for the split): approval can reduce autonomy, never manufacture authority; deny ≠ cancel; the consumer re-checks the task signal immediately before the protected side effect with no await in between (network.js `request()` is the reference implementation); at most one pending interactive request; stale ids are no-ops; grants are exact-key, session-scoped, memory-only.

### 3.6 Packaging, workers, CSP (Runtime-owned)

- Worker sources ship inside the Runtime package as string modules (`pyWorkerSource`, `grepWorkerSource`), not as `#py-worker-src`/`#grep-worker-src` DOM elements. `RuntimeHost` receives them via `workerAssets` and exposes the same Blob-URL construction. Host pages must allow `worker-src blob:` (the creator-iframe CSP today already does).
- The Python creator-iframe document, `PY_CREATOR_CSP`, the bootstrap manifest (names/sizes/SHA-256s), budget clocks and the fail-closed acquisition path are Runtime-internal but contract-visible: `capabilities().bootstrap = { assetCount, totalBytes, shaPinned: true }` lets Product/Harness verify integrity posture without importing internals.
- `tests/e2e.html` stops re-extracting sources from `index.html` and imports the same packaged strings (removes a whole class of drift — see INVENTORY §1.3).

### 3.7 Capability descriptions, mutation policy, plugin payload

```
DescriptionPort (Runtime-implemented, Harness-consumed) = {
  describeCommands(): string             // today shellSystemPromptSection() — derived
                                         //   from the command registry, never hand-written
  describeExecution(): string            // static python/curl guidance lines if the
                                         //   harness prompt wants them
}

MutationPolicy (Product-implemented, Runtime-consumed) — **M1b LANDED** as
`src/mutation-policy.js` (`LocusMutationPolicy.create()`), injected by the Product
into EVERY bash execution (`opts.mutationPolicy`); a product missing its policy
implementation REFUSES execution loudly instead of running unprotected, and the
generic runtime with no policy is deliberately neutral:

```
MutationPolicy = {
  // Operation-aware (the ~/.skills knowledge moved OUT of shell.js):
  checkMove(args:   { source: AbsPath, destination: AbsPath,    // destination = the FINAL
                    destinationKind?: 'file'|'directory'|null,  //   target (mv-into-directory
                    recursive: boolean })                       //   appends the basename)
    → { allowed: true } | { allowed: false, reason: string }   // reason is user-facing, WITHOUT
                                                               //   the command prefix — the shell
                                                               //   composes 'mv: <src>: <reason>'
  checkRemove(args: { target: AbsPath, kind: 'file'|'directory', recursive: boolean })
    → { allowed: true } | { allowed: false, reason: string }   // shell composes 'rm: <reason>'
  isPolicyRefusal(error): boolean        // the python commit phase reports these as REFUSED
}                                        //   conflicts (honest changeset accounting), not
                                         //   generic write failures; no policy injected = no
                                         //   refusal class
```

PluginPayload (Harness-prepared, Runtime-validated) = {
  key: string                            // canonical pythonExtensionKeyOf()
  modules: ReadonlyArray<{
    pluginId: string                     // validated against the declared id pattern —
                                         //   the pattern becomes part of THIS contract's
                                         //   documented shape, not a shared source file
    imports: string[]
    files?: { [relPath]: string }        // legacy synthetic path
    wheels?: [WheelArtifact]             // TPR v1A: exactly one verified wheel
  }>
}
```

M1b landed rules: the Locus policy refuses ANY move touching the skills tree (source OR final destination, judged on normalized absolute paths after shell resolution — relative/`..`-spelling cannot bypass) and refuses removal of DIRECTORIES under the root (recursive or not), while single declared skill FILES stay on their per-file approval path. Refusals keep the exact message text the shell used to embed (`SKILL_IDENTITY_BOUNDARY_MSG` etc.) — pinned byte-stable by `tests/mutation-policy.test.cjs`. Check order is preserved (policy refusal before the geometry/stat rules, after protected-root). The policy is NOT a file-access safety boundary: VFS read-only/protected-root/path-safety enforcement and the SkillInstanceWorkspace confirmation/diff/TOCTOU guard stay runtime/provider-level, and the policy can never turn those refusals into allowances. Ownership note for M3: `LocusMutationPolicy` is PRODUCT code — it moves to the Product repository, not Harness.

### 3.8 Events and observability

Two streams, never mixed:

```
RuntimeEventSink = {                         // Runtime → Product/Harness
  onInterpreterStatus(status, detail?)       // replaces #sb-python write + status poll
  onExecutionMeasurement(m)                  // today's Telemetry.record rows:
}                                            //   { executionId, kind, durationMs, ioBytes,
                                             //     ok, backend?, operation? }

Harness task events (unchanged surface):     // Harness → Product
  task_start | reasoning | tool_call | tool_result | assistant_text
  | warning | error | task_end
```

Correlation and ordering: every `execute` gets an `executionId` unique within the session; harness events carry `toolCallId` (native protocol correlation) exactly as today; exactly one terminal `task_end` per task, emitted after the final persistence settle; events arriving after their task ended are dropped by the emitter, never re-attached; a `session_changed` terminal is distinct from `cancelled` (discarding semantics differ — `src/agent.js` staleness rules). The Product projector remains the only thing rendering events; no consumer reads `AgentSession.history`, `PythonRuntime._pending`, or controller internals.

### 3.9 Persistence port and the Product adapter

```
PersistencePort (Harness-defined semantics; formalizes AgentSession.persistence) = {
  onUserMessage(text, contentParts?)            // required: durable ordering before first
                                                //   provider request; failure ⇒ task
                                                //   persistence_error, no request sent
  onProviderFrame(frame) → frame                // required for replay integrity
  onNormalizedMessage(msg)                      // required
  onCheckpoint({ frame, reason })               // required; replay boundary advances only here
  onPersistenceError(error)                     // degrades session; surfaces honestly
  onPersistenceWarning(error)                   // optional-write failures
}
// StoragePort (Product-implemented, consumed via PersistencePort adapter):
//   appendProviderFrame / saveNormalizedMessage / saveProviderSession /
//   loadProviderFrames / loadProviderSession / loadNormalizedMessages / …
//   plus validateReplayPrefix / validateNormalizedPrefix (Harness-owned logic)
```

Failure semantics (current, kept): a failed *required* write ends the task with `persistence_error`, marks the conversation `degraded`, and never silently converts into success; an uncheckpointed durable suffix is rejected on restore (never replayed — a side-effecting tool could run twice); replay-incompatible provider identity falls back to the normalized projection or blocks replay outright; `StorageClearError` classification is part of the port contract.

**Product adapter map** (M1 landing surface; every row is a thin function, no reimplementation):

| Adapter function | Replaces today |
|---|---|
| `productModelClient(body, opts)` | `wiredModelClient` (hooks + `Model` config + image-rejection recording) |
| `productToolPort.execute` | `executeTool` + `wiredToolExecutor` (injects authz context) |
| `productAuthorization` | `approvals` controller wiring (`ApprovalController` + UI projection) |
| `productDescriptions(env)` | `shellSystemPromptSection` global read in `buildSystemPrompt` |
| `productMutationPolicy` — **M1b LANDED** | `LocusMutationPolicy` (`src/mutation-policy.js`) injected into every bash execution; missing implementation fails loudly |
| `productPersistence` | `makePersistenceContext` + `PersistenceServiceInstance` glue |
| `productFilesystem` | VFS construction/mount lifecycle (`mountDurableStorage`, `mountExternalHandle`, task fork + skill/introspection mounts) |
| `productRuntimeLifecycle` — **M1b LANDED** | the store's canonical `createPythonRuntime()` instance + `preparePythonRuntimeForEnvironment` (→ instance.prepare) + `onSessionReset` (→ instance.reset) + `opts.pythonRuntime` injection |

## 4. Error and retry taxonomy (normative)

| Class | Example | Auto-retry? | Rationale |
|---|---|---|---|
| Model transport TypeError (network/CORS) | `model.js` | **Current code:** once, to `/proxy` relay, same body. A fetch TypeError does **not** prove the request was never delivered — the request may have reached the provider, so this fallback carries a duplicate-inference risk (see note below) | row describes what the code does today, not a delivery guarantee |
| Model HTTP authoritative (401/402/403/429) | `AUTHORITATIVE_STATUS` | No | provider answer |
| Model parse/body-read/timeout/cancel | `ParseError` etc. | No | inference may be billed |
| Network read-like transport failure | GET/HEAD direct `DirectTransportFailure` | Once to relay | reads duplicate harmlessly |
| Network side-effecting dispatch failure | `mapWriteDispatchError` | **Never across backends** | server may have processed it |
| Network denial vs cancellation | `network_denied` vs cancelled | No / no | deny is a decision; cancel is liveness |
| Tool execution failure | any `ExecutionResult.ok=false` | Platform: never. Model may re-request deliberately | model-visible failed result |
| Partial commit (conflicts/writeFailed/notPersisted) | python commit phases | Never silently | partial state is real; report it |
| Required persistence write failure | `persistence_write_failed` | No; task ends `persistence_error` | replay integrity beats progress |
| Interpreter bootstrap integrity failure | `python_bootstrap_unavailable` / sha mismatch | Fresh worker rebuild only; never unverified bytes | fail-closed acquisition |
| `task_expired` / stale execution | post-cancel dispatch | No | old task must not act |

Note on model-transport fallback: the first row records current behavior, not an endorsed guarantee. A model POST re-sent to `/proxy` after a TypeError can repeat an inference the provider already executed (double billing); unlike the network GET/HEAD fallback, model requests are not idempotent by construction. The split does not change this implementation in M1a; whether to keep, gate, or drop the model-call relay fallback is recorded as follow-up work owned by the Harness repository (M1a verification record, "deferred").

## 5. Contract version and capability negotiation

- Every port above carries a `contractVersion` integer owned by its defining repo. Breaking semantic changes bump it and are documented in that repo.
- Before a task starts, the Product adapter runs `runtime.capabilities()` and the Harness's own declaration check: supported `commands`, `executionKinds`, `limits`, `policyMechanisms` (`mutationPolicy`, `authorization`), `bootstrap.shaPinned`. A missing mandatory capability or an unsupported mandatory version **fails the task before any side effect** with an actionable compatibility error naming the port, the required and provided versions, and the offending capability.
- No silent downgrades: if authority/cancellation/persistence guarantees cannot be met, the task does not start (REPOSITORY-SPLIT §4). Version strings are identifiers, never a substitute for the declared-capability check.
- The Product dependency lock (REPOSITORY-SPLIT §6) records both core SHAs *and* their `contractVersion`s; a version bump on either side is integration work, not a runtime event.
