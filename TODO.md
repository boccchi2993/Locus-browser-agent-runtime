# Locus TODO

This file is for concrete implementation work.

Architecture-level decisions belong in docs/ARCHITECTURE.md and docs/MODEL-PROTOCOL.md. Milestones belong in ROADMAP.md.

## Immediate — V0.2.1

### Network consistency

- [ ] Add timeout to NetworkRuntime browser-direct fetch.
- [ ] Add browser-direct response-size cap.
- [ ] Avoid unbounded arrayBuffer() reads for large direct responses.
- [ ] Keep browser-direct and edge-relay timeout/error semantics aligned.
- [ ] Check workspace before starting curl -o downloads.
- [ ] Add regression tests for direct-fetch timeout.
- [ ] Add regression tests for direct-fetch response-size cap.
- [ ] Add regression test proving curl -o without a workspace performs no network request.

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

- [ ] Replace callModelText() with a structured callModel() response.
- [ ] Introduce a response envelope.
- [ ] Separate visible content from provider-native replay state.
- [ ] Preserve native assistant messages when exact replay is required.
- [ ] Preserve reasoning_content when a provider/model requires it.
- [ ] Preserve Anthropic-style thinking/redacted/opaque blocks when required.
- [ ] Do not expose opaque continuation state as user-visible prose.
- [ ] Do not invent reasoning for providers that do not return it.
- [ ] Keep provider-specific replay policy inside provider adapters.
- [ ] Preserve stop reason.
- [ ] Preserve usage metadata where available.
- [ ] Add tests for raw reasoning replay.
- [ ] Add tests for reasoning summary presentation.
- [ ] Add tests for opaque-state preservation.
- [ ] Add tests proving visible UI history is not used to reconstruct provider history.
- [ ] Reset/scope provider-native state when switching workspace/session.

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

## V0.4 — Core primitive completion

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

### Deterministic edit primitive

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

- [ ] Python primitive is isolated and reliable.
- [ ] JavaScript primitive is isolated and reliable.
- [ ] Edit/state mutation is deterministic.
- [ ] curl connectivity is bounded and reliable.
- [ ] Workspace authority is explicit.
- [ ] Agent loop is UI-independent.
- [ ] Model protocol preserves provider-native continuation semantics.
- [ ] Runtime event stream exists.
- [ ] A capability can be added without editing the agent loop.

## V0.5 — Extension layer

### Capability registry

- [ ] Define minimal capability descriptor.
- [ ] Register current core capabilities through the same conceptual interface where practical.
- [ ] Support dependency declaration.
- [ ] Support availability checks.
- [ ] Support provider/backend metadata.
- [ ] Avoid exposing every capability as a new model tool.

### Plugins

- [ ] Define minimal plugin manifest.
- [ ] Plugin can declare required core primitives.
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
- [ ] Local model runtime.

These may become future providers/plugins/community work. They are not prerequisites for freezing the Locus core architecture.
