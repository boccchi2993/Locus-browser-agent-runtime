// Browser-local persistence contract tests. Node intentionally exercises the
// service's memory fallback; browser suites cover the real IndexedDB/OPFS
// substrate.
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'persistence.js'), 'utf8');
const P = (0, eval)(source + '\n;({ PersistenceService, PERSISTENCE_SCHEMA_VERSION, PERSISTENCE_DB_NAME });');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

(async () => {
  const service = new P.PersistenceService();
  await service.ready;

  check('P1 schema version is explicit', P.PERSISTENCE_SCHEMA_VERSION === 1);
  check('P2 stable database name', P.PERSISTENCE_DB_NAME === 'locus');
  check('P3 unavailable IndexedDB degrades to memory', service.mode === 'memory');

  const conv = {
    id: 'conv-1', title: 'persisted', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z', activeProviderSessionId: 'session-1',
    runState: 'idle', schemaVersion: 1,
  };
  await service.saveConversation(conv);
  await service.saveProviderSession({
    id: 'session-1', conversationId: conv.id, provider: 'anthropic',
    adapterId: 'anthropic-compatible', dialect: 'anthropic', model: 'test',
    replayCheckpointSequence: 0, schemaVersion: 1,
  });

  const raw = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'provider-returned-thinking', signature: 'opaque-signature' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tool_123', name: 'bash', input: { command: 'pwd' } },
    ],
    future_unknown_field: { nested: [1, 2, 3] },
  };
  await service.appendProviderFrame({
    id: 'frame-1', sessionId: 'session-1', conversationId: conv.id,
    sequence: 1, direction: 'inbound', role: 'assistant', kind: 'assistant', raw,
  });
  const frames = await service.loadProviderFrames('session-1');
  check('P4 provider raw object round-trips exactly', JSON.stringify(frames[0].raw) === JSON.stringify(raw));
  check('P5 provider unknown fields survive', frames[0].raw.future_unknown_field.nested[2] === 3);
  check('P6 provider thinking signature survives', frames[0].raw.content[0].signature === 'opaque-signature');

  await service.put('settings', { key: 'apiBase', value: 'https://example.test' });
  await service.setRememberedApiKey('TEST_SECRET_123', false);
  const noSecret = await service.loadSettings();
  check('P7 API key is absent by default', !noSecret.apiKey && noSecret.remember === false);
  await service.setRememberedApiKey('TEST_SECRET_123', true);
  const remembered = await service.loadSettings();
  check('P8 remembered key requires explicit opt-in', remembered.apiKey === 'TEST_SECRET_123' && remembered.remember === true);
  await service.appendPresentationEvent(conv.id, 1, { type: 'assistant_text', content: 'TEST_SECRET_123' });
  const redacted = await service.get('presentationEvents', (await service.all('presentationEvents'))[0].id);
  check('P9 secret is redacted from persisted projections', !JSON.stringify(redacted).includes('TEST_SECRET_123'));

  await service.setRememberedApiKey('TEST_SECRET_123', false);
  check('P10 disabling remember deletes the secret', !(await service.get('secrets', 'apiKey')));

  await service.saveNormalizedMessage({ conversationId: conv.id, sequence: 1, role: 'user', kind: 'message', text: 'hello' });
  await service.deleteConversation(conv.id);
  check('P11 conversation cascade deletes conversation', !(await service.get('conversations', conv.id)));
  check('P12 cascade deletes provider session', !(await service.get('providerSessions', 'session-1')));
  check('P13 cascade deletes provider frames', (await service.all('providerFrames')).length === 0);
  check('P14 cascade deletes presentation events', (await service.all('presentationEvents')).length === 0);
  check('P15 cascade deletes normalized messages', (await service.all('normalizedMessages')).length === 0);

  console.log('---');
  console.log('persistence.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

