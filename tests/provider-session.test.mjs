// Provider-session preparation tests (node, no DOM, no Vue, no store import).
// Drives the PUBLIC entry of src/harness/provider-session.js (M1a extraction
// of ensureProviderSession / restoreSessionForConversation /
// makePersistenceContext from src/ui/store.js) through a fake persistence
// port and asserts the replay/durable-sequencing semantics survived the
// move unchanged:
//
//   P1  ensureSession reuses a compatible previous session and realigns
//       its sequence cursors (required conversation persist on rebind)
//   P2  ensureSession creates a fresh row; an invalid normalized prefix
//       marks the row replay-blocked without throwing
//   P3  restoreInto rejects an uncheckpointed durable suffix: raw replay
//       is invalidated, conversation degraded, normalized projection
//       loaded read-only (replayBlocked)
//   P4  restoreInto with an incompatible session projects the normalized
//       history instead of replaying raw frames
//   P5  makeContext advances frame/normalized cursors in order and a
//       failing required write propagates the raw error (the runner
//       classifies it as persistence_error)
//
// Run: node tests/provider-session.test.mjs

import { createProviderSessions } from '../src/harness/provider-session.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function makeDeps(overrides) {
  const o = overrides || {};
  const calls = { persistConversation: [], reportIssue: [], frames: [], normalized: [], sessions: [] };
  const store = {
    providerSessions: new Map(),
    framesBySession: new Map(),
    normalizedByConversation: new Map(),
    conversations: new Map(),
  };
  const persistence = {
    async get(name, key) { return store[name].get(key) || null; },
    async loadProviderSession(conversationId) {
      for (const row of store.providerSessions.values()) if (row.conversationId === conversationId) return row;
      return null;
    },
    async loadProviderFrames(sessionId) { return (store.framesBySession.get(sessionId) || []).slice(); },
    async loadNormalizedMessages(conversationId) { return (store.normalizedByConversation.get(conversationId) || []).slice(); },
    async saveProviderSession(row) { store.providerSessions.set(row.id, row); calls.sessions.push(row.id); return row; },
    async appendProviderFrame(frame) {
      const list = store.framesBySession.get(frame.sessionId) || [];
      list.push(frame); store.framesBySession.set(frame.sessionId, list);
      calls.frames.push(frame);
      if (o.failAppendFrames) throw new Error('frame write failed');
      return frame;
    },
    async saveNormalizedMessage(row) {
      const list = store.normalizedByConversation.get(row.conversationId) || [];
      list.push(row); store.normalizedByConversation.set(row.conversationId, list);
      calls.normalized.push(row);
      if (o.failNormalized) throw new Error('normalized write failed');
      return row;
    },
  };
  const deps = {
    persistence,
    persistConversation: (conv, opts) => { calls.persistConversation.push({ id: conv.id, required: !!(opts && opts.required) }); return Promise.resolve(); },
    reportIssue: (error, message) => { calls.reportIssue.push(message); },
    getAdapter: () => ({ dialect: 'openai', isRawReplayCompatible: (meta) => !(o.incompatible && meta.id === 'sess-old') }),
    providerConfig: () => ({ provider: 'openai', adapterId: 'openai', dialect: 'openai', apiBase: 'https://x.example/v1', model: 'm1', endpointIdentity: 'https://x.example', protocolVersion: '1' }),
    createProviderIdentity: (config) => ({ provider: config.provider, dialect: config.dialect, endpointIdentity: config.endpointIdentity }),
    projectHistory: (messages, dialect) => messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' })),
    validateReplayPrefix: (session, frames) => { if (o.failReplay) throw Object.assign(new Error('replay invalid'), { code: 'replay_invalid' }); },
    validateNormalizedPrefix: (conversationId, rows) => { if (o.failNormalizedPrefix) throw Object.assign(new Error('normalized invalid'), { code: 'normalized_invalid' }); },
    durableId: (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 8),
    now: () => '2026-09-29T00:00:00.000Z',
  };
  return { deps, calls, store };
}

function fakeSession() {
  return {
    history: [],
    replayBlocked: false,
    generation: 0,
    resetCount: 0,
    reset() { this.resetCount++; this.generation++; this.history = []; },
  };
}

// ---------- P1: reuse compatible previous ----------
{
  const { deps, calls, store } = makeDeps();
  const conv = { id: 'conv-1', persistenceState: 'healthy' };
  store.providerSessions.set('sess-old', {
    id: 'sess-old', conversationId: 'conv-1', persistenceState: 'healthy',
    rawReplayInvalid: false, replayCheckpointSequence: 3,
  });
  store.framesBySession.set('sess-old', [{ sequence: 1, raw: { role: 'user', content: 'q' } }, { sequence: 2 }, { sequence: 3 }]);
  store.normalizedByConversation.set('conv-1', [{ sequence: 7, role: 'user', text: 'q' }]);
  const ps = createProviderSessions(deps);
  const row = await ps.ensureSession(conv);
  check('P1 reuses the compatible previous session', row.id === 'sess-old');
  check('P1 realigns frame + normalized cursors from durable rows',
    row.nextFrameSequence === 3 && row.nextNormalizedSequence === 7, JSON.stringify({ f: row.nextFrameSequence, n: row.nextNormalizedSequence }));
  check('P1 conversation rebind persisted as required',
    conv.activeProviderSessionId === 'sess-old' && calls.persistConversation.some((c) => c.id === 'conv-1' && c.required));
}

