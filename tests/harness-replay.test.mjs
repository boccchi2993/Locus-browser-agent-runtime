// Harness replay-validation ownership (M2b review round F3): the
// durable-prefix validators live in the HARNESS (src/harness/replay-
// validation.js, re-exported by the public entry) and
// createProviderSessions defaults to them — so a standalone host can
// restore provider sessions with the REAL semantics, no Product module
// and no injected fake validator. Every case here obtains the validators,
// the adapter and the session factory from the harness ENTRY and drives a
// full restore over an in-memory store. A validator that always returned
// { valid: true } could not produce any assertion below.
// Run: node tests/harness-replay.test.mjs

import {
  ensureHarnessCore, createProviderSessions, getProviderAdapter,
  createProviderIdentity, projectNormalizedHistory,
  validateReplayPrefix, validateNormalizedPrefix,
} from '../src/harness/index.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- in-memory Product storage (the ONLY Product-provided part) ----------
function memoryPersistence() {
  const sessions = new Map();   // providerSessions by id
  const framesBySession = new Map(); // sessionId -> frames[]
  const normalizedByConversation = new Map(); // conversationId -> rows[]
  const fail = { saveProviderSession: null };
  return {
    fail,
    sessions, framesBySession, normalizedByConversation,
    async get(name, key) {
      if (name === 'providerSessions') return sessions.get(key) || null;
      return null;
    },
    async loadProviderSession(conversationId) {
      for (const s of sessions.values()) if (s.conversationId === conversationId) return s;
      return null;
    },
    async loadProviderFrames(sessionId) {
      return (framesBySession.get(sessionId) || []).slice().sort((a, b) => a.sequence - b.sequence);
    },
    async loadNormalizedMessages(conversationId) {
      return (normalizedByConversation.get(conversationId) || []).slice().sort((a, b) => a.sequence - b.sequence);
    },
    async saveProviderSession(row) {
      if (fail.saveProviderSession) throw fail.saveProviderSession(row);
      sessions.set(row.id, row);
      return row;
    },
    async appendProviderFrame(frame) {
      if (!framesBySession.has(frame.sessionId)) framesBySession.set(frame.sessionId, []);
      framesBySession.get(frame.sessionId).push(frame);
      return frame;
    },
    async saveNormalizedMessage(row) {
      if (!normalizedByConversation.has(row.conversationId)) normalizedByConversation.set(row.conversationId, []);
      normalizedByConversation.get(row.conversationId).push(row);
      return row;
    },
  };
}

const CONFIG = { dialect: 'openai', apiBase: 'https://api.example.test/v1', model: 'm1' };

// The FULL provider config the store hands to createProviderSessions:
// identity fields resolved through the entry's createProviderIdentity,
// exactly like src/ui/store.js's providerConfig().
function fullConfig() {
  return Object.assign(
    { dialect: CONFIG.dialect, apiBase: CONFIG.apiBase, model: CONFIG.model },
    createProviderIdentity({ dialect: CONFIG.dialect, apiBase: CONFIG.apiBase, model: CONFIG.model }),
  );
}

function harnessDeps(store, extra) {
  return Object.assign({
    persistence: store,
    persistConversation: async () => {},
    reportIssue: () => {},
    getAdapter: (config) => getProviderAdapter(config),
    providerConfig: () => fullConfig(),
    createProviderIdentity: (config) => createProviderIdentity(config),
    projectHistory: (messages, dialect) => projectNormalizedHistory(messages, dialect),
    durableId: (prefix) => prefix + '-test',
    now: () => '2026-10-01T00:00:00.000Z',
  }, extra || {});
}

function plainSession() {
  return { history: [], replayBlocked: false, reset() { this.history = []; this.replayBlocked = false; } };
}

function assistantToolCallRaw() {
  return {
    role: 'assistant', content: 'working',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
}

// A still-open TWO-call batch is the shape whose duplicate result id is
// rejected while the batch is open (a duplicate after a closed single-call
// batch is an UNPAIRED result instead).
function twoCallAssistantRaw() {
  return {
    role: 'assistant', content: 'working',
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
}

// Record a realistic prefix through the REAL context writers (the same
// payload shapes agent.js persists: assistant frames carry kind
// 'assistant'), then checkpoint at the final frame.
async function recordTurn(ctx, userText, assistantRaw, toolResult) {
  await ctx.onUserMessage(userText, null);
  await ctx.onProviderFrame({ role: 'assistant', kind: 'assistant', raw: assistantRaw });
  if (toolResult) {
    await ctx.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: toolResult.toolCallId, raw: toolResult });
  }
  await ctx.onCheckpoint({ frame: { sequence: toolResult ? 3 : 2 } });
}

