# Locus TODO

This file is for concrete implementation work.

Architecture-level decisions belong in docs/ARCHITECTURE.md and docs/MODEL-PROTOCOL.md. Milestones belong in ROADMAP.md.

## Done on fix/v0.3-reliability

Two audit rounds (baselines da94d1f and 40a22d2) are complete; checked items
below are reflected in the roadmap sections.

### Round 1 (V0.3, commit 40a22d2)

- [x] Real-directory stat options + exists() fault propagation (F01)
- [x] Write-back failure stops deletions; staged commit states reported honestly (F04)
- [x] External-edit conflict detection on write/delete (F11)
- [x] Skipped snapshot paths recorded and protected from overwrite (F10)
- [x] Workspace switch = real session boundary (cancel task, generation, Python rebuild) (F02/F03)
- [x] End-to-end cancellation (model → tools → python → write-back) (F07)
- [x] Model envelope + error taxonomy; relay authoritative errors preserved (F08/F09)
- [x] Network deadlines/caps/anonymity; no CORS misclassification (F07/F13)
- [x] Python stdout/stderr/output caps enforced in-worker (F18)
- [x] Pyodide init-failure recovery (F14)
- [x] Quote-aware tokenizer; unsupported shell syntax fails loudly (F15)
- [x] Relay null-body statuses, stream-error mapping, /proxy inbound limits, active-content isolation (F12/F16/F05)
- [x] Session reset command + history budget (F17)

### Round 2 (V0.3.1)

- [x] Output-limit overflow returns structured `uncollectedFiles`; incomplete change sets block deletions (rename no longer loses files)
- [x] Network deadline/cancel covers headers AND full body (direct, relay, relay error JSON); every read races the abort signal
- [x] Cancel reachable while busy: status-bar button + Escape, verified through real UI events in headless Chrome
- [x] Cancellation re-checked after every async pre-check (conflict detect, delete validation, echo/curl write-back, workspace collection)
- [x] History transport budget in UTF-8 bytes (incl. reasoning/native fields); whole-task trimming via internal `_taskStart` markers; oversized single task fails loudly
- [x] Model body-read failures after headers classified as BodyReadError (no relay fallback, no double-billed inference)
- [x] verify-active-content serves the real functions/fetch.js handler response

### Round 3 (V0.3.2)

- [x] Cancel vs session switch distinguished in the agent loop: a current-session cancel after a completed tool call shows the tool's real commit report (written/deleted/not-persisted), records it in history and stops the model loop — cancellation is never presented as a rollback; a session switch still discards late results without leaking them
- [x] Stream cleanup (reader.cancel()) on timeout/cancel/size-cap exits is best-effort and never awaited in network.js and model.js — a hanging or rejecting cancel() can no longer block the caller or cause unhandled rejections; error classification preserved
- [x] relayTimeoutMs is a real NetworkRuntime.fetch option, plumbed fetch → _relay; N23 now proves the passed deadline is actually used (elapsed-time assertion) and that the 45s default is retained

## Completed — V0.2.1

### Network consistency

- [x] Add timeout to NetworkRuntime browser-direct fetch.
- [x] Add browser-direct response-size cap.
- [x] Avoid unbounded arrayBuffer() reads for large direct responses.
- [x] Keep browser-direct and edge-relay timeout/error semantics aligned.
- [x] Check workspace before starting curl -o downloads.
- [x] Add regression tests for direct-fetch timeout.
- [x] Add regression tests for direct-fetch response-size cap.
- [x] Add regression test proving curl -o without a workspace performs no network request.

## V0.3.x — Reliability leftovers (this branch)

- [ ] Bound the workspace collection phase (huge directory traversal has no deadline yet).
- [ ] On-demand file bridging or incremental sync instead of full snapshot per python call.
- [ ] Empty-directory preservation and file↔directory type-change semantics in snapshot/diff.
- [ ] `lstat`-style handling for special entries in the Pyodide MEMFS walk.
- [ ] API base URL normalization hints (e.g. base already ending in `/v1` → avoid `/v1/v1/...`).

## V0.3 — Agent loop / UI separation

### Runtime boundary

- [ ] Introduce AgentSession or equivalent UI-independent runtime.
- [ ] Remove terminal object from agent-loop function signatures.
- [ ] Remove direct term.echo / render calls from runtime logic.
- [ ] Remove direct DOM dependencies from the agent loop.
- [ ] Inject model adapter instead of reading presentation globals.
- [ ] Inject workspace/session state instead of reading App.workspace directly.
- [ ] Keep tool execution behind a runtime dependency boundary.
- [ ] Make one complete agent loop runnable in tests without DOM/UI.

### Runtime events

Define a small provider-neutral event surface.

Candidate events:

- [ ] assistant_start
- [ ] reasoning
- [ ] tool_call
- [ ] tool_result
- [ ] assistant_text
- [ ] routing/backend metadata where useful
- [ ] error
- [ ] done

Do not over-design the event schema before the first real consumer exists.

### Model protocol

- [x] Replace callModelText() with a structured callModel() response.
- [x] Introduce a response envelope.
- [x] Separate visible content from provider-native replay state.
- [x] Preserve native assistant messages when exact replay is required.
- [x] Preserve reasoning_content when a provider/model requires it.
- [x] Preserve Anthropic-style thinking/redacted/opaque blocks when required.
- [x] Do not expose opaque continuation state as user-visible prose.
- [x] Do not invent reasoning for providers that do not return it.
- [ ] Keep provider-specific replay policy inside provider adapters (currently per-dialect parsers in one model.js; no separate adapter modules yet).
- [x] Preserve stop reason.
- [x] Preserve usage metadata where available.
- [ ] Add tests for raw reasoning replay (preservation is tested; full replay round-trip is not).
- [ ] Add tests for reasoning summary presentation.
- [ ] Add tests for opaque-state preservation.
- [ ] Add tests proving visible UI history is not used to reconstruct provider history.
- [x] Reset/scope provider-native state when switching workspace/session.

