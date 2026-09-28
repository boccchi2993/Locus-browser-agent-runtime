# Repository split M0 — verification baseline

Status: M0 deliverable. Records the environment, exact commands, results, untested scope and findings for the audited baseline `d25f30ea75e54989393230cb6c7695359d4c0815`. Companion documents: [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md), [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md).

This is an audit/contract task: no product code was changed, no tests were added or weakened, and every result below was produced from a clean worktree of the pinned commit with dependencies installed from the lockfile.

## 1. Environment

| Item | Value |
|---|---|
| Host | Windows 10 (10.0.26200), Git Bash shell |
| Node | v24.10.0 |
| npm | 11.6.1 (dependency install via `npm ci`, lockfile-pinned) |
| Python (real-world-50 tooling only) | 3.12.10 |
| Browser | Local Chrome, launched headless by the suites via CDP (per-suite temp profiles, dynamic ports) |
| Dependencies | `vue@3.5.x` runtime; `vite@6`, `@vitejs/plugin-vue@5` dev only — no test-framework dependency, no network dependencies at install time beyond the npm registry |

## 2. Commands and results

All commands run at the worktree root for commit `d25f30e` on branch `docs/repository-split-m0`.

| Command | Result | Notes |
|---|---|---|
| `npm ci --no-audit --no-fund` | PASS | Lockfile install, exit 0 |
| `npm test` | PASS | 41/41 unit suites (`node tests/run-unit.cjs`), 0 failures |
| `npm run build` | PASS | Vite production build, 22 modules, `dist/` incl. `dist/src/*` runtime copies |
| `python tests/real-world-50/setup.py` | PASS | 43 files / 19 dirs / 40,992 bytes fixture built |
| `python tests/real-world-50/verify.py` | PASS | 12/12 checks |
| `npm run test:e2e` (full, one process) | **14/16 suite entries** | `python-authority` and `network` failed inside the sequential run — see §3 |
| `node tests/e2e-python-authority.cjs` (standalone, served app) | PASS | 56/56 checks, exit 0 |
| `node tests/e2e-network.cjs` (standalone, self-contained) | PASS | 60 checks PASS, 0 FAIL, exit 0 |

### 2.1 Browser-suite selection rationale

The full `npm run test:e2e` set was run because it is exactly the coverage the M0 audit needs to trust:

