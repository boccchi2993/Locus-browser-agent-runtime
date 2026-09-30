// ============================================================
//  HARNESS PROVIDER-SESSION PREPARATION (UI-independent ESM module)
//  The protocol-replay and durable-sequencing half of task setup,
//  extracted verbatim from src/ui/store.js in M1a:
//    ensureSession          (was ensureProviderSession)
//    restoreInto            (was restoreSessionForConversation)
//    makeContext            (was makePersistenceContext)
//    sessionCompatible      (was sessionCompatible)
//  Behavior is intentionally identical; only the dependency style
//  changed — every classic-script global (PersistenceServiceInstance,
//  getProviderAdapter, projectNormalizedHistory, validate*) is now an
//  injected port owned by the Product wiring in src/ui/store.js.
//
//  deps = {
//    persistence: { get, loadProviderSession, loadProviderFrames,
//                   loadNormalizedMessages, saveProviderSession,
//                   appendProviderFrame, saveNormalizedMessage }
//    persistConversation(conv, opts?)   — Product projection persistence
//    reportIssue(error, message)        — Product storage notice
//    getAdapter({dialect, apiBase})     — getProviderAdapter
//    providerConfig()                   — current provider configuration
//    createProviderIdentity(config)
//    projectHistory(messages, dialect)  — projectNormalizedHistory
//    validateReplayPrefix(session, frames, adapter)   — OPTIONAL since the
//    validateNormalizedPrefix(conversationId, rows)   — review round F3:
//        both default to the HARNESS algorithms in ./replay-validation.js;
//        an explicit injection still wins (test seam). The Product wiring
//        supplies only storage/config/projection adapters — never the
//        validation algorithm.
//    durableId(prefix), now()
//  }
//  `conv` is a plain conversation record; `session` is the AgentSession
//  -shaped object { reset(), history, replayBlocked } — passed in, never
//  imported. The module never touches Vue, the DOM or other globals.
// ============================================================

import {
  validateReplayPrefix as harnessValidateReplayPrefix,
  validateNormalizedPrefix as harnessValidateNormalizedPrefix,
} from './replay-validation.js';

