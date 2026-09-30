# Repository split M2a — Runtime independence: symbol-level design

Status: M2a design record (written before implementation). Base: `refactor/repository-split-m1b` @ `83fdfbb` (PR #4 head, verified unchanged; PRs #2/#3/#4 all OPEN at branch creation, none merged). Contract basis: [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) §3.1/§3.5/§3.6/§3.7/§3.8, inventory [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) §2/§3/§4 step 3.

M2a scope (per INVENTORY §4 step 3 + the phase brief): Runtime packaging and the public entry — worker sources as Runtime-owned modules, `#sb-python` write → status events, `LOCUS_HOME_SKELETON` as an argument, `EXTENSION_*` patterns as Runtime contract data, `ConversationHistoryWorkspace` moved to Product files, `createRuntime → RuntimeHost → RuntimeSession` landed, `prepare` waits for in-flight executions at the session layer, Product rewired through the public entry, independence gates A–G. M2b (Harness port injection: `describeCommands`, ToolPort split, Telemetry sink) and M3 (repository extraction) are explicitly OUT of scope.

## 1. Public entry and minimal configuration

New module `src/runtime/index.js` (ESM — the only new always-bundled surface):

```
createRuntime(opts: {
  workerAssets: { pyWorkerSource: string, grepWorkerSource: string }   // required, non-empty strings
}) → RuntimeHost

RuntimeHost = {
  contractVersion: 1
  capabilities(): { executionKinds: ['shell','python'],
                    bootstrap: { shaPinned: true, assetCount, totalBytes },
                    policyMechanisms: ['mutationPolicy', 'authorization'] }
  createSession(opts = {}) → RuntimeSession     // each session owns ONE interpreter instance
  dispose(reason?)                              // terminal: disposes every session (idempotent)
}

RuntimeSession = {
  prepare(req: { signal?: AbortSignal, python?: PluginPayload | null })
    → Promise<{ rebuiltInterpreter: boolean }>   // §4 below: waits for in-flight executions
  execute(req: { kind: 'shell' | 'python', input: string,
                 context: { filesystem, signal?, mutationPolicy?, authorization?, cwd? } })
    → Promise<result>                            // tool-shaped result + normalized `ok`
  status() → { interpreter, busyExecutions, extensionKey, disposed }
  onStatus(fn) → unsubscribe()                   // immediate snapshot on subscribe, then edges
  reset(reason?)                                 // session boundary (M1b instance semantics)
  dispose(reason?)                               // terminal, idempotent (M1b instance semantics)
}
```

Deviations from the CONTRACTS §3.1 draft, all intentional:

1. **No `cancelActiveExecutions`.** No current caller needs it: the harness cancels through the task signal (which the instance already honors) and session boundaries use `reset()`. At the instance level a cancel-all would BE `reset()` (reset invalidates queued work and pending requests, never rolls back committed effects, and preserves the configured payload). Added nothing that has no consumer.
2. **No `grep-regex` execution kind.** Grep is a shell command; there is no standalone grep execution today. The kinds are the real needs: `shell` and `python`.
3. **No session-pinned `filesystem`.** The product's model is fork-per-task (`session base .fork()` + task mounts); a base filesystem stored on the session would be unused hidden state. `context.filesystem` travels per request; it is OPTIONAL — when absent, the shell's accepted fallback applies (`asVfs` builds a fresh internal machine), so `execute` never invents a second rule where the runtime already has one.
4. **`authorization` instead of contract-draft `ExecutionAuthorization`-in-createSession.** The port arrives per request (like `mutationPolicy`) because it is task-scoped state (§5 below).
5. **`workerAssets`/`hosting`/`events` shrink to `workerAssets`.** Hosting context stays where it is today (`network.js` reads `window.location`; injecting it is NetworkRuntime work owned by the same file, not needed by the entry). Events are per-session subscriptions (`onStatus`), not a host-level sink object — the one consumer (UI status) is per-page-per-session.
6. **`pythonRuntime()` accessor on the session** — a Runtime-internal accessor returning the underlying interpreter instance, used ONLY by test/e2e seams (documented users: `window.__locus` seams, Node suites). The Product execution chain never touches it; it exists so tests can drive the SAME object the session drives, not a second one.

Import-time safety: importing `src/runtime/index.js` performs no DOM access, no worker spawn, no fetch. The entry resolves its runtime core at `createRuntime()` call time through TWO assembly modes over ONE implementation set (review round, §12): the declared Runtime-internal registry `globalThis.__LOCUS_RUNTIME_CORE__` (populated by `src/shell.js` at classic load) is DELEGATED to when present — a mixed page keeps exactly one copy of every core definition — and otherwise the entry dynamically imports the SAME five sources through `src/runtime/core.js` (one memoized import; the files publish their cross-file names explicitly for this mode). Merely not having preloaded the classic scripts is therefore NOT an error; a broken or partial registry, or missing worker assets, still is (A1c correction).

## 2. State ownership

| Owner | State |
|---|---|
| RuntimeHost | The `workerAssets` bundle (validated, frozen), the set of sessions it created, host disposal reason. Nothing else. |
| RuntimeSession | ONE `createPythonRuntime()` instance (all interpreter state stays inside it, M1b), the session's status-listener set, the prepare serialization tail, session disposal reason. |
| Task execution context (per `execute` call) | `filesystem` (the caller's task VFS), `signal`, `mutationPolicy`, `authorization`, `cwd`. Held for the call only; never stored on the session. |
| Product (unchanged) | Page VFS + mounts, task forks, approval controller, capability manager, relay config, the ONE host+session created at first use. |

The canonical interpreter instance MOVES from the store into `RuntimeSession` (contract §3.4-Q3 target shape). Preparation (`session.prepare`), session boundaries (`session.reset`) and execution (internal injection into `runShellCommand`/`runPythonCode`) can never split onto two interpreters — the session owns the only reference that matters.

Instance-per-task is explicitly rejected: sessions keep M1b lazy boot; a text-only task constructs nothing and downloads nothing.

## 3. Worker and Python assets (couples #1 removal)

- New `src/runtime/worker-assets.js` (ESM): `PY_WORKER_SOURCE`, `GREP_WORKER_SOURCE` — the exact sources migrated verbatim out of `index.html` (`#py-worker-src` / `#grep-worker-src` blocks deleted). Encoding: per-line JSON-escaped strings in an array joined with `\n` (the sources contain backticks and backslashes; this form is mechanically safe and keeps 1:1 reviewable lines). A syntax gate (`new Function(src)` in the worker suites) pins that each string still parses as a worker script.
- `createPythonRuntime(opts)` takes `{ pyWorkerSource }` (required, non-empty string, validated at construction). `_ensureWorker` uses the stored source; the `document.getElementById('py-worker-src')` read is DELETED — no DOM fallback, no CDN fallback, no cross-backend retry.
- `createGrepRegexSession(pattern, flags, workerSource)` takes the source; `shGrep` forwards `opts.grepWorkerSource`. `GrepRegexRuntime.createWorker(source)` uses the argument (the `_workerFactory` TEST-ONLY seam stays). The `#grep-worker-src` read is deleted.
- Creator iframe, strict CSP (`PY_CREATOR_CSP`), message identity checks, SHA-256 bootstrap verification, per-phase budgets and fail-closed boot failure handling: UNCHANGED.
- Asset ownership: sources are immutable strings shared by every session of a host; the verified Pyodide byte cache stays PER INSTANCE (M1b decision); instances dispose their own creator iframes/workers. The Product bundle ships the sources via the ESM import (Vite-bundled); the standalone host imports the same module — no page copies anything.

## 4. `prepare` waits for in-flight executions (session layer)

`RuntimeSession.prepare(req)`:

1. Refuse when disposed (the disposal reason) or when `req.signal` is already aborted (cancellation-shaped `AbortError`, M1b form preserved).
2. **Barrier**: capture the in-flight set = queued + active run entries of the instance (each entry now records its `done` promise, assigned synchronously at `run()` call time) and await `Promise.allSettled` over them, raced against `req.signal` abort. No timers, no busy polling, no retry.
3. **No late effect**: after the barrier, re-validate in order — disposed → throw the disposal reason; a `reset()`/`dispose()` landing during the wait (reset-generation changed since entry) → throw a boundary error, NOTHING applied; signal aborted during the wait → throw the cancellation-shaped refusal. Only then apply, synchronously, via the existing instance `prepare` (compare-key → validate-then-swap; unchanged M1b code).
4. Concurrent prepares serialize through a session-level tail chain (apply order = call order).

The instance-level `prepare` keeps its accepted synchronous contract (validate-then-swap, no awaits, all-or-nothing) — the waiting lives ONLY in the session wrapper. A killed-during-wait in-flight run still settles honestly at its own boundary (M1b generation semantics); the configuration that lost the race is never applied afterwards.

## 5. Execution authorization port (couples #6 removal)

`network.js` `request(spec)` consumes `spec.authorization = { request(req, opts) → Promise<{ outcome, scope }> }` with `req = { kind:'permission', action, resource, policyKey }` — the Runtime-defined consumer interface (contract §3.5). The `policyContext { approvals, conversationId, taskGeneration }` shape and the chat-identity field names are REMOVED from the Runtime: the approval request the Runtime constructs carries no identity; the PRODUCT adapter supplies identity on its side.

Product adapter (store): `productNetworkAuthorization()` closes over the CURRENT live conversation id + session generation per execution and forwards to `approvals.request({ ...req, conversationId, taskGeneration }, opts)` — byte-identical approval payloads downstream, so approval UI/persistence behavior is unchanged. Deny ≠ cancel, dispatch-once semantics, SSRF relay policy: unchanged.

`wiredToolExecutor` stops injecting `approvals/conversationId/taskGeneration/pythonRuntime` into tool opts; it injects `runtimeSession`, `mutationPolicy`, `authorization`. `SkillInstanceWorkspace` wiring in `prepareTask` keeps its direct Product→Product approvals reference (never crossed the Runtime boundary).

## 6. Remaining Runtime-internal packaging (declared, temporary)

`src/shell.js` stays a classic script until M3 (converting it would break the eval-based suite loading model of ~20 suites — that conversion belongs to repository extraction). To make the entry genuinely importable instead of a wrapper of *implicit* globals, shell.js ends with ONE declared registration:

```
globalThis.__LOCUS_RUNTIME_CORE__ = Object.freeze({ createPythonRuntime, runShellCommand, runPythonCode,
                                                   VirtualWorkspace, SHELL_COMMANDS, ... })
```

The entry (and any host) resolves through this named seam when the page carries the classic copies; a host that carries none gets the entry's own self-assembly of the SAME sources (§12). Either way the boundary test (gate G) enforces that Runtime files reference ONLY this registry among globals and never any Harness/Product global, and gate G7 walks the entry's transitive import closure. The registry is not a second state holder: it is a frozen table of the same functions; the self-assembly chunk is code-split and never fetched on a registry page.

Contract data: the payload-identity patterns live IN `src/shell.js` as the Runtime's own constants (`RUNTIME_PLUGIN_ID_PATTERN` / `RUNTIME_PY_MODULE_PATTERN`, exported through the registry as `contract`) — the same module that enforces them, no extra classic file, no load-order cost (a separate `runtime/contract.js` classic script would have had to be threaded into every eval-based suite and page for zero gain; deviation from the earlier draft of this section). `src/extensions.js` keeps its Harness copy unchanged; a boundary test pins the two regex sources EQUAL (the declared synchronization mechanism).

## 7. Status events replace DOM writes and polling (couples #3 removal)

- `_setStatus(status)` updates `this.status` and emits to the instance's listener set; the `#sb-python` DOM write is DELETED.
- `RuntimeSession.onStatus(fn)`: invokes `fn(snapshot())` synchronously on subscribe (initial read; no missed-edge window), then on every change; returns an unsubscribe; observer exceptions are contained per listener (a throwing observer can never break execution, other observers, or cleanup); after `dispose`, listeners may receive the final transition; no events flow after unsubscribe.
- Events are instance-scoped: a stale instance's events reach only its own (unsubscribed) listeners — no cross-instance pollution by construction.
- Product: `main.js` subscribes once at boot and projects `snapshot.interpreter` into `store.pythonStatus`; the 1-second `setInterval` poll is DELETED. `ContextRail.vue` keeps reading the store projection (UI code untouched).
- Harness telemetry sink injection stays M2b (per brief §7); the Runtime adds no telemetry dependency in M2a.

## 8. Product globals removal (inventory §3 items 4, 7, 11)

1. **`LOCUS_HOME_SKELETON`**: `VirtualWorkspace` takes `opts.homeSkeleton` (array of relative dir paths). Default when omitted: `['.config', '.cache']` — neutral, non-Locus. The Product (store) passes `LOCUS_HOME_SKELETON` explicitly (Product→Product classic-global read, unchanged values, byte-identical VFS for Locus). Tests that pinned the old implicit fallback are updated to pass skeletons explicitly; new checks pin the neutral default.
2. **`EXTENSION_*` patterns**: Runtime contract data (§6). `shell.js` no longer references `extensions.js` globals — gate A's eval set (telemetry, workspace, vfs, network, shell, contract, entry) boots and configures payloads with zero Harness/Product files in scope.
3. **`MutationPolicy`**: stays a per-request port; the generic default (no policy) keeps accepted semantics (no refusal class). Unchanged from M1b except that it now travels through `session.execute` context.
4. **`ConversationHistoryWorkspace`**: moved verbatim from `src/workspace.js` to `src/conversation-history-workspace.js` (Product classic script; loads after `workspace.js`, copied by the build). The `service._byIndex` private read becomes Product-internal (same owner on both sides). `workspace.js` is Runtime-only afterwards.
5. **NetworkRuntime**: no code move (it is Runtime-owned); the authorization port (§5) is the boundary work. `Runtime 不导入 AgentSession 或产品会话状态` — unchanged and now enforced structurally (gate G).

## 9. Product wiring (no bypass)

`store.js` builds ONE host+session lazily (`hooks().runtimeSession` test seam → `createRuntime({ workerAssets })` → `host.createSession()`); drives `session.prepare/reset`; `executeTool` (Product tool router) executes bash through `session.execute` and REQUIRES the session (loud failure without — the old direct `runShellCommand` global path is no longer reachable from the product chain; runtime suites test `runShellCommand` directly as the internal implementation). `window.__locus.runtime()` replaces `window.__locus.pythonRuntime()` as the e2e seam (same underlying object via the documented accessor). Every transition seam is one-way delegation with no second state.

## 10. Independence gates (brief §10 mapping)

- **A** `tests/runtime-standalone.test.mjs`: import entry+assets with NO other file loaded (no DOM); then eval ONLY runtime files → VFS + shell + python-instance construction + status events run; python never starts (fetch/document asserts).
- **B** `tests/runtime-host.html` (vite build input → `dist/tests/runtime-host.html`) + `tests/e2e-runtime-host.cjs`: built-artifact host page runs grep (real worker) and real Python with zero `py-worker-src`/`grep-worker-src` DOM, cold-load downloads nothing.
- **C** two hosts/sessions in one page: status, execution, cancel, dispose stay independent (Node + browser).
- **D** prepare barrier suites: settle-wait, cancel-during-wait, reset-during-wait, dispose-during-wait, late-execution-vs-prepare ordering (Node, deterministic worker fixtures).
- **E** M1 lifecycle: `python-lifecycle`/`store-python-lifecycle` suites extended, not weakened (all LC/SP checks stay).
- **F** status subscription semantics suite: initial read, edge order, unsubscribe, late events, observer exceptions (Node + host-page e2e).
- **G** `tests/runtime-boundary.test.cjs`: structural scan of `src/runtime/*` + the runtime classic files + `dist/` copies — forbidden: imports of/references to Harness/Product modules (`agent`, `store`, `persistence`, `extensions`, `capability*`, `attachment*`, `approval`, `model`, `ui/`, Vue), Product DOM ids (`py-worker-src`, `grep-worker-src`, `sb-python`), `LOCUS_HOME_SKELETON` reads in Runtime files, `EXTENSION_*` global reads in shell.js. Paired with gate A's real execution (structure + behavior, not grep alone). Also pins contract-pattern equality with `extensions.js`.

## 11. Commit plan

1. `refactor(runtime): own the worker/asset sources` — worker-assets module, index.html blocks removed, shell/grep source injection, all consumer assemblies updated (unit-green).
2. `feat(runtime): public createRuntime/RuntimeHost/RuntimeSession entry` — contract data, status events, homeSkeleton arg, ConversationHistoryWorkspace move, authorization port, prepare barrier, Product rewiring, suites updated (unit-green).
3. `test(runtime): independence gates and standalone host` — gates A–G, host page, vite input, e2e host suite.
4. `docs(split): M2a records` — CONTRACTS/INVENTORY updates, this design record, verification record, TODO.

## 12. Review round (M2a review fixes, appended after `8b44a42`)

The review of PR #5 identified three gaps. First-round failure evidence is preserved verbatim in [REPOSITORY-SPLIT-M2A-REVIEW-FIRST-ROUND.txt](REPOSITORY-SPLIT-M2A-REVIEW-FIRST-ROUND.txt) (30+ failing checks on the pre-fix implementation). M2b/M2c/M3 remain out of scope.

### 12.1 The session owns the FULL execution lifecycle (gap 1)

The M2a session tracked only the interpreter instance; a composite shell execution (VFS writes, grep, curl, python-inside-shell) was invisible to `busyExecutions`, to the prepare barrier, and to reset/dispose — the first round demonstrated `busyExecutions: 0` with a write in flight, the second write executing after a reset, and a clean `ok: true` for a boundary-struck run.

The session now tracks EVERY accepted public `execute` from admission to complete settlement:

- **Tracking**: one `inflight` set, entry added synchronously at admission, `done` assigned synchronously, released exactly once in the run's own `finally`. Composite work lives INSIDE its one execute entry — shell-internal python/grep is never counted twice (R8a pins busy=2 for one python + one shell, R8b/c pin per-seat release).
- **Session-owned invalidation plane**: each execute gets an internal `AbortController` MERGED with the caller's signal (caller abort → merged abort with the caller's reason; session boundary → merged abort with the boundary reason). The underlying shell/python/curl machinery already re-checks the signal between steps and before every side effect, so a boundary lands without the caller ever aborting. Already-dispatched provider operations settle and are reported honestly (the parked first write commits; the second write never dispatches; the run reports `ok: false`); the report carries an ADDITIVE `boundary` field naming the boundary (the session's cancellation plane may preempt the instance's own generation check). Never a rollback, never a fake success.
- **Busyness**: `status().busyExecutions` is the session's own count (admission → settlement), replacing the instance count in the session snapshot.
- **Termination paths**: `reset` (reusable boundary), `dispose` (terminal, idempotent, keeps the first reason), `host.dispose` (all sessions) — all bump the boundary generation, fire the invalidation plane, and forward to the instance (M1b semantics verbatim). Queued-but-not-started executes refuse cancellation-shaped; every listener registration is released exactly once.

### 12.2 Session boundary algebra ≠ interpreter rebuild algebra (gap 2)

The M2a prepare judged its no-late-effect check against the INSTANCE generation — which a same-stack `prepare(A)`'s legitimate rebuild also bumps, so `prepare(B)` misjudged A's rebuild as an external reset (first round: B refused, final key `env-a`).

Two separate algebras now:

- **Session boundary generation** (session-owned): bumped by `session.reset/dispose` ONLY. A waiting prepare refuses iff this moved (`reset while preparation waited ... (<boundary reason>)`).
- **Interpreter generation** (instance-owned): moves on legitimate prepare rebuilds too. The prepare chain tracks `chainPyGeneration` — the generation the CHAIN last observed or produced — and refuses only when the instance generation moved OUTSIDE the chain (`reset outside the preparation chain`), which detects out-of-band `pythonRuntime().reset()` seam mutations. A chained prepare's rebuild is normal serialized work; concurrent prepares apply in call order (P1: A then B, final key B, both report `rebuiltInterpreter: true`).
- A cancelled QUEUED prepare returns promptly (cancellation-shaped) but its chain segment still completes in order — a later prepare can never jump ahead of an unfinished earlier one (P3), and a failing prepare never wedges the chain (P4). A real boundary refuses EVERY prepare it crossed (P5) while the session stays usable afterwards (P2b/R7c2 — the boundary's own interpreter reset is synced into the chain algebra).
- **Execute admission** (requirement 6): a new execute waits out the prepare barrier in force at call time — it can never penetrate an in-flight prepare (R4: the admitted execute's first effect sees the prepared config; P6: an execute admitted between A and B runs after A and settles before B applies). The prepare barrier itself waits for the settlement of the executions in flight AT CALL TIME (call-time snapshot; later admissions queue behind the chain and cannot deadlock against the barrier).

Coverage: `tests/runtime-session-lifecycle.test.mjs` (48 deterministic checks — reset/dispose/host.dispose over composite shells, prepare vs non-python work, same-stack admission races, network authorization and response waits, grep across a boundary, two-session isolation, settlement-vs-busy ordering, A/B/C prepare queues with cancellation/failure/real boundaries/old-execution-unsettled/admission; event barriers and scheduling ticks only, no fixed delays prove ordering) plus the browser L-gates in `e2e-runtime-host.cjs` (the same semantics live on the packaged entry, driven through a real parked VFS and real logs).

### 12.3 The entry assembles its own dependencies (gap 3)

- `createRuntime` is now ASYNC and self-assembling: configuration is validated synchronously (bad worker assets / a broken or partial registry fail with clear errors — the A1c correction: missing LEGAL configuration errors, merely missing classic scripts does NOT), then the core resolves through the registry (delegation; the product page path) or ONE memoized dynamic import of `src/runtime/core.js` — the SAME five sources as ES modules (load order mirrors the classic page; the per-file explicit publishes appended to telemetry/workspace/vfs/network.js keep the classic bare-global cross-file references working in both modes). The product bundle never fetches the self-assembly chunk (verified: `classicScriptTags === 0` and the registry published, live in the browser).
- **VFS exports**: `createWorkspace` (VirtualWorkspace, with the runtime's own shell command surface as the `listCommands` default), `createMemoryWorkspace`, `shellCommandNames` — a host imports one module and builds a filesystem without any classic global (the standalone host page now carries ZERO classic scripts).
- **Boundary gate G7**: the entry's transitive ESM import closure is walked structurally — every reached file must be Runtime-owned, and the closure must cover the whole core (worker-assets stays host-injected by design).
- **Product wiring**: store.js resolves the session via the seam-first sync accessor (`ensureRuntimeSession`) plus `whenRuntimeSession()` for the task path (`wiredToolExecutor` and `preparePythonRuntimeForEnvironment` await it); main.js attaches the status subscription after resolution. The standalone host page imports the entry + worker assets ONLY; `tests/runtime-self-assembly.test.mjs` proves cold import → self-assembly → VFS exports → execution with zero classic scripts and zero DOM.
- **Boot rebind fix (found by the honest boundary)**: `bootPersistence` re-ran `providerSessions.restoreInto` on the conversation THIS boot had just created — a spurious `session.reset()` (provider-session.js:109) that, with the new session-owned invalidation, cancelled unrelated in-flight executes on the product page (first seen as the network suite's N4 approval card dying). Boot now rebinds only onto a DIFFERENT conversation (archived boots still rebind and replay; fresh boots skip the meaningless reset).

### 12.4 Verification of the review round

First round evidence preserved (pre-fix); then: unit gate 50/50 suites (incl. the two new suites), `vite build`, the standalone-host e2e (22 checks incl. H0b/c assembly proofs and L1–L5 live boundary semantics), the FULL browser e2e (17/17 suites), and an interactive browser pass driving BOTH the standalone host and the full product page through the same parked-composite/boundary flow with event-barrier logs (zero classic scripts on the host page; product chain executes, boundary blocks the second write, commits the dispatched one, busy drains, zero page errors).
