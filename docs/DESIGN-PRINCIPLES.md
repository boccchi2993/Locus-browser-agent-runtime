# Locus design principles

These rules are decision tools, not slogans pasted on top of arbitrary code.

## 1. Model decides WHAT. Harness decides WHERE.

The model chooses an operation in familiar task terms. The harness chooses the backend, mount, relay, worker, provider adapter, or future escalation path.

## 2. Prefer execution close to data

For lightweight work, prefer local browser execution next to user-granted data, the least authority sufficient for the operation, the cheapest reliable backend, and explicit escalation only when the browser cannot faithfully complete the task.

## 3. Do not make the model learn Locus

Expose ordinary paths, a bounded Unix-like shell, and familiar library APIs. Internal objects such as CapabilityManager, OPFS, CSP creator iframes, and relay topology are harness concerns.

## 4. Keep the core primitive set small

The browser substrate has four categories:

- Execution
- Filesystem
- Network
- Perception

A domain request does not become a new core primitive just because it is common.

## 5. Capability is the user abstraction

> Plugin adds code.  
> Skill adds knowledge.  
> MCP adds authority.  
> Capability composes them for the user.

## 6. Authority never expands silently

Execution placement may be transparent. Authority cannot.

A package does not inherit credentials. A relay does not inherit cookies. Approval does not make a read-only mount writable. Enabling a Capability does not connect MCP.

## 7. Snapshot task identity; allow explicit state mutation

A task freezes its `TaskEnvironment` identity at start. Files remain mutable within authority. SkillInstance mutation is special because it changes future agent behavior and therefore requires explicit confirmation.

## 8. Preserve provider semantics

Visible text is not the entire protocol. Provider-native continuation, reasoning, and tool-call state must survive when required.

## 9. Fail honestly

Do not claim rollback after a committed side effect. Do not retry ambiguous writes. Do not call a partial changeset complete. Do not collapse unknown into unsupported.

## 10. Evidence beats aesthetic architecture

Add abstraction because trajectories and tests show a need, not because a diagram has an empty box. Product capabilities should follow real user workflows after infrastructure contracts are stable.