// ---------- P2: fresh row + invalid normalized prefix ----------
{
  const { deps, calls } = makeDeps({ failNormalizedPrefix: true });
  const conv = { id: 'conv-2', persistenceState: 'healthy' };
  const ps = createProviderSessions(deps);
  const row = await ps.ensureSession(conv);
  check('P2 fresh session row created and bound', !!row.id && conv.activeProviderSessionId === row.id && row.rawReplayInvalid === false);
  check('P2 invalid normalized prefix ⇒ _replayBlocked flagged, not thrown',
    row._replayBlocked === true && row.replayError && row.replayError.code === 'normalized_invalid'
    && row._projectedHistory.length === 0);
}

// ---------- P3: uncheckpointed suffix rejected on restore ----------
{
  const { deps, store } = makeDeps();
  const conv = { id: 'conv-3', persistenceState: 'healthy' };
  store.providerSessions.set('sess-3', {
    id: 'sess-3', conversationId: 'conv-3', persistenceState: 'healthy',
    rawReplayInvalid: false, replayCheckpointSequence: 1,
  });
  // frame 2 was archived AFTER the last checkpoint (checkpoint write failed)
  store.framesBySession.set('sess-3', [
    { sequence: 1, raw: { role: 'user', content: 'q' } },
    { sequence: 2, raw: { role: 'assistant', content: 'partial' } },
  ]);
  store.normalizedByConversation.set('conv-3', [{ sequence: 1, role: 'user', text: 'q' }, { sequence: 2, role: 'assistant', text: 'partial' }]);
  const ps = createProviderSessions(deps);
  const session = fakeSession();
  await ps.restoreInto(session, conv);
  check('P3 raw replay invalidated: replayBlocked + degraded conversation',
    session.replayBlocked === true && conv.persistenceState === 'degraded' && conv.replayState === 'raw_invalid');
  check('P3 normalized projection loaded instead (never replayed raw)',
    session.history.length === 2 && session.history[0].content === 'q' && session.history[1].content === 'partial');
  check('P3 provider session persisted as invalid', store.providerSessions.get('sess-3').rawReplayInvalid === true);
}

// ---------- P4: incompatible session projects normalized history ----------
{
  const { deps, store } = makeDeps({ incompatible: true });
  const conv = { id: 'conv-4', persistenceState: 'healthy' };
  store.providerSessions.set('sess-old', {
    id: 'sess-old', conversationId: 'conv-4', persistenceState: 'healthy',
    rawReplayInvalid: false, replayCheckpointSequence: 9,
  });
  store.normalizedByConversation.set('conv-4', [{ sequence: 1, role: 'user', text: 'hello' }]);
  const ps = createProviderSessions(deps);
  const session = fakeSession();
  await ps.restoreInto(session, conv);
  check('P4 incompatible session falls back to the normalized projection',
    session.history.length === 1 && session.history[0].content === 'hello' && session.replayBlocked === false);
  check('P4 session was reset before rebuilding history', session.resetCount === 1);
}

// ---------- P5: makeContext ordering + required-write failure ----------
{
  const { deps, calls } = makeDeps();
  const conv = { id: 'conv-5', persistenceState: 'healthy' };
  const row = { id: 'sess-5', conversationId: 'conv-5', nextFrameSequence: 0, nextNormalizedSequence: 0, replayCheckpointSequence: 0 };
  const ps = createProviderSessions(deps);
  const ctx = ps.makeContext(conv, row);
  await ctx.onUserMessage('first question', null);
  check('P5 onUserMessage writes frame then normalized then session, and checkpoints at the user frame',
    row.nextFrameSequence === 1 && row.nextNormalizedSequence === 1 && row.replayCheckpointSequence === 1);
  const frame = await ctx.onProviderFrame({ role: 'assistant', kind: 'assistant', raw: { role: 'assistant', content: 'a' }, rawResponse: { content: 'a' } });
  check('P5 onProviderFrame returns the persisted frame and advances both cursors',
    frame.sequence === 2 && row.nextFrameSequence === 2 && row.nextNormalizedSequence === 2);
  await ctx.onCheckpoint({ frame, reason: 'assistant_final' });
  check('P5 checkpoint advances only the replay boundary', row.replayCheckpointSequence === 2 && row.nextFrameSequence === 2);
  // Required-write failure: the error must propagate (the task runner turns
  // it into persistence_error and stops before any model request).
  const { deps: deps2 } = makeDeps({ failNormalized: true });
  const ps2 = createProviderSessions(deps2);
  const ctx2 = ps2.makeContext({ id: 'conv-5b' }, { id: 'sess-5b', nextFrameSequence: 0, nextNormalizedSequence: 0 });
  let threw = null;
  try { await ctx2.onUserMessage('will fail', null); } catch (e) { threw = e; }
  check('P5 a failing required write propagates unswallowed', threw !== null && /normalized write failed/.test(threw.message));
  void deps; void calls;
}

console.log('---');
console.log('provider-session.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
