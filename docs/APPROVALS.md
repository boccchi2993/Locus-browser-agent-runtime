# Locus Approval Model

Approval Framework v1 — a UI-independent primitive for
"pause → human decision → the SAME task continues", inspired by the
architecture of Codex approvals and Claude Code permission modes
(ideas only; no product behavior is copied).

```
Harness consumer (NetworkRuntime / ImageInputGate / SkillInstanceWorkspace)
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

The controller supports three fixed request kinds. Their choice sets come from the Harness, never from model-provided button text.

### `permission`

Used for actions such as side-effecting network requests.

- **Allow once**
- **Allow for this session**
- **Deny**
- exact Harness-constructed `policyKey` controls session grants;
- session grants are in-memory only and disappear on page reload/reset-all-data;
- deny refuses the current action, not the whole task.

### `capability`

Used by Image Feedback when the current provider/model image-input capability is unknown.

- **Yes / confirm**
- **No / decline**
- **I don't know / unsure**
- no session scope;
- the approval result is only the human decision; durable capability evidence belongs to `ModelCapabilityRegistry`.

This is a compatibility-knowledge question, not an authority grant.

### `confirmation`

Used for persistent behavior mutations such as SkillInstance create/write/delete.

- **Confirm**
- **Cancel**
- no session scope;
- each mutation asks again;
- the Harness supplies the Capability/Skill/path identity and reviewable diff;
- the Skill consumer re-checks the task signal and before-state hash after the decision before committing.

A `confirmation` cannot be upgraded to `scope: 'session'`.

### Shared lifecycle

- Decisions are structured, never bare booleans.
- Cancel/abort closes the pending request distinctly from a domain denial.
- Suspend/resume stays inside the same Agent task and Promise.
- Pending requests are ephemeral control-plane state, not provider/presentation history.

## Not v1

- persistent allow rules / "always allow";
- automatic risk-classifier/auto-review approval;
- organization policy language or policy sync;
- production MCP permission flows;
- full Codex / Claude Code permission-mode matrices;
- a generic audit-log product for approvals.

NetworkRuntime, ImageInputGate, and SkillInstanceWorkspace are **current production consumers** of the framework; they are not future placeholders.

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

## Consumer execution contract

An approval decision authorizes an **ACTION**. It does not keep the
originating task alive. Between "the Promise resolved with allow" and
"the protected side effect begins" there is a window that only the
consumer knows about (preparation, barriers, other awaits). A task
cancel, session reset or workspace switch inside that window must never
let a dead task start its side effect.

1. **ApprovalController only decides approval state.**
2. **Allow does not guarantee that the originating task is still live later.**
3. **Every consumer MUST pass the task AbortSignal.**
4. **After an allow decision, every consumer MUST re-check the signal
   immediately before starting the protected side effect.**
5. **No await/yield may occur between the final liveness check and the
   beginning of the protected side effect.**
6. **Once a side effect has started, cancellation is not rollback.**

Canonical consumer template:

```js
const decision = await approvals.request(spec, { signal });

if (decision.outcome !== 'allow') {
  return deniedResult(decision);        // deny/cancel → domain result
}

await prepareNonSideEffectingInputs();  // may yield to cancellation

signal.throwIfAborted();                // FINAL liveness check — the last
                                        // synchronous checkpoint; no await
                                        // may follow this line
return performProtectedAction();        // the side effect starts here;
                                        // past this point cancel does not
                                        // roll back
