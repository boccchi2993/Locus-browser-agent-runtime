// AgentSession image-input integration tests (node, fake model client).
// Exercises the model-input boundary: gate runs only when images are about
// to enter a request, history stays semantic (no base64), the consumer
// contract's final liveness check prevents dead-task side effects, notices
// are deterministic, the per-run gate ask happens once, and the transport
// budget counts resolved image payloads. Also drives the FULL unknown→Yes
// flow through the real ApprovalController + registry.
// Run: node tests/agent-image.test.cjs

const fs = require('fs');
const path = require('path');

globalThis.AGENT_TOOL_DEFINITIONS = [
  { name: 'bash', description: 'local shell', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } },
  { name: 'cloud_bash', description: 'remote shell', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } },
];
const AG = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8') +
  '\n;({ AgentSession, HISTORY_BUDGET_BYTES });'
);
const P = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'persistence.js'), 'utf8') +
  '\n;({ PersistenceService });'
);
const AT = eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'attachments.js'), 'utf8') +
  '\n;({ AttachmentStore, isAttachmentIntegrityError });');
const AP = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'approval.js'), 'utf8') +
  '\n;({ ApprovalController });'
);
const C = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'capabilities.js'), 'utf8') +
  '\n;({ ModelCapabilityRegistry, createImageInputGate, imageInputUnavailableNotice, runImageInputProbe });'
);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SENTINEL_TEXT = 'sentinel-pixel-payload-0001';
const SENTINEL_B64 = Buffer.from(SENTINEL_TEXT).toString('base64');
const IMAGE_PART = { type: 'image', attachmentId: 'att_1', mimeType: 'image/png', sha256: 'aa11', size: SENTINEL_TEXT.length };
const RICH_CONTENT = [{ type: 'text', text: '看这张图' }, IMAGE_PART];

const FINAL_ENVELOPE = {
  content: 'done', reasoning: null, reasoningType: null, toolCalls: null,
  rawMessage: { role: 'assistant', content: 'done' }, stopReason: 'stop',
  usage: null, providerMetadata: null, truncated: false,
};
const TOOL_ENVELOPE = {
  content: '', reasoning: null, reasoningType: null,
  toolCalls: [{ id: 'call-1', name: 'bash', input: { input: 'ls' } }],
  rawMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"input":"ls"}' } }] },
  stopReason: 'tool_calls', usage: null, providerMetadata: null, truncated: false,
};

function makeHarness(imageInput, modelClient) {
  const events = [];
  const modelCalls = [];
  const session = new AG.AgentSession({
    modelClient: modelClient || (async (body) => {
      modelCalls.push(body);
      return FINAL_ENVELOPE;
    }),
    toolExecutor: async () => ({ output: 'tool-out', success: true, backend: 'browser' }),
    buildSystemPrompt: () => 'SYSTEM',
    emit: (e) => events.push(e),
    imageInput,
  });
  return { session, events, modelCalls };
}

async function runRich(session, opts) {
  await session.run('看这张图', Object.assign({ userContent: RICH_CONTENT }, opts || {}));
}

