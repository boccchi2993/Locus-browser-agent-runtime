# Repository split M2b — verification record

Status: M2b deliverable (Harness independentization). Branch `refactor/repository-split-m2b`, stacked on `refactor/repository-split-m2a` @ `ce471b0066f698f14fcf780d3054def1886714d7` (PR #5 head, verified OPEN and unchanged via the GitHub API at branch creation; PRs #2 `docs/repository-split-m0` @ `57b3c5d`, #3 M1a @ `0b56922`, #4 M1b @ `83fdfbb` re-verified OPEN the same way — none merged; the stack is #2 → #3 → #4 → #5 → this branch's PR, base `refactor/repository-split-m2a`). Companion documents: [REPOSITORY-SPLIT-M2B-DESIGN.md](REPOSITORY-SPLIT-M2B-DESIGN.md) (symbol-level design, written before implementation, deviations recorded in-commit), [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) (§3.2/§3.7/§3.8/§3.9 M2b landed notes), [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) (couplings #8/#9/#12 resolved, extensions split, §4 step 4), [REPOSITORY-SPLIT.md](REPOSITORY-SPLIT.md) (M2 status).

Environment: Windows 10, Git Bash, Node v24.10.0, local headless Chrome via CDP (the e2e orchestrator's own launch); worktree `Locus-repository-split-m2b` (fresh, `node_modules` junction to the main install — unchanged lockfile). Branch base `ce471b0`; this record covers commits `d101161..HEAD`.

## 1. What landed (commit by commit)

| Commit | Piece |
|---|---|
| `d101161` | M2b symbol-level design record (pre-implementation; contract deviations + reasons) |
| `ff0b2fc` | **ToolPort + snapshots + description port**: `AgentSession` requires `toolPort` (the `toolExecutor` dep and the `AGENT_TOOL_DEFINITIONS` global read deleted); one validated, frozen per-task definition snapshot feeding prompt, `request.tools`, `normalizeNativeCall` (explicit names), the text-fallback name check (unknown → zero-execution failed result inside the Harness) and unknown-tool errors; assembly errors (`tool_registry_invalid`) fail before any model request; `buildSystemPrompt` rebuilt product-agnostic (tool list by traversal, description text via the port, Locus rules via `environmentNotes` — `src/ui/product-prompt.js`); `RuntimeSession.describeCommands()`; the store's `productToolPort` over the unchanged `executeTool`; `historyRequestBytes` async with one shared prompt input per task; suites converted to the port shape |
| `8582fcc` | **Harness entry + ownership split**: `src/harness/index.js` (+ self-assembly `src/harness/core.js`) over the declared `__LOCUS_HARNESS_CORE__` table; per-file explicit globalThis publishes; `createModelClient` (captured config/transport/`relayEligible`) with legacy `Model`/`callModel`/`verifyConnection` wrappers delegating to it; `capabilities.js` explicit dependencies (persistence REQUIRED; probe takes explicit `callModelFn`/`model`); `src/extension-composition.js` vs `src/extensions.js` ownership split (narrow instance-storage port; pure mount specs + `productTaskVfsMounts`); the telemetry sink (explicit contained `opts.telemetry`; `renderDebugPanel` deleted); the Product rewired through the entry (`createAgentSession`/`createApprovalController`/`createModelClient`/image gate/`historyBudgetBytes`); Node store suites seed the declared table with their fakes |
| `4be9863` | **Independence gates H1–H11**: `tests/harness-standalone.test.mjs` (52 checks), `tests/harness-boundary.test.cjs` (12), `tests/harness-prompt-parity.test.mjs` (17); registered in `tests/run-unit.cjs` |
| `d0d9b57` | **e2e round-1 findings fixed** (see §4): the product ToolPort context read, the probe's transport opts, the synthetic trusted-plugin page serving the split composition file |
| (this commit) | Docs: CONTRACTS §3.2/§3.7/§3.8/§3.9 landed notes, INVENTORY couplings #8/#9/#12 + §2.5/§2.6/§2.9/§2.13 + §4 step 4, TODO, REPOSITORY-SPLIT M2 status, this record |

## 2. Gates

| Command | Result | Notes |
|---|---|---|
| `npm test` | **PASS 53/53 suites, exit 0** (50 + `harness-standalone` + `harness-boundary` + `harness-prompt-parity`) | every M1/M2a suite kept, none weakened; the 8 suites constructing real sessions converted to the ToolPort shape with identical assertions; store suites seed the declared table (see §3) |
| `npm run build` | PASS | chunk shape verified IDENTICAL to the accepted M2a baseline: the runtime entry code shares the worker-assets chunk; the harness self-assembly chunk is tree-shaken from the product bundle (the product page uses the registry path); `dist/src/extension-composition.js` copied by the build; the boundary gate's dist scans pass |
| `npm run test:e2e` (round 1) | 12/17 — **first failures preserved** (`tmp-e2e-run1.log`, not committed) | FAIL: approval, image, capabilities, skill-instances, trusted-plugin-runtime — all root-caused, see §4 |
| `npm run test:e2e` (round 2, final) | **PASS 17/17 suites, exit 0** | runtime, active-content, runtime-host, presentation, responsive, persistence, wire, approval, image, grep, python-authority, capabilities, skill-instances, network, python-browser-authority, python-bootstrap-integrity, trusted-plugin-runtime |
| Interactive browser pass | PASS — see §5 | built product page via `vite preview`, real clicks/evals, screenshots retained |

Operational note (honest record): the first `npm test` invocation appeared to hang for ~20 minutes with no output. Root cause was the INVOCATION, not the code — the output pipe chain (`npm test | tee | grep | tail`) deadlocked on Windows Git Bash; the identical gate with plain file redirection (`node tests/run-unit.cjs > log`) completed all 53 suites in ~90 s and reproduces deterministically (it had also silently affected previous sessions' gates — stale `run-unit` processes from other worktrees were still parked on finished suites). No suite timeout or retry was touched.

## 3. What each original global dependency became

| Original global read (file) | M2b replacement |
|---|---|
| `AGENT_TOOL_DEFINITIONS` in `agentToolDefinitions()`/`agentToolNames()`/`normalizeNativeCall`/`buildSystemPrompt` (agent.js) | **Deleted.** The injected `toolPort` + the per-task frozen snapshot (`createToolSnapshot`); `normalizeNativeCall(call, index, toolNames)` takes the explicit list |
| `shellSystemPromptSection` typeof-read (agent.js) | **Deleted.** The injected `descriptionPort` (Product adapter `productDescriptionPort` over the Runtime's public `RuntimeSession.describeCommands()`); absent → no capability text |
| hardwired bash/cloud_bash prompt lines, `defs[0]`/`defs[1]` (agent.js) | Tool list from the snapshot; Locus behavior rules via the injected `environmentNotes` (`locusEnvironmentNotes`, `src/ui/product-prompt.js`); the fenced example names the first SNAPSHOT tool |
| `Model`/`Model.transport`/`Model.proxy`/`window.location` reads mid-request (model.js) | `createModelClient({ config, transport, relayEligible })` — captured & frozen at client creation; the mid-request reads are gone (the old `tryFetch` re-read `Model.proxy` per attempt — fixed by construction). The ONE remaining guarded `window.location` read is the declared legacy-compat helper (`legacyModelClient`, product-side wrappers only), pinned by boundary gate B3 and deleted at M3 |
| `callModel` global fallback (capabilities.js probe) | Explicit `opts.callModelFn` (the store passes the raw product client); absent → the existing `no-model-client` unknown verdict |
| `Model.model` global fallback (capabilities.js probe) | Explicit `opts.model` (image-probe suite V2d re-pinned to the injected form) |
| `PersistenceServiceInstance` typeof-fallback (capabilities.js registry) | REQUIRED constructor dependency (loud error); the store injects the service |
| `Telemetry` in the executor (tools.js) | Explicit optional `opts.telemetry` sink with contained delivery (throw/rejection-proof); the page `Telemetry` stays the Product default |
| `renderDebugPanel` (telemetry.js) | **Deleted** (no core reaches into Product UI) |
| `HISTORY_BUDGET_BYTES` typeof-read (store.js) | `historyBudgetBytes()` from the Harness entry (inventory coupling #9 closed) |
| `new AgentSession` / `new ApprovalController` / `callModel` / `verifyConnection` classic globals (store.js) | `createAgentSession` / `createApprovalController` / `createModelClient(...)` / `client.verify()` through `src/harness/index.js` |
| `new ModelCapabilityRegistry` (store.js) | `createModelCapabilityRegistry({ persistence })` through the entry |
| `manager.taskVfsMounts(env)` constructing `StaticFileWorkspace` (extensions.js) | `manager.taskVfsMountSpecs(env)` (pure data) + `productTaskVfsMounts(manager, env)` (Product adapter, extensions.js) |
| `instanceof SkillInstanceStorage` (CapabilityManager) | The narrow port the manager calls: `{ readBytes, writeBytes, removeDir, stat }` (loud failure when incomplete) |

Retained intentionally (compat entries, callers, removal conditions):

- `Model` + `callModel`/`callModelText`/`verifyConnection` (model.js legacy wrappers) — callers: the eval-based model/native-tools suites and any deployment still holding the old surface; they capture config at call start and delegate to the SAME factory. Removed at M3 when the Product passes config objects directly and the suites import the factory.
- The per-file `globalThis` publishes + the frozen `__LOCUS_HARNESS_CORE__` table (agent.js) — the ONE declared seam (mirrors the Runtime's `__LOCUS_RUNTIME_CORE__`); product pages get it automatically from classic script execution, Node store suites seed it with fakes (tests-as-hosts), standalone hosts get it via `ensureHarnessCore()` self-assembly. Deleted at M3 when the harness files become the package.
- Classic-script packaging of the harness core (unchanged M2a decision) — converts at M3 with the eval-based suite model.
- `executeTool` itself (tools.js) — still the Product execution adapter; the `?e2e=1` `hooks.toolExecutor` seam and the runtime suites' direct callers keep working through it. It is Product code; its fate is M3's Product-repository extraction.
- `capabilities.js` stays in the harness entry closure (image gating is Harness perception); `attachments.js` (AttachmentStore + content-part constructors) stays Product — its `PersistenceServiceInstance` fallback is Product-internal wiring, not a core boundary.

## 4. First-run failures: root-caused and fixed (no assertion loosening)

**Unit round** — two failures, both test-side:
- `agent.test` S1h/S6/S8: the suite's sessions lacked the product `environmentNotes` (S1h asserted the workspace line) and `historyRequestBytes` is now async (the description capture may await). Fixed in the suite: the notes module wired into `newSession`, the estimates awaited; S18 rewritten to compose via `product-prompt.js` (its content assertions unchanged), with the full product parity moved to the dedicated suite.
- `image-probe` V2d pinned the OLD global fallback (`probe uses Model.model`); re-pinned to the contract: the probe uses the EXPLICIT `model` opt. `capability-composition`/`agent-image` awaited the async estimate.

**e2e round 1 (12/17, failures preserved verbatim in `tmp-e2e-run1.log`)** — three root causes, all real product-wiring defects caught by the honest boundary:
- **approval (A30–A39 + all five viewport variants) / skill-instances (si-card timeout) / capabilities**: the store's `productToolPort.execute` read `c.signal`/`c.filesystem`, but the ToolPort contract carries them in `c.context` — so the task signal never reached the tool executor (cancel paths dead: `busy=true`, side effects ran after cancel) and every bash executed on the shell's fresh-machine fallback (no skills tree → no confirmation card). Fix: read `c.context` (one page of code). capabilities' `TypeError: terminated` was downstream of the same hung path and disappeared with it.
- **image (I-E18/E19/E22)**: the raw product model client — the probe's `callModelFn` — omitted the `transport`/`relayEligible` opts, so the visual probe hit the REAL network (`lastProbeFailure: 'network'`) instead of the suite's `Model.transport` fake. Fix: `productModelTransportOpts()` wired in.
- **trusted-plugin (E3b/R2b/U2i)**: the synthetic test page now loads the SPLIT pair; its server served only `extensions.js`, so the fetch oracle recorded `/extension-composition.js` as an unauthorized request. Fix: serve + load the composition file (page order preserved: composition → extensions).

**e2e round 2: 17/17, exit 0.**

## 5. Real-browser verification (interactive, beyond the deterministic suites)

`vite preview` (built dist, `--host 127.0.0.1`), ZCode in-app browser, real clicks + page evals on `/?e2e=1` (fake model hooks only — no real keys, no paid APIs). Screenshot retained in the session artifacts:

- **Cold load**: app mounted, runtime session resolved through the public entry, `Python: cold` (Context rail), 1 conversation, zero console errors.
- **Complete tool task** (composer → fake model → REAL bash): the tool card shows `echo m2b-interactive > from-agent.txt && cat from-agent.txt` with the `browser`/`filesystem` attribution and the read-back output `m2b-interactive`; the final assistant answer projected; a direct `session.toolPort.execute` re-check confirmed the file in the VFS. Timeline: `user → tool → assistant`.
- **Cancel**: a task parked on a never-resolving model reply, cancelled via the REAL composer button → `task_cancelled` warning projected, `busy=false`, session task cleared, conversation status `cancelled` (visible in the sidebar as `cancelled`).
- **Approval**: `requestTestPermission` raised the REAL ApprovalCard (`Approval required … Deny/Allow`); clicking **Deny** cleared `pendingApproval` and closed the card.
- **Conversation switch**: New task created a fresh live conversation; the archived conversation stayed viewable with its full timeline intact.
- **Telemetry**: the Context rail's Telemetry panel holds the execution records (bash, `browser` backend, success/failure as executed) — the product sink through the new ToolPort.
- **Image capability**: the registry status read through the explicit-dependency path (`supported`, source `builtin` — the default deepseek-flash seed).
- **Persistence recovery**: reload → conversations restored from IndexedDB (`storageStatus.mode: indexeddb`), the tool turn and the cancelled turn both present (`user,tool,assistant,user,warning`), runtime session re-resolved, `Python: cold`, zero page errors.

Not exercised interactively (covered by the deterministic gates instead): the standalone harness host in a BROWSER (H1 runs in Node; the entry's import-time safety and self-assembly are proven there and by the runtime-host analogue), plugin enable → interpreter rebuild (trusted-plugin e2e drives real wheel payloads through `prepare` on the production chain), model wire protocol against a live relay (the wire e2e covers the production path with a deterministic transport).

## 6. Independence gates H1–H11 (brief §十二 mapping)

- **H1** (`harness-standalone` H1): the entry imports with `window`/`document`/`__LOCUS_RUNTIME_CORE__` all undefined; `ensureHarnessCore()` self-assembles the same sources as ES modules; a complete fake-model/fake-ToolPort task runs on `createAgentSession`.
- **H2** (H2 block): a single `lookup` tool — prompt names only `lookup` with zero bash/cloud_bash/python/curl/mnt claims and no shell text; `request.tools` is exactly the snapshot; native AND text-fallback unknown tools fail with zero execution and an available-tools list of `lookup`; the task continues so the model can correct.
- **H3**: native call → untrusted-framed result → final answer with paired replay history; prose-wrapped fence is plain text; pure fence executes once; native + fence executes the native calls only.
- **H4**: two sessions — distinct tool registries (A rejects B's tool name), parked-cancel vs completion independent, histories and persistence frames never cross.
- **H5**: mid-task `definitions()` mutation (push + description rewrite) leaves the running task's prompt AND `request.tools` frozen; the next task reads the new definitions.
- **H6**: no description port → no fabricated claims; two sessions with different ports carry only their own description; budget estimates (`historyRequestBytes`) track their own text and never cross; the budget constant is reachable via the entry.
- **H7**: carried — the unchanged task-runner (99 checks), provider-session, submit-presentation, conversation-routing, store-python-lifecycle, provider-replay-persistence, persistence and e2e-persistence suites all green; no assertion touched.
- **H8** (`harness-prompt-parity` H8 block): a throwing sink and a rejected-promise sink both leave the failed tool result intact, exactly one record per execution, no unhandled rejections (process-level listener), missing sink is a no-op; record shape unchanged.
- **H9** (`harness-standalone` H9 block): real `getProviderAdapter` + fake transports — OpenAI/Anthropic endpoint paths, headers, tool serialization, Anthropic block replay + neutral tool_result mapping, explicit-rejection single downgrade, 500 never re-sends, 401 authoritative, 404 → /v1 fallback once, and captured-config isolation (two clients over one mutated source object).
- **H10** (`harness-boundary` B1–B6): the entry's transitive ESM import closure stays inside the harness-owned set, covers the whole core and excludes `tools.js`; structural scans find no Runtime/Product/DOM/telemetry/worker-asset references in the closure (the one declared exception: model.js's guarded legacy-compat `window.location`, pinned to its exact form and count of 2); probe deps explicit; the declared table is the only registry seam — paired with H1's real execution.
- **H11**: the store suites + the FULL browser e2e drive the product task path through the entry (§4/§5); prompt parity proven against the real builder + real product notes + real runtime description (P1–P5).

**M2b 完成；M2c 集成兼容性门与 M3 仓库提取尚未完成。**

## 7. Unverified scope this round (honest boundary)

- The standalone harness entry was proven in Node (H1/H4/H9), not as a BROWSER-built standalone page (no `dist/tests/harness-host.html` analogue was added — the runtime's host page remains the browser-side host evidence; a packaged harness host page is straightforward follow-up work if a browser harness host is wanted before M3).
- No real model/relay was contacted anywhere (fakes and deterministic transports only); relay fallback (`/proxy`) behavior is carried by the unchanged implementation + the proxy/fetch suites, not re-verified end-to-end this round.
- The replay validators remain in `persistence.js` (Product file) behind the landed port — their physical relocation, like all file extraction, is M3.
- Python-related behavior is carried by this round's full e2e (python-authority, python-browser-authority, python-bootstrap-integrity, trusted-plugin-runtime all green); no NEW python-specific gates were added — M2b touched no worker/bootstrap code.
