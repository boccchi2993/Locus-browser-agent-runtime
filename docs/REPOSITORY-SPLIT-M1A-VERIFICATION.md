# Repository split M1a — verification record

Status: M1a deliverable (task lifecycle + provider-session extraction, store rewiring, M0 contract corrections). Branch `refactor/repository-split-m1a`, stacked on `docs/repository-split-m0` (`57b3c5d`, PR #2, unmerged at the time of writing). Companion documents: [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md), [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md), [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md).

Environment: same host as the M0 baseline (Windows 10, Git Bash, Node v24.10.0, npm 11.6.1, local Chrome via CDP). Dependencies installed with `npm ci` from the unchanged lockfile; no dependency or product-build config changed in M1a.

## 1. What landed

| Piece | File | Notes |
|---|---|---|
| Harness task runner | `src/harness/task-runner.js` | ESM, no Vue/DOM/globals. `createTaskRunner({emit, prepare, sessionEpoch, onTaskEnd})` → `submit/activeTask/observeEvent/quiesceAndRun`. TaskHandle: id, read-only signal, idempotent cancel (no-op after end), `ended` promise, outcome getter |
| Harness provider sessions | `src/harness/provider-session.js` | Verbatim extraction of `ensureProviderSession` / `restoreSessionForConversation` / `makePersistenceContext` / `sessionCompatible` with every global replaced by an injected port |
| AgentSession controller seam | `src/agent.js` | `run(opts)` accepts `opts.controller` (the task-lifetime controller); standalone callers keep self-created controllers; one agent loop, no duplicate implementation |
| Store rewiring | `src/ui/store.js` | `submit()` = admission call; `prepareTask()` = product preparation returning ready/blocked/silent/failed with a pre-run-start predicate; `cancelTask`/`newTask` keep cancel-vs-session_changed semantics; `withStorageMutation` delegates to the runner gate; busy/binding release moved to id-guarded `onTaskEnd`; `pendingCancel`/`storageMutationTail`/`waitFor` deleted; `providerSessionsAdapter()` is the single lazy globals→ports block |

Deliberately NOT done (M1b/M2 scope): RuntimeHost/RuntimeSession instantiation, worker asset packaging, `~/.skills` mutation-policy port, module conversion of classic scripts, repository extraction. The product adapter still uses `PythonRuntime`/`vfs`/`PersistenceServiceInstance` globals inside `prepareTask`/adapter blocks — centralized and recorded in INVENTORY §2.14.

## 2. New behavior evidence (public entry, no Vue/store import)

`tests/task-runner.test.mjs` (30 checks) drives the runner through controlled async barriers:

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

Existing store-level suites keep their guarantees through the new path: `conversation-routing` (18/18 — tail events follow the bound conversation, including the settle-after-projection ordering), `submit-presentation` (15/15 — pre-run cancel/session-switch/persistence-failure intent preservation, one synthetic start, terminal semantics), `store-defaults` (loader updated to inline the new ESM modules).

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
