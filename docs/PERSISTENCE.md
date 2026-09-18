# Locus Persistence v1

Locus persistence is local to the browser profile. It remembers durable machine state that changes future behaviour, while process state remains ephemeral.

## Storage substrate

The canonical database is IndexedDB named `locus`, schema version `2`. The upgrade function is explicit: `0 → 1` creates the stores below, and `1 → 2` adds the `providerFrames.conversationId` index and deletes the unscoped legacy `secrets/apiKey` record. Migration never guesses which endpoint an old key belonged to.

| Store | Purpose | Important indexes |
| --- | --- | --- |
| `conversations` | Conversation records and UI projection snapshot | `updatedAt` |
| `presentationEvents` | Durable runtime-to-timeline events | unique `conversationId + sequence`, `conversationId` |
| `providerSessions` | Adapter/dialect/model session metadata and checkpoint | `conversationId` |
| `providerFrames` | Provider-native protocol frames | unique `sessionId + sequence`, `sessionId`, `conversationId` |
| `normalizedMessages` | Provider-neutral semantic projection | unique `conversationId + sequence`, `conversationId` |
| `settings` | Endpoint, model, proxy and dialect settings | key `key` |
| `secrets` | Explicitly remembered API keys only | key `key` |
| `workspaceHandles` | User-selected external directory handles | key `key` |
| `meta` | Small schema/runtime metadata | key `key` |

If IndexedDB or OPFS cannot be initialized, Locus stays usable in memory-only mode and exposes the degraded state in Settings. It never silently drops old history to recover quota. The storage estimate is informational, not a correctness decision.

## Durable and ephemeral state

Durable state:

- conversations and presentation events;
- provider-native replay frames and provider sessions;
- normalized semantic history;
- endpoint/model/dialect settings;
- API keys only after the user explicitly enables Remember API key;
- `/home/locus` and `/mnt/plugins` through OPFS when the browser supports it;
- a selected workspace `FileSystemDirectoryHandle`, subject to browser permission.

Ephemeral state:

- `/tmp`;
- `/mnt/upload` browser `File` objects;
- `/mnt/download` artifacts in v1;
- active task/process state and the Pyodide worker.

The `/home/locus/history` VFS path is a read-only IndexedDB virtual projection. It is not a second OPFS conversation database.

## Conversation and replay records

A conversation has a stable `id`, title, timestamps, `activeProviderSessionId`, `runState` (`idle`, `running`, or `interrupted`), `persistenceState` (`healthy` or `degraded`) and `schemaVersion`. Every ordered stream uses an explicit sequence rather than timestamp ordering.

A provider session records its conversation, provider family, adapter id, dialect, normalized endpoint identity, model, protocol version, timestamps and `replayCheckpointSequence`. Raw replay compatibility is owned by the adapter: provider family, adapter, dialect, endpoint path, protocol version and model must match unless that adapter explicitly declares model-portable history.

`raw` means the semantic provider object visible to the model/provider layer, not an HTTP packet dump. Authorization headers, cookies, API keys, proxy tokens and other temporary credentials are never stored there. Unknown provider fields are retained, including nested fields and opaque signatures.

Provider-returned reasoning/thinking is retained only when the configured provider actually returned it. This state is preserved because some providers/models require or benefit from faithful protocol replay. Locus does not synthesize or request hidden reasoning that the provider does not expose, and it never derives a CoT from a final answer.

The normalized store carries portable fields such as role, kind, text, tool name/input/result, public replayable reasoning where appropriate, timestamp and sequence. Provider-specific signatures and opaque fields are not disguised as normalized semantics.

Same-provider or compatible-adapter continuation uses the provider-native frames up to the session checkpoint. Before serialization, the checkpoint is checked for contiguous sequences, session/conversation identity, checkpoint/tail agreement and complete tool-call/result pairing. Invalid raw state is marked degraded and is never sent; Locus may retain a normalized inspection projection, but requires a new task boundary before another provider request. Cross-provider continuation uses the normalized semantic projection; a foreign Anthropic block or OpenAI wire object is never sent directly to the other provider.

