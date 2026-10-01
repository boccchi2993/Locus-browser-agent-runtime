# Repository split M0 — interface contracts (drafts)

Status: M0 deliverable, **revised in M1a** (corrections: §3.5 authorization direction — each core defines its own side, Product bridges; §4 model-retry row — current behavior, not a non-delivery guarantee; §3.1/§3.4 current-vs-target lifecycle distinction — single live session + lazy interpreter today; §3.4-Q1 — internal execution-layer cancellation controllers are legitimate when cascading the task signal). **M1a landed** the §2 task lifecycle and the §3.9 persistence-context port as real modules (`src/harness/task-runner.js`, `src/harness/provider-session.js`, product wiring in `src/ui/store.js`; verification in [REPOSITORY-SPLIT-M1A-VERIFICATION.md](REPOSITORY-SPLIT-M1A-VERIFICATION.md)). **M1b landed** the §3.1 interpreter lifecycle (as `createPythonRuntime()` instances with prepare/run/reset/dispose/snapshot — no page-global `PythonRuntime` remains) and the §3.7 `MutationPolicy` port (as `src/mutation-policy.js` product policy consumed via `opts.mutationPolicy`; verification in [REPOSITORY-SPLIT-M1B-VERIFICATION.md](REPOSITORY-SPLIT-M1B-VERIFICATION.md)). **M2a landed** the Runtime public entry and packaging: `createRuntime → RuntimeHost → RuntimeSession` (`src/runtime/index.js`), worker assets as Runtime modules (`src/runtime/worker-assets.js`, no `#py-worker-src`/`#grep-worker-src` DOM), status events (no `#sb-python` write, no 1s poll), `LOCUS_HOME_SKELETON` as a constructor argument, the payload-identity patterns as Runtime contract data, `ConversationHistoryWorkspace` moved to Product, and the §3.5 execution-authorization port replacing `policyContext`/chat identities in network.js — deviations and the landed shapes are recorded per section below and in [REPOSITORY-SPLIT-M2A-DESIGN.md](REPOSITORY-SPLIT-M2A-DESIGN.md) + [REPOSITORY-SPLIT-M2A-VERIFICATION.md](REPOSITORY-SPLIT-M2A-VERIFICATION.md). **M2b landed** the §3.2 ToolPort with per-task definition snapshots, the §3.7 description port, the §3.8 harness-side notes and the §3.9 audit: the public entry (`src/harness/index.js` + self-assembly `core.js`) over the declared `__LOCUS_HARNESS_CORE__` table, `createModelClient` with captured configuration, explicit `capabilities.js` dependencies, the extensions.js ownership split, the contained telemetry sink, and the Product rewired through the entry — deviations and landed shapes recorded per section below and in [REPOSITORY-SPLIT-M2B-DESIGN.md](REPOSITORY-SPLIT-M2B-DESIGN.md) + [REPOSITORY-SPLIT-M2B-VERIFICATION.md](REPOSITORY-SPLIT-M2B-VERIFICATION.md). TypeScript-like notation describes shapes for the JavaScript implementations; no migration to TypeScript is implied. In-process module calls are sufficient — no RPC, service, or message bus is introduced.

Design rule (from the task and REPOSITORY-SPLIT §4): no single boundless `RuntimeContext`/`AppContext`. Each concern below is its own small port with its own owner. Ports are plain parameters, exactly like the existing seams they formalize (`AgentSession` deps, `policyContext.approvals` (now the §3.5 `authorization` port), `imageInput`).

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

### 3.1 Runtime lifecycle and execution (Runtime-owned) — **M2a: RuntimeHost/RuntimeSession LANDED over the M1b instance**

Current reality (must not be blurred): today there is **one** live agent session and **one** runtime session per page (`session` and the store-resolved `RuntimeSession` are singletons; `src/ui/store.js`). The wrapper is real code now (`src/runtime/index.js`), not a draft, but it is not an invitation to run many concurrent sessions. The interpreter still boots **lazily** — the first Python execution fetches/boots it; preparation only *configures* the payload for a future boot, so a text-only task downloads and starts nothing.

