// ============================================================
//  APPROVAL FRAMEWORK v1 (UI-independent)
//
//  A suspendable approval primitive: the Harness asks, the current
//  async execution PAUSES on a pending Promise, the UI renders a card,
//  a human decides, and the SAME Promise resolves so the SAME task
//  continues. Approval is suspension, never task termination — a deny
//  only rejects the current action; cancelling the task flows through
//  the AbortSignal and resolves the request as 'cancelled'.
//
//  Two separate layers (docs/APPROVALS.md):
//    Authority — what the runtime can technically access (VFS mounts,
//                workspace permissions, provider boundaries). Owned
//                elsewhere; never touched by this module.
//    Approval  — whether an action the Harness already judged technically
//                executable needs human consent first.
//
//  Invariants enforced here:
//    - Hard authority cannot be bypassed by approval. Approval can reduce
//      autonomy; it cannot manufacture authority.
//    - Requests are constructed by the Harness. The model cannot supply
//      policy keys, buttons, or HTML — every request field is validated
//      and carried as plain text.
//    - At most ONE pending interactive request. A second request while
//      one is unresolved fails loudly (ApprovalBusyError) instead of
//      queueing or overwriting.
//    - Every request has a unique id; resolving/cancelling a stale id is
//      a no-op. Old UI decisions can never land on a newer request.
//    - Session grants are exact-normalized-policyKey matches held in
//      memory only ("Allow for this session" = this page session). They
//      never persist and never widen authority.
//    - Decisions are structured ({ outcome, scope, requestId }), never a
//      bare boolean: 'allow once' and 'allow for session' differ, and
//      'deny' is distinct from 'cancelled'.
//    - Observer callbacks (onChange/onEvent) are presentation/debug
//      surfaces, never control flow: a throwing observer is contained
//      and reported console-only. It cannot decide outcomes, block
//      Promise settlement, strand pending state or auto-allow.
//    - An allow decision authorizes an ACTION, not task liveness. What
//      happens between decision delivery and the start of the protected
//      side effect is known only to the consumer, which MUST re-check
//      the task AbortSignal immediately before that side effect
//      (docs/APPROVALS.md, "Consumer execution contract"). This
//      controller deliberately does not enforce task liveness.
//
//  The controller is framework/DOM/Vue/provider/tool independent. The
//  pending state owner is this class; UI stores are projections via the
//  onChange callback.
// ============================================================

function approvalMakeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function ApprovalError(message, code) {
  const e = new Error(message);
  e.name = 'ApprovalError';
  e.code = code || 'approval_error';
  return e;
}

function ApprovalBusyError(message) {
  const e = ApprovalError(message, 'approval_busy');
  e.name = 'ApprovalBusyError';
  return e;
}

// kind → fixed decision schema. UI choice sets are derived from the kind,
// never from caller/model data. 'permission' is the only kind v1 consumes;
// 'capability' (e.g. image-input: yes/no/unsure) and 'confirmation' are
// reserved schemas so the controller is not hardwired to allow/deny.
const APPROVAL_KINDS = {
  permission: { outcomes: ['allow', 'deny'], sessionScope: true },
  capability: { outcomes: ['confirm', 'decline', 'unsure'], sessionScope: false },
  confirmation: { outcomes: ['confirm', 'cancel'], sessionScope: false },
};

// Grants match the EXACT normalized policy key: trim, require non-empty.
// Model-supplied strings ("*", "allow everything") are just keys that were
// never granted — only a Harness-constructed request can create a grant.
function normalizePolicyKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  return k ? k : null;
}

