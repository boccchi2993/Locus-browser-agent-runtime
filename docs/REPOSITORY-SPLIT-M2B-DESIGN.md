# Repository split M2b — Harness independence: symbol-level design

Status: M2b design record (written before implementation). Base: `refactor/repository-split-m2a` @ `ce471b0066f698f14fcf780d3054def1886714d7` (PR #5 head, verified OPEN and unchanged at branch creation; PRs #2 @ `57b3c5d`, #3 @ `0b56922`, #4 @ `83fdfbb` also re-verified OPEN — none merged). Contract basis: [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) §3.2/§3.7/§3.8/§3.9, inventory [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) §3 item 8/9/12 + §4 step 4.

M2b scope: Harness port injection — the §3.2 ToolPort split with task-level definition snapshots, the §3.7 description port, the Harness public module entry (`src/harness/index.js`), the model client/config ownership split (`createModelClient`), explicit dependencies replacing the `capabilities.js` global fallbacks, the extensions.js split by ownership (composition core vs Product adapters), the Telemetry sink containment, and the Product rewired through the public entry. Independence gates H1–H11. M2c (integration compatibility gates) and M3 (repository extraction) are explicitly OUT of scope; no new repositories, no published packages, no new service bus/RPC/DI container, no new scheduling framework — the existing `task-runner` and `AgentSession` loop stay.

## 1. ToolPort and the task-level definition snapshot (§3.2)

```
ToolPort = {
  definitions(): ToolDefinition[]        // read ONCE per task by the session
  execute({ name, input, context })      // context = { filesystem, signal }
    → Promise<{ output, success, backend?, operation? }>
}
ToolDefinition = { name: string, description: string, inputSchema: object }
```

Deviations from the §3.2 draft, intentional:

1. **`context` is the narrow pair `{ filesystem, signal }`**, not the drafted full `HarnessTaskContext`. The port shape is extracted from actual use: the Product adapter closes over its OWN authorization adapter, mutation policy and runtime session (they are Product wiring, not per-call harness data), and events flow through `AgentSession`'s emit, never through the tool call. Nothing drops the drafted fields that have a consumer; none does.
2. **`AgentSession` requires `toolPort`** and rejects the old `toolExecutor` dep (loud constructor error) — ONE authoritative registry/execution path inside the session. Implementation correction (recorded at commit A): the planned `toolPortFromExecutor` compat adapter file was NOT added — after the Product grew its native ToolPort, no production consumer remained, and the M2a rule is that nothing ships without a consumer. The conversion is a six-line mapping each consumer inlines (the Node suites do; a future external host copies it from the contract). `AgentSession` itself never sees two shapes.
3. **Backend default when a port result omits it**: `'harness'` (the harness event envelope's own routing value, already used for skipped calls). The Product adapter always supplies `backend` (`executeTool` keeps its exact `'browser'`/`'cloud'`/runtime-derived values), so the product-visible behavior is unchanged; the name-based `cloud_bash → 'cloud'` inference is deleted from the Harness (that knowledge lives in the Product adapter now).

### 1.1 The snapshot

`run()` reads `toolPort.definitions()` exactly ONCE at task start and builds an immutable snapshot: each definition copied into a frozen plain object, the array frozen, plus a `names` array and a name→definition map. The caller's objects are never frozen. The SAME snapshot feeds, for the WHOLE task:

- the system prompt's tool list (rendered by traversal, one `- name: description` line per definition — the `defs[0]`/`defs[1]` reads are deleted),
- the `tools` field of every model request,
- `normalizeNativeCall` validation (now takes the explicit names list),
- the strict text-fallback name validation (an unknown name in a text-fallback call is now rejected by the Harness BEFORE any execution, as a failed tool result — previously the executor decided),
- the unknown-tool error's available-tools list.

Assembly errors (not an array; an element that is not an object; missing/empty/non-string name; non-string description; non-object inputSchema; duplicate names) fail the task BEFORE any model request: `{ type: 'error', code: 'tool_registry_invalid' }` + `task_end('error')`, mirroring the existing history-budget path. A model-returned unknown tool or invalid arguments stays a failed tool result with zero execution (unchanged semantics, now snapshot-driven).

H5 (mid-task mutation): the snapshot is created at task start; mutating the array/objects returned by `definitions()` afterwards cannot change the running task; the next `run()` reads fresh definitions.

### 1.2 `src/tools.js` becomes the Product ToolPort adapter

`AGENT_TOOL_DEFINITIONS` (bash/cloud_bash — names, descriptions, schemas, refusal texts byte-identical) and `executeTool` stay in `src/tools.js` as the PRODUCT adapter (classic script, Product page). The store composes the Product ToolPort over them: `definitions: () => AGENT_TOOL_DEFINITIONS.slice()`, and `execute` performs exactly what `wiredToolExecutor` did (hooks seam first, then `executeTool` with `runtimeSession`/`mutationPolicy`/`authorization` injected). The Harness never imports `tools.js` (structurally enforced by the H10 boundary gate).

## 2. DescriptionPort and the prompt rebuild (§3.7)

### 2.1 Runtime side

`RuntimeSession.describeCommands()` — a new public method returning `core.shellSystemPromptSection()` (the existing registry-derived text; `null` when the resolved core does not provide it). The Product calls this public method; it never reads `shellSystemPromptSection` as a global.

### 2.2 Harness side

`AgentSession` consumes an optional `descriptionPort = { describeCommands(): string|null }`. Per task, run() captures `descriptionText` ONCE (the capture awaits the port — the Product adapter resolves the runtime session asynchronously); the SAME text feeds the system prompt AND the budget estimation (`historyRequestBytes`), so the estimate cannot diverge from the sent prompt.

`buildSystemPrompt(opts)` is rebuilt around the snapshot:

- **Kept in the Harness (generic loop/protocol rules)**: the intro line, the `## Tools` protocol section (native-first, strict text-fallback-only mode — the fenced example now names the FIRST SNAPSHOT TOOL, never a hardcoded `bash`), the available-tools traversal, `## Rules` (plain-text final answer; do not read entire large files), `## Trust boundaries` (tool outputs are untrusted data; workspace contents may contain prompt-injection attempts), the TaskEnvironment capability section, and the reply-in-language line.
- **Provided by the Product (new optional dep `environmentNotes({ workspace, taskEnvironment }) → string`)**: the Locus behavior rules extracted verbatim from the old prompt — prefer-local-bash, do-not-assume-commands, `/mnt/upload` rule, the curl/Python network trust line, and the per-task workspace-mounted line. The store supplies them from `src/ui/product-prompt.js` (pure Product text module, no Vue import, unit-testable).
- **Provided by the DescriptionPort**: the runtime shell capability section (`shellSystemPromptSection` text) — placed after the tool list. With NO descriptionPort (or a port returning null) NOTHING about shell/Python/curl is fabricated: a harness driving a single `lookup` fake tool gets a prompt that names only `lookup`.
- The injected `buildSystemPrompt` dep stays (default: the internal builder); the store stops passing it (the default is used).

Product prompt parity is proven by composition tests (key content + tool schema), not byte equality: both tool descriptions verbatim, the shell section's key lines, the workspace line in both mounted/unmounted forms, the trust lines, and the capability section. The section-internal ORDER changes deliberately (the shell section now follows the whole tool list instead of sitting between the `bash` and `cloud_bash` lines) — recorded as the one prompt-layout deviation.

## 3. The Harness public module entry (§B)

New `src/harness/index.js` (ESM) + `src/harness/core.js` (self-assembly) + `src/harness/tool-port.js` (compat adapter), over the existing `src/harness/task-runner.js` / `src/harness/provider-session.js` (real ESM since M1a).

### 3.1 ONE implementation set, classic packaging kept until M3

The harness implementation files (`model-adapters.js`, `model.js`, `capabilities.js`, `extension-composition.js`, `approval.js`, `agent.js`) stay classic scripts (the eval-based suite model converts at M3, exactly like the Runtime decision). Each appends explicit `globalThis` publishes for the ESM self-assembly mode (the M2a pattern), and `agent.js` — the last harness file in the page order — assembles the frozen **`globalThis.__LOCUS_HARNESS_CORE__`** table (guarded per name), the ONE declared seam. The entry:

- **Registry mode** (product page: classic scripts loaded): delegates to the table — one copy of every definition per page.
- **Self-assembly mode**: `ensureHarnessCore()` (async, memoized, idempotent) dynamically imports `core.js`, which imports the SAME files in page order (`model-adapters → model → capabilities → extension-composition → approval → agent`); the publishes make the identical sources work as ES modules. Merely lacking classic scripts is NOT an error.
- A present-but-partial table fails the factory that needs the missing name with a targeted error naming it.

Export surface (sync factories; each resolves its name from the resolved core at call time): `ensureHarnessCore`, `createAgentSession(deps)`, `buildSystemPrompt(opts)`, `HISTORY_BUDGET_BYTES`, `MAX_TOOL_ITERATIONS`, `createTaskRunner`, `isPersistenceFailure`, `createProviderSessions`, `createModelClient`, `MODEL_TIMEOUT_MS`, `MODEL_MAX_RESPONSE_BYTES`, `getProviderAdapter`, `OpenAIAdapter`, `AnthropicAdapter`, `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory`, `createApprovalController`, `APPROVAL_KINDS`, `ModelCapabilityRegistry`→`createModelCapabilityRegistry`, `createImageInputGate`, `runImageInputProbe`, `classifyImageProviderError`, `imageInputUnavailableNotice`, `createCapabilityManager`, `SkillSourceStore`, `pythonExtensionKeyOf`, `validatePluginPayload`, `registerPluginRuntimeProvider`, `EXTENSION_ID_PATTERN`, `EXTENSION_PY_MODULE_PATTERN`.

Import-time safety: importing `src/harness/index.js` performs no fetch, no DOM access, no storage open, no runtime start; the self-assembly chunk is dynamic-imported only by `ensureHarnessCore()` and never fires on a registry page. No `HarnessHost`/`HarnessSession` wrappers are invented — the entry exports the existing `AgentSession` class through a one-line factory, nothing more.

The TaskEnvironment/capability composition enters the entry through the extensions split (§5); the Product wiring (store) constructs the session, approvals and the model client through the entry, so the product task path physically passes through the public entry. Node store suites act as hosts that seed the declared table with their fakes (`globalThis.__LOCUS_HARNESS_CORE__ = { AgentSession: Fake, ... }`) — the same hosting rule a classic page follows, with no second production path.

## 4. Model client and configuration ownership (§C1)

`createModelClient(opts)` in `src/model.js` (Harness) — the authoritative implementation:

```
createModelClient({
  config: { apiKey, apiBase, model, proxy, dialect },   // captured & frozen at creation
  transport?: (url, init) => Promise<Response>,          // default: global fetch at call time
  relayEligible?: () => boolean,                          // default: () => false (no relay)
}) → { config, call(body, opts), callText(body, opts), verify() }
```

- The config is captured ONCE per client: a request in flight never observes a mid-request settings change (endpoint, key, dialect, proxy, transport and relay decisions are all read from the captured config — the old `tryFetch` re-read `Model.proxy` mid-request; that is fixed by construction). Two clients never share a mutable singleton.
- The relay/hosting decision is the explicit `relayEligible()` port (product passes `location.protocol !== 'file:'`; a standalone harness host gets the conservative no-relay default). The `window.location` read leaves the generic path; the ONE remaining guarded read lives in the legacy `callModel` compat wrapper (declared exception, deleted at M3).
- Everything else is preserved verbatim: endpoint/gateway path semantics (`buildEndpoints`), original provider replay, the explicit-tools-rejection-only downgrade, timeout/parse/cancel/HTTP error classification, network-fallback rules and request-count caps.
- The legacy `Model` singleton + `callModel`/`callModelText`/`verifyConnection` remain as Product-side compat wrappers that capture `Model.*` at call start and delegate to the same factory (test suites and the `Model.transport` e2e seam keep working). The ProviderAdapter layer (`model-adapters.js`) is untouched pure logic — explicit dialect stays authoritative.

Product wiring: `wiredModelClient` builds the client through the entry factory per request (config from the store-maintained `Model` fields, `Model.transport` seam honored), keeping the image-rejection recording wrapper; the image probe gets an explicit `callModelFn` (the same raw product client, without the hooks seam — unchanged e2e behavior).

## 5. extensions.js split by ownership (§C3)

New classic file **`src/extension-composition.js`** (loads before `extensions.js`): the pure composition core — identity patterns, bounds constants, descriptor validators, `SkillSourceStore`, the plugin-runtime provider registry, `validatePluginPayload`, `pythonExtensionKeyOf`, `sha256Hex`, `CapabilityManager`, the frozen empty production catalogs, state enums. No `workspace.js`/`vfs.js` dependency — a Harness-owned file.

`src/extensions.js` keeps ONLY the Product adapter side: `StaticFileWorkspace`, `SkillInstanceStorage`, `SkillInstanceWorkspace` (the WorkspaceAdapter subclass), loaded after the composition file (classic lexical chain) and after `workspace.js`.

Two boundary changes in `CapabilityManager` (each extracts the port shape from actual use):

1. **`instanceof SkillInstanceStorage` → narrow port**: the manager validates `opts.instances` duck-typed against the methods it actually calls — `{ readBytes, writeBytes, removeDir, stat }` — and fails loudly otherwise. No storage class moves into the Harness.
2. **`taskVfsMounts(env)` → `taskVfsMountSpecs(env)` + Product adapter**: the manager returns pure mount DATA (`{ path, name, files, authority }[]` — no Runtime VFS construction); the Product function `productTaskVfsMounts(manager, env)` in `extensions.js` maps the specs through `StaticFileWorkspace`. Store's prepare mounts the adapters' result. Mount paths/authorities/content are unchanged (composition tests assert the specs; the product adapter keeps the provider behavior).

`capability-package.js` continues reading the composition constants via the classic lexical chain (composition → extensions → capability-package load order). ~~The replay validators (`validateReplayPrefix`/`validateNormalizedPrefix`) STAY in `persistence.js` (Product file) behind the already-landed M1a provider-session port~~ — superseded by the review round (§10, F3): the algorithms moved verbatim into the Harness as `src/harness/replay-validation.js`, with `persistence.js` keeping one-way delegates.

## 6. capabilities.js explicit dependencies (§C4)

- `ModelCapabilityRegistry`: the `PersistenceServiceInstance` typeof-fallback is deleted — `opts.persistence` is REQUIRED (loud constructor error). The store already injects it.
- `runImageInputProbe`: the `callModel`/`Model` typeof-fallbacks are deleted — `opts.callModelFn` explicit (absent → the existing `{ state: 'unknown', reason: 'no-model-client' }`), `opts.model` explicit (absent → `''`; the product client stamps the configured model anyway).
- Image gating/attachment resolution keep the existing `AgentSession.imageInput` injection seam; no attachment storage moves into the Harness.

## 7. Telemetry sink (§C5)

- `src/telemetry.js`: the `renderDebugPanel` reverse dependency on the Product UI is DELETED. `Telemetry` stays the Product recording sink; `utf8ByteLength`/`window.__telemetry` unchanged.
- `src/tools.js` (Product): the execution measurement goes through an explicit optional `opts.telemetry` sink with the existing record fields, wired by the store's ToolPort to the page `Telemetry`; delivery is contained — a throwing sink or a rejected returned promise never breaks the tool result and never surfaces as an unhandled rejection. One record per execution (no double metering): the Harness records nothing per tool execution, and the Runtime records nothing either (both proven by the H10 gate scans).
- Neither core reads the Telemetry global; the two cores cannot couple through it.

## 8. Product wiring (§D) and preserved lifecycle

`src/ui/store.js` assembles through the entry: `createAgentSession({ modelClient: wiredModelClient, toolPort: productToolPort, descriptionPort, environmentNotes, emit, onSessionReset })`, `createApprovalController(...)`, `createModelClient(...)` (settings test + probe path), `createCapabilityManager(...)` (guarded on the composition catalogs, as today). `src/ui/product-prompt.js` (new, pure) supplies `locusEnvironmentNotes` and the `productDescriptionPort` adapter (`whenRuntimeSession() → session.describeCommands()`).

Unchanged M1/M2a semantics (all existing suites keep their assertions): task_start/task_end exactly once; taskId validated before projection; signal override across prepare and execution; adoptEpoch rebinds; required-persistence failure priority; finalizeTask → final publish → onTaskEnd → release; synchronous quiesce admission; the Runtime prepare queue vs caller cancellation; honest post-boundary settlement and effect reports. The runtime entry gains only `describeCommands()`; no runtime execution semantics change.

## 9. Independence gates (§E mapping)

- **H1** `tests/harness-standalone.test.mjs`: import the entry with NO other file loaded (no window/document/Runtime/Vue/storage), `ensureHarnessCore()` self-assembly, then a full task on a fake model + fake ToolPort.
- **H2**: a single `lookup` fake tool — prompt, model `tools`, and the validator name ONLY `lookup`; no bash/cloud_bash/python/curl/mnt claims; an unknown tool (native and text-fallback) is a failed result with zero execution.
- **H3**: native tool → tool result → final answer round trip; strict text-fallback rules preserved (prose-wrapped fence is plain text; fence must be the entire reply).
- **H4**: two sessions (distinct toolPorts/model clients/history/cancellation/persistence) interleaved without pollution.
- **H5**: mid-task `definitions()` mutation cannot change the running task; the next task sees the new definitions.
- **H6**: missing description port fabricates nothing; two sessions' description texts and budget estimates never cross.
- **H7**: existing task-runner/provider-session/persistence suites continue to pass unchanged.
- **H8**: a telemetry sink that throws (sync) and one that returns a rejected promise — the task settles honestly, no unhandled rejection (process-level guard), no duplicate records.
- **H9**: real `getProviderAdapter` + fake transport — OpenAI/Anthropic serialization, endpoint fallback, replay round-trips, explicit tools-downgrade only, error classification (authoritative vs fallbackable), and config isolation between two clients.
- **H10** `tests/harness-boundary.test.cjs`: walk the entry's transitive ESM import closure + structural scans of the harness files — forbidden: Runtime (`runtime/`, `shell.js`, `workspace.js`, `vfs.js`, `network.js`), Product (`tools.js`, `ui/`, `persistence.js`, `attachments.js`, Vue), DOM ids/globals, `AGENT_TOOL_DEFINITIONS`/`shellSystemPromptSection`/`Telemetry`/`PersistenceServiceInstance`/`callModel`/`Model` global reads in the Harness files — paired with the H1 real execution (structure + behavior).
- **H11**: the store suites + full browser e2e drive the product task path through the entry (the suites seed the declared table with their fakes); a prompt-parity suite proves the Product prompt keeps its key content and tool schema.

New suites register in `tests/run-unit.cjs`; no M1/M2a assertion is deleted or loosened. Real-browser verification runs the full e2e set plus an interactive product-page pass (tool call, cancel, approval, conversation switch, image capability, persistence recovery, event display) — fake models only, no real keys.

## 10. Review round (M2b first-pass findings, closed in-branch)

Four review findings, fixed in-branch on top of `3792fe8` (commits: deep snapshot → request-context capture → replay-validation ownership → standalone browser gate + docs). Task lifecycle and model retry policy untouched.

### F1 — tool definitions are truly independent task snapshots

`createToolSnapshot` shallow-copied each definition (`Object.assign` + freeze), so everything nested inside `inputSchema` (`properties`, `required`, …) stayed shared with the caller's objects — a mutation after task start could reach the running task's prompt and every provider request, and H5 (which only mutated the array and the top-level description) could not see it.

Landed shape (`src/agent.js`): `deepCopyToolData` recursively copies each definition's **transportable JSON data** — plain objects, arrays, finite numbers, strings, booleans, null — and freezes the copy at every level. A tool definition IS JSON data by contract (it is rendered into the prompt and serialized into every provider request), so anything that would not survive a JSON round-trip fails LOUDLY with `ToolRegistryError` (`tool_registry_invalid`, task error before any model request): functions, symbols, bigints, `undefined` fields, non-finite numbers, non-plain objects (Date/Map/…), circular references. No generic JSON-Schema validator engine — only snapshot isolation + serializability. The caller's objects are never written or frozen; the next `run()` reads fresh legal definitions; two sessions over one port never share a snapshot; prompt, `request.tools`, the name index and both validators keep consuming that ONE per-task snapshot. Tests: harness-standalone F1 block (red on `3792fe8`, green after).

### F2 — relay/transport decisions are captured once per request

`tryFetch` consulted the `relayEligible` getter only AFTER the direct attempt failed, so an external flip while a request was parked could add (or remove) a `/proxy` attempt for that very request; and `fetchJsonPost` resolved the transport per attempt from the per-call opts object, so a mid-request opts mutation could swap the fallback's transport.

Landed shape (`src/model.js`): `call()` builds a per-call **request context at entry, before any transport await** — `{ config, transport, relayAllowed }` plus captured `{ timeoutMs, signal }` — and passes it through endpoint attempts, the direct→relay fallback and the tools-downgrade re-request. `tryFetch` consults the captured `relayAllowed` BOOLEAN, never the getter; the transport resolves once per request (per-call override still wins, client transport next, global fetch last). The next `call()` captures fresh values; two clients never share capture state. Not fixed by forbidding relay; error classification, retry scope, endpoint semantics and request-count caps unchanged (model/proxy suites pass unmodified). Tests: harness-standalone F2 block — false→true adds no relay to the parked request; true→false still relays per entry permission; next call reads fresh; exactly one getter read per call (downgrade included); two-client isolation; mid-request opts.transport swap ignored. Fake transports only.

### F3 — the replay validators are Harness-owned

`validateReplayPrefix`/`validateNormalizedPrefix` and their error constructor lived in `persistence.js` (Product) behind the M1a injected port, so the harness entry offered no real replay semantics and a standalone host could only restore sessions with injected (possibly fake) validators.

Landed shape: the algorithms move VERBATIM into `src/harness/replay-validation.js` (ESM, pure; error codes, check order, checkpoint/contiguous-sequence, identity matching and tool-call/result pairing semantics unchanged). `createProviderSessions` makes its two validator deps OPTIONAL with the harness implementations as defaults — an explicit injection still wins (test seam); the store stops passing validators entirely (Product supplies only storage/config/projection adapters). The entry re-exports the validators (+ `replayValidationError`). `persistence.js` keeps ONE-WAY compatibility delegates resolving the single implementation through the published frozen `globalThis.__LOCUS_HARNESS_REPLAY_VALIDATION__` table (the M2a/M2b publish pattern; loud `replay_validator_missing` when the harness module was never evaluated) — no second copy of the algorithm, no manual sync. IDB/OPFS and the rest of `persistence.js` stay Product; required-persistence, cancellation and provider-replay behavior untouched. New `tests/harness-replay.test.mjs` restores provider sessions from the ENTRY alone over an in-memory store with the REAL validators and REAL adapter (18 checks: valid prefix; checkpoint/sequence errors; identity mismatch; dangling/duplicate/unpaired tool results; uncheckpointed suffix; normalized validation, fallback and blocking; required-write failure).

### F4 — the standalone harness host is a real browser artifact gate

New `tests/harness-host.html`, added to the Vite build inputs (`rollupOptions.input.harnessHost`) so the gate runs the PACKAGED artifacts, not dev sources. Modeled on the runtime-host page but loading ONLY the harness: no classic scripts, no Vue, no Runtime, no Product page, no `persistence.js`, no real IDB/OPFS. The page awaits `ensureHarnessCore()` (self-assembly), then drives: a complete native tool → tool result → final answer task over the REAL `createModelClient`/adapter pipeline with a scripted fake transport and a lookup fake ToolPort; strict text-fallback rules (prose-wrapped fence stays plain text; a pure fence executes exactly once); cancellation (a parked transport that honors the abort signal); and provider-session restore over an IN-MEMORY store with the harness's REAL replay validators (valid restore + a corrupted tail rejected by code). Page errors, unhandled rejections and every requested resource are recorded for the driver.

`tests/e2e-harness-host.cjs` (registered in `tests/e2e.cjs` as `harness-host`, own build + preview + Chrome) asserts on the dist page: zero classic script tags; the declared table published (v1) with no product DOM; the loaded resource set is EXACTLY the harness host entry chunk + Vite's preload helper + the shared harness chunk (task-runner/provider-session/replay-validation) + the self-assembly chunk — NO Runtime/Product chunk, no copied classic `dist/src` scripts, no product CSS, no CDN; the four behavioral batteries; zero page errors. Screenshots do not substitute the assertions.

## 11. Review round 2 (snapshot fidelity, closed in-branch)

The round-1 `deepCopyToolData` copied plain objects with `out = {}` + `out[k] = value`, enumerated keys with `Object.keys` and copied arrays with `value.map(...)`. Two defect classes, both silently provider-visible and pinned red on the pristine round-1 head:

1. A legal JSON own key `"__proto__"` — exactly what `JSON.parse` produces for `{"__proto__": …}` — was interpreted as the prototype SETTER: the field vanished from the snapshot and the copied value instead became the copy's prototype (the model received a rewritten schema; the copy's prototype chain was definition-data-influenced). A primitive-valued own `"__proto__"` key was silently dropped outright (setter ignores non-object operands).
2. `Object.keys` misses Symbol keys and non-enumerable own properties; `value.map` skips holes, dispatches through the SOURCE's own `map` (an own `map` override hijacked the copy's content), and invokes element getters. Functions, holes and hidden business fields therefore crossed the boundary as silently-dropped or silently-rewritten data instead of failing loudly.