M2a status: **LANDED**. `createRuntime(opts: { workerAssets: { pyWorkerSource, grepWorkerSource } }) → RuntimeHost` (`contractVersion: 1`, `capabilities()`, `createSession()`, `dispose()`); `host.createSession() → RuntimeSession` owning ONE `createPythonRuntime()` instance plus the status fan-out and the prepare serialization tail; `session.execute({ kind: 'shell'|'python', input, context: { filesystem, signal, mutationPolicy, authorization, cwd } })` returns the honest tool-shaped result with a normalized `ok`. **`prepare(req)` now WAITS at the session layer**: it barriers on every execution in flight at call time (settlement promises — no timers, no busy polling), then re-validates disposed / boundary-generation / signal before the instance's synchronous validate-then-swap; a cancel, reset or dispose landing during the wait refuses the configuration (cancellation-shaped for the signal case), and the superseded run settles honestly. Deviations from the draft below, all intentional and recorded in the M2a design doc: no `cancelActiveExecutions` (no caller; at the instance level it would BE `reset()`), no `grep-regex` execution kind (grep is a shell command), no session-pinned `filesystem` (fork-per-task stays the model; `context.filesystem` is per-request and optional — absent means the shell's accepted fresh-machine fallback), `authorization` travels per request, `status()`/`onStatus()` replace the draft's `status` field shape (snapshot objects, immediate snapshot on subscribe). The worker sources are the `workerAssets` bundle (`src/runtime/worker-assets.js`) — the DOM elements are gone. The draft's `createRuntime` options shrink accordingly (`hosting` stays where window-sniffing lives today inside network.js; `events` became per-session `onStatus`; `limits` stays a per-instance test seam).

M2a review round (binding additions to the landed session contract; design §12, verification §7):

- **Full execution lifecycle**: the session tracks EVERY accepted public `execute` from admission to complete settlement — composite shell work (VFS writes, grep, curl, python-inside-shell) included, counted exactly once. `status().busyExecutions` is the SESSION's count (admission → settlement).
- **Session-owned invalidation plane**: each execute carries an internal `AbortController` MERGED with the caller's signal. A session `reset`/`dispose` (and `host.dispose`) invalidates in-flight executes at the run's next cancellation checkpoint WITHOUT the caller ever aborting; already-dispatched provider operations settle and are reported honestly (`ok: false`, committed effects listed, an ADDITIVE `boundary` field naming the boundary). Queued-not-started side effects never dispatch. A reset session stays usable; dispose is terminal and idempotent.
- **Two invalidation algebras**: the SESSION boundary generation (reset/dispose only) is separate from the INTERPRETER generation (also moved by legitimate prepare rebuilds). A waiting prepare judges only the session algebra for boundaries and refuses only an instance-generation move OUTSIDE the preparation chain (out-of-band instance resets); concurrent prepares apply in call order; a cancelled queued prepare returns promptly WITHOUT releasing its chain segment; a failing prepare never wedges the chain; a real boundary refuses every prepare it crossed while the session stays usable afterwards.
- **Execute admission**: a new execute admitted while a prepare is in flight QUEUES behind that prepare barrier (admission-time capture) — it can never penetrate an in-flight prepare; a prepare's own barrier waits for the executions in flight AT ITS CALL TIME, so later admissions cannot deadlock it.

M2a review round 2 (design §13, verification §8) — the two gaps against the bullets above, closed:

