# Locus runtime model

This document follows one task through the system.

## 1. Long-lived page state

The page owns the live VFS, persistence, CapabilityManager, provider settings, AgentSession, optional durable attachments, and the page-session verified Python bootstrap cache.

## 2. Submit boundary

Before `AgentSession.run`, the harness binds durable user/conversation state, refreshes SkillInstance presence, builds the frozen `TaskEnvironment`, prepares the Python extension identity, forks the VFS, and installs task-scoped overlays.

A running task never “looks up whatever capabilities are enabled now”.

## 3. System prompt

Prompt text derives from real registries: model tools, shell commands, workspace state, compact Capability index, present SkillInstance paths, and external-connection availability.

Skill bodies are not pre-injected. The model reads them with ordinary `cat` only when relevant.

## 4. Model request and perception

ProviderAdapter serializes the request while preserving provider-native history semantics.

If history contains image references, ImageInputGate resolves provider/model capability exactly where image bytes are about to cross the model boundary. Supported images are materialized from the durable attachment store only for that request.

## 5. Tool execution

```
model tool call
 -> model-visible tool registry
 -> bash
 -> explicit shell parser/registry
 -> VFS / Python / NetworkRuntime
 -> bounded result
 -> telemetry
 -> provider tool-result history
```

No system shell or `eval` parser is involved.

## 6. Python

Python receives a bounded mirror of relevant VFS state and executes inside Pyodide under the strict browser authority boundary.

After execution Locus computes a changeset and commits through the VFS with conflict/cancellation checks. Python therefore cannot bypass Skill approval by writing a path internally.

## 7. Network

GET/HEAD may use direct fetch and retry through the relay only on genuine initial transport failure. HTTP responses are authoritative.

Side-effecting methods are validated, approval-gated where required, assigned a backend before send, and dispatched exactly once.

## 8. Skill mutation

For declared SkillInstance create/write/delete:

1. validate exact task identity;
2. bound and validate UTF-8;
3. hash before-state;
4. compute a human-readable diff;
5. suspend for confirmation;
6. re-check liveness and before-state hash;
7. commit only if both still match.

## 9. Cancellation and session changes

Cancellation stops future work without inventing rollback for committed side effects.

A workspace/session switch changes generation; late results from the old generation are discarded rather than projected into the new session.

## 10. Persistence and replay

Provider-native frames, normalized semantic rows, and presentation events are separate durable streams.

Replay checkpoints stop unsafe re-execution of dangling side-effecting tool suffixes.

## 11. Task end

The task fork and TaskEnvironment expire. The next task may observe a different workspace, Capability set, or SkillInstance presence.