Landed shape (`src/agent.js`): the copy is DESCRIPTOR-driven end to end.

- **Plain objects**: audit EVERY own name (`Object.getOwnPropertyNames` + `getOwnPropertyDescriptor`) — each must be an enumerable data property, else `tool_registry_invalid` (accessor property / non-enumerable property, with the JSON-drop reason in the message); Symbol keys (`getOwnPropertySymbols`) reject the same way. Keys are recreated with `Object.defineProperty`, so `"__proto__"` lands as an OWN data key and the copy's prototype is never touched; key order follows own-name enumeration, keeping serialization byte-stable. `"__proto__"` is NOT a forbidden field — it is legal JSON data.
- **Arrays**: audit every own name — only canonical indices `0..length-1` as enumerable data elements, plus the standard non-configurable `length`; a hole (index count ≠ length), an extra non-index key, an accessor element or a Symbol key rejects loudly (holes would serialize as `null`). The copy is built strictly from the audited index descriptors in ascending index order — the source's own `map` is never called.
- **Getter discipline extends to validation**: `validateToolDefinition` reads `name`/`description`/`inputSchema` through their descriptors (`validatedOwnField` — an accessor or non-enumerable field rejects without its getter running), and the duplicate-name check moved AFTER the copy (it reads the snapshot's name). No accessor on a caller object executes anywhere in assembly.
- **Unchanged by design**: recursive copy with per-level freeze; the seen-set stays an ANCESTRY PATH (shared acyclic sub-objects remain legal, copied per reference; only true cycles reject); the caller's objects are never written or frozen; no JSON-Schema validation engine; relay capture (F2), replay validation (F3), task-runner and model retry policy untouched.

Tests: the harness-standalone **F1b block** (public entry only): (A) a `JSON.parse`-built schema with an own `properties.__proto__` key reaches `request.tools` byte-identically AND the OpenAI wire serialization (real `getProviderAdapter().serializeRequest` + real `JSON.stringify` round trip), with the copy's prototypes unchanged; (B) `constructor`/`prototype`/`toString` keys preserved verbatim (no forbidden-key list); (C) a Symbol-keyed function, a function in a non-index array property, a sparse array, an object accessor, an accessor array element, an own `map` override and a non-enumerable business property all fail `tool_registry_invalid` before any model request with zero executions — with counter-proofs that no getter and no hostile `map` ever ran; (D) dense arrays / null / nesting / shared acyclic sub-objects still copy losslessly, deeply frozen, as independent copies; (E) the round-1 F1 assertions (caller ownership, task isolation, next-task fresh read, deep freeze, two-instance isolation) kept unchanged. First-failure evidence: 14 of the 18 new checks red on the pristine round-1 head (73 PASS / 14 FAIL; `tmp-f1b-firstfail.log`, not committed); 87 PASS / 0 FAIL after the fix.