// ============================================================
async function main() {
  await ensureHarnessCore();
  check('H1 the entry re-exports the REAL validators (functions, not stubs)',
    typeof validateReplayPrefix === 'function' && typeof validateNormalizedPrefix === 'function');

  // ---------- direct validator checks (entry exports, real adapter) ----------
  {
    const adapter = getProviderAdapter({ dialect: 'openai', apiBase: CONFIG.apiBase });
    const session = {
      id: 's-dir', conversationId: 'c-dir', replayCheckpointSequence: 2,
      provider: 'openai', adapterId: adapter.adapterId, dialect: 'openai',
      endpointIdentity: CONFIG.apiBase, model: 'm1', protocolVersion: 'chat-completions-v1',
    };
    const frames = [
      { sequence: 1, sessionId: 's-dir', conversationId: 'c-dir', kind: 'user', role: 'user', raw: { role: 'user', content: 'hi' } },
      { sequence: 2, sessionId: 's-dir', conversationId: 'c-dir', kind: 'assistant', role: 'assistant', raw: { role: 'assistant', content: 'done' } },
    ];
    const ok = validateReplayPrefix(session, frames, adapter);
    check('V1 the entry validator accepts a valid contiguous prefix',
      ok && ok.valid === true && ok.checkpoint === 2 && ok.frames.length === 2, JSON.stringify(ok));
    const codes = [];
    for (const broken of [
      [Object.assign({}, session, { replayCheckpointSequence: -1 }), frames],
      [Object.assign({}, session, { replayCheckpointSequence: 3 }), frames],
      [Object.assign({}, session, { replayCheckpointSequence: 2 }), [frames[0], Object.assign({}, frames[1], { sessionId: 'other' })]],
      [Object.assign({}, session, { replayCheckpointSequence: 2 }), [frames[0], Object.assign({}, frames[1], { sequence: 3 })]],
    ]) {
      try { validateReplayPrefix(broken[0], broken[1], adapter); codes.push('accepted'); }
      catch (e) { codes.push(e.code); }
    }
    check('V2 checkpoint/identity/sequence errors keep their codes',
      JSON.stringify(codes) === JSON.stringify(['checkpoint_invalid', 'checkpoint_beyond_tail', 'session_identity_mismatch', 'sequence_invalid']),
      JSON.stringify(codes));
    const pairing = [];
    const dangling = [frames[0], {
      sequence: 2, sessionId: 's-dir', conversationId: 'c-dir', kind: 'assistant', role: 'assistant',
      raw: assistantToolCallRaw(),
    }];
    // A duplicate id INSIDE a still-open multi-call batch.
    const dup = [frames[0], {
      sequence: 2, sessionId: 's-dir', conversationId: 'c-dir', kind: 'assistant', role: 'assistant',
      raw: twoCallAssistantRaw(),
    }, {
      sequence: 3, sessionId: 's-dir', conversationId: 'c-dir', kind: 'tool_result', role: 'tool_result', toolCallId: 'call-1',
      raw: { role: 'tool_result', toolCallId: 'call-1', content: 'a' },
    }, {
      sequence: 4, sessionId: 's-dir', conversationId: 'c-dir', kind: 'tool_result', role: 'tool_result', toolCallId: 'call-1',
      raw: { role: 'tool_result', toolCallId: 'call-1', content: 'b' },
    }];
    const unpaired = [frames[0], {
      sequence: 2, sessionId: 's-dir', conversationId: 'c-dir', kind: 'tool_result', role: 'tool_result', toolCallId: 'call-x',
      raw: { role: 'tool_result', toolCallId: 'call-x', content: 'x' },
    }];
    for (const set of [dangling, dup, unpaired]) {
      const s = Object.assign({}, session, { replayCheckpointSequence: set.length });
      try { validateReplayPrefix(s, set, adapter); pairing.push('accepted'); }
      catch (e) { pairing.push(e.code); }
    }
    check('V3 dangling/duplicate/unknown tool results keep their codes',
      JSON.stringify(pairing) === JSON.stringify(['tool_batch_dangling', 'tool_result_duplicate', 'tool_result_unpaired']),
      JSON.stringify(pairing));

    const norm = [
      { conversationId: 'c-dir', sequence: 1, role: 'user', kind: 'message', text: 'hi' },
      { conversationId: 'c-dir', sequence: 2, role: 'assistant', kind: 'tool_call', text: '', toolCalls: [{ id: 'call-1', name: 'lookup' }] },
      { conversationId: 'c-dir', sequence: 3, role: 'tool_result', kind: 'tool_result', toolCallId: 'call-1' },
    ];
    check('V4 the entry normalized validator accepts a paired prefix',
      validateNormalizedPrefix('c-dir', norm).valid === true);
    // The validator sorts by sequence before checking, so a genuine HOLE
    // (a missing middle row) is the detectable corruption — not a swap.
    try { validateNormalizedPrefix('c-dir', [norm[0], norm[2]]); check('V4b sequence hole rejected', false); }
    catch (e) { check('V4b sequence hole rejected', e.code === 'normalized_sequence_invalid', e.code); }
  }

  // ---------- full restore over the in-memory store (no injected validators) ----------
  {
    const store = memoryPersistence();
    const sessions = createProviderSessions(harnessDeps(store));
    const conv = { id: 'conv-1', activeProviderSessionId: null, persistenceState: 'healthy' };
    const row = await sessions.ensureSession(conv);
    check('R1 ensureSession creates a fresh session bound to the conversation',
      !!row && row.id === conv.activeProviderSessionId && row.replayCheckpointSequence === 0
      && row._replayBlocked === undefined && Array.isArray(row._projectedHistory) && row._projectedHistory.length === 0,
      JSON.stringify(row && row.id));

    const ctx = sessions.makeContext(conv, row);
    await recordTurn(ctx, 'run lookup', assistantToolCallRaw(), { role: 'tool_result', toolCallId: 'call-1', content: 'OUT' });
    check('R2 the recorded prefix is checkpointed and complete',
      row.replayCheckpointSequence === 3 && (await store.loadProviderFrames(row.id)).length === 3,
      JSON.stringify({ ck: row.replayCheckpointSequence }));

    const restored = plainSession();
    const prev = await sessions.restoreInto(restored, conv);
    check('R3 a valid raw prefix restores through the REAL validator',
      !!prev && prev.id === row.id && restored.replayBlocked === false
      && restored.history.length === 3
      && restored.history[1].tool_calls[0].id === 'call-1'
      && restored.history[2].role === 'tool_result',
      JSON.stringify({ id: prev && prev.id, n: restored.history.length, blocked: restored.replayBlocked }));

    // ---------- checkpoint error → normalized fallback ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-2', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r2 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r2);
      await recordTurn(cx, 'run lookup', assistantToolCallRaw(), { role: 'tool_result', toolCallId: 'call-1', content: 'OUT' });
      // Corrupt the durable state: drop the last frame BEHIND the checkpoint.
      const frames = st.framesBySession.get(r2.id);
      frames.pop();
      const s2 = plainSession();
      await ss.restoreInto(s2, cv);
      check('R4 checkpoint beyond tail → raw replay invalid, degraded, normalized fallback',
        r2.rawReplayInvalid === true && r2.replayError.code === 'checkpoint_beyond_tail'
        && cv.persistenceState === 'degraded' && cv.replayState === 'raw_invalid'
        && s2.replayBlocked === true && s2.history.length === 1 && s2.history[0].role === 'user',
        JSON.stringify({ code: r2.replayError && r2.replayError.code, state: cv.replayState, n: s2.history.length, blocked: s2.replayBlocked }));
    }

    // ---------- identity mismatch → fallback ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-3', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r3 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r3);
      await recordTurn(cx, 'run lookup', assistantToolCallRaw(), { role: 'tool_result', toolCallId: 'call-1', content: 'OUT' });
      st.framesBySession.get(r3.id)[1].sessionId = 'sess-foreign';
      const s3 = plainSession();
      await ss.restoreInto(s3, cv);
      check('R5 identity mismatch is caught by the REAL validator',
        r3.replayError.code === 'session_identity_mismatch' && s3.replayBlocked === true,
        JSON.stringify(r3.replayError));
    }

    // ---------- dangling tool batch → fallback ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-4', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r4 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r4);
      await recordTurn(cx, 'run lookup', assistantToolCallRaw(), null); // no tool result
      const s4 = plainSession();
      await ss.restoreInto(s4, cv);
      check('R6 a checkpoint ending inside a tool batch is rejected',
        r4.replayError.code === 'tool_batch_dangling' && s4.replayBlocked === true,
        JSON.stringify(r4.replayError));
    }

    // ---------- duplicate tool result → fallback ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-5', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r5 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r5);
      await cx.onUserMessage('run', null);
      await cx.onProviderFrame({ role: 'assistant', kind: 'assistant', raw: twoCallAssistantRaw() });
      await cx.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: 'call-1', raw: { role: 'tool_result', toolCallId: 'call-1', content: 'a' } });
      await cx.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: 'call-1', raw: { role: 'tool_result', toolCallId: 'call-1', content: 'b' } });
      await cx.onCheckpoint({ frame: { sequence: 4 } });
      const s5 = plainSession();
      await ss.restoreInto(s5, cv);
      check('R7 a duplicate tool result id is rejected',
        r5.replayError.code === 'tool_result_duplicate' && s5.replayBlocked === true,
        JSON.stringify(r5.replayError));
    }

    // ---------- unknown (unpaired) tool result → fallback ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-6', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r6 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r6);
      await cx.onUserMessage('run', null);
      await cx.onProviderFrame({ role: 'tool_result', kind: 'tool_result', toolCallId: 'call-ghost', raw: { role: 'tool_result', toolCallId: 'call-ghost', content: 'x' } });
      await cx.onCheckpoint({ frame: { sequence: 2 } });
      const s6 = plainSession();
      await ss.restoreInto(s6, cv);
      check('R8 a tool result without a preceding call is rejected',
        r6.replayError.code === 'tool_result_unpaired' && s6.replayBlocked === true,
        JSON.stringify(r6.replayError));
    }

    // ---------- durable uncheckpointed suffix is never replayed ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-7', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r7 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r7);
      await recordTurn(cx, 'run lookup', assistantToolCallRaw(), { role: 'tool_result', toolCallId: 'call-1', content: 'OUT' });
      // A frame archived after the checkpoint write failed.
      await st.appendProviderFrame({
        sessionId: r7.id, conversationId: cv.id, sequence: 4, turnId: r7.id,
        direction: 'inbound', role: 'assistant', kind: 'message', raw: { role: 'assistant', content: 'late' },
      });
      const s7 = plainSession();
      await ss.restoreInto(s7, cv);
      check('R9 an uncheckpointed durable suffix blocks raw replay',
        r7.replayError.code === 'uncheckpointed_suffix' && s7.replayBlocked === true
        && s7.history.length === 1 && s7.history[0].role === 'user',
        JSON.stringify({ code: r7.replayError && r7.replayError.code, n: s7.history.length }));
    }

    // ---------- normalized prefix validation on a NEW session ----------
    {
      const st = memoryPersistence();
      st.normalizedByConversation.set('conv-8', [
        { conversationId: 'conv-8', sequence: 1, role: 'user', kind: 'message', text: 'hi' },
        { conversationId: 'conv-8', sequence: 3, role: 'assistant', kind: 'message', text: 'gap' },
      ]);
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-8', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r8 = await ss.ensureSession(cv);
      check('R10 a normalized sequence hole blocks the fresh session',
        r8._replayBlocked === true && r8.replayError.code === 'normalized_sequence_invalid'
        && r8._projectedHistory.length === 0,
        JSON.stringify(r8.replayError));
    }

    // ---------- incompatible session + invalid normalized → blocked ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      const cv = { id: 'conv-9', activeProviderSessionId: null, persistenceState: 'healthy' };
      const r9 = await ss.ensureSession(cv);
      const cx = ss.makeContext(cv, r9);
      await cx.onUserMessage('hi', null);
      st.normalizedByConversation.set('conv-9', [
        { conversationId: 'conv-9', sequence: 1, role: 'assistant', kind: 'tool_call', text: '', toolCalls: [{ id: 'call-1', name: 'lookup' }] },
        { conversationId: 'conv-9', sequence: 2, role: 'assistant', kind: 'message', text: 'ends inside batch' },
      ]);
      // Make the stored session replay-incompatible (foreign dialect).
      r9.dialect = 'anthropic';
      r9.adapterId = 'anthropic';
      const s9 = plainSession();
      await ss.restoreInto(s9, cv);
      check('R11 an incompatible session with an invalid normalized prefix blocks replay',
        cv.replayState === 'blocked' && cv.replayError.code === 'normalized_tool_batch_dangling'
        && s9.replayBlocked === true && s9.history.length === 0,
        JSON.stringify({ state: cv.replayState, code: cv.replayError && cv.replayError.code }));
    }

    // ---------- required-write failure propagates ----------
    {
      const st = memoryPersistence();
      const ss = createProviderSessions(harnessDeps(st));
      st.fail.saveProviderSession = () => new Error('quota exceeded');
      const cv = { id: 'conv-10', activeProviderSessionId: null, persistenceState: 'healthy' };
      let threw = null;
      try { await ss.ensureSession(cv); } catch (e) { threw = e; }
      check('R12 a failed required session write rejects ensureSession',
        !!threw && /quota exceeded/.test(threw.message),
        String(threw && threw.message));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER FAIL', e && e.stack || e); process.exit(1); });
