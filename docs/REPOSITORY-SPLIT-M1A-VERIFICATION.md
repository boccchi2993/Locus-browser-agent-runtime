# Repository split M1a — verification record

Status: M1a deliverable (task lifecycle + provider-session extraction, store rewiring, M0 contract corrections). Branch `refactor/repository-split-m1a`, stacked on `docs/repository-split-m0` (`57b3c5d`, PR #2, unmerged at the time of writing). Companion documents: [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md), [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md), [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md).

Environment: same host as the M0 baseline (Windows 10, Git Bash, Node v24.10.0, npm 11.6.1, local Chrome via CDP). Dependencies installed with `npm ci` from the unchanged lockfile; no dependency or product-build config changed in M1a.

## 1. What landed

| Piece | File | Notes |
|---|---|---|
| Harness task runner | `src/harness/task-runner.js` | ESM, no Vue/DOM/globals. `createTaskRunner({emit, prepare, sessionEpoch, finalizeTask?, onTaskEnd})` → `submit/activeTask/observeEvent/quiesceAndRun`. TaskHandle: id, read-only signal, idempotent cancel (no-op after end), adoptEpoch (preparation-phase rebind adoption), `ended` promise, outcome getter |
| Harness provider sessions | `src/harness/provider-session.js` | Verbatim extraction of `ensureProviderSession` / `restoreSessionForConversation` / `makePersistenceContext` / `sessionCompatible` with every global replaced by an injected port |
| AgentSession controller seam | `src/agent.js` | `run(opts)` accepts `opts.controller` (the task-lifetime controller); standalone callers keep self-created controllers; one agent loop, no duplicate implementation |
| Store rewiring | `src/ui/store.js` | `submit()` = admission call; `prepareTask()` = product preparation returning ready/blocked/silent/failed with a pre-run-start predicate; `cancelTask`/`newTask` keep cancel-vs-session_changed semantics; `withStorageMutation` delegates to the runner gate; busy/binding release moved to id-guarded `onTaskEnd`; `pendingCancel`/`storageMutationTail`/`waitFor` deleted; `providerSessionsAdapter()` is the single lazy globals→ports block |

Deliberately NOT done (M1b/M2 scope): RuntimeHost/RuntimeSession instantiation, worker asset packaging, `~/.skills` mutation-policy port, module conversion of classic scripts, repository extraction. The product adapter still uses `PythonRuntime`/`vfs`/`PersistenceServiceInstance` globals inside `prepareTask`/adapter blocks — centralized and recorded in INVENTORY §2.14.

## 2. New behavior evidence (public entry, no Vue/store import)

`tests/task-runner.test.mjs` (30 checks at landing; **74** after the lifecycle review round, see §2b; **99** after the second round, see §2c) drives the runner through controlled async barriers:

- **S1** normal order — exact event sequence `task_start → tool_call → tool_result → task_end(completed)`, one terminal, one `onTaskEnd`, slot freed.
- **S2** cancel while preparing — handle+signal exist synchronously at admission; the LATE ready result is refused (zero `run` invocations); backfilled `task_start` only when `preRunStart` asks; single cancelled terminal. Chinese warning text preserved byte-for-byte.
- **S3** session boundary during prepare — zero run, `session_changed` outcome, one warning + one terminal; explicit rebind epoch realignment still runs to completion.
- **S4** cancel mid-run — the committed-effect report (`not rolled back`) survives, exactly one `task_end(cancelled)`, repeated cancel is a no-op.
- **S5** required persistence failure — no run, `persistence_error` terminal; a persistence failure thrown while cancelled is NOT downgraded to `cancelled`.
- **S6** concurrent submits — admission holds through the prepare window; reopens only after the first task ended.
- **S7** storage quiesce race — submit refused while the gate is closed; the mutation runs only after the task fully ended; the cancelled task never reaches `run` (no late write-back); admission reopens after the mutation.
- **S8** late finish of an old task — repeated cancel of an ended task is a no-op; a late old `task_end` cannot settle the preparing new task; the new task completes with its own single terminal.
- **S9** prepare throws + repeated cancel — exactly one error, one terminal, one `onTaskEnd`, one `ended` resolution; runner reusable afterwards.

`tests/provider-session.test.mjs` (14 checks) pins the extraction against fake persistence: compatible-session reuse with cursor realignment and required conversation persist; fresh-row creation with `_replayBlocked` on an invalid normalized prefix; uncheckpointed-suffix rejection (`raw_invalid` degradation, normalized projection loaded read-only, never raw-replayed); incompatible-session normalized fallback; frame/normalized/checkpoint cursor ordering in `makeContext`; a failing required write propagates unswallowed.

Existing store-level suites keep their guarantees through the new path: `conversation-routing` (18/18 at landing, **23/23** after §2b, **25/25** after §2c — tail events follow the bound conversation, including the settle-after-projection ordering), `submit-presentation` (15/15 at landing, **22/22** after §2b — pre-run cancel/session-switch/persistence-failure intent preservation, one synthetic start, terminal semantics), `store-defaults` (loader updated to inline the new ESM modules).

## 2b. Lifecycle review round (PR #3 follow-up, 2026-09-29)

A review of head `4840c19` reproduced four lifecycle defects through the runner's public entries (`node` repro against the actual branch; 12 expectation violations). All four were fixed in code, not in prose; each fix is pinned by new public-entry tests.

**F1 — `observeEvent(task_end)` completed `ended` too early.** The observed terminal event settled the task immediately: `active` was cleared, `onTaskEnd` ran and `ended` resolved while `prep.run()` was still suspended, so a second task could be admitted and a storage mutation could run before the run body's own `finally`/persistence tail finished. Fix: a terminal event records an *intent* only; the runner publishes the single final `task_end` and resolves `ended` at the real completion boundary (run body returned/thrown, publication done, must-await cleanup done). Admission and the storage gate key off that boundary. `onTaskEnd` roles are explicit: a thenable return is must-await cleanup (covered by `ended`); a throw/rejection is contained and surfaced as a `task_cleanup_failed` warning without wedging admission. A necessary persistence failure surfacing after the intent but before publication overrides the recorded reason (`persistence_error`) and is never silently lost; any other post-intent throw is surfaced as a `task_aftermath_failed` warning and the recorded reason stands. Tests: S10 (suspension barriers: `ended` pending, second submit refused, storage action blocked and not started; after release — publication, cleanup ordering, admission reopen), plus onTaskEnd throw/reject containment.

**F2 — events were attributed to "whoever is active now".** Only the `started` flag guarded old `task_end`s before the new task's start; after B started, a late A `task_end` settled B. Fix: task event identity. Every lifecycle event carries the task's unforgeable `taskId`; the runner stamps its own emissions and the run body emits through the task-bound `ctx.emit` the runner hands it (`store.js` passes it into `AgentSession.run({ emit })`; `agent.js` routes run-body emissions — including `_materializeImageContent` — through the override). Nothing is stamped at arrival with the current active id. `observeEvent` ignores events whose `taskId` is not the active task's; the Product's `handleRuntimeEvent` routes stamped events through a `taskEventTargets` (taskId → conversation) map captured at execution start and DELETES the binding in `onTaskEnd` — a late tail of a released task is dropped BEFORE any projection, so neither the harness state nor the UI can be polluted. The marker is envelope-only: provider messages and `toolCallId` semantics untouched. Tests: S11 (foreign — unstamped and old-`taskId`-stamped — events during B preparing AND B running), conversation-routing Case E (stale entry-point tail dropped before projection, B unaffected), submit-presentation Case G (stale tail during B preparing).

**F3 — `quiesceAndRun` closed admission asynchronously.** `mutationGateClosed` was set only after `await previous`, so a same-stack `submit` right after calling `quiesceAndRun` was admitted, and queued mutations briefly reopened admission between each other. Fix: a `pendingMutations` counter incremented synchronously at the call — admission is closed whenever it is non-zero, stays closed across the whole queued chain, and reopens only when the last mutation's `finally` runs. A timeout still rejects the mutation without executing the action and without pretending the old task ended; actions stay strictly serial; throwing actions release the gate. Tests: S12 (same-stack refusal, refusal between queued actions, throw-then-continue, timeout vs a task that never ends, serial order).

**F4 — structured failures were classified after the liveness guards.** `drive()` checked `signal.aborted` before `prep.status === 'failed'`, so a structured `{status:'failed', error}` with `persistenceFailure` returned by the real `prepareTask` catch was downgraded to `cancelled` under a concurrent cancel, while the identical THROWN error won — two contradictory classification tables. Fix: one classification table, applied to both forms and BEFORE the liveness guards: `persistence_error` > `error` > `session_changed` > `cancelled`; an `AbortError` IS the cancellation (never upgraded to `error`); an epoch change or an explicit `cancel('session_changed')` wins over a plain cancel. The Product keeps no competing logic — `prepareTask` reports `{status:'failed', error}` and `src/ui/store.js` now imports the runner's `isPersistenceFailure` instead of its own copy. Tests: S13 (structured/throw parity incl. `AbortError` and `session_changed`, epoch+cancel, post-intent persistence override), submit-presentation Case F (the REAL `prepareTask` path: required write failure + concurrent cancel → `persistence_error`, one error item, no provider request).

Product wiring touched by the fixes: `src/harness/task-runner.js` (completion boundary, identity, gate, classification), `src/agent.js` (`opts.emit` task-bound sink seam + `_taskEmit` for `_materializeImageContent`), `src/ui/store.js` (`taskEventTargets` routing with pre-projection drop, `taskEventTargets.delete` in `onTaskEnd`, `ctx.emit` pass-through, shared `isPersistenceFailure` import). Contract §2 records the revised semantics.

## 2c. Second lifecycle round (PR #3 follow-up, 2026-09-29)

Two residual gaps from the same review series, both first reproduced through the runner's public entries against the F1–F4 fix commit (`7ec4917`) before this round's diff. Scope held to the two gaps — no new architecture.

**G1 — a preparation-phase AbortError lost the `session_changed` classification.** `classifyFailure` compared epochs only when `task.epoch !== null`, but the epoch is pinned by the READY result — so a session boundary that happened DURING preparation (epoch change + a thrown OR structured AbortError, with or without a concurrent plain cancel) classified as `cancelled`. Fix: one effective-epoch rule for both failure forms at any phase — the pinned epoch once the ready result adopted it, `submitEpoch` before that, NEVER the current epoch read at failure time (that would compare the session with itself and mask a real boundary). A preparation-phase epoch change is now a session boundary; a legitimate Product-internal rebind is adopted explicitly via the new `handle.adoptEpoch(epoch)` AT the rebind point — `prepareTask` calls it where the intentional provider-session rebind resets the session — and is therefore not misread as a boundary, while a real boundary after the adoption is still detected; the ready epoch stays authoritative (it subsumes any preparation-phase adoption; `adoptEpoch` is refused once preparation is over). Necessary-persistence priority (table rule 1) is untouched. Tests: S14 — four-corner matrix (thrown/structured × cancel/no-cancel, all → `session_changed`), unchanged epoch + AbortError → `cancelled`, rebind adoption continues into run and a real boundary after it is still detected, adoption does not mask a later boundary, ready authority, refused adoption after end.

**G2 — a necessary-finalize failure could not change the already-published terminal.** `complete()` published `task_end` FIRST and only then ran `onTaskEnd`, so a rejected must-await cleanup carrying `persistenceFailure` left the final outcome `completed` with just a `task_cleanup_failed` warning. Fix: staged termination publication — (1) run returns/throws, termination intent collected; (2) NECESSARY finalize (new optional `finalizeTask(handle, outcome)` dep) runs awaited BEFORE the outcome is fixed: a persistence failure there REPLACES the outcome (`persistence_error` + one `persistence_write_failed` error, never downgraded to a warning), any other failure is contained; (3) the single final `task_end` publishes the final outcome while the Product task→conversation map is still ALIVE (its release is stage 4); (4) `onTaskEnd` releases bindings / notifies — still awaited (admission and the storage gate cover it) but contained (`task_cleanup_failed`), never changing the published outcome, and it observes the FINAL outcome; (5) admission released, `ended` resolved. No path publishes a second `task_end`; quiesce and the next task wait for the whole necessary-completion boundary. Product audit: every write on the completion path (`persistConversation` in `handleRuntimeEvent`/`taskFailedProductPart`, `appendPresentationEvent`) is failure-tolerant and optional — none is a completion condition of the task — so the Product registers NO `finalizeTask`; required writes (ensureSession, first user frame, run checkpoints) are awaited inside prepare/run and classify through the failure table. The seam stays available for a proven necessary completion write (M1b reconsideration point). Tests: S15 — parked-finalize barriers (no `task_end`, no `ended`, admission refused, storage action blocked and not started; staged order intent→finalize→task_end→notify→ended), persistence finalize failure → the single terminal `persistence_error`, non-persistence finalize failure contained, notification observes the final outcome and cannot wedge, rejected task finalizes nothing; conversation-routing Case F — the map lives through the terminal projection, is deleted afterwards, and a late tail through the same task's sink is refused.

Contradictory wording fixed in the same round: the contract §3.8 line "task_end … emitted after the final persistence settle" is now literally true (it described the intended order while the code published first); the runner header and `complete()` comments and the store routing comments now all describe the staged order (finalize → publish → release → ended).

Gates for this round (run on the fix commit):

| Command | Result | Notes |
|---|---|---|
| Repro scripts against `7ec4917` (public entries, `/tmp/m1a-round2/repro-g{1,2}.mjs`) | both gaps reproduced, exit 2 | G1: epoch 1→2 during a parked prepare + AbortError — all five corners (thrown/structured × cancel/no-cancel, rebind) classified `cancelled` instead of `session_changed`; G2: completed intent + a persistence-failing completion-edge cleanup → final `completed` + only `task_cleanup_failed` (want `persistence_error`). Rerun against this round's runner: all corners + G2 pass, exit 0 |
| `node tests/task-runner.test.mjs` | PASS | 99 checks (74 prior semantics preserved + 25 new) |
| `node tests/provider-session.test.mjs` | PASS | 14 checks |
| `node tests/conversation-routing.test.mjs` | PASS | 25 checks (23 prior + Case F) |
| `node tests/submit-presentation.test.mjs` | PASS | 22 checks |
| `npm test` | PASS | 43/43 suites |
| `npm run build` | PASS | `adoptEpoch` and `finalizeTask` present in `dist/assets/index-*.js` |
| `node tests/e2e-persistence.cjs` (built app, vite preview + CDP) | PASS | 26/26 checks |
| `node tests/e2e-ui.cjs` (built app, same preview) | PASS | presentation suite incl. busy-release/view-routing; no console errors |
| `node tests/e2e-approval.cjs` (built app, same preview) | PASS | approval lifecycle + focus/Escape probes |

Browser gates were run against one explicitly-owned preview server (port 4187) with `?e2e=1`, mirroring the e2e orchestrator's presentation group; each suite owns its Chrome process and profile as usual.

Gates for the review round (run on the fix commit):

| Command | Result | Notes |
|---|---|---|
| Repro against head `4840c19` | 12 expectation violations | F1×5 (early `ended`/release/gate), F2×1 (B running settled by a foreign terminal), F3×1 (same-stack submit admitted), F4×4 (structured persistence→cancelled, AbortError→error, epoch→cancelled, explicit session_changed→cancelled); rerun after the fix: all hold |
| `node tests/task-runner.test.mjs` | PASS | 74 checks (30 original semantics preserved through the new protocol + 44 new) |
| `node tests/conversation-routing.test.mjs` | PASS | 23 checks (18 original + Case E) |
| `node tests/submit-presentation.test.mjs` | PASS | 22 checks (15 original + Cases F/G) |
| `npm test` | PASS | 43/43 suites |
| `npm run build` | PASS | freshness verified (`task_cleanup_failed` in the bundle, `_taskEmit` in `dist/src/agent.js`) |
| `npm run test:e2e` | **PASS 16/16 suite entries, single sequential run, exit 0** | no readiness flake this round (unlike the landing round's `active-content`); runtime, active-content, presentation, responsive, persistence, wire, approval, image, grep, python-authority, capabilities, skill-instances, network, python-browser-authority, python-bootstrap-integrity, trusted-plugin-runtime all first-run PASS |

## 3. Gates

| Command | Result | Notes |
|---|---|---|
| `npm ci --no-audit --no-fund` | PASS | unchanged lockfile |
| `npm test` | PASS | **43/43** suites (41 baseline + task-runner + provider-session) |
| `npm run build` | PASS | bundle now includes the two harness modules via the store's imports |
| `npm run test:e2e` (single sequential run) | **15/16 suite entries** | `active-content` failed at first run — see §4 |
| `node tests/verify-active-content.cjs` (standalone) | PASS | 3/3 checks, exit 0 |
| `python tests/real-world-50/setup.py && verify.py` | not re-run | fixtures untouched by the M1a diff (docs + harness/store/agent.js + tests only); see §5 |

Relevant browser suites for this round all passed in the sequential run: presentation, responsive, **persistence** (reload/recovery through the new submit path), wire, **approval**, image (attachment preparation), **capabilities** and **skill-instances** (task-environment/skill mounts through `prepareTask`), **python-authority**, network, python-browser-authority, python-bootstrap-integrity, **trusted-plugin-runtime** (plugin payload preparation through the new path).

## 4. First-run failure, preserved and reproduced honestly

The single sequential e2e run reported `FAIL suite: active-content`. First-failure evidence (kept in the run log): `tests/verify-active-content.cjs:113` — `CDP browser endpoint unavailable: readiness timeout` from `waitForCdp` in `tests/helpers/chrome.cjs`; the suite's own three isolation checks never ran. Standalone re-run with identical inputs: **3/3 PASS, exit 0**.

What this proves and does not prove: the standalone re-run proves the suite and the product pass under standalone conditions; it does not identify why the in-sequence attempt failed at browser readiness. This is the same failure *class* observed (also unexplained) for different suites in the M0 round — see [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md) §3, which explicitly records that root causes for this class are candidate, not confirmed. No retry, timeout loosening, or assertion change was added. This round's M1a diff touches no network/relay/Chrome code path; the failure mode predates it (M0: `python-authority` + `network`; M1a: `active-content`), which is consistent with an environmental readiness race but remains unconfirmed.

## 5. Not executed / out of scope

- real-world-50 `setup.py`/`verify.py`: not re-run; the M1a diff does not touch the fixture pipeline (verified by diff scope: `src/harness/*`, `src/ui/store.js`, `src/agent.js`, `tests/{task-runner,provider-session,store-defaults}*`, docs). The M0 record remains the reference for those checks.
- Deployed-build (Cloudflare Pages) checks: out of scope for M1a (packaging work is M2/M3).
- REAL-WORLD-50 NET 32–37 manual tasks: unchanged policy (manual, real network).

## 6. M1b next step (precise scope)

1. Introduce the interpreter lifecycle handle behind `preparePythonRuntimeForEnvironment` + `AgentSession.onSessionReset` (both currently reaching the `PythonRuntime` global from the moved orchestration) so the harness task path no longer names the global.
2. Move the hardcoded `/home/locus/.skills` rules in `shMv`/`shRm` behind the `MutationPolicy` port (refusal text byte-identical; `shell`/`shell-compat` suites must stay green).
3. Acceptance: task setup/run/cancel/reset exercisable without the `PythonRuntime` global; `skill-instances`, `python-plugin-runtime`, `python-authority` browser suites unchanged; full unit + build green.