function normalizeText(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

// Observer failure containment (docs/APPROVALS.md, "Observer failures"):
// onChange/onEvent are best-effort presentation/debug observers. A throw
// from either must NEVER re-enter approval control flow — it cannot
// settle, reject or strand a request, cannot mint or drop a grant and
// cannot auto-allow. Failures are reported console-only: never as a
// semantic Agent event and never into provider/model history.
function safeNotify(label, invoke) {
  try {
    invoke();
  } catch (error) {
    try {
      console.error('ApprovalController: ' + label + ' observer threw (contained):', error);
    } catch (ignored) {}
  }
}

function normalizeAction(action) {
  const a = action && typeof action === 'object' ? action : {};
  return {
    type: normalizeText(a.type),
    summary: normalizeText(a.summary),
    detail: normalizeText(a.detail),
  };
}

function normalizeResource(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const r = {
    type: normalizeText(resource.type),
    key: normalizeText(resource.key),
    label: normalizeText(resource.label),
  };
  return (r.type || r.key || r.label) ? r : null;
}

// ------------------------------------------------------------
//  ApprovalController
//
//  new ApprovalController({ onChange, onEvent })
//    onChange(pending | null) — projection hook for UI stores. The
//                  controller stays the canonical pending-state owner.
//                  Best-effort: a throwing projection is contained and
//                  never blocks settlement or strands pending state.
//    onEvent(name, data)    — lightweight debug hook (best-effort, same
//                  containment):
//                  approval_requested / approval_resolved /
//                  approval_cancelled / approval_grant_added /
//                  approval_grant_hit / approval_grants_cleared
//
//  request(spec, { signal }) → Promise<decision>
//    spec: { kind, action: { type, summary, detail },
//            resource: { type, key, label }, policyKey,
//            conversationId, taskGeneration }
//    decision: { outcome: 'allow'|'deny'|'cancelled', scope: 'once'|'session',
//                requestId, reason? }
//  request() NEVER rejects — including when an observer callback throws.
//  A delivered decision authorizes the action only; task liveness after
//  delivery is the consumer's responsibility (final AbortSignal recheck
//  immediately before the protected side effect — docs/APPROVALS.md,
//  "Consumer execution contract").
//  resolve(requestId, decision) / cancel(requestId, reason) /
//  cancelAll(reason) / clearSessionGrants() / hasPending()
// ------------------------------------------------------------
class ApprovalController {
  constructor(options) {
    const o = options || {};
    this._onChange = typeof o.onChange === 'function' ? o.onChange : function () {};
    this._onEvent = typeof o.onEvent === 'function' ? o.onEvent : function () {};
    this._pending = null;        // canonical request while unresolved
    this._resolvePending = null; // resolves the request() Promise
    this._signal = null;
    this._signalHandler = null;
    this._grants = new Map();    // normalized policyKey → { requestId, createdAt }
    this._seq = 0;
  }

  // Canonical pending request (read-only projection source).
  get pending() { return this._pending; }

  hasPending() { return !!this._pending; }

  hasSessionGrant(policyKey) {
    const k = normalizePolicyKey(policyKey);
    return !!k && this._grants.has(k);
  }

  clearSessionGrants() {
    this._grants.clear();
    safeNotify('onEvent', () => this._onEvent('approval_grants_cleared', {}));
  }

  // Ask for human approval. Resolves when the UI (or an abort, or a
  // session grant) decides. NEVER rejects: callers check decision.outcome,
  // so no unhandled rejections and no dangling promises.
  request(spec, options) {
    if (this._pending) {
      throw new ApprovalBusyError(
        'ApprovalController: another approval request is already pending (id ' + this._pending.id + ')');
    }
    const s = spec && typeof spec === 'object' ? spec : {};
    const kindSpec = APPROVAL_KINDS[s.kind];
    if (!kindSpec) {
      throw ApprovalError('unknown approval kind: ' + String(s.kind), 'unknown_kind');
    }
    const policyKey = normalizePolicyKey(s.policyKey);
    if (s.kind === 'permission' && !policyKey) {
      throw ApprovalError('permission requests require a Harness-constructed policyKey', 'missing_policy_key');
    }

    // A session grant covers this exact policy key: resolve immediately —
    // no pending state, no UI, no busy interaction.
    if (policyKey && this._grants.has(policyKey)) {
      safeNotify('onEvent', () => this._onEvent('approval_grant_hit', { policyKey: policyKey }));
      return Promise.resolve({ outcome: 'allow', scope: 'session', requestId: null, viaGrant: true });
    }

    const id = 'apr-' + (++this._seq).toString(36) + '-' + approvalMakeId();
    const request = {
      id: id,
      kind: s.kind,
      action: normalizeAction(s.action),
      resource: normalizeResource(s.resource),
      policyKey: policyKey,
      conversationId: normalizeText(s.conversationId),
      // F-A34: INFORMATIONAL CONTEXT ONLY — debugging, UI diagnostics and
      // future audit events. Never a security enforcement token, never an
      // authorization identity and never a replacement for the AbortSignal:
      // runtime liveness enforcement relies on requestId + AbortSignal +
      // the caller's final liveness recheck (docs/APPROVALS.md).
      taskGeneration: Number.isFinite(s.taskGeneration) ? s.taskGeneration : null,
      createdAt: new Date().toISOString(),
    };
    if (!request.action.summary) {
      throw ApprovalError('approval request requires a non-empty action.summary', 'missing_summary');
    }

    const signal = options && options.signal ? options.signal : null;
    if (signal && signal.aborted) {
      // Task already cancelled before the ask: nothing to show, nothing pending.
      return Promise.resolve({ outcome: 'cancelled', scope: 'once', requestId: id, reason: 'aborted' });
    }

    return new Promise((resolve) => {
      this._pending = request;
      this._resolvePending = resolve;
      if (signal) {
        this._signal = signal;
        this._signalHandler = () => { this.cancel(id, 'aborted'); };
        signal.addEventListener('abort', this._signalHandler, { once: true });
      }
      // Canonical pending state is registered ABOVE, before the observers
      // run: even a throwing projection can never leave a half-created
      // request, and these contained throws can never reject this Promise
      // (request() never rejects).
      safeNotify('onEvent', () => this._onEvent('approval_requested', { id: id, kind: request.kind, policyKey: request.policyKey }));
      safeNotify('onChange', () => this._onChange(request));
    });
  }

  // Apply a UI decision to the CURRENT pending request. A stale id (old
  // card, old handler, late click) is a no-op — it can never resolve a
  // newer request. Invalid decision shapes fail loudly: that is a caller
  // bug, not a user choice.
  resolve(requestId, decision) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return false;
    const kindSpec = APPROVAL_KINDS[pending.kind];
    const d = decision && typeof decision === 'object' ? decision : {};
    if (kindSpec.outcomes.indexOf(d.outcome) === -1) {
      throw ApprovalError(
        'invalid outcome "' + String(d.outcome) + '" for approval kind "' + pending.kind + '"',
        'invalid_decision');
    }
    const scope = d.scope || 'once';
    if (scope !== 'once' && scope !== 'session') {
      throw ApprovalError('invalid decision scope: ' + String(scope), 'invalid_scope');
    }
    if (scope === 'session') {
      // Session scope exists to GRANT: only a positive outcome may carry it
      // (spec: deny is always scope 'once' — a deny never creates a rule).
      const grantOutcome = d.outcome === 'allow' || d.outcome === 'confirm';
      if (!grantOutcome || !kindSpec.sessionScope || !pending.policyKey) {
        throw ApprovalError('decision outcome "' + String(d.outcome) + '" cannot carry session scope', 'invalid_scope');
      }
    }
    this._finish(pending.id, { outcome: d.outcome, scope: scope, requestId: pending.id }, 'approval_resolved');
    if (scope === 'session' && pending.policyKey) {
      this._grants.set(pending.policyKey, { requestId: pending.id, createdAt: new Date().toISOString() });
      safeNotify('onEvent', () => this._onEvent('approval_grant_added', { policyKey: pending.policyKey }));
    }
    return true;
  }

  // Close one request without a user decision (task cancel, session
  // boundary, abort). Resolves 'cancelled' — distinct from 'deny'.
  cancel(requestId, reason) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return false;
    this._finish(pending.id, {
      outcome: 'cancelled', scope: 'once', requestId: pending.id, reason: reason || 'cancelled',
    }, 'approval_cancelled');
    return true;
  }

  cancelAll(reason) {
    if (!this._pending) return false;
    return this.cancel(this._pending.id, reason);
  }

  _finish(requestId, decision, eventName) {
    const pending = this._pending;
    if (!pending || pending.id !== requestId) return;
    if (this._signal && this._signalHandler) {
      this._signal.removeEventListener('abort', this._signalHandler);
    }
    const resolve = this._resolvePending;
    // Canonical cleanup happens FIRST and exactly once (the id guard above
    // makes every later finish/resolve/cancel for this id a no-op).
    this._pending = null;
    this._resolvePending = null;
    this._signal = null;
    this._signalHandler = null;
    try {
      // Observers stay best-effort: each is individually contained, so the
      // UI projection still clears BEFORE the awaiting continuation resumes
      // and an observer throw can never prevent settlement.
      safeNotify('onEvent', () => this._onEvent(eventName, { id: pending.id, outcome: decision.outcome, scope: decision.scope }));
      safeNotify('onChange', () => this._onChange(null));
    } finally {
      // Unconditional exactly-once settlement — the invariant observers
      // must never be able to break.
      resolve(decision);
    }
  }
}