async function main() {
  const identity = {
    provider: 'anthropic', adapterId: 'anthropic-compatible', dialect: 'anthropic',
    endpointIdentity: 'https://gateway.example/anthropic', model: 'test-model', protocolVersion: 'messages-v1',
  };

  // ---------- CASE A: known supported ----------
  {
    const gateCalls = [];
    const imageInput = {
      ensureCapability: async (o) => { gateCalls.push(o); return { state: 'supported', source: 'user' }; },
      resolveAttachment: async (id) => id === 'att_1' ? { mimeType: 'image/png', dataBase64: SENTINEL_B64 } : null,
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    await runRich(h.session);
    check('A1 supported: exactly one provider request carrying the image bytes',
      h.modelCalls.length === 1
        && h.modelCalls[0].messages[0].content[1].type === 'image'
        && h.modelCalls[0].messages[0].content[1].dataBase64 === SENTINEL_B64
        && h.modelCalls[0].messages[0].content[1].mimeType === 'image/png');
    check('A1b history stays SEMANTIC: attachmentId kept, base64 never stored',
      h.session.history[0].content[1].attachmentId === 'att_1'
        && !JSON.stringify(h.session.history).includes(SENTINEL_B64));
    check('A1c no base64 reaches the event stream',
      !h.events.some((e) => JSON.stringify(e).includes(SENTINEL_B64)));
    check('A1d task_start carries the image count; exactly one start/end',
      h.events.filter((e) => e.type === 'task_start').length === 1
        && h.events[0].images === 1
        && h.events.filter((e) => e.type === 'task_end').length === 1);
    check('A1e tool availability is independent of image capability (tools still advertised)',
      Array.isArray(h.modelCalls[0].tools) && h.modelCalls[0].tools.length === 2);
  }

  // ---------- CASE B: known unsupported ----------
  {
    const imageInput = {
      ensureCapability: async () => ({ state: 'unsupported', source: 'user' }),
      resolveAttachment: async () => { throw new Error('must not resolve when unsupported'); },
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    await runRich(h.session);
    const sent = h.modelCalls[0].messages[0].content;
    check('B1 unsupported: image absent, deterministic notice sent, text preserved',
      !sent.some((p) => p.type === 'image')
        && sent.some((p) => p.type === 'text' && p.text.includes('marked as not supporting image input'))
        && sent[0].text === '看这张图');
    check('B1b the task still completes normally (image absence is not a failure)',
      h.events.some((e) => e.type === 'task_end' && e.reason === 'completed')
        && h.events.some((e) => e.type === 'assistant_text'));
    check('B1c tools remain advertised for text-only models',
      Array.isArray(h.modelCalls[0].tools) && h.modelCalls[0].tools.length === 2);
  }

  // ---------- CASE C: unknown → Yes via the REAL ApprovalController ----------
  {
    const service = new P.PersistenceService();
    await service.ready;
    const registry = new C.ModelCapabilityRegistry({ persistence: service });
    const approvals = new AP.ApprovalController({ onChange() {}, onEvent() {} });
    const gate = C.createImageInputGate({
      registry, approvals,
      runProbe: async () => ({ state: 'unknown', reason: 'unused' }),
      identityOf: () => identity,
    });
    const imageInput = {
      ensureCapability: (o) => gate.ensure(o),
      resolveAttachment: async () => ({ mimeType: 'image/png', dataBase64: SENTINEL_B64 }),
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    const runPromise = runRich(h.session).catch(() => {});
    while (!approvals.pending) await sleep(5);
    check('C1 unknown image boundary suspends the SAME task on a capability card',
      approvals.pending.kind === 'capability' && approvals.pending.action.type === 'image_input_capability');
    approvals.resolve(approvals.pending.id, { outcome: 'confirm' });
    await runPromise;
    check('C1b Yes → same task resumes with exactly one image provider request',
      h.modelCalls.length === 1
        && h.modelCalls[0].messages[0].content[1].dataBase64 === SENTINEL_B64
        && h.events.filter((e) => e.type === 'task_start').length === 1
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
    const row = await registry.lookup(identity);
    check('C1c the decision persisted to the capability registry (source user)',
      row.state === 'supported' && row.source === 'user');
    check('C1d the approval question never enters provider history',
      !JSON.stringify(h.modelCalls).includes('image-capable') && !JSON.stringify(h.modelCalls).includes('Image capability'));
    // Second run: registry answers — no second ask.
    const h2 = makeHarness(imageInput);
    await runRich(h2.session);
    check('C1e the next run no longer asks (registry persisted)',
      h2.modelCalls.length === 1 && h2.modelCalls[0].messages[0].content[1].type === 'image');
  }

  // ---------- CASE G: Yes → cancel TOCTOU (consumer contract) ----------
  {
    let resolveGate;
    const gatePromise = new Promise((r) => { resolveGate = r; });
    const imageInput = {
      ensureCapability: () => gatePromise,
      resolveAttachment: async () => {
        // The "safe preparation" window: the decision arrived, the
        // provider request has NOT begun. A cancel here must stop it.
        h.session.cancel();
        await sleep(5);
        return { mimeType: 'image/png', dataBase64: SENTINEL_B64 };
      },
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    const runPromise = runRich(h.session).catch(() => {});
    resolveGate({ state: 'supported', source: 'user', decision: 'yes' });
    await runPromise;
    check('G1 cancel after Yes but before the request → zero provider side effects',
      h.modelCalls.length === 0
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'cancelled'));
  }

  // ---------- Escape semantics: cancelled decision, task continues ----------
  {
    const imageInput = {
      ensureCapability: async () => ({ state: 'unknown', source: 'none', decision: 'cancelled' }),
      resolveAttachment: async () => ({ mimeType: 'image/png', dataBase64: SENTINEL_B64 }),
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    await runRich(h.session);
    const sent = h.modelCalls[0].messages[0].content;
    check('E1 a cancelled capability question is NOT a No: image unsent, task continues',
      h.modelCalls.length === 1 && !sent.some((p) => p.type === 'image')
        && sent.some((p) => p.text && p.text.includes('cancelled'))
        && h.events.some((e) => e.type === 'warning' && e.code === 'image_capability_cancelled')
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- per-run gate ask exactly once across a tool loop ----------
  {
    // The agent invokes ensureCapability per model request; the SAME
    // askCache flows through the whole run, so a gate honoring it (as the
    // real one does) is consulted exactly once.
    let gateCalls = 0, cacheHits = 0;
    const KEY = 'test-identity';
    const imageInput = {
      ensureCapability: async (o) => {
        if (o.askCache && o.askCache.has(KEY)) { cacheHits++; return o.askCache.get(KEY); }
        gateCalls++;
        const out = { state: 'supported', source: 'user' };
        if (o.askCache) o.askCache.set(KEY, out);
        return out;
      },
      resolveAttachment: async () => ({ mimeType: 'image/png', dataBase64: SENTINEL_B64 }),
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    h.session.modelClient = async (body, opts) => {
      h.modelCalls.push(body);
      return h.modelCalls.length === 1 ? TOOL_ENVELOPE : FINAL_ENVELOPE;
    };
    await runRich(h.session);
    check('L1 the run shares one askCache: gate consulted once, second turn served from cache',
      gateCalls === 1 && cacheHits === 1 && h.modelCalls.length === 2
        && h.modelCalls.every((b) => b.messages[0].content.some((p) => p.type === 'image' && p.dataBase64 === SENTINEL_B64)));
    check('L1b history is never mutated by materialization',
      !JSON.stringify(h.session.history).includes(SENTINEL_B64));
  }

  // ---------- missing durable bytes degrade honestly ----------
  {
    const imageInput = {
      ensureCapability: async () => ({ state: 'supported', source: 'user' }),
      resolveAttachment: async () => null,
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    await runRich(h.session);
    check('M1 vanished bytes → explicit warning + model told, no phantom image',
      !h.modelCalls[0].messages[0].content.some((p) => p.type === 'image')
        && h.modelCalls[0].messages[0].content.some((p) => p.text && p.text.includes('no longer available'))
        && h.events.some((e) => e.type === 'warning' && e.code === 'image_attachment_missing')
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- F-I04: corrupted durable blob fails closed BEFORE the provider ----------
  {
    const service = new P.PersistenceService();
    await service.ready;
    const attStore = new AT.AttachmentStore({ persistence: service });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6, 7, 8]);
    const rec = await attStore.ingestImage({ bytes: pngBytes, name: 'doomed.png', declaredType: 'image/png' });
    // External corruption (bit flip) of the durable bytes behind live metadata.
    const stored = await service.readAttachmentBytes(rec.sha256);
    stored[5] ^= 0xFF;
    await service.writeAttachmentBytes(rec.sha256, stored);

    const fIdentity = {
      provider: 'anthropic', adapterId: 'anthropic-compatible', dialect: 'anthropic',
      endpointIdentity: 'https://gateway.example/anthropic', model: 'f-model', protocolVersion: 'messages-v1',
    };
    const registry = new C.ModelCapabilityRegistry({ persistence: service });
    await registry.setUserDecision(fIdentity, 'supported');

    const imageInput = {
      ensureCapability: async () => ({ state: 'supported', source: 'user' }),
      resolveAttachment: (id) => attStore.resolveForWire(id),
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    // Reference the REAL record id — the corruption must be hit through
    // the actual resolver, not the shared fixture's synthetic 'att_1'.
    await h.session.run('看这张图', { userContent: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachmentId: rec.id, mimeType: rec.mimeType, sha256: rec.sha256, size: rec.size },
    ] });
    check('F1 (T4) corrupted durable blob → ZERO provider calls, fail closed with the integrity reason',
      h.modelCalls.length === 0
        && h.events.some((e) => e.type === 'error' && e.code === 'image_attachment_integrity' && e.reason === 'hash_mismatch')
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'error'),
      JSON.stringify(h.events.map((e) => e.type + ':' + (e.code || e.reason || ''))));
    check('F1b the corruption never leaked into any event payload',
      !h.events.some((e) => JSON.stringify(e).includes(Buffer.from(pngBytes).toString('base64'))));
    const looked = await registry.lookup(fIdentity);
    check('F2 (H) an integrity failure NEVER mutates the capability registry',
      looked.state === 'supported' && looked.source === 'user', JSON.stringify(looked));
  }

  // ---------- non-integrity resolution errors still degrade honestly ----------
  {
    const imageInput = {
      ensureCapability: async () => ({ state: 'supported', source: 'user' }),
      resolveAttachment: async () => { throw new Error('transient storage hiccup'); },
      unavailableNotice: C.imageInputUnavailableNotice,
    };
    const h = makeHarness(imageInput);
    await runRich(h.session);
    check('F3 non-integrity resolution failures keep the honest missing path (degrade + continue)',
      h.modelCalls.length === 1
        && !h.modelCalls[0].messages[0].content.some((p) => p.type === 'image')
        && h.events.some((e) => e.type === 'warning' && e.code === 'image_attachment_missing')
        && h.events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- transport budget counts resolved image payloads ----------
  {
    const h = makeHarness(null);
    // Metadata-only accounting would be ~200 bytes; resolved base64 is 4/3
    // of 900_000 → the request must exceed the 768 KiB transport budget.
    h.session.history.push({ role: 'user', _taskStart: true, content: [
      { type: 'text', text: 'x' },
      { type: 'image', attachmentId: 'att_big', mimeType: 'image/png', size: 900000 },
    ] });
    let threw = null;
    try { h.session.enforceHistoryBudget(null); } catch (e) { threw = e; }
    check('P1 the transport budget counts the RESOLVED image payload (4/3 + framing)',
      !!threw && /transport budget/.test(threw.message), threw && threw.message);
    const small = makeHarness(null).session;
    small.history.push({ role: 'user', _taskStart: true, content: [
      { type: 'text', text: 'x' },
      { type: 'image', attachmentId: 'att_small', mimeType: 'image/png', size: 1200 },
    ] });
    const withImage = small.historyRequestBytes(null);
    const withoutImage = (() => {
      const s = makeHarness(null).session;
      s.history.push({ role: 'user', _taskStart: true, content: [{ type: 'text', text: 'x' }] });
      return s.historyRequestBytes(null);
    })();
    check('P1b budget math grows by ≈ size×4/3 (1200 → +1600+256 bytes, not metadata-size)',
      withImage - withoutImage >= 1600 && withImage - withoutImage < 3000,
      String(withImage - withoutImage));
    // End-to-end: a run with an over-budget image fails loudly BEFORE any model call.
    const big = makeHarness(null);
    await big.session.run('x', { userContent: [
      { type: 'text', text: 'x' },
      { type: 'image', attachmentId: 'att_big', mimeType: 'image/png', size: 900000 },
    ] });
    check('P1c an over-budget image task fails with an explicit error, zero model calls',
      big.modelCalls.length === 0
        && big.events.some((e) => e.type === 'error' && e.code === 'history_budget')
        && big.events.some((e) => e.type === 'task_end' && e.reason === 'error'));
  }

  // ---------- text-only regression: no imageInput, no images, no gate ----------
  {
    const h = makeHarness(null);
    await h.session.run('plain text task');
    check('T1 text-only sessions never touch the gate (unchanged baseline)',
      h.modelCalls.length === 1 && h.modelCalls[0].messages[0].content === 'plain text task'
        && h.events[0].images === undefined);
  }

  console.log('---');
  console.log('agent-image.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
