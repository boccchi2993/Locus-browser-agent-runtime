# Locus TODO

Concrete implementation work. Architecture-level direction lives in the upstream
project docs (docs/ARCHITECTURE.md, docs/MODEL-PROTOCOL.md, ROADMAP.md — not
currently vendored in this branch).

## Done in V0.3 (this branch)

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

## Next (smallest valuable items first)

### Reliability leftovers

- [ ] Bound the workspace collection phase (huge directory traversal has no deadline yet).
- [ ] On-demand file bridging or incremental sync instead of full snapshot per python call.
- [ ] Empty-directory preservation and file↔directory type-change semantics in snapshot/diff.
- [ ] `lstat`-style handling for special entries in the Pyodide MEMFS walk.
- [ ] API base URL normalization hints (e.g. base already ending in `/v1` → avoid `/v1/v1/...`).

### AgentSession extraction (V0.3 remainder)

- [ ] Remove terminal/DOM access from the agent loop (`term.echo`, `document` in shell status).
- [ ] Emit provider-neutral runtime events (assistant_start / reasoning / tool_call / tool_result / error / done).
- [ ] Inject model adapter + workspace instead of reading `App`/`Model` globals.
- [ ] Run one complete agent loop in tests without DOM stubs.

### Model protocol remainder

- [ ] Native tool-call support per adapter (keep fenced-JSON as compatibility path).
- [ ] Provider-aware history trimming that preserves native tool-call pairing (current budget trim is text-based and provider-neutral).
- [ ] Tests for opaque-state replay and reasoning-summary presentation.

### Harder isolation (declared gap, see README security note)

- [ ] Evaluate isolated-origin execution (separate opaque origin iframe/worker + explicit RPC bridge) so Python compute loses direct network capability instead of merely declaring it.
- [ ] Telemetry coverage for Python-originated network once a controlled bridge exists.

## Deferred / explicitly not now

- Vue migration, plugin marketplace, MCP, JS runtime primitive, edit primitive (post AgentSession).
- Real cloud_bash provider, remote sandbox, browser automation, authenticated sessions.
- Full POSIX shell, full curl, domain allowlists (provider/site-agnostic by design).