### Network virtualization (declared gap, see README security note)

- [ ] Route Python-originated HTTP through the same Locus network capability used by shell networking, using an internal bridge where browser constraints require it.
- [ ] Preserve routing, bounds, cancellation and telemetry when Python HTTP moves onto the shared network path.

## V0.4 — Vue presentation layer

Prerequisite: AgentSession must already run without UI dependencies.

### Project structure

- [ ] Introduce Vue 3 + Vite.
- [ ] Move current presentation into Vue components/store.
- [ ] Keep runtime modules framework-independent.
- [ ] Remove jQuery Terminal as an architectural dependency.
- [ ] Decide whether a terminal-style component remains as a visual surface.

### Main interface

- [ ] Conversation timeline.
- [ ] User message cards.
- [ ] Assistant final output.
- [ ] Collapsible reasoning panels.
- [ ] Tool-call panels.
- [ ] Tool-result panels.
- [ ] Backend badge: browser / browser-direct / edge-relay / cloud.
- [ ] Workspace selector/status.
- [ ] Model/provider configuration.
- [ ] Execution/debug telemetry panel.
- [ ] Clear error presentation.
- [ ] Busy/cancel state where supported.

### UI rule

The Vue layer consumes runtime events.

Do not move provider serialization, tool semantics, execution routing, or agent-loop decisions into Vue stores/components.

## V0.4 — Runtime substrate completion

### JavaScript runtime

- [ ] Add isolated JavaScript Worker runtime.
- [ ] Never eval model-generated JS in the main UI/application context.
- [ ] No DOM access from model-generated JS.
- [ ] No access to API keys/sessionStorage/application globals.
- [ ] Define timeout.
- [ ] Terminate/recover Worker after timeout.
- [ ] Define input/output byte limits.
- [ ] Add heredoc-style js command if useful.
- [ ] Add regression tests for isolation.
- [ ] Add regression tests for timeout/recovery.
- [ ] Add regression tests proving application globals are inaccessible.

### Deterministic edit capability

- [ ] Define minimal semantic edit operations.
- [ ] Exact read.
- [ ] Exact write.
- [ ] Exact replace.
- [ ] Fail when old text is absent.
- [ ] Fail when old text is ambiguous unless explicitly allowed.
- [ ] Insert operation if justified.
- [ ] Preserve workspace path confinement.
- [ ] Record edits in telemetry.
- [ ] Test model reliability with edit as shell command.
- [ ] Test model reliability with edit as structured tool.
- [ ] Choose the smaller/reliable model-facing interface based on evidence.

## Core freeze checklist

Do not declare core frozen until:

- [ ] Execution substrate is reliable for the supported userland runtimes.
- [ ] Filesystem/state substrate is reliable and deterministic.
- [ ] Network is a common runtime capability rather than a curl-only special case.
- [ ] Python HTTP access can reuse the controlled Locus network path for normal lightweight workflows.
- [ ] JavaScript userland runtime is isolated and reliable.
- [ ] Edit/state mutation is deterministic.
- [x] Current curl connectivity is bounded and reliable.
- [x] Workspace authority is explicit.
- [ ] Agent loop is UI-independent.
- [x] Model protocol preserves provider-native continuation semantics.
- [ ] Runtime event stream exists.
- [ ] A capability can be added without editing the agent loop.

## V0.5 — Extension layer

### Capability registry

- [ ] Define minimal capability descriptor around execution / filesystem / network plus higher-level providers.
- [ ] Register current runtime capabilities through the same conceptual interface where practical.
- [ ] Support dependency declaration.
- [ ] Support availability checks.
- [ ] Support provider/backend metadata.
- [ ] Avoid exposing every capability as a new model tool.

### Plugins

- [ ] Define minimal plugin manifest.
- [ ] Plugin can declare required runtime capabilities.
- [ ] Plugin can provide Python packages.
- [ ] Plugin can provide JavaScript/WASM packages.
- [ ] Plugin install/load failure is isolated and visible.
- [ ] Build one boring reference plugin before designing a marketplace.
- [ ] Suggested reference: openpyxl or another small package-backed capability.

### Skills

- [ ] Define skill discovery/loading format.
- [ ] Skill can declare capability/plugin dependencies.
- [ ] Skill grants no new authority.
- [ ] Build one reference workflow skill.
- [ ] Keep skill text out of core system prompt unless selected/relevant.

### MCP

- [ ] Define MCP capability bridge.
- [ ] Keep credentials outside ordinary curl/plugin semantics.
- [ ] Surface MCP tools through explicit authority boundary.
- [ ] Preserve auditability of external actions.
- [ ] Build one reference MCP integration only after the capability registry is stable.

## Deferred / explicitly not now

- [ ] Real cloud_bash provider.
- [ ] Remote Docker sandbox.
- [ ] Browser automation.
- [ ] Authenticated website sessions.
- [ ] LibreOffice integration.
- [ ] Native ffmpeg integration.
- [ ] Compiler-specific core tools.
- [ ] Plugin marketplace.
- [ ] Full POSIX shell.
- [ ] Full curl implementation.
- [ ] RAG as a core primitive (local retrieval should compose Plugin + Skill; durable/external retrieval should normally be MCP).
- [ ] Local model runtime.
- [ ] Vue migration, MCP, JS runtime primitive, edit primitive (pre-AgentSession).
- [ ] Domain allowlists (provider/site-agnostic by design).

These may become future providers/plugins/community work. They are not prerequisites for freezing the Locus core architecture.