- **Three distinct time points, never conflated**: (1) the CALLER's cancellation answer, (2) the internal queue/barrier positions, (3) the provider operation's true settlement. No one implies another: a caller may be told "cancelled" while its queue position is still held; a queue position may outlive its caller's answer; a dispatched provider operation settles on its own and its settlement is not validation.
- **Result classification (F1)**: a run whose boundary struck — or whose caller aborted — while its LAST provider operation was dispatched-but-unsettled has no later cancellation checkpoint inside the command: the operation settles, the command reports a clean success, and only the SESSION can see the supersession. Every resolved result therefore passes ONE classification inside the execute closure before it leaves the session (shell and direct python alike): a boundary-struck run is `ok:false` (+`isError:true` / `success:false`) and the boundary ALWAYS names itself — the ADDITIVE `boundary` field carries the run's OWN first invalidation reason, captured in the execute's closure at strike time, never re-read from the session global that a later reset may have rewritten; a caller abort downgrades a report that never observed it (no cancellation checkpoint ran after the last dispatched operation) and is explained as `execution cancelled` (no `boundary` field — a caller cancel is not a session boundary); an ALREADY-FAILED report ('bash: cancelled' / 'python: execution cancelled') IS the cancellation report and stays untouched; real worker/provider errors keep precedence — the note is additive, the original output/stderr and every existing field (`io`/`backend`/`operation`…) are kept and `io.out` accounts for the note. An underlying throw keeps the existing propagation (never rewritten as a cancellation). Re-specified deliberately: grep-worker R1 (abort requested after the worker reply had been delivered) now settles as the honest failure with the delivered result text kept — not a clean success.
- **Prepare queue segment vs caller cancellation (F2)**: `prepareTail` represents "the internal queue segment completed", NEVER "the caller received its answer". Each prepare enqueues an internal SEGMENT that settles only after the previous segment TRULY settled and its own turn completed (applied, or a refused/skipped exit) — deliberately no race against the abort; the CALLER receives a cancellable observation of the segment instead (abort answers it promptly, cancellation-shaped, while the segment keeps its queue position). `prepareTail` is the segment's failure-proofed settlement barrier, so a rejected segment never poisons the queue behind it. A cancelled waiting prepare therefore can never let a later prepare or execute overtake an unfinished earlier segment.

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
  // already aborted is refused and applies nothing; the refusal is
  // CANCELLATION-SHAPED (AbortError), so the caller's existing
  // cancellation classification reads it as a cancellation, never as an
  // independent prepare error. prepare is
  // SYNCHRONOUS by construction (no awaits between compare and commit),
  // so no stale/cancelled caller can interleave; callers cannot assume
  // async completion because there is none. The Product additionally
  // self-checks task liveness after every async preparation step
  // (refreshSkillPresence, prepare) and never hands a cancelled or
  // boundary-struck task's configuration to the runtime at all.
  prepare(req: { signal?: AbortSignal, python?: PluginPayload | null })
    → { rebuiltInterpreter: boolean }

  // The execution port (shell python lands here via opts.pythonRuntime;
  // serialized queue, mirror/commit phases unchanged). Missing injection
  // fails the tool call loudly — there is no global fallback. A run is
  // VALID for its whole lifetime — queued, seat acquisition, boot, file
  // collection, worker execution AND the complete write-back (commit)
  // phase: a reset()/dispose() that lands at ANY await boundary
  // invalidates the run, which then starts NO further VFS side effect
  // (mkdir, write, file removal, directory removal). Operations ALREADY
  // dispatched to the provider (a worker run in flight, a commit call in
  // flight) cannot be rolled back; the run waits out their settlement,
  // commits nothing further, and reports honestly (boundary reason in
  // `error`, stopped operations in `notPersisted`) — never an empty
  // success masking the invalidation, never a partial result presented
  // as complete. Validity is re-checked ONE LAST TIME when the report
  // is formed: a boundary that lands while the FINAL dispatched effect
  // is still unsettled still lands in that report's `error` (settlement
  // of a provider call is not validation), what the effect really
  // committed stays in `written`/`mkdirs`/`deleted`, and a real worker
  // error keeps precedence over the boundary reason.
  run(code, vfs, opts) → Promise<ExecutionReport>

  // Session/rebuild boundary. SYNCHRONOUS effect: aborts the in-flight
  // boot, fails every pending request, drains queued-but-unstarted runs,
  // tears the worker stack down to cold. Three DISTINCT moments must not
  // be conflated:
  //   (1) SYNCHRONOUS INVALIDATION — what reset() itself does, before it
  //       returns: kill the worker stack, mark queued runs killed, bump
  //       the generation every run re-checks;
  //   (2) RUN SETTLEMENT — when each affected run's promise actually
  //       settles, at that run's next await boundary (with the boundary
  //       reason as its error, or as a cancellation if the task signal
  //       aborted). Synchronous invalidation is NOT settlement: the
  //       killed/committing runs stay counted in busyExecutions until
  //       they truly settle, so admission/quiesce gates never reopen
  //       early on a lie;
  //   (3) ALREADY-DISPATCHED PROVIDER EFFECTS — operations already handed
  //       to the provider (posted worker execution, in-flight commit).
  //       These CANNOT be rolled back; after their settlement nothing
  //       further runs and the report says exactly what committed and
  //       what never ran — including the boundary itself in `error`,
  //       re-validated at report formation so the LAST settling effect
  //       can never yield an error:null success.
  // The instance stays REUSABLE afterwards. A boundary landing while a
  // run is suspended between seat acquisition and the worker post is
  // caught by the reset generation: the run rejects with the boundary
  // reason and never reaches the next generation's interpreter.
  reset(reason?: string): void

  // Terminal. Everything reset does, plus permanent refusal of
  // prepare/run/configureExtensions (throws with the disposal reason).
  // IDEMPOTENT — a second dispose keeps the first reason. Late worker
  // messages cannot revive the instance (creator destroyed; the disposed
  // flag blocks new work). Returns nothing; disposal is synchronous
  // (invalidation sense — affected runs still settle at their own next
  // await boundary, exactly like reset).
  dispose(reason?: string): void

  // Canonical state read: { interpreter: 'cold'|'loading'|'ready',
  // busyExecutions, extensionKey, disposed }. busyExecutions counts
  // QUEUED (not yet started) + ACTIVE runs, where ACTIVE spans the whole
  // post-seat lifetime — boot, file collection, worker execution and the
  // commit/write-back phase — released exactly once at each run's own
  // settlement (never by reset/dispose). Queued and active runs are
  // counted once each; a boundary never falsifies the count.
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

