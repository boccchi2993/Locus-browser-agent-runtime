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

## Deferred runtime reliability improvements

Not blocking AgentSession / provider architecture work.

- [ ] Bound the workspace collection phase (huge directory traversal has no deadline yet).
- [ ] On-demand file bridging or incremental sync instead of full snapshot per python call.
- [ ] Empty-directory preservation and file↔directory type-change semantics in snapshot/diff.
- [ ] `lstat`-style handling for special entries in the Pyodide MEMFS walk.
- [ ] API base URL normalization hints (e.g. base already ending in `/v1` → avoid `/v1/v1/...`).

## V0.3 — Agent loop / UI separation

### Runtime boundary

- [x] Introduce AgentSession or equivalent UI-independent runtime. (`src/agent.js` `AgentSession`)
- [x] Remove terminal object from agent-loop function signatures. (`runAgentTask(term, …)` → `session.run(input, { workspace })`)
- [x] Remove direct term.echo / render calls from runtime logic. (V0.3: terminal rendering in ui.js; V0.4: removed, Vue store consumes events)
- [x] Remove direct DOM dependencies from the agent loop.
- [x] Inject model adapter instead of reading presentation globals. (`modelClient` injection; `Model.model` is added by the presentation wiring)
- [x] Inject workspace/session state instead of reading App.workspace directly. (workspace bound per `run()` call)
- [x] Keep tool execution behind a runtime dependency boundary. (`toolExecutor` injection)
- [x] Make one complete agent loop runnable in tests without DOM/UI. (`tests/agent.test.cjs` runs the full loop in Node)

### Runtime events

A small provider-neutral event surface is implemented and consumed by the
presentation store in `src/ui/store.js`:

- [x] task_start
- [x] reasoning (full provider-visible reasoning; presentation truncation is a UI concern)
- [x] tool_call
- [x] tool_result (incl. backend/operation routing metadata)
- [x] assistant_text
- [x] warning (model_truncated / answer_truncated / task_cancelled / task_cancelled_committed / session_changed / iteration_limit)
- [x] error
- [x] task_end

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
- [x] Keep provider-specific replay policy inside provider adapters. (`src/model-adapters.js`: `OpenAIAdapter` / `AnthropicAdapter` behind `getProviderAdapter()`; model.js keeps only transport/fallback orchestration)
- [x] Explicit API dialect override (`auto`/`openai`/`anthropic`) so arbitrary hostnames/gateways can pick a protocol; provider identity stays decoupled from API dialect.
- [x] Preserve stop reason.
- [x] Preserve usage metadata where available.
- [x] Add tests for raw reasoning replay (round-trip: parse → rawMessage → next request body, `tests/model-adapters.test.cjs` O6–O8 / A6–A7 / I3 / I5).
- [ ] Add tests for reasoning summary presentation.
- [x] Add tests for opaque-state preservation (redacted_thinking / unknown blocks survive parse→replay byte-identically and never render as visible reasoning).
- [x] Add tests proving visible UI history is not used to reconstruct provider history. (events are never serialized; provider history is session-owned, `tests/agent.test.cjs` S2/S11)
- [x] Reset/scope provider-native state when switching workspace/session.

### Network virtualization (declared gap, see README security note)

- [ ] Route Python-originated HTTP through the same Locus network capability used by shell networking, using an internal bridge where browser constraints require it.
- [ ] Preserve routing, bounds, cancellation and telemetry when Python HTTP moves onto the shared network path.

## V0.4 — Vue presentation layer

Prerequisite: AgentSession must already run without UI dependencies.

### Project structure

- [x] Introduce Vue 3 + Vite. (`package.json`, `vite.config.js`, `src/main.js`, `src/App.vue`)
- [x] Move current presentation into Vue components/store. (`src/components/`, `src/ui/store.js`)
- [x] Keep runtime modules framework-independent. (runtime `src/*.js` are classic scripts; no Vue imports — grep-verified)
- [x] Remove jQuery Terminal as an architectural dependency. (`src/ui.js` deleted; jQuery/jQuery-Terminal CDN removed from index.html)
- [x] Decide whether a terminal-style component remains as a visual surface. (No terminal surface; a reserved, clearly marked Terminal drawer is the future entry point — not wired to any shell semantics)
- [x] Pure event→timeline projector, framework-independent and Node-tested. (`src/ui/projector.js`, `tests/presentation.test.cjs`)

### Main interface

- [x] Conversation timeline.
- [x] User message cards.
- [x] Assistant final output (markdown-lite, escape-first).
- [x] Collapsible reasoning panels (full content preserved, `summary` labeled "Reasoning summary").
- [x] Tool-call panels (collapsible; long inputs folded).
- [x] Tool-result panels (attached to their call; long outputs folded).
- [x] Backend badge: browser / browser-direct / edge-relay / cloud (only from event metadata).
- [x] Workspace selector/status (composer chip + context rail; mount = real session boundary).
- [x] Model/provider configuration (Settings panel: key, endpoint, model, dialect, proxy).
- [x] Execution/debug telemetry panel (context rail Telemetry section).
- [x] Clear error presentation.
- [x] Busy/cancel state where supported (composer Cancel + Escape; AgentSession remains the real guard).
- [x] Conversation history sidebar (New task / search / recents; page-lifetime only, no durable persistence).
- [x] Composer `+` context menu: Upload files (seam, marked not-wired) / Mount folder (working) / Open terminal (reserved drawer).
- [ ] Durable conversation persistence across reloads (recents are page-lifetime by design for now).
- [ ] Attachment runtime pipeline (upload UI seam exists; files are never sent to the agent yet).
- [ ] Direct user terminal over the shared workspace authority (drawer reserved; no shell semantics added).

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
- [x] Agent loop is UI-independent.
- [x] Model protocol preserves provider-native continuation semantics.
- [x] Runtime event stream exists.
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
- [ ] Vue migration, MCP, JS userland runtime, edit capability (pre-AgentSession).
- [ ] Domain allowlists (provider/site-agnostic by design).

These may become future providers/plugins/community work. They are not prerequisites for freezing the Locus core architecture.
