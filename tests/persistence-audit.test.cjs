// Adversarial persistence-v1 audit coverage. These tests stay deliberately
// close to the durable contracts: invalid replay never reaches a provider,
// opaque values are not JSON-coerced, credentials are destination-scoped,
// and a required write failure stops the agent before another model turn.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const persistenceSrc = fs.readFileSync(path.join(root, 'src', 'persistence.js'), 'utf8');
const adapterSrc = fs.readFileSync(path.join(root, 'src', 'model-adapters.js'), 'utf8');
const toolsSrc = fs.readFileSync(path.join(root, 'src', 'tools.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(root, 'src', 'agent.js'), 'utf8');
const P = (0, eval)(persistenceSrc + '\n;({ PersistenceService, validateReplayPrefix, validateNormalizedPrefix });');
const A = (0, eval)(adapterSrc + '\n;({ OpenAIAdapter, AnthropicAdapter, createCredentialIdentity, createProviderIdentity, normalizeCredentialEndpoint });');
const G = (0, eval)(toolsSrc + '\n' + agentSrc + '\n;({ AgentSession });');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

function rejects(fn, code) {
  return Promise.resolve().then(fn).then(() => false, (error) => !code || error.code === code);
}

function frame(session, sequence, kind, raw, extra) {
  return Object.assign({
    id: 'frame-' + sequence, sessionId: session.id, conversationId: session.conversationId,
    sequence, kind,
    role: kind === 'assistant' ? 'assistant' : (kind === 'tool_result' ? 'tool_result' : 'user'),
    raw, toolCallId: kind === 'tool_result' && raw ? raw.toolCallId || null : null,
  }, extra || {});
}

function openAiSession(checkpoint) {
  return { id: 's-audit', conversationId: 'c-audit', replayCheckpointSequence: checkpoint,
    provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai',
    endpointIdentity: 'https://gateway.example/v1', model: 'audit', protocolVersion: 'chat-completions-v1',
    persistenceState: 'healthy' };
}

async function run() {
  // ---------- F-05: the raw prefix is a validated protocol boundary ----------
  {
    const good = openAiSession(2);
    const goodFrames = [
      frame(good, 1, 'user', { role: 'user', content: 'hello' }),
      frame(good, 2, 'assistant', { role: 'assistant', content: 'done' }),
    ];
    check('AUD-R1 valid replay prefix accepted', P.validateReplayPrefix(good, goodFrames, A.OpenAIAdapter).valid === true);
    check('AUD-R2 sequence hole rejected', await rejects(() => P.validateReplayPrefix(openAiSession(2), [
      goodFrames[0], frame(good, 3, 'assistant', { role: 'assistant', content: 'late' }),
    ], A.OpenAIAdapter), 'sequence_invalid'));
    check('AUD-R3 duplicate sequence rejected', await rejects(() => P.validateReplayPrefix(openAiSession(3), [
      goodFrames[0], goodFrames[1], frame(good, 2, 'assistant', { role: 'assistant', content: 'duplicate' }),
    ], A.OpenAIAdapter), 'sequence_invalid'));
    check('AUD-R4 checkpoint beyond tail rejected', await rejects(() => P.validateReplayPrefix(openAiSession(3), goodFrames, A.OpenAIAdapter), 'checkpoint_beyond_tail'));
    check('AUD-R5 wrong session identity rejected', await rejects(() => P.validateReplayPrefix(good, [
      frame(good, 1, 'user', { role: 'user', content: 'hello' }, { sessionId: 'foreign' }),
      goodFrames[1],
    ], A.OpenAIAdapter), 'session_identity_mismatch'));

    const toolSession = openAiSession(1);
    const toolCall = { role: 'assistant', content: null, tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'bash', arguments: '{}' } },
      { id: 'call-b', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ] };
    check('AUD-R6 dangling single-tool batch rejected', await rejects(() => P.validateReplayPrefix(toolSession, [
      frame(toolSession, 1, 'assistant', toolCall),
    ], A.OpenAIAdapter), 'tool_batch_dangling'));
    const partial = openAiSession(2);
    check('AUD-R7 partial multi-tool batch rejected', await rejects(() => P.validateReplayPrefix(partial, [
      frame(partial, 1, 'assistant', toolCall),
      frame(partial, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-a', content: 'ok' }, { toolCallId: 'call-a' }),
    ], A.OpenAIAdapter), 'tool_batch_dangling'));
    const complete = openAiSession(3);
    check('AUD-R8 complete multi-tool batch accepted', P.validateReplayPrefix(complete, [
      frame(complete, 1, 'assistant', toolCall),
      frame(complete, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-a', content: 'ok' }, { toolCallId: 'call-a' }),
      frame(complete, 3, 'tool_result', { role: 'tool_result', toolCallId: 'call-b', content: 'ok' }, { toolCallId: 'call-b' }),
    ], A.OpenAIAdapter).valid === true);
    check('AUD-R9 malformed provider raw rejected', await rejects(() => P.validateReplayPrefix(openAiSession(1), [
      frame(openAiSession(1), 1, 'assistant', { role: 'assistant', content: 'x', tool_calls: {} }),
    ], A.OpenAIAdapter), undefined));
    check('AUD-R10 normalized holes rejected', await rejects(() => P.validateNormalizedPrefix('c', [
      { conversationId: 'c', sequence: 1, role: 'user', kind: 'message', text: 'a' },
      { conversationId: 'c', sequence: 3, role: 'assistant', kind: 'message', text: 'b' },
    ]), 'normalized_sequence_invalid'));

    // ---------- F-C01: raw semantic truth cannot be hidden by metadata ----------
    const rawToolCall = { role: 'assistant', content: null, tool_calls: [
      { id: 'call-c01', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ], vendor_opaque: { keep: true } };
    const hiddenKind = openAiSession(1);
    check('C01-1 raw assistant tool call + kind=message rejected', await rejects(() => P.validateReplayPrefix(hiddenKind, [
      frame(hiddenKind, 1, 'message', rawToolCall, { role: 'assistant' }),
    ], A.OpenAIAdapter), 'metadata_kind_mismatch'));
    const hiddenRole = openAiSession(1);
    check('C01-2 raw assistant + role metadata mismatch rejected', await rejects(() => P.validateReplayPrefix(hiddenRole, [
      frame(hiddenRole, 1, 'assistant', rawToolCall, { role: 'user' }),
    ], A.OpenAIAdapter), 'metadata_role_mismatch'));
    const badResultKind = openAiSession(2);
    check('C01-3 raw tool_result + kind mismatch rejected', await rejects(() => P.validateReplayPrefix(badResultKind, [
      frame(badResultKind, 1, 'assistant', rawToolCall),
      frame(badResultKind, 2, 'message', { role: 'tool_result', toolCallId: 'call-c01', content: 'ok' }, { role: 'tool_result' }),
    ], A.OpenAIAdapter), 'metadata_kind_mismatch'));
    const badResultId = openAiSession(2);
    check('C01-4 toolCallId raw/metadata mismatch rejected', await rejects(() => P.validateReplayPrefix(badResultId, [
      frame(badResultId, 1, 'assistant', rawToolCall),
      frame(badResultId, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-c01', content: 'ok' }, { toolCallId: 'call-other' }),
    ], A.OpenAIAdapter), 'tool_result_id_mismatch'));
    let harmlessKindsRejected = true;
    for (const badKind of ['message', 'text', 'unknown', null, '']) {
      const s = openAiSession(1);
      const corrupted = frame(s, 1, badKind, rawToolCall, { role: 'assistant', kind: badKind });
      if (!(await rejects(() => P.validateReplayPrefix(s, [corrupted], A.OpenAIAdapter)))) harmlessKindsRejected = false;
    }
    check('C01-5 harmless metadata cannot hide raw tool call', harmlessKindsRejected);
    const finalSession = openAiSession(2);
    check('C01-6 normal assistant final accepted', P.validateReplayPrefix(finalSession, [
      frame(finalSession, 1, 'user', { role: 'user', content: 'hello' }),
      frame(finalSession, 2, 'assistant', { role: 'assistant', content: 'done' }),
    ], A.OpenAIAdapter).valid === true);
    const batchSession = openAiSession(2);
    check('C01-7 normal tool batch accepted', P.validateReplayPrefix(batchSession, [
      frame(batchSession, 1, 'assistant', rawToolCall),
      frame(batchSession, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-c01', content: 'ok' }),
    ], A.OpenAIAdapter).valid === true);
    const multiSession = openAiSession(3);
    const multiRaw = { role: 'assistant', content: null, tool_calls: [
      { id: 'call-one', type: 'function', function: { name: 'bash', arguments: '{}' } },
      { id: 'call-two', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ] };
    check('C01-8 multi-tool complete accepted', P.validateReplayPrefix(multiSession, [
      frame(multiSession, 1, 'assistant', multiRaw),
      frame(multiSession, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-one', content: 'one' }),
      frame(multiSession, 3, 'tool_result', { role: 'tool_result', toolCallId: 'call-two', content: 'two' }),
    ], A.OpenAIAdapter).valid === true);
    const reverse = openAiSession(1);
    check('C01-9 raw user + kind=assistant rejected', await rejects(() => P.validateReplayPrefix(reverse, [
      frame(reverse, 1, 'assistant', { role: 'user', content: 'feedback' }),
    ], A.OpenAIAdapter)));
    const missingMetadata = openAiSession(1);
    const missing = frame(missingMetadata, 1, 'assistant', rawToolCall);
    delete missing.kind;
    check('C01-10 required metadata missing rejected', await rejects(() => P.validateReplayPrefix(missingMetadata, [missing], A.OpenAIAdapter), 'metadata_missing'));
    const unchanged = JSON.stringify(rawToolCall);
    const unchangedSession = openAiSession(2);
    P.validateReplayPrefix(unchangedSession, [
      frame(unchangedSession, 1, 'assistant', rawToolCall),
      frame(unchangedSession, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-c01', content: 'ok' }),
    ], A.OpenAIAdapter);
    check('C01-11 raw provider object remains unchanged', JSON.stringify(rawToolCall) === unchanged);

    const anthropicSession = {
      id: 's-anthropic-audit', conversationId: 'c-anthropic-audit', replayCheckpointSequence: 2,
      provider: 'anthropic', adapterId: 'anthropic-compatible', dialect: 'anthropic',
      endpointIdentity: 'https://gateway.example/v1', model: 'audit', protocolVersion: 'messages-v1',
      persistenceState: 'healthy',
    };
    const anthropicCall = { role: 'assistant', content: [
      { type: 'text', text: 'inspect' },
      { type: 'tool_use', id: 'tool-c01', name: 'bash', input: {} },
    ] };
    check('C01-12 Anthropic native tool batch accepted', P.validateReplayPrefix(anthropicSession, [
      frame(anthropicSession, 1, 'assistant', anthropicCall),
      frame(anthropicSession, 2, 'tool_result', { role: 'tool_result', toolCallId: 'tool-c01', content: 'ok' }),
    ], A.AnthropicAdapter).valid === true);
    const anthropicCorrupt = Object.assign({}, anthropicSession, { replayCheckpointSequence: 1 });
    check('C01-13 Anthropic raw tool_use + kind=message rejected', await rejects(() => P.validateReplayPrefix(anthropicCorrupt, [
      frame(anthropicCorrupt, 1, 'message', anthropicCall, { role: 'assistant' }),
    ], A.AnthropicAdapter), 'metadata_kind_mismatch'));

    let fuzzRejected = 0;
    for (let i = 0; i < 100; i++) {
      const s = openAiSession(2);
      const resultFrame = frame(s, 2, 'tool_result', { role: 'tool_result', toolCallId: 'call-c01', content: 'ok' });
      if (i % 3 === 0) resultFrame.kind = 'message';
      else if (i % 3 === 1) resultFrame.role = 'user';
      else resultFrame.toolCallId = 'corrupt-' + i;
      if (await rejects(() => P.validateReplayPrefix(s, [
        frame(s, 1, 'assistant', rawToolCall), resultFrame,
      ], A.OpenAIAdapter))) fuzzRejected++;
    }
    check('C01-14 metadata corruption fuzz 100/100 rejected', fuzzRejected === 100, String(fuzzRejected));
  }

  // ---------- F-03/F-07/F-08: identities, types, and atomic cascade ----------
  {
    const service = new P.PersistenceService();
    await service.ready;
    const secret = 'AUDIT_SECRET';
    service.secrets.add(secret);
    const date = new Date('2026-09-18T00:00:00.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = new Uint8Array([4, 5, 6]).buffer;
    const map = new Map([[secret, { value: secret }]]);
    const set = new Set([secret, 'safe']);
    const redacted = service._redact({ text: secret, date, bytes, buffer, map, set });
    check('AUD-T1 redaction preserves Date', redacted.date instanceof Date && redacted.date.getTime() === date.getTime());
    check('AUD-T2 redaction preserves Uint8Array', redacted.bytes instanceof Uint8Array && redacted.bytes[2] === 3);
    check('AUD-T3 redaction preserves ArrayBuffer', redacted.buffer instanceof ArrayBuffer && new Uint8Array(redacted.buffer)[1] === 5);
    check('AUD-T4 redaction preserves Map and redacts keys/values', redacted.map instanceof Map && redacted.map.has('[REDACTED]') && redacted.map.get('[REDACTED]').value === '[REDACTED]');
    check('AUD-T5 redaction preserves Set and redacts values', redacted.set instanceof Set && redacted.set.has('[REDACTED]') && redacted.set.has('safe'));
    await service.put('meta', { key: 'typed', value: redacted });
    const roundTrip = (await service.get('meta', 'typed')).value;
    check('AUD-T6 typed values survive persistence clone', roundTrip.date instanceof Date && roundTrip.bytes instanceof Uint8Array && roundTrip.map instanceof Map && roundTrip.set instanceof Set);
    check('AUD-T7 unsupported noncloneable fails loudly', await rejects(() => service.put('meta', { key: 'function', value: { callback: () => 1 } })));

    const conv = { id: 'cascade-c', title: 'cascade', updatedAt: '2026-09-18T00:00:00.000Z' };
    await service.saveConversation(conv);
    await service.saveProviderSession({ id: 'cascade-s', conversationId: conv.id });
    await service.appendProviderFrame({ id: 'cascade-f', sessionId: 'missing-session', conversationId: conv.id, sequence: 1, kind: 'assistant', raw: { role: 'assistant', content: 'orphan' } });
    await service.appendPresentationEvent(conv.id, 1, { type: 'assistant_text', content: 'x' });
    await service.saveNormalizedMessage({ conversationId: conv.id, sequence: 1, role: 'user', kind: 'message', text: 'x' });
    await service.deleteConversation(conv.id);
    check('AUD-C1 cascade deletes orphan provider frame without session row', (await service.all('providerFrames')).length === 0);
    check('AUD-C2 cascade deletes every related store', (await service.all('providerSessions')).length === 0 && (await service.all('presentationEvents')).length === 0 && (await service.all('normalizedMessages')).length === 0);
  }

  {
    const normalized = A.normalizeCredentialEndpoint;
    check('AUD-I1 endpoint identity normalizes scheme/host/default port/slashes', normalized('HTTPS://API.Example.COM:443/v1///') === 'https://api.example.com/v1');
    check('AUD-I2 endpoint path participates in identity', normalized('https://api.example.com/team-a') !== normalized('https://api.example.com/team-b'));
    const auto = A.createProviderIdentity({ dialect: 'auto', apiBase: 'https://api.example.com/v1///', model: 'm' });
    check('AUD-I3 auto identity records effective dialect', auto.dialect === 'openai' && auto.protocolVersion === 'chat-completions-v1');
    const same = { dialect: 'openai', apiBase: 'HTTPS://API.Example.COM:443/v1///', model: 'm' };
    const meta = Object.assign({ persistenceState: 'healthy' }, auto);
    check('AUD-I4 same endpoint/model/protocol accepts raw replay', A.OpenAIAdapter.isRawReplayCompatible(meta, same));
    check('AUD-I5 different endpoint path rejects raw replay', !A.OpenAIAdapter.isRawReplayCompatible(meta, { dialect: 'openai', apiBase: 'https://api.example.com/v2', model: 'm' }));
    check('AUD-I6 different model rejects opaque replay', !A.OpenAIAdapter.isRawReplayCompatible(meta, { dialect: 'openai', apiBase: 'https://api.example.com/v1', model: 'other' }));
    check('AUD-I7 cross-adapter raw replay rejects', !A.AnthropicAdapter.isRawReplayCompatible(meta, { dialect: 'anthropic', apiBase: 'https://api.example.com/v1', model: 'm' }));

    const service = new P.PersistenceService();
    await service.ready;
    const a = { provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', endpointIdentity: 'https://a.example' };
    const b = { provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', endpointIdentity: 'https://b.example' };
    await service.setRememberedApiKey('KEY_A', true, a);
    await service.setRememberedApiKey('KEY_B', true, b);
    check('AUD-I8 credential A/B isolation', await service.loadRememberedApiKey(a) === 'KEY_A' && await service.loadRememberedApiKey(b) === 'KEY_B');
    await service.setRememberedApiKey('', false, b);
    check('AUD-I9 forget current identity does not erase other endpoint', await service.loadRememberedApiKey(a) === 'KEY_A' && !(await service.loadRememberedApiKey(b)));
    check('AUD-I10 credential key is not global apiKey', !Array.from(service.memory.secrets.keys()).includes('apiKey'));
    await service.forgetApiKeys();
  }

  // ---------- F-02: required persistence failure is terminal ----------
  {
    const events = [];
    let modelCalls = 0;
    let toolCalls = 0;
    let persistenceErrors = 0;
    const native = {
      content: '', reasoning: null, stopReason: 'tool_use', truncated: false,
      toolCalls: [{ id: 'call-audit', name: 'bash', input: { input: 'pwd' }, argumentsError: null }],
      rawMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'call-audit', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } }] },
    };
    const session = new G.AgentSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls === 1 ? native : { content: 'must not be requested', rawMessage: { role: 'assistant', content: 'must not be requested' } };
      },
      toolExecutor: async () => { toolCalls++; return { output: '/home/locus', success: true, backend: 'browser' }; },
      buildSystemPrompt: () => 'audit',
      emit: (event) => events.push(event),
      persistence: {
        onProviderFrame: async (payload) => {
          if (payload.kind === 'tool_result') throw new Error('quota exhausted');
          return { sequence: 1 };
        },
        onNormalizedMessage: async () => ({ sequence: 1 }),
        onCheckpoint: async () => ({ sequence: 1 }),
        onPersistenceError: async () => { persistenceErrors++; },
      },
    });
    await session.run('persist-failure', { workspace: { name: 'audit' } });
    check('AUD-F1 persistence failure emits terminal persistence_error', events.some((e) => e.type === 'task_end' && e.reason === 'persistence_error'));
    check('AUD-F2 persistence failure is visible as an error', events.some((e) => e.type === 'error' && e.code === 'persistence_write_failed'));
    check('AUD-F3 failed tool is not retried through another model turn', toolCalls === 1 && modelCalls === 1, 'tools=' + toolCalls + ',models=' + modelCalls);
    check('AUD-F4 persistence failure callback ran', persistenceErrors === 1);
    check('AUD-F5 no completed terminal outcome is emitted', !events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  console.log('---');
  console.log('persistence-audit.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