- **Task lifecycle / persistence**: `presentation`, `responsive`, `persistence` (real OPFS/IndexedDB reload recovery), `wire` (provider-native serialization through the real adapter path).
- **VFS / Python / plugin bootstrap**: `runtime` (file:// full-stack), `grep` (worker fail-closed), `python-authority`, `python-browser-authority` (browser-enforced egress denial with request-counter oracles), `python-bootstrap-integrity` (SHA-pinned acquisition, budgets, verified cache), `trusted-plugin-runtime` (offline wheel install before READY, 33/33).
- **Permissions**: `approval` (suspend/resume, deny vs cancel, stale decisions), plus the mutation-confirmation cases inside `skill-instances`.
- **Capability/skill boundary**: `capabilities`, `skill-instances` (identity protection, diff/TOCTOU, reload reuse).
- **Network authority**: `network` (dispatch-once, SSRF, approval gating, request counters), `active-content` (relay handler isolation).

No external model API, key, or paid endpoint is used by any suite: model calls go through in-page deterministic fixtures (`?e2e=1` hooks / `wire` transport queue), and network suites run local servers. The only genuine internet fetch in the whole run is the first Pyodide bootstrap download from the pinned CDN (jsDelivr), which is itself hash-verified by the code under test; later boots use the verified page-session cache.

## 3. Known flake encountered, and how it was resolved

The single-process full e2e run reported `FAIL suite: python-authority` and `FAIL suite: network` while the other 14 entries passed. Both suites pass when re-run with identical inputs:

- `python-authority` failed at CDP *readiness* (`waitForRuntimeCondition`, `tests/helpers/chrome.cjs` — phase `pyauth-app-boot`) — the page was loaded but the boot condition poll timed out after 7 prior suites had each spawned and torn down their own Chrome; this matches the load-related readiness flake documented in earlier closure audits. Standalone re-run (with a `vite preview` server on the documented `E2E_APP_URL` default): **56/56 PASS**. Note for reproduction: this suite requires a served app when run outside `npm run test:e2e`; running it without a server produces the same readiness failure and is not a product defect.
- `network` standalone re-run (the suite is self-contained: own dist rebuild, app+relay+target servers): **60 PASS / 0 FAIL, exit 0**.

Conclusion: no evidence of a product regression at this baseline; the failures are the known sequential-load flake class. M1+ migration gates that depend on these suites should keep the existing practice of re-running a failed suite standalone before treating it as a blocker.

## 4. Findings

### 4.1 Split-blocking couplings (target of M1/M2)

Recorded with evidence in [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) §3. The highest-priority items, in fix order:

1. Runtime worker sources live in Product page DOM (`#py-worker-src`, `#grep-worker-src`).
2. Harness prompt reads Runtime global (`shellSystemPromptSection`).
3. Runtime writes Product DOM (`PythonRuntime._setStatus` → `#sb-python`) plus a 1s status poll.
4. Product injects the VFS home skeleton via script-order global (`LOCUS_HOME_SKELETON`).
5. Shell `mv`/`rm` hardcode the `/home/locus/.skills` policy.
6. Chat identities (`conversationId`, `taskGeneration`) flow into `NetworkRuntime` policy context (informational today, ownership must settle before extraction).

### 4.2 Pre-existing defects / risks (not fixed in this round; no scope creep)

No new functional defect was found during the audit — the items below are layering risks that are correct today but will break or silently mis-carry during extraction if not sequenced:

- **D1 — presentation write inside Runtime** (`PythonRuntime._setStatus`, `src/shell.js`): harmless today (the element always exists), but it is the reason the status must also be polled (`src/main.js`). Becomes a real defect the moment Runtime runs outside the Locus page. Fix in M2a via `RuntimeEventSink.onInterpreterStatus`. Priority: medium (M2-blocking, not M1).
- **D2 — sequential-load e2e flake** (§3): environmental, recurring across audits. Suggested follow-up (out of M0 scope): per-suite readiness retry-once with backoff in the orchestrator, keeping the honest final FAIL if the retry also fails.
- **D3 — private cross-module access** (`ConversationHistoryWorkspace` → `service._byIndex`, `src/workspace.js`): works today, violates the future adapter rules; move with the Product persistence provider in M2a and expose a public query method.
- **D4 — silent fallbacks to the persistence global** (`capabilities.js:162`, `attachments.js:155`): untested for the undefined case; make the dependency constructor-required during M2b so a missing store fails loudly instead of producing a text-only runtime half-configured.
- **D5 — test-loading model is coupled to file order** (`eval(readFileSync(...))` in 41 suites): not a product defect, but the classic-script globals it exercises are the same seams the split removes; M2 must port the affected suites to the public entries where they assert independence (REPOSITORY-SPLIT M2 exit criteria).

### 4.3 Verified invariants this baseline protects

The semantics the split must not regress, each pinned by the suites listed in Inventory §2: task-bound immutable routing/authority (fork + generation guards), cancellation-not-rollback reporting, Python state isolation and read-only mount enforcement, browser-level Python egress denial with zero-request oracles, SHA-256 bootstrap integrity and offline wheel install, skill identity/confirmation/diff/TOCTOU, no cross-backend retry of side-effecting requests, provider-native replay and persistence failure honesty, and empty production extension catalogs.

## 5. Not executed / out of scope

- **REAL-WORLD-50 NET 32–37**: manual real-network tasks by design (require a human driving the UI against the live internet); only the automated fixture setup/verification ran (§2).
- **Deployed-build checks** (Cloudflare Pages `/fetch`/`/proxy` relays in production): out of scope for M0; the packaging implications for deployed builds are captured in Contracts §3.6 and REPOSITORY-SPLIT §8 ("Packaging" gate) for the M3/M4 gates.
- **No doc-only formal tests were added** for this round, per the M0 charter; the three documents are the deliverable.

## 6. M0 exit assessment

M0's exit criterion — "ownership and contract tests identify every supported cross-layer interaction" — is met to the extent of this round's charter: every supported cross-layer interaction observed in code is now inventoried with an owner and a target port (Inventory §2–§3), and the interface drafts (Contracts §3) cover the lifecycle, ownership and error questions the migration depends on. What remains open for M1 is listed in the final report of the task branch: implement the lifecycle/task-handle port, extract task assembly from `src/ui/store.js`, and move the skill-path policy behind `MutationPolicy`, with the M1 acceptance condition that task setup/run/cancel/reset work without Vue or a Locus page while the §2 gate set stays green.
