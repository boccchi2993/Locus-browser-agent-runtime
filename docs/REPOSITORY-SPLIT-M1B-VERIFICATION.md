# Repository split M1b — verification record

Status: M1b deliverable (interpreter lifecycle explicitization + skill-path protection moved behind the MutationPolicy port). Branch `refactor/repository-split-m1b`, stacked on `refactor/repository-split-m1a` (`0b56922`, PR #3, unmerged at the time of writing — PR #2 `docs/repository-split-m0` (`57b3c5d`) remains the document base). Companion documents: [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) (§3.1/§3.7 M1b landed forms), [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) (coupling #5 and #10 resolved), [REPOSITORY-SPLIT-M1A-VERIFICATION.md](REPOSITORY-SPLIT-M1A-VERIFICATION.md).

Environment: same host as the M0/M1a rounds (Windows 10, Git Bash, Node v24.10.0, npm 11.6.1, local Chrome via CDP). Dependencies via a node_modules junction to the M1a worktree's `npm ci` install (unchanged lockfile); no dependency or build config changed beyond the one-line `vite.config.js` copy-list entry for the new classic script.

## 1. What landed

| Piece | File | Notes |
|---|---|---|
| Instance factory + explicit lifecycle | `src/shell.js` | `createPythonRuntime()` replaces the page-global `PythonRuntime` singleton: ALL mutable state per instance (worker facade, boot promise/timers, `_pending` map, `_reqId`, execution queue, `_queuedRuns`, plugin payload, disposed flag, reset generation). Lifecycle: `prepare(req)` / `run(code, vfs, opts)` / `reset(reason?)` / `dispose(reason?)` / `snapshot()`. `runPythonCode` executes on `opts.pythonRuntime` and fails LOUDLY ("python: no runtime instance injected") without injection — no global fallback. `buildExtensions` split out of `configureExtensions` so prepare can validate-then-swap. `reset`/`dispose` bump a reset GENERATION that invalidates queued runs caught between seat acquisition and the worker post (a real gap found by the new suite: such a run used to post onto the nulled worker of the next generation) |
| Product ownership | `src/ui/store.js` | The store OWNS the ONE canonical instance: `ensurePythonRuntime()` resolves lazily (`window.__LOCUS_HOOKS__.pythonRuntime` seam → `createPythonRuntime` factory → null for python-less deployments); `preparePythonRuntimeForEnvironment` drives `instance.prepare` (null payload for the core-only runtime); `AgentSession.onSessionReset` calls `instance.reset()`; `wiredToolExecutor` injects the SAME instance as `opts.pythonRuntime` — preparation and execution cannot split |
| UI + e2e seam | `src/main.js` | Status poll mirrors the canonical instance; `?e2e=1` exposes `window.__locus.pythonRuntime()` |
| Product mutation policy | `src/mutation-policy.js` (new, classic script) | `LocusMutationPolicy.create()` → frozen stateless policy: `checkMove` (source + FINAL destination), `checkRemove` (target, kind, recursive), `isPolicyRefusal` (`skill_mutation_*`). Owns `/home/locus/.skills` knowledge + the byte-stable refusal texts formerly hardcoded in shell.js |
| Shell consumes the port | `src/shell.js` | `shMv` consults `policy.checkMove` (resolved final destination, same position as the old hardcoded check); `shRm` consults `policy.checkRemove` for every existing target; the python commit phase classifies via `policy.isPolicyRefusal` (no policy = plain write failures). Zero `~/.skills` knowledge remains in the runtime (grep-verified in dist) |
| Product assembly guard | `src/ui/store.js` | `taskMutationPolicy()` injects the policy into EVERY bash call and THROWS when `LocusMutationPolicy` is unavailable — a product without its policy refuses execution instead of running unprotected |

Deliberately NOT done (M2 scope): RuntimeHost/RuntimeSession wrapper (`createSession` over worker-asset bundles), `ExecutionRequest` shape, `cancelActiveExecutions`, worker-source packaging (`#py-worker-src` DOM extraction), `#sb-python` status write → event port, `VFS_HOME_SKELETON` injection, repository extraction. The worker plugin-loading seam is untouched per the M1b brief.

## 2. New behavior evidence (public entries, no globals)

`tests/python-lifecycle.test.cjs` (52 checks) drives the REAL factory through controlled worker fixtures:

- **LC1** prepare is pure configuration: same key = no-op, key change = validate-then-rebuild, null payload = core-only; zero downloads (counting fetch stub), zero boot DOM work (createElement/appendChild stubs throw; only the legacy `#sb-python` status write occurs).
- **LC2** all-or-nothing: an invalid payload throws and the previous payload survives INTACT (the old code reset BEFORE configure — a throw left the interpreter configured empty); a prepare with an aborted signal is refused and applies nothing; the instance stays reusable after refused prepares.
- **LC3** two instances share nothing mutable: distinct `_pending`/`_queue`/`_queuedRuns` objects; per-instance plugin configuration; parked runs on A and B — reset(A) fails A's run (honest error report, nothing committed) while B stays pending and resolves normally; dispose(A) leaves B fully operational.
- **LC4** execution state: serialization queue preserved (second run queued while the first holds the seat); reset during execution fails the in-flight run with the boundary reason and DRAINS the queued run (rejection with the reason); stale worker results have nowhere to land; late `_onWindowMessage` traffic after reset mutates nothing (no status writes, no pending); the instance is reusable; task-signal cancellation rejects the run.
- **LC5** dispose: idempotent (first reason stands), permanently refuses prepare/run/configureExtensions/boot, configuration unchanged after dispose, late messages revive nothing, disposing a never-booted instance is safe.
- **LC6** the shell executes python on the INJECTED instance only (a second instance sees zero requests), converges with prepare on the SAME object, and missing injection is an honest failure while non-python shell work needs no instance.
- **LC7** `snapshot()` state reads (cold/busy/drained, extension key, disposed).

`tests/store-python-lifecycle.test.mjs` (10 checks) pins the PRODUCT wiring against the real store module: exactly ONE instance created; task preparation configures it (null payload without a capability manager); the tool executor receives the SAME instance in `opts.pythonRuntime`; the session boundary resets it; construction is lazy and reused across tasks; the hooks seam substitutes the instance; the executor opts carry the REAL product mutation policy (enforces the skill identity, nothing else); and a missing policy implementation REFUSES execution loudly (SP7).

`tests/mutation-policy.test.cjs` (35 checks) pins the policy port: byte-exact refusal matrix through the real shell (mv out/into the skills tree, capability directories, `rm -r` of a directory and of the root — identical texts incl. the `mv: <src>: ` / `rm: ` composition); INJECTED-policy proof (a second policy guarding a different mount is enforced verbatim while the SAME shell ALLOWS skills-tree moves — no hardcoding remains); policy-less neutrality; normalization (relative cwd, `..`, redundant segments, trailing slash — resolved before the policy); final-destination semantics (mv-into-directory basename append) and multi-source mv; single skill FILES still deletable (per-file guard owns them); non-skill operations untouched; VFS protected-root/geometry refusals still fire WITH a policy present; `isPolicyRefusal` commit-phase classification (conflict with policy, plain write failure without).

Updated assemblies (singleton consumers → injected instances): `tests/shell.test.cjs`, `shell-compat(+2)`, `worker-output`, `vfs-audit`, `python-bootstrap-integrity` + `python-plugin-runtime` (`freshRuntime` = factory, no more `Object.create(singleton)` — the exact anti-pattern the brief forbids), `skill-instances` S1–S6 (policy injected exactly like the store does; 69/69), `tests/e2e.html` (suite-local instance via an executeTool wrapper), the three python e2e suites (`window.__pyrt = createPythonRuntime()` on the standalone harness pages; the authority suite's `__paE2e.exec` injects `window.__locus.pythonRuntime()`), and skill-instances e2e R3 (dist freshness now asserts policy present + shell.js clean).

## 3. Gates

| Command | Result | Notes |
|---|---|---|
| `npm test` | PASS | **46/46 suites** (44 at M1a + `python-lifecycle` + `store-python-lifecycle` + `mutation-policy`, minus none) — first run after the lifecycle commit had 3 real failures (worker-output/vfs-audit/mutation-policy: stale singleton assemblies + the not-yet-written suite), fixed in the same commits; the recorded final state is green |
| `npm run build` | PASS | freshness verified on the newest `dist/assets/index-*.js`: zero bare `PythonRuntime` global reads, `createPythonRuntime` referenced, `mutationPolicy` wired; `dist/src/mutation-policy.js` present, `dist/src/shell.js` carries NO `/home/locus/.skills` knowledge |
| `npm run test:e2e` (run 1, single sequential run) | **11/16 suite entries** | first-run failures honestly preserved (see §4): runtime, python-authority, skill-instances, python-bootstrap-integrity, trusted-plugin-runtime |
| `npm run test:e2e` (run 2, after the §4 fixes) | **PASS 16/16 suite entries, exit 0** | runtime, active-content, presentation, responsive, persistence (26/26), wire (16/16), approval, image (56/56), grep (19/19), **python-authority (56/56)**, capabilities, **skill-instances**, network, **python-browser-authority (102/102)**, **python-bootstrap-integrity (27/27)**, **trusted-plugin-runtime (33/33)** — the REAL browser python + skill gates all green on the production instance/policy chain |

Real browser evidence for the M1b boundaries specifically: python-authority E10–E12 drive `window.__locus.pythonRuntime().reset()` and the fatal-worker recovery path on the PRODUCTION instance (the same object prepare/shell use) with a full re-bootstrap; python-bootstrap/plugin suites build standalone pages that construct their OWN instance from the factory (proving the runtime no longer needs a page global); trusted-plugin-runtime re-verifies wheel payloads through `instance.prepare`-configured boots; skill-instances e2e drives the rm-refusal text through `submit` → wiredToolExecutor → injected policy (A12) and asserts `dist/src/shell.js` no longer embeds the product rules.

## 4. First-run e2e failure, root-caused and fixed (no assertion loosening)

Run 1 failed 5 suites. Every failure was a TEST-HARNESS wiring gap (the suites still reached python through the removed page global), not a product defect; each was fixed at the harness and the whole gate re-run:

| Suite | First failure | Root cause | Fix |
|---|---|---|---|
| runtime (tests/e2e.html) | `python: no runtime instance injected` + `ReferenceError: pyRuntime is not defined` at line 220 | the executeTool→instance wrapper edit had been LOST when an earlier multi-edit script aborted before writing (two later one-line patches landed without it) | wrapper re-inserted (suite-local `createPythonRuntime()` instance injected into every bash call) |
| python-authority | every python probe: `no runtime instance injected` | `window.__paE2e.exec` called the GLOBAL `window.executeTool` — not the store's wired executor | exec helper injects `pythonRuntime: window.__locus.pythonRuntime()` |
| python-bootstrap-integrity / trusted-plugin-runtime | readiness timeout at `window.__f04c.ready` | these suites build STANDALONE pages (no app, no `window.__locus`); the patched seam `window.__pyrt = window.__locus.pythonRuntime()` threw ReferenceError, killing the boot script | standalone pages construct their own instance: `window.__pyrt = createPythonRuntime()` |
| skill-instances | R3 dist-freshness check only (1 check) | R3 grepped `dist/src/shell.js` for the refusal text — the text legitimately moved to `src/mutation-policy.js` | R3 now asserts the policy file is fresh in dist AND shell.js is clean of product rules |

Run 1 results are preserved verbatim in the branch's working notes (`tmp-e2e-run1.log`, not committed); run 2 is the recorded gate. No retry-without-change, no timeout loosening, no assertion change anywhere.

## 5. Not executed / out of scope

- real-world-50 `setup.py`/`verify.py`: fixtures untouched by this diff (shell.js behavior for the covered commands is pinned by the shell/skill/policy suites and the browser gates above); the M0 record remains the reference.
- REAL-WORLD-50 NET 32–37 manual tasks: unchanged policy (manual, real network).
- Deployed-build (Cloudflare Pages) checks: packaging is M2/M3.
- Standalone-Runtime independence proof (shell.js running WITHOUT extensions.js/tools.js in scope): the M1b factory still reads `EXTENSION_ID_PATTERN`/`EXTENSION_PY_MODULE_PATTERN` globals at configure time (unchanged from M1a; payload-port becomes contract data in M2) — recorded in INVENTORY §2.3.

## 6. M1b follow-up round (2026-09-29): lifecycle gaps found by review, fixed test-first

Three gaps in the M1b round were reported by review and fixed on the same branch (append commits, no history rewrite; base `26cac7f`, PR #4 head unchanged until this round):

### 6.1 Root causes

1. **Stale write-back after reset/dispose** (`src/shell.js` `_runOnce`): the reset generation was checked before the worker post ONLY. Once the worker had answered, a run parked at an async pre-commit VFS check (stat before mkdir, readBytes for the external-write/delete verification) kept committing mkdir/write/remove/rmdir into the VFS after the boundary — and could return `error: null` as if nothing had happened. Nothing checked validity between the awaited checks and the side-effect calls.
2. **`busyExecutions` did not cover the whole run** (`src/shell.js` `snapshot()`): the count was `_pending.size + _queuedRuns.size`. After the worker answered (pending removed), a run still in its commit phase counted 0; reset() also cleared `_queuedRuns` synchronously, so a boundary masqueraded as the settlement of runs whose promises had not settled yet (the storage-mutation gate could reopen early on that lie).
3. **Prepare-phase signal/liveness gap** (`src/ui/store.js` `prepareTask`): `task.signal` was not handed to the interpreter prepare, and no liveness check ran between the async capability refresh (`refreshSkillPresence`) and the interpreter configuration. A task cancelled or boundary-struck while the refresh hung still built the TaskEnvironment, prepared (and on a key change reset!) the canonical interpreter, and — observed by SP9 against the old code — ran the FULL model request to completion after the boundary.

### 6.2 Fixes (each pinned by tests that failed on `26cac7f` first)

| Fix | File | Shape |
|---|---|---|
| Commit-phase invalidation | `src/shell.js` | `invalidated()` (disposed + generation) is checked after the worker reply and before EVERY commit side effect (mkdir after its stat, write after the concurrency pre-check, delete after the verification read, rmdir — new gate before `remove`). Stopped operations land in `notPersisted` with the boundary reason; the report carries the reason in `error` — never an empty success over a partially-invalidated run. Already-dispatched provider operations are waited out, not rolled back, and nothing further starts |
| Full-lifetime counting | `src/shell.js` | `_activeRuns` tracks every run from seat acquisition to final settlement (boot, collection, worker execution, whole commit phase); released exactly once in the run's own `finally`. `busyExecutions = queued + active`. reset/dispose only MARK queued entries killed (no set clearing) — synchronous invalidation never masquerades as settlement |
| Prepare-phase liveness + signal | `src/ui/store.js` | `preRunStopped()` is checked after `refreshSkillPresence` (before any environment build / interpreter prepare) and after prepare; `preparePythonRuntimeForEnvironment(env, signal)` hands the task's signal to `rt.prepare` |
| Cancellation-shaped prepare refusal | `src/shell.js` | a prepare whose signal already aborted throws an AbortError (`makeCancelledError('python preparation')`) — existing classification reads it as cancelled, never as an independent error |

Preserved unchanged (pinned by the existing suites): the adoptEpoch legitimate-rebind semantics (S14; the epoch in the ready result stays the submit-time pin so a boundary is detected, not accidentally adopted), the `persistence_error` priority (task-runner classification table untouched), same-key no-rebuild, invalid-payload-leaves-old-config-intact, text-only-tasks-boot-nothing (LC1/LC2, SP1/SP4, SP10c).

### 6.3 New evidence (all failing on `26cac7f`, green after the fixes)

- `tests/python-lifecycle.test.cjs` **LC8a–LC8t + LC2c2** (first run: 13 failures — `["mkdir /mnt/workspace/newdir"]`, `["write /mnt/workspace/in.txt"]`, `["remove /mnt/workspace/file.txt","remove /mnt/workspace/sub"]` all executed after the boundary; `busyExecutions: 0` while committing and right after the synchronous reset): barrier tests drive `createPythonRuntime().run()` with a controlled worker; the run parks at the async pre-commit VFS check; reset/dispose lands; the barrier releases. Assertions: no mkdir/write/remove/rmdir starts; honest report (boundary reason + `notPersisted`, never `error: null`); `busyExecutions` stays ≥1 through the commit phase and across the synchronous boundary (reset → 1, not 0); queued + committing = 2 without double counting; failure / task-cancel / boundary each release tracking exactly once; the instance is reusable after reset; a dispatched-but-unanswered worker run is failed by the boundary and never reported as success. LC2c2 pins the AbortError shape of the refused prepare. Final: **73/73**.
- `tests/store-python-lifecycle.test.mjs` **SP8–SP10** (first run: 6 failures; SP9's detail was the live proof that the old code ran the FULL model request after the boundary — `envBuilt: 1, ran: 1`): a gated fake CapabilityManager parks a REAL `submit()` inside `refreshSkillPresence`; cancel (SP8) / `newTask()` boundary (SP9) lands; after the gate releases the stale task built no environment, never prepared/reset the canonical interpreter and made no model request; admission reopened. SP10 is the positive control: a live task hands its OWN signal to the interpreter prepare and runs the model exactly once, with no churn on same-key follow-ups. Final: **21/21**.

### 6.4 Gates for this round

| Command | Result | Notes |
|---|---|---|
| Named regression suites | PASS | task-runner 99/99, conversation-routing 25/25, submit-presentation 22/22, mutation-policy 35/35, store-python-lifecycle 21/21, python-lifecycle 73/73 |
| `npm test` | PASS | 46/46 suites |
| `npm run build` | PASS | dist freshness verified (`_activeRuns`/`boundaryStop` present in `dist/src/shell.js`) |
| `npm run test:e2e` | see §7 | full browser round incl. the python/plugin/approval/skill/persistence gates |

### 6.5 Not executed / out of scope

- real-world-50, NET 32–37 manual tasks, deployed-build checks: unchanged policy (M0 record remains the reference).
- No assertion was loosened anywhere; no retry added anywhere; both barrier repros are in-repo suites (not /tmp scripts).

## 7. M1b follow-up browser gates

Full `npm run test:e2e` after the §6 fixes (single sequential run, exit 0, **16/16 suite entries**): runtime, active-content, presentation, responsive, **persistence**, wire, **approval**, image, grep, **python-authority**, **capabilities**, **skill-instances**, network, **python-browser-authority (102/102)**, **python-bootstrap-integrity (27/27)**, **trusted-plugin-runtime (33/33)** — i.e. every affected gate named by the review round: browser Python (authority / browser-authority / bootstrap-integrity), plugins (trusted-plugin-runtime), approvals, skills (skill-instances + capabilities), persistence. Notably python-authority drives `window.__locus.pythonRuntime().reset()` on the PRODUCTION instance with a full re-bootstrap, and trusted-plugin-runtime R2 re-verifies `reset()` + re-boot with a configured payload — both now exercising the new commit-phase invalidation and full-lifetime counting paths on the real asset chain. No assertion loosened, no retry added; first and only run of this round is the recorded gate.

## 8. M1b final targeted fix (2026-09-29): last dispatched effect, settlement validity

The last item of the M1b follow-up (append commit on top of `9222341`; no history rewrite, no merge, M2 untouched).

### 8.1 The gap

§6.2's commit-phase invalidation checked validity before every side effect but relied on a LATER loop iteration to surface a boundary that landed while an effect was IN FLIGHT. When the run's LAST (only) provider call — a write, mkdir, file removal or directory removal — had been dispatched but not settled, and a reset()/dispose() landed in that window, the effect settled, no further pre-effect check existed, and the final report read `result.error || boundaryStop` = `error: null`: a boundary-stopped run presented as a success (`runPythonCode` would report `success: true`). The dispatched effect itself was real and stayed committed — only the classification lied.

### 8.2 Fix

`src/shell.js` `_runOnce`, at result formation (immediately before the return): re-run `invalidated()` and, when neither a real worker error nor an earlier stop already owns the report, carry the boundary reason into `boundaryStop`. Settlement of a provider call is not validation. No new lifecycle machinery, no change to the per-side-effect guards, no rollback: what committed stays in `written`/`mkdirs`/`deleted`, nothing is fabricated into `notPersisted`, and `result.error` keeps precedence over the boundary text. CONTRACTS §3.1 run()/reset() wording now states the report-formation re-validation explicitly.

### 8.3 Evidence (failing on `9222341` first)

`tests/python-lifecycle.test.cjs` **LC9a–LC9s** (first run against the old code: 6 failures, every one `"error":null` with the committed operation correctly kept — write+reset LC9d, write+dispose LC9i, mkdir+reset LC9l, file delete+reset LC9n, rmdir+reset LC9p, provider-failure+boundary LC9s): a barrier fixture parks the run's ONLY changeset entry INSIDE the provider call (`vfs.write`/`mkdir`/`remove` entered, promise unsettled), driven through the real `runtime.run` public entry + controlled worker; reset/dispose lands; the barrier releases. After the fix, in every scenario: `error` carries the boundary reason; the really-committed operation stays in `written`/`mkdirs`/`deleted` and out of `notPersisted`; `busyExecutions` is 1 across the barrier and the synchronous boundary and 0 exactly at settlement; a boundary-free run of the same shape still succeeds (LC9q); a real worker error is not overwritten by the boundary (LC9r); a provider failure text survives in `writeFailed` while the boundary is the `error` (LC9s). Final: **92/92**.

### 8.4 Gates for this round

| Command | Result | Notes |
|---|---|---|
| `node tests/python-lifecycle.test.cjs` | PASS | **92/92** (86 from §6 + LC9) |
| `node tests/store-python-lifecycle.test.mjs` | PASS | 21/21 |
| `node tests/task-runner.test.mjs` | PASS | 99/99 |
| `node tests/mutation-policy.test.cjs` | PASS | 35/35 |
| `npm test` | PASS | **46/46 suites, 2085 checks, 0 failures** |
| `npm run build` | PASS | |

Browser gates deliberately NOT re-run: the change is host-side result classification only (`shell.js` final-report formation + tests) — worker protocol, bootstrap, VFS and mutation-policy semantics untouched, so per this round's charter no mechanical full browser round. §7's 16/16 browser record over the same production seams remains the standing gate.

## 9. M2 next step (precise scope)

1. RuntimeHost/RuntimeSession wrapper (contract §3.1 target shape): worker assets as string modules, `ExecutionRequest`/`ExecutionResult` port, status events replacing `#sb-python` + the 1s poll, `LOCUS_HOME_SKELETON` as a mount argument, `EXTENSION_*` patterns as payload-port contract data.
2. Harness port injection (§3.2/§3.7): `buildSystemPrompt` via injected description port; `executeTool` split into registry + product adapter; `Telemetry` as an injected sink; independence suites (each core's test entry loads only its own files + fakes).
3. With M1a + M1b closed, M1 is COMPLETE; M2a/M2b gates and the M3 extraction order are as recorded in INVENTORY §4.