**M2b LANDED** (`src/agent.js`, product adapter in `src/ui/store.js`): `AgentSession` REQUIRES `toolPort` — the old `toolExecutor` dep and the `AGENT_TOOL_DEFINITIONS` global read are gone (no compat adapter file ships: after the Product grew its native port no production consumer remained; the six-line conversion is inlined by each legacy-shape consumer). The session snapshots `definitions()` EXACTLY ONCE per task — validated (array, object shape, non-empty string name, string description, object inputSchema, unique names; violations fail the task as `tool_registry_invalid` BEFORE any model request), frozen-copied (caller objects never frozen), and that one snapshot feeds the prompt tool list (rendered by traversal — no `defs[0]`/`defs[1]`), every `request.tools`, `normalizeNativeCall` (explicit names parameter), the text-fallback name check (unknown names fail with zero execution inside the Harness) and the unknown-tool error's available list. `context` is the narrow pair `{ filesystem, signal }` (deviation from the draft: the Product adapter closes over its own authorization/mutation-policy/runtime session; events flow through the session's emit). A missing result `backend` defaults to `'harness'` (the `cloud_bash → 'cloud'` name inference left the Harness; the Product adapter supplies the real values). H5 pinned: mid-task `definitions()` mutation cannot rebind a running task. **M2b review round (F1)**: the snapshot is a DEEP copy — a tool definition is transportable JSON data by contract (plain objects, arrays, finite numbers, strings, booleans, null, recursively copied and frozen); non-transportable content (functions, symbols, undefined fields, non-finite numbers, non-plain objects, circular references) would be silently dropped or corrupted by a JSON round-trip, so it fails LOUDLY as `tool_registry_invalid` before any model request (pinned by the harness-standalone F1 block: nested mutation cannot reach a running task or the tool-result round trip, the caller keeps ownership, the next task reads fresh definitions, two sessions never share a snapshot). **M2b review round 2 (snapshot fidelity)**: the deep copy is DESCRIPTOR-driven — plain-object keys are enumerated via `getOwnPropertyNames` + `getOwnPropertyDescriptor` and recreated with `Object.defineProperty`, so EVERY legal JSON string key survives as an own data property (`"__proto__"`, `"constructor"`, `"prototype"` are ordinary keys, never a forbidden list — assignment `out[k] = v` would reinterpret an own `"__proto__"` key as a prototype setter and silently lose or rewrite it); accessor properties, non-enumerable own properties and Symbol keys (as keys AND as values) are rejected as `tool_registry_invalid` WITHOUT ever invoking a getter (definition validation reads descriptors too, and the duplicate-name check reads the snapshot copy's name); arrays are copied strictly through audited index descriptors — the source's own `map()` is never called, only the standard `length` is allowed, and holes / extra non-index properties / accessor elements fail loudly (a JSON round-trip would serialize holes as `null`); repeated references to a shared acyclic sub-object stay legal — only true cycles are rejected. Still no JSON-Schema validation engine.

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

### 3.5 Authorization — two sides, bridged by Product — **M2a: the Runtime side is LANDED (`authorization` port)**

Direction (corrected in M1a): **each core defines its own side of the authorization boundary.** The Runtime defines the execution-authorization interface *it needs*; the Harness defines the approval controller and approval semantics; a Product adapter connects them. Neither core imports the other's types or implementation.

**M2a landed the Runtime side**: `NetworkRuntime.request(spec)` consumes `spec.authorization = { request(req, opts) → Promise<{ outcome, scope }> }` with `req = { kind:'permission', action, resource, policyKey }` — the `policyContext { approvals, conversationId, taskGeneration }` shape and the chat-identity field names are GONE from the Runtime (structurally enforced by `tests/runtime-boundary.test.cjs` G3). The Product adapter (`productNetworkAuthorization` in the store) adds `conversationId`/`taskGeneration` on ITS side when forwarding to the ApprovalController — downstream approval payloads are unchanged. Deny ≠ cancel and dispatch-once semantics unchanged.

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

### 3.6 Packaging, workers, CSP (Runtime-owned) — **M2a LANDED; review round: the entry assembles itself**

**Landed in M2a**: the worker sources ship inside the Runtime package as string modules (`src/runtime/worker-assets.js`: `PY_WORKER_SOURCE`, `GREP_WORKER_SOURCE` — migrated verbatim from `index.html`, CRLF normalized); `createPythonRuntime` takes `{ pyWorkerSource }` and `createGrepRegexSession` takes the source — there is NO `#py-worker-src`/`#grep-worker-src` DOM element anywhere anymore, no fallback, and the `tests/e2e.html` harness imports the same modules instead of re-extracting `index.html`. `dist/tests/runtime-host.html` (a real vite build input) is the packaged standalone host the gate B e2e drives. The Python creator-iframe document, `PY_CREATOR_CSP`, the bootstrap manifest (names/sizes/SHA-256s), budget clocks and the fail-closed acquisition path are UNCHANGED Runtime-internal behavior; `capabilities().bootstrap = { shaPinned: true }` is exposed on the host for integrity-posture checks. No CDN fallback and no cross-backend retry were added.

**Review round — assembly modes (A1c correction)**: `createRuntime` is async and assembles its own dependencies over ONE implementation set. Registry mode: a page that loaded the core as classic scripts gets DELEGATION to the declared `__LOCUS_RUNTIME_CORE__` table (one copy per page — the product page). Self-assembly mode: with no registry, the entry dynamically imports the SAME five sources through `src/runtime/core.js` (one memoized import; telemetry/workspace/vfs/network publish their cross-file names explicitly so the identical sources work as ES modules). Merely lacking classic scripts is NOT an error; a broken or partial registry, or missing worker assets, still is. The self-assembly chunk is code-split and never fetched on a registry page (verified in the built product bundle). Host-facing VFS exports (`createWorkspace` with the runtime's own command surface as default, `createMemoryWorkspace`, `shellCommandNames`) make a host self-sufficient — the standalone host page carries ZERO classic scripts. Boundary gate G7 walks the entry's transitive ESM import closure (Runtime-owned files only, closure covers the core).

### 3.7 Capability descriptions, mutation policy, plugin payload

```
DescriptionPort (Runtime-implemented, Harness-consumed) = {
  describeCommands(): string             // **M2b LANDED** as RuntimeSession.describeCommands()
                                         //   (src/runtime/index.js) — delegates to the resolved
                                         //   core's shellSystemPromptSection (registry-derived,
                                         //   never hand-written); null when absent, never fabricated
  describeExecution(): string            // not landed — no consumer; the shell description
                                         //   already carries the python/curl guidance
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
                                         //   **M2a LANDED**: the Runtime validates against
                                         //   its OWN copy (RUNTIME_PLUGIN_ID_PATTERN /
                                         //   RUNTIME_PY_MODULE_PATTERN in src/shell.js,
                                         //   exported via the declared core registry as
                                         //   `contract`); extensions.js keeps the Harness
                                         //   copy and a boundary test pins the two regex
                                         //   sources EQUAL (the declared synchronization
                                         //   mechanism — never a shared source file)
    imports: string[]
    files?: { [relPath]: string }        // legacy synthetic path
    wheels?: [WheelArtifact]             // TPR v1A: exactly one verified wheel
  }>
}
```

M1b landed rules: the Locus policy refuses ANY move touching the skills tree (source OR final destination, judged on normalized absolute paths after shell resolution — relative/`..`-spelling cannot bypass) and refuses removal of DIRECTORIES under the root (recursive or not), while single declared skill FILES stay on their per-file approval path. Refusals keep the exact message text the shell used to embed (`SKILL_IDENTITY_BOUNDARY_MSG` etc.) — pinned byte-stable by `tests/mutation-policy.test.cjs`. Check order is preserved (policy refusal before the geometry/stat rules, after protected-root). The policy is NOT a file-access safety boundary: VFS read-only/protected-root/path-safety enforcement and the SkillInstanceWorkspace confirmation/diff/TOCTOU guard stay runtime/provider-level, and the policy can never turn those refusals into allowances. Ownership note for M3: `LocusMutationPolicy` is PRODUCT code — it moves to the Product repository, not Harness.

### 3.8 Events and observability — **M2a: the Runtime status stream is LANDED (`onStatus`); the harness task-event stream and Telemetry sink stay M2b**

**Landed in M2a** (Runtime half): the interpreter status is a per-instance/per-session subscription — `session.onStatus(fn)` delivers `fn(snapshot())` synchronously at subscribe (initial read, no missed-edge window, no polling), then on every `cold|loading|ready` transition; unsubscribe stops delivery; observer exceptions are contained per listener; events are instance-scoped so a stale instance cannot pollute another consumer. The `#sb-python` DOM write and the 1-second `setInterval` poll are REMOVED; the store projects `snapshot.interpreter` into `store.pythonStatus` at boot. **M2b**: the execution measurement stays at its OWNING layer — the Product tool adapter (`src/tools.js`) delivers one record per execution through an explicit optional `opts.telemetry` sink (existing record fields unchanged), delivery is CONTAINED (a throwing sink or a rejected returned promise never breaks the tool result and never surfaces as an unhandled rejection — H8 pinned); the `renderDebugPanel` reverse dependency on the Product UI is deleted from `telemetry.js`; NEITHER core reads the Telemetry global (structurally enforced by `tests/harness-boundary.test.cjs` B2 on the harness side and the runtime gate G on the runtime side). No `onExecutionMeasurement` runtime sink was added — the runtime records nothing today, and an unused sink would violate the nothing-without-a-consumer rule. The harness task-event stream notes below are unchanged (landed M1a).

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
//   (validateReplayPrefix / validateNormalizedPrefix are HARNESS-owned
//   algorithms — src/harness/replay-validation.js, re-exported by the
//   entry; the Product provides only storage/config/projection adapters)
```

Failure semantics (current, kept): a failed *required* write ends the task with `persistence_error`, marks the conversation `degraded`, and never silently converts into success; an uncheckpointed durable suffix is rejected on restore (never replayed — a side-effecting tool could run twice); replay-incompatible provider identity falls back to the normalized projection or blocks replay outright; `StorageClearError` classification is part of the port contract. **M2b audit**: the harness entry's transitive import closure contains NO persistence module (`tests/harness-boundary.test.cjs` B1) — provider-sessions consumes everything injected (verified again), and `capabilities.js` persistence became a REQUIRED constructor dependency. **M2b review round (F3)**: the replay validators (`validateReplayPrefix`/`validateNormalizedPrefix`) moved VERBATIM into the Harness as `src/harness/replay-validation.js` (one implementation; error codes, check order, checkpoint/sequence/identity/pairing semantics unchanged) — `createProviderSessions` defaults its validator ports to it (an explicit injection stays as a test seam), the entry re-exports them, and the Product persistence module keeps ONE-WAY compatibility delegates resolving the single implementation through the published `__LOCUS_HARNESS_REPLAY_VALIDATION__` table (loud failure when unevaluated — never a second copy). A standalone host can now restore provider sessions with the REAL validators from the entry alone (proven by `tests/harness-replay.test.mjs` and the packaged-artifact `tests/e2e-harness-host.cjs` browser gate).

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

## 5. Contract version and capability negotiation — **M2c: the declarations and the Product check are LANDED**

- Every port above carries a `contractVersion` integer owned by its defining repo. Breaking semantic changes bump it and are documented in that repo.
- **M2c landed shape** (design: [REPOSITORY-SPLIT-M2C-DESIGN.md](REPOSITORY-SPLIT-M2C-DESIGN.md); evidence: [REPOSITORY-SPLIT-M2C-VERIFICATION.md](REPOSITORY-SPLIT-M2C-VERIFICATION.md)):
  - **Runtime — `RuntimeHost.capabilities()`** (public entry, frozen): `contractVersion: 1`, `executionKinds`, `bootstrap.shaPinned`, `policyMechanisms` (M2a), plus `commands` — the RESOLVED core's actual `SHELL_COMMANDS` registry keys — and `limits` — the core's OWN frozen constants (`shellPipeMaxBytes`/`headTailMaxOutputBytes`/`pythonTimeoutMs`, published on the declared core table). A core that does not provide a section makes it OMITTED, never fabricated.
  - **Harness — `harnessCapabilities()`** (public entry export, frozen read-only): the public `contractVersion: 1` and SIX port declarations (`taskLifecycle` with the REAL outcome enum `TASK_OUTCOME_REASONS` + real `MAX_TOOL_ITERATIONS`/`HISTORY_BUDGET_BYTES`; `toolPort` per-task frozen transportable-JSON snapshots; `descriptionPort` optional; `modelClient` captured-config; `approval` kinds from the table, shape-checked; `persistencePort` harness-owned validators + `persistence_error` required-write outcome) plus semantic capabilities (`nativeToolCalls`, `textFallbackStrict`, `taskEventIdentity`, `providerReplay`, and table-presence-derived `imageInputGate`/`capabilityComposition`). Table-derived fields are declared from the resolved table's actual content — hostile/malformed content is OMITTED, never reported as supported.
  - **TWO VERSION CONCEPTS, never merged**: the public `contractVersion` (protocol semantics) and the declared `__LOCUS_*_CORE__` registry's internal `contractVersion` (assembly generation). They may share the initial number 1; the harness declaration surfaces the internal one ONLY as `registryVersion`, and the Product keeps separate supported sets for each.
- Before a task starts, the Product runs the check: **`src/product/core-compatibility.js`** (Product-owned, pure module — no Vue/DOM/storage/worker, no core imports; the cores cannot depend back). `checkCoreCompatibility({ runtime, harness, requirements })` validates the two PUBLIC declarations against the frozen `PRODUCT_CORE_REQUIREMENTS` (supported protocol + registry versions; required runtime capabilities `executionKinds ⊇ [shell]`, `policyMechanisms ⊇ [mutationPolicy, authorization]`, `bootstrap.shaPinned`, non-empty `commands`; required harness ports `taskLifecycle/toolPort/modelClient/approval/persistencePort` v1 and capabilities `taskEventIdentity`/`providerReplay`). A missing mandatory capability or an unsupported mandatory version **fails the task before any side effect** — wired at the head of the store's `prepareTask`, before required persistence, image ingest, capability refresh/environment build, Runtime prepare, tool dispatch and any model request — with a structured `CompatibilityError` (`code/core/port/capability/required/provided`, frozen) surfaced through the runner's EXISTING `blocked` mechanism (`error {code: 'core_incompatible'}` + one `task_end`; no second task_end or release path). An absent declaration (`declaration_missing`) is a rejection, never a default-pass: undefined is not compatible.
- No silent downgrades: the runner's `blocked` terminal is the only rejection path; missing OPTIONAL capabilities (`executionKinds.python`, `nativeToolCalls`, `imageInputGate`, `capabilityComposition`) are reported in the frozen result's `optional.*.missing` and handled ONLY through the documented product rules (e.g. missing `imageInputGate` → text-only attachment degrade with the explicit warning) — never a reduction of approval/cancellation/persistence/execution guarantees. Unknown EXTRA capabilities never reject.
- The Product dependency lock (REPOSITORY-SPLIT §6) will record both core SHAs *and* their `contractVersion`s/`registryVersion`s; a version bump on either side is integration work, not a runtime event. No lock tuple exists yet (M3/M4).