Replay validation derives protocol semantics from raw provider state and cross-checks persisted `kind`, `role` and tool-call metadata against that state. Persisted metadata is an index and invariant, never a safety gate that can hide provider-native tool calls or results.

All raw frames are archived, including an assistant tool call that was interrupted. The checkpoint advances only at a protocol-valid boundary: a final assistant response, or a complete multi-tool result batch. A dangling tool call therefore remains inspectable but is excluded from the next replay. Locus never automatically reruns an interrupted tool because it may already have caused a real side effect.

## Crash recovery

Before a model request, Locus persists the user presentation/semantic/provider state and marks the conversation `running`. A complete provider response is persisted before its checkpoint is advanced. On startup, any `running` conversation is changed to `interrupted` and shown as such in the UI. The user or model must explicitly continue it.

Presentation history is a UI projection. It is persisted for reload display, but it is never used to reconstruct provider messages.

Required replay writes are fail-closed. If a provider frame, normalized semantic row or checkpoint cannot be committed, the task ends with `persistence_error`/`persistence_write_failed`; it cannot be reported as `completed`, and no tool result is retried through another model request. Optional UI snapshots surface a storage notice and the service exposes its last persistence error in Settings.

## Workspace handles and permissions

The selected external folder handle is stored in IndexedDB. Startup checks `queryPermission({mode: 'readwrite'})` only. A `granted` handle is restored automatically; `prompt` does not trigger a permission request. The user must click Reconnect, which is the user gesture that calls `requestPermission`. Denied or stale handles are shown as recoverable UI state and never crash startup.

## API keys and threat model

API keys are not durable by default. Remember API key is an explicit opt-in and stores the key locally in the browser profile, separate from settings. Each remembered key is indexed by `{provider, adapterId, dialect, endpointIdentity}`; endpoint identity normalizes scheme/hostname/default port/trailing slash while retaining the path. Turning it off deletes only the current destination's key; Forget API keys clears the complete secret store. Values are redacted from persisted events, raw frames, normalized messages and other persistence projections.

Local browser-profile storage is not immune to XSS, not hardware secured and not cryptographically isolated. Locus does not claim otherwise and does not implement fake encryption by storing an AES key beside its ciphertext.

## OPFS plugins and authority

`/mnt/plugins` is durable installed-code storage backed by OPFS. Ordinary agent VFS access is `system-read-only`; a privileged host/plugin installation integration may write plugin bytes through the persistence service. The canonical `/home/locus` skeleton is `.skills`, `.config/locus/mcp` and `.cache/locus`; it is recreated after mount, Clear home and Reset. Persisted plugin code does not imply persistent credentials, remote authority or MCP authority. Plugins add code, Skills add knowledge, and MCP adds authority.

## Management actions

Settings exposes a storage estimate, a browser persistent-storage request, and isolated actions for Clear conversations, Clear home, Clear plugins and Forget API keys. These actions share one runtime gate: an active AgentSession is cancelled, its `finally` settlement is awaited, and a timeout fails loudly without mutating storage. Reset all local data clears all IndexedDB durable state, unmounts `/mnt/workspace`, resets workspace UI state, clears OPFS home/plugins and recreates the ephemeral session mounts. Each clear action is scoped to its named surface; deleting a conversation cascades presentation events, provider sessions, provider frames (including orphan frames selected by conversation id) and normalized messages in one IndexedDB transaction.

Clear home and Reset also clear the current `/home/locus` provider when the durable backend is unavailable, then rebuild the canonical memory-backed skeleton. A durable clear failure is propagated before the live provider is replaced.

Persistence redaction is type-preserving for structured-clone values such as `Date`, typed arrays, `ArrayBuffer`, `Map` and `Set`. Unsupported non-cloneable values fail explicitly rather than being silently converted through JSON. OPFS enumeration, mount, write and clear failures are reported with the affected operation/path; a workspace can remain mounted for the current session while a failed handle-remember operation is shown as not remembered.