```

WRONG — the recheck is not the last checkpoint before the effect:

```js
const decision = await approvals.request(...);
if (decision.outcome === 'allow') {
  await unrelatedAsyncWork();           // yields to cancellation AFTER the ask
  return performProtectedAction();      // a dead task can still start this
}
```

`AbortSignal.throwIfAborted()` is native in every supported runtime. Where
it is unavailable, an equivalent helper:

```js
if (signal && signal.aborted) {
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
```

### Controller guarantees — and what is deliberately NOT guaranteed

ApprovalController guarantees:

- pending request identity
- exactly-once decision delivery
- stale request no-op
- session grants
- cancellation while pending
- observer failures do not break settlement (below)

ApprovalController DOES NOT guarantee:

- the task is still alive after decision delivery
- resource identity remains valid forever
- side effects are rolled back
- hard authority
- policy selection

Consumer MUST:

- pass the task AbortSignal
- final-check the AbortSignal immediately before the action starts
- honor hard authority
- convert deny/cancel into a domain result

### Observer failures never break settlement (fail-closed, always-settles)

`onChange` / `onEvent` are presentation/debug observers — best effort only.
If either throws, the throw is contained and reported **console-only**
(never as a semantic Agent event, never into provider/model history). A
throwing observer:

- cannot decide an approval outcome and cannot auto-allow,
- cannot prevent the request Promise from settling exactly once,
- cannot strand the canonical pending state (no dangling controller),
- cannot prevent a session grant from being recorded,
- cannot brick the controller — the next request works.

Settlement ordering in `_finish`: canonical cleanup → best-effort observer
notification → unconditional `resolve(decision)`. If a UI needs its
projection to run before the continuation resumes, the observer is still
wrapped so the settle step is unreachable by any observer exception.
`request()` therefore never rejects — including when an observer throws at
request time: the request stays pending, the controller stays the
canonical owner, and the caller/UI can still resolve or cancel it through
the controller API.

### taskGeneration is informational context only

`taskGeneration` on a request is **INFORMATIONAL CONTEXT ONLY** — debugging,
UI diagnostics, future audit events, caller context. It is NOT a security
enforcement token, NOT an authorization identity, and NOT a replacement
for the AbortSignal. Runtime liveness enforcement relies on
`requestId` + `AbortSignal` + the caller-side final liveness recheck above.

## API (`src/approval.js`, framework/DOM/provider independent)

```js
const approvals = new ApprovalController({ onChange, onEvent });

const decision = await approvals.request(
  {
    kind: 'permission',                    // or 'capability' / 'confirmation';
                                           // each kind has a fixed decision schema
    action: { type, summary, detail },     // plain text; summary required
    resource: { type, key, label },        // optional
    policyKey: 'network-origin:https://example.com',  // Harness-canonical
    conversationId, taskGeneration,        // optional context; taskGeneration
                                           // is INFORMATIONAL ONLY (see above)
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
grant covers the policy key — and observer callback failures never change
that contract (see "Observer failures" above). A second concurrent
`request()` throws `ApprovalBusyError`.

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
- Keyboard: Tab walks the scrollable summary body (keyboard-reachable
  overflow region) and then the three buttons; Enter/Space only activates the
  focused button; **Escape = Deny** (approval wins the Escape priority
  over drawers and task cancel). Enter can never default-approve: focus
  starts on the card container, never on an Allow button, and returns to
  the composer when the card closes.
- The card follows the RUNNING task: if the user is browsing another
  conversation it stays visible with "Request from running task:
  `<title>`". It is never projected into another conversation's timeline
  and never saved as conversation content.
- Vertical containment (pointer accessibility invariant): the card is a
  flex column capped at `min(60dvh, 520px)`; the body (summary / detail /
  resource / context) is the only scrollable region, while the action row
  is pinned to the card bottom (`flex: 0 0 auto`). No summary/detail
  length — 2KB+ text, long URLs, no-whitespace tokens — can push the
  buttons (or the composer's Cancel task below the card) out of the
  viewport. Body text wraps with `overflow-wrap: anywhere`, so there is no
  horizontal page overflow down to 360px viewports.

## Test-only seam

Production has no approval consumer yet (the first consumer will be Image
Feedback v1). Browser e2e drives the real card through
`?e2e=1` only: `window.__locus.approvals.requestTestPermission(...)`,
plus `window.__locus.approvals.controller` for assertions on the canonical
pending state. A second `?e2e=1`-only seam,
`window.__e2eObserverFailure = { onChange, onEvent }`, makes the store's
observer callbacks throw so e2e can prove observer failures never break
settlement. Neither seam exists in production mode and no test-approval
button exists in the production UI.