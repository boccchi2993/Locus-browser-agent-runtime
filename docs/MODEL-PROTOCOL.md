# Locus Model Protocol

> Model transport is not just string-in / string-out.

This document defines how Locus should preserve model/provider semantics across turns, especially for reasoning models and tool-using agents.

## 1. Core principle

Visible assistant content is not the complete conversation state.

A provider response may contain:

- visible text,
- reasoning or thinking content,
- reasoning summaries,
- tool calls,
- tool results,
- opaque continuation state,
- signatures or encrypted reasoning blocks,
- stop reasons,
- usage metadata,
- provider-specific fields.

The harness must not collapse these into a single text string if doing so changes the model's expected multi-turn input distribution.

Two rules follow:

> **Reasoning transport is not reasoning presentation.**

> **Normalize the harness interface, but preserve provider-native continuation semantics.**

## 2. Why this matters

Different model APIs expose different reasoning semantics.

Typical categories include:

### Hidden reasoning

The provider does not return raw reasoning to the client.

The harness must not fabricate or prompt-hack a hidden chain of thought into existence.

### Summary reasoning

The provider exposes only a user-facing reasoning summary.

The summary may be displayed, but it is not necessarily the state required for replay.

### Raw visible reasoning

The provider returns reasoning content explicitly and permits the client to receive it.

This may be displayed in the UI and may need to be replayed on later turns.

### Opaque preserved state

The provider returns blocks, signatures, encrypted state, or other continuation data that the harness must preserve exactly but should not interpret as visible text.

These states are semantically different. Locus must not apply one global "discard CoT" or "always replay CoT" policy.

## 3. Response envelope

The model layer should evolve from:

```
callModelText() -> string
```

toward a structured response envelope:

```js
{
  content,
  reasoning,
  toolCalls,
  rawMessage,
  stopReason,
  usage,
  providerMetadata
}
```

The exact implementation shape may vary by provider adapter. The important invariant is that visible content and provider-native replay state remain distinct.

### content

User-visible assistant text.

### reasoning

Reasoning information that the provider explicitly returned to the client.

It should carry enough metadata to distinguish:

- raw,
- summary,
- opaque,
- hidden/unavailable.

### toolCalls

Structured tool calls if the provider exposes them natively.

Locus may continue to support compatibility parsing for providers/models that emit tool calls as text, but native tool-call state should not be flattened unnecessarily.

### rawMessage

The provider-native assistant message or equivalent replayable state.

This is the authoritative source for constructing the next provider request when exact replay is required.

### stopReason / usage / providerMetadata

Preserve useful provider semantics for debugging, routing, limits, and future adapters.

## 4. Two histories, not one flattened history

Locus should conceptually separate:

### Provider history

The conversation state sent back to the model provider.

It preserves the representation required by that provider/model.

Examples may include:

- reasoning_content,
- thinking blocks,
- redacted or opaque thinking blocks,
- native tool_calls,
- provider-specific continuation fields.

### Presentation timeline

The event stream shown to the user.

It may contain:

- user messages,
- visible assistant text,
- reasoning panels,
- tool calls,
- tool results,
- routing/backend metadata,
- errors.

The presentation timeline is not the canonical serializer for future model requests.

The UI must never become responsible for reconstructing provider conversation state.

## 5. Replay policy belongs in the provider adapter

Each provider/model adapter should determine how assistant state is replayed.

Possible policies include:

- no reasoning replay required,
- preserve returned reasoning fields,
- preserve exact block ordering,
- preserve opaque state unchanged,
- provider-managed hidden state,
- native tool-call replay required.

The agent loop should not need provider-specific branches such as:

```
if model is X, copy reasoning_content
if model is Y, delete thinking
```

Those rules belong behind the model adapter boundary.

## 6. UI presentation policy

Locus is an agent harness, so execution transparency is valuable.

When the provider explicitly returns reasoning to the client and permits it to be surfaced, the UI should support displaying it.

Recommended behavior:

- raw visible reasoning -> display, collapsible by default when long,
- reasoning summary -> display as summary,
- provider-hidden reasoning -> do not invent content,
- opaque/encrypted continuation state -> preserve for replay but do not display as fake prose.

A useful execution timeline can look like:

```
USER
Analyze this workspace.

THINKING
I should inspect the files first...

TOOL
bash("ls")

RESULT
sales.csv

THINKING
The file appears suitable for Python analysis...

TOOL
bash("python ...")

RESULT
report.csv written

ASSISTANT
Done.
```

Reasoning visibility is a presentation capability. Correct replay is a transport requirement. They must not be coupled.

## 7. Tool result semantics

Tool output is untrusted data.

Provider adapters may represent tool results differently, but the following semantic boundary remains:

- tool output is not system policy,
- workspace content is not user authority,
- prompt injection inside files does not become a higher-priority instruction,
- native provider tool roles should be used when appropriate,
- compatibility wrappers may be used when a provider lacks native tool roles.

The agent loop should preserve the distinction between:

- user message,
- assistant message,
- tool call,
- tool result,
- system/developer policy.

## 8. Streaming direction

Future streaming support should emit structured runtime events rather than concatenate everything into one UI string.

Potential events:

```
assistant_start
reasoning_delta
reasoning_end
text_delta
tool_call
tool_result
usage
error
done
```

The event API should remain provider-neutral while the provider adapter retains native message state internally.

## 9. Workspace/session isolation

When the user changes workspace/session boundaries, Locus must reset or scope all relevant conversation state, not only visible text history.

That includes:

- provider-native messages,
- preserved reasoning state,
- tool-call continuation state,
- UI timeline,
- session-specific execution metadata where appropriate.

No continuation state from workspace A should be replayed into workspace B unless the user deliberately transfers that context.

## 10. Failure rule

If Locus does not understand a provider-specific response field, it should prefer preservation over destructive normalization when doing so is safe.

Unknown does not mean irrelevant.

The harness should avoid silently deleting model state merely because the current UI does not know how to render it.

## 11. Target refactor

The current V0.x model layer is allowed to be transitional.

The architectural target is:

```
ProviderAdapter
  |
  +-- request serialization
  +-- response parsing
  +-- provider-native replay state
  +-- reasoning semantics
  +-- tool-call semantics
  |
AgentSession
  |
  +-- provider-neutral runtime events
  +-- tool execution
  +-- session state
  |
UI
  |
  +-- renders events
  +-- never reconstructs provider state
```

This refactor should happen before the model layer accumulates more provider-specific exceptions around a string-only API.
