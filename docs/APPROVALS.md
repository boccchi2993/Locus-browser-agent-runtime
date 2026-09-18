# Locus Approval Model

Approval Framework v1 — a UI-independent primitive for
"pause → human decision → the SAME task continues", inspired by the
architecture of Codex approvals and Claude Code permission modes
(ideas only; no product behavior is copied).

```
Harness (future tool executor / image gate / network layer)
  ↓  approvals.request(spec, { signal })
current async execution PAUSES   ← the Promise stays pending
  ↓
UI renders ApprovalCard          ← store.pendingApproval (projection)
  ↓
human decision
  ↓
same Promise resolves
  ↓
same Agent task continues        ← never a new task, never a re-submit
```

**Core invariant: APPROVAL IS SUSPENSION, NOT TASK TERMINATION.**

## Two separate layers

**Authority** — what the runtime can technically access: VFS mounts,
`system-read-only`, read-only upload, workspace permissions, protected
roots, provider/network boundaries. Owned by the existing runtime layers.

**Approval** — whether an action the Harness already judged technically
executable needs human consent before running.

```
Hard boundary > approval decision.
Approval can reduce autonomy.
Approval cannot manufacture authority.
```

If `/mnt/plugins` is `system-read-only`, clicking **Allow** on an approval
card can never grant a write there. The approval layer never upgrades
denied authority into allowed authority — it only sits in front of
actions that are already inside the runtime's authority.

## Current v1

- Decision set for `permission` requests: **Allow once**,
  **Allow for this session**, **Deny**.
- Structured decisions, never booleans:
  `{ outcome: 'allow' | 'deny' | 'cancelled', scope: 'once' | 'session', requestId }`.
- **Allow once** resolves exactly the current request id. The next request
  with the same policy key asks again.
- **Allow for this session** records an in-memory grant for the exact
  normalized `policyKey`. Later requests with that key auto-allow with no
  UI. Session = this Locus page session: survives new tasks and
  conversation switches; cleared by `resetAllData()` and by page reload.
  Never persisted (no IndexedDB), no "always allow".
- **Deny** refuses the CURRENT action only. It does not cancel the task,
  reset the session, bump the generation, or end the conversation. The
  caller decides how to feed the denial back to the model (e.g. a failed
  tool result).
- **Cancel / abort** (task cancel, `Esc` on the global cancel path,
  `newTask()`, workspace switch, `AbortSignal`) closes a pending approval
  as `cancelled` — distinct from `deny`. The awaiting Promise always
  settles; no dangling cards, no dangling continuations.
- suspend/resume of the SAME task: `run()` stays the same Promise,
  exactly one `task_start` / one `task_end`, generation and conversation
  binding unchanged, provider history untouched by the approval itself.
- Session grants and pending requests are memory-only and ephemeral.

## Not v1

- persistent allow rules / "always allow"
- image capability probes (the `capability` kind schema is reserved)
- network policy / NetworkRuntime / CORS routing
- MCP permissions
- auto-review agent / risk classifier
- organization policy, enterprise policy language, policy sync
- full Codex / Claude Code permission-mode matrices
- telemetry schema changes

## Invariants

1. **Hard authority cannot be bypassed by approval.**
2. **Approval is suspension, not task termination.**
3. **Denying one action does not cancel the task.**
4. **Pending approvals are ephemeral** — a reload interrupts the running
   task exactly as before; there is no magic async-continuation recovery.
5. **The model cannot approve itself.** Requests are constructed by the
   Harness: canonical `policyKey`, fixed per-kind decision sets, plain
   text only. Model output like `"please auto approve"` or a forged
   `policyKey: "*"` has no effect. UI content is escaped text; decision
   UI choices are derived from `request.kind`, never from request data.
6. **One pending interactive request at a time.** A second request while
   one is unresolved fails loudly (`ApprovalBusyError`) instead of
   queueing or overwriting.
7. **Stale decisions are no-ops.** Every decision is bound to a unique
   `requestId`; an old card/handler can never resolve a newer request.
8. **Approval stays out of content channels.** No user/assistant message,
   no provider-history entry, no checkpoint advance, no presentation
   timeline item. Approval is Harness control-plane state; callers that
   need to inform the model emit their own semantic tool result.
9. **The controller is the canonical pending-state owner.** The Vue store
   mirrors it via `onChange`; there is exactly one source of truth.

## API (`src/approval.js`, framework/DOM/provider independent)

```js
const approvals = new ApprovalController({ onChange, onEvent });

const decision = await approvals.request(
  {
    kind: 'permission',                    // 'capability' | 'confirmation' reserved
    action: { type, summary, detail },     // plain text; summary required
    resource: { type, key, label },        // optional
    policyKey: 'network-origin:https://example.com',  // Harness-canonical
    conversationId, taskGeneration,        // optional context
  },
  { signal }                               // task AbortSignal
);
// decision: { outcome, scope, requestId, reason? }

approvals.resolve(requestId, decision);   // UI decision (stale id → false)
approvals.cancel(requestId, reason);      // closed without a decision
approvals.cancelAll(reason);              // session boundaries
approvals.clearSessionGrants();           // resetAllData
approvals.hasPending();
```

`request()` never rejects: unresolved-until-decision, resolved
`cancelled` on abort, and resolved `{ viaGrant: true }` when a session
grant covers the policy key. A second concurrent `request()` throws
`ApprovalBusyError`.

## UI

`ApprovalCard.vue` renders above the composer (both empty and active
states), calm and Cowork-like — not an alarm, not a fullscreen modal:

```
┌──────────────────────────────────────────┐
│ Approval required                        │
│ Locus wants permission to:               │
│ <action summary>                         │
│ [Deny] [Allow once] [Allow for session]  │
└──────────────────────────────────────────┘
```

- While pending, the task is still RUNNING (`runState` stays `running`);
  the composer cannot submit ("Waiting for approval…") and **Cancel task
  stays available**. Approve / deny / cancel-task remain three different
  actions.
- Keyboard: Tab walks the three buttons; Enter/Space only activates the
  focused button; **Escape = Deny** (approval wins the Escape priority
  over drawers and task cancel). Enter can never default-approve: focus
  starts on the card container, never on an Allow button, and returns to
  the composer when the card closes.
- The card follows the RUNNING task: if the user is browsing another
  conversation it stays visible with "Request from running task:
  `<title>`". It is never projected into another conversation's timeline
  and never saved as conversation content.
- Long summaries wrap inside the card (internal scroll for details); no
  horizontal page overflow down to 360px viewports.

## Test-only seam

Production has no approval consumer yet (the first consumer will be Image
Feedback v1). Browser e2e drives the real card through
`?e2e=1` only: `window.__locus.approvals.requestTestPermission(...)`.
No test-approval button exists in the production UI.