export function createProviderSessions(deps) {
  const required = ['persistence', 'persistConversation', 'reportIssue', 'getAdapter',
    'providerConfig', 'createProviderIdentity', 'projectHistory', 'durableId', 'now'];
  for (const k of required) {
    if (!deps || !deps[k]) throw new Error('provider sessions: ' + k + ' is required');
  }
  // Validation algorithms default to the Harness implementation (review
  // round F3); an explicit injection keeps working as a test seam.
  const validateReplayPrefix = deps.validateReplayPrefix || harnessValidateReplayPrefix;
  const validateNormalizedPrefix = deps.validateNormalizedPrefix || harnessValidateNormalizedPrefix;
  const p = deps.persistence;
  for (const m of ['get', 'loadProviderSession', 'loadProviderFrames', 'loadNormalizedMessages',
    'saveProviderSession', 'appendProviderFrame', 'saveNormalizedMessage']) {
    if (typeof p[m] !== 'function') throw new Error('provider sessions: persistence.' + m + ' is required');
  }

  const persistConversation = deps.persistConversation;
  const reportIssue = deps.reportIssue;

  function sessionCompatible(meta, config) {
    try {
      const adapter = deps.getAdapter({ dialect: config.dialect, apiBase: config.apiBase });
      return !!(adapter && typeof adapter.isRawReplayCompatible === 'function'
        && adapter.isRawReplayCompatible(meta, config));
    } catch (e) { return false; }
  }

  async function ensureSession(conv) {
    const config = deps.providerConfig();
    let previous = conv && conv.activeProviderSessionId ? await p.get('providerSessions', conv.activeProviderSessionId) : null;
    if (!previous) previous = conv ? await p.loadProviderSession(conv.id) : null;
    if (previous && conv.persistenceState !== 'degraded' && sessionCompatible(previous, config)) {
      if (previous.nextFrameSequence == null) {
        const frames = await p.loadProviderFrames(previous.id);
        previous.nextFrameSequence = frames.reduce((n, f) => Math.max(n, f.sequence || 0), 0);
      }
      if (previous.nextNormalizedSequence == null) {
        const messages = await p.loadNormalizedMessages(conv.id);
        previous.nextNormalizedSequence = messages.reduce((n, m) => Math.max(n, m.sequence || 0), 0);
      }
      if (conv.activeProviderSessionId !== previous.id) {
        conv.activeProviderSessionId = previous.id;
        await persistConversation(conv, { required: true });
      }
      return previous;
    }
    const row = {
      id: deps.durableId('provider-session'), conversationId: conv.id,
      provider: config.provider, adapterId: config.adapterId, dialect: config.dialect,
      model: config.model, endpointIdentity: config.endpointIdentity,
      protocolVersion: config.protocolVersion,
      providerIdentity: deps.createProviderIdentity(config),
      createdAt: deps.now(), updatedAt: deps.now(),
      replayCheckpointSequence: 0, nextFrameSequence: 0, nextNormalizedSequence: 0,
      persistenceState: 'healthy', rawReplayInvalid: false, schemaVersion: 2,
    };
    row._projectedHistory = await p.loadNormalizedMessages(conv.id);
    row.nextNormalizedSequence = row._projectedHistory.reduce((n, message) => Math.max(n, message.sequence || 0), 0);
    try { validateNormalizedPrefix(conv.id, row._projectedHistory); }
    catch (e) {
      row._projectedHistory = [];
      row._replayBlocked = true;
      row.replayError = { code: e.code || 'normalized_invalid', message: e.message || String(e) };
    }
    const persistedRow = Object.assign({}, row);
    delete persistedRow._projectedHistory;
    await p.saveProviderSession(persistedRow);
    conv.activeProviderSessionId = row.id;
    await persistConversation(conv, { required: true });
    return row;
  }

  async function restoreInto(session, conv) {
    if (!conv) return null;
    const config = deps.providerConfig();
    const adapter = deps.getAdapter({ dialect: config.dialect, apiBase: config.apiBase });
    const previous = conv.activeProviderSessionId
      ? await p.get('providerSessions', conv.activeProviderSessionId)
      : await p.loadProviderSession(conv.id);
    session.reset();
    session.replayBlocked = false;
    if (!previous) return null;
    if (sessionCompatible(previous, config) && conv.persistenceState !== 'degraded') {
      const allFrames = await p.loadProviderFrames(previous.id);
      const frames = allFrames.filter((frame) => frame.sequence <= previous.replayCheckpointSequence);
      try {
        validateReplayPrefix(previous, frames, adapter);
        // A durable suffix exists when a response/tool result was archived but
        // the checkpoint write failed.  It is intentionally not replay-safe:
        // reusing only the old checkpoint could execute an already-side-effecting
        // tool a second time after reload.
        if (allFrames.some((frame) => frame.sequence > previous.replayCheckpointSequence)) {
          throw Object.assign(new Error('durable transcript has an uncheckpointed suffix'), {
            name: 'ReplayValidationError', code: 'uncheckpointed_suffix', replayInvalid: true,
          });
        }
        session.history = frames.map((f) => f.raw).filter(Boolean);
      } catch (e) {
        previous.rawReplayInvalid = true;
        previous.persistenceState = 'invalid';
        previous.replayError = { code: e.code || 'replay_invalid', message: e.message || String(e) };
        conv.runState = 'interrupted';
        conv.status = 'interrupted';
        conv.persistenceState = 'degraded';
        conv.replayState = 'raw_invalid';
        await p.saveProviderSession(previous);
        await persistConversation(conv);
        try {
          const normalized = await p.loadNormalizedMessages(conv.id);
          validateNormalizedPrefix(conv.id, normalized);
          // The semantic projection is useful for inspection/recovery, but a
          // corrupt raw checkpoint is never silently turned into a new provider
          // request. Starting a fresh task creates a new safe boundary.
          session.replayBlocked = true;
          session.history = deps.projectHistory(normalized, config.dialect);
        } catch (normalizedError) {
          session.history = [];
          session.replayBlocked = true;
          conv.replayState = 'blocked';
          conv.replayError = { code: normalizedError.code || 'normalized_invalid', message: normalizedError.message || String(normalizedError) };
          await persistConversation(conv);
        }
      }
    } else {
      const normalized = await p.loadNormalizedMessages(conv.id);
      try {
        validateNormalizedPrefix(conv.id, normalized);
        session.history = deps.projectHistory(normalized, config.dialect);
      } catch (e) {
        session.history = [];
        session.replayBlocked = true;
        conv.runState = 'interrupted';
        conv.status = 'interrupted';
        conv.persistenceState = 'degraded';
        conv.replayState = 'blocked';
        conv.replayError = { code: e.code || 'normalized_invalid', message: e.message || String(e) };
        await persistConversation(conv);
      }
    }
    return previous;
  }

  function makeContext(conv, providerSession) {
    let frameSequence = providerSession.nextFrameSequence || 0;
    let normalizedSequence = providerSession.nextNormalizedSequence || 0;
    return {
      async onUserMessage(text, userContent) {
        // Rich user content (docs/IMAGE-INPUT.md): the raw provider frame
        // and the normalized row keep SEMANTIC image parts (attachmentId +
        // sha256 refs into the durable store) — never base64. Replay
        // materializes the bytes at request time through the gate.
        const parts = Array.isArray(userContent) && userContent.length ? userContent : null;
        const raw = { role: 'user', content: parts || text };
        await p.appendProviderFrame({
          sessionId: providerSession.id, conversationId: conv.id,
          sequence: ++frameSequence, turnId: providerSession.id,
          direction: 'outbound', role: 'user', kind: 'user', raw: raw,
        });
        await p.saveNormalizedMessage({
          conversationId: conv.id, sequence: ++normalizedSequence,
          role: 'user', kind: 'message', text: text,
          contentParts: parts || null,
        });
        providerSession.nextFrameSequence = frameSequence;
        providerSession.nextNormalizedSequence = normalizedSequence;
        // A user frame is a safe replay boundary. If the browser dies before
        // the provider answers, the next run can still resume from this turn
        // without replaying a dangling assistant/tool frame.
        providerSession.replayCheckpointSequence = frameSequence;
        providerSession.updatedAt = deps.now();
        await p.saveProviderSession(providerSession);
      },
      async onProviderFrame(payload) {
        const raw = payload.raw || null;
        const frame = await p.appendProviderFrame({
          sessionId: providerSession.id, conversationId: conv.id,
          sequence: ++frameSequence, turnId: providerSession.id,
          direction: payload.role === 'assistant' ? 'inbound' : 'outbound',
          role: payload.role || (raw && raw.role) || null, kind: payload.kind || 'message', raw: raw,
          toolCallId: payload.toolCallId || null,
        });
        providerSession.updatedAt = deps.now();
        providerSession.nextFrameSequence = frameSequence;
        providerSession.nextNormalizedSequence = normalizedSequence;
        if (payload.rawResponse) {
          await p.saveNormalizedMessage({
            conversationId: conv.id, sequence: ++normalizedSequence,
            role: 'assistant', kind: payload.rawResponse.toolCalls ? 'tool_call' : 'message', text: payload.rawResponse.content || '',
            reasoning: payload.rawResponse.reasoning || null,
            toolCalls: payload.rawResponse.toolCalls || null,
          });
        }
        providerSession.nextNormalizedSequence = normalizedSequence;
        await p.saveProviderSession(providerSession);
        return frame;
      },
      async onNormalizedMessage(payload) {
        const row = await p.saveNormalizedMessage(Object.assign({}, payload, {
          conversationId: conv.id, sequence: ++normalizedSequence,
        }));
        providerSession.nextNormalizedSequence = normalizedSequence;
        await p.saveProviderSession(providerSession);
        return row;
      },
      async onCheckpoint(payload) {
        if (!payload || !payload.frame) return;
        providerSession.replayCheckpointSequence = payload.frame.sequence || providerSession.replayCheckpointSequence || 0;
        providerSession.updatedAt = deps.now();
        await p.saveProviderSession(providerSession);
      },
      async onPersistenceError(error) {
        providerSession.persistenceState = 'degraded';
        providerSession.lastPersistenceError = { code: error.code || 'persistence_write_failed', message: error.message || String(error) };
        try { await p.saveProviderSession(providerSession); } catch (ignored) {}
        conv.persistenceState = 'degraded';
        conv.runState = 'interrupted';
        conv.status = 'interrupted';
        await persistConversation(conv);
      },
      async onPersistenceWarning(error) {
        reportIssue(error, 'Optional persistence warning');
      },
    };
  }

  return {
    ensureSession: ensureSession,
    restoreInto: restoreInto,
    makeContext: makeContext,
    sessionCompatible: sessionCompatible,
  };
}
