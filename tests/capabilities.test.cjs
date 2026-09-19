// ModelCapabilityRegistry + ImageInputGate tests (node, memory persistence).
// Covers docs/IMAGE-INPUT.md: tri-state capability (never boolean), identity
// scoping (endpoint/model/dialect/protocol — never model name alone),
// persistence across reload, documented precedence (runtime evidence beats
// the builtin seed; probes never overwrite user/provider decisions), the
// agent-writability boundary and the gate's ask-once-per-run contract.
// Run: node tests/capabilities.test.cjs

const fs = require('fs');
const path = require('path');

const P = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'persistence.js'), 'utf8') +
  '\n;({ PersistenceService });'
);
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'attachments.js'), 'utf8') + '\n;void AttachmentStore;');
const A = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'approval.js'), 'utf8') +
  '\n;({ ApprovalController });'
);
const C = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'capabilities.js'), 'utf8') +
  '\n;({ ModelCapabilityRegistry, createImageInputGate, capabilityIdentityKey, builtinImageCapability, imageInputUnavailableNotice, runImageInputProbe, isImageUnsupportedProviderError, classifyImageProviderError, parseEndpointIdentity, isOfficialProviderEndpoint });'
);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const DEEPSEEK_FLASH = {
  provider: 'anthropic', adapterId: 'anthropic-compatible', dialect: 'anthropic',
  endpointIdentity: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash',
  protocolVersion: 'messages-v1',
};

function identity(overrides) {
  return Object.assign({}, DEEPSEEK_FLASH, overrides || {});
}

// Minimal approval fake: records ask() calls, resolves a configured outcome.
function fakeApprovals(outcome) {
  const calls = [];
  return {
    calls,
    request(spec, opts) {
      calls.push(spec);
      return Promise.resolve({ outcome, scope: 'once', requestId: 'fake' });
    },
  };
}

function fakeProbe(state, reason) {
  const calls = [];
  return {
    calls,
    fn: async () => { calls.push(1); return { state, reason: reason || (state === 'supported' ? undefined : 'probe-failure') }; },
  };
}

async function main() {
  const service = new P.PersistenceService();
  await service.ready;

  // --- identity scoping ---
  check('R1 identity key includes more than the model name',
    C.capabilityIdentityKey(identity({ model: 'x' })) !== C.capabilityIdentityKey(identity({ model: 'y' })));
  check('R1b endpoint switch yields a NEW identity', C.capabilityIdentityKey(identity())
    !== C.capabilityIdentityKey(identity({ endpointIdentity: 'https://gateway.example/anthropic' })));
  check('R1c model switch yields a NEW identity', C.capabilityIdentityKey(identity())
    !== C.capabilityIdentityKey(identity({ model: 'deepseek-chat' })));
  check('R1d dialect/adapter/protocol switch yields a NEW identity', C.capabilityIdentityKey(identity())
    !== C.capabilityIdentityKey(identity({ dialect: 'openai', adapterId: 'openai-compatible', protocolVersion: 'chat-completions-v1' })));

  // --- builtin seed ---
  const registry = new C.ModelCapabilityRegistry({ persistence: service });
  check('R2 builtin seed: deepseek-flash (official endpoint) is supported',
    (await registry.lookup(DEEPSEEK_FLASH)).state === 'supported' && (await registry.lookup(DEEPSEEK_FLASH)).source === 'builtin');
  check('R2b builtin seed: deepseek-chat is text-only',
    (await registry.lookup(identity({ model: 'deepseek-chat' }))).state === 'unsupported');
  check('R2c builtin never guesses from the hostname alone (unknown model on known endpoint)',
    (await registry.lookup(identity({ model: 'deepseek-whatever' }))).state === 'unknown');
  check('R2d model-name substring cannot forge capability',
    (await registry.lookup(identity({ endpointIdentity: 'https://gateway.example/v1', model: 'my-totally-vision-model' }))).state === 'unknown'
    && (await registry.lookup(identity({ endpointIdentity: 'https://gateway.example/v1', model: 'gpt-4o-clone' }))).state === 'unknown');
  check('R2e gpt-4o on the OFFICIAL endpoint seeds supported, elsewhere unknown',
    (await registry.lookup(identity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', endpointIdentity: 'https://api.openai.com/v1', model: 'gpt-4o' }))).state === 'supported'
    && (await registry.lookup(identity({ provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai', endpointIdentity: 'https://gateway.example/v1', model: 'gpt-4o' }))).state === 'unknown');
  check('R2f claude on the official endpoint seeds supported',
    (await registry.lookup(identity({ endpointIdentity: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' }))).state === 'supported');

  // --- persistence + precedence ---
  await registry.setUserDecision(DEEPSEEK_FLASH, 'unsupported');
  let row = await registry.lookup(DEEPSEEK_FLASH);
  check('R3 explicit user No overrides the builtin seed', row.state === 'unsupported' && row.source === 'user');

  // Reload: a fresh registry over the same backend keeps the decision.
  const registry2 = new C.ModelCapabilityRegistry({ persistence: service });
  row = await registry2.lookup(DEEPSEEK_FLASH);
  check('R3b persisted user decision survives reload', row.state === 'unsupported' && row.source === 'user');

  const probeSupported = fakeProbe('supported');
  await registry2.recordProbeResult(DEEPSEEK_FLASH, { state: 'supported' });
  row = await registry2.lookup(DEEPSEEK_FLASH);
  check('R4 a probe never overwrites a user decision', row.state === 'unsupported' && row.source === 'user');

  await registry2.recordProviderRejection(DEEPSEEK_FLASH, 'model does not support image');
  row = await registry2.lookup(DEEPSEEK_FLASH);
  check('R5 authoritative provider rejection persists as unsupported/provider-rejection',
    row.state === 'unsupported' && row.source === 'provider-rejection');
  const probeAgain = fakeProbe('supported');
  await registry2.recordProbeResult(DEEPSEEK_FLASH, { state: 'supported' });
  row = await registry2.lookup(DEEPSEEK_FLASH);
  check('R5b a probe never overwrites a provider rejection', row.state === 'unsupported' && row.source === 'provider-rejection');

  // Builtin can NEVER override runtime evidence: a "supported" builtin with
  // a stored unsupported user decision stays unsupported (R3 covers it);
  // the user can correct a mistake via forget (Recheck).
  await registry2.forget(DEEPSEEK_FLASH);
  row = await registry2.lookup(DEEPSEEK_FLASH);
  check('R6 Recheck (forget) clears the override for THIS identity and falls back to the seed',
    row.state === 'supported' && row.source === 'builtin' && row.recorded === false);
  check('R6b forget does not touch OTHER identities',
    (await registry2.lookup(identity({ model: 'deepseek-chat' }))).state === 'unsupported');

  // Unknown stays unknown and persists that way (inconclusive probe writes
  // no supported/unsupported state).
  const unknownId = identity({ endpointIdentity: 'https://gateway.example/v1', model: 'mystery' });
  const registry3 = new C.ModelCapabilityRegistry({ persistence: service });
  await registry3.recordProbeResult(unknownId, { state: 'unknown', reason: 'http-429' });
  row = await registry3.lookup(unknownId);
  check('R7 inconclusive probe keeps state unknown + records why',
    row.state === 'unknown' && row.lastProbeFailure === 'http-429');
  check('R7b unknown != unsupported (distinct tri-state)',
    row.state !== 'unsupported' && (await registry3.lookup(identity({ model: 'deepseek-chat' }))).state === 'unsupported');

  // --- gate ---
  const G = (over) => {
    const s = {
      registry: over && over.registry || registry3,
      approvals: over && 'approvals' in (over || {}) ? over.approvals : null,
      probe: over && over.probe || null,
    };
    return C.createImageInputGate({
      registry: s.registry,
      approvals: s.approvals,
      runProbe: s.probe ? s.probe.fn : null,
      identityOf: () => unknownId,
    });
  };

  let out = await G({}).ensure({ askCache: new Map() });
  check('G1 gate without approvals stays unknown and never asks', out.state === 'unknown' && out.decision === 'no-ask');

  // unknown → Yes: persisted, gate returns supported with source user.
  const yesService = new P.PersistenceService();
  await yesService.ready;
  const yesRegistry = new C.ModelCapabilityRegistry({ persistence: yesService });
  const yesGate = G({ registry: yesRegistry, approvals: fakeApprovals('confirm'), probe: fakeProbe('supported') });
  out = await yesGate.ensure({ askCache: new Map() });
  row = await yesRegistry.lookup(unknownId);
  check('G2 unknown + Yes → supported persisted (source user)',
    out.state === 'supported' && out.source === 'user' && row.state === 'supported' && row.source === 'user');
  out = await yesGate.ensure({ askCache: new Map() });
  check('G2b after persistence the gate answers from the registry (no second ask)',
    out.state === 'supported' && out.source === 'user');

  // unknown → No: persisted unsupported.
  const noRegistry = new C.ModelCapabilityRegistry({ persistence: new P.PersistenceService() });
  await noRegistry.ready;
  const noGate = G({ registry: noRegistry, approvals: fakeApprovals('decline'), probe: fakeProbe('supported') });
  out = await noGate.ensure({ askCache: new Map() });
  row = await noRegistry.lookup(unknownId);
  check('G3 unknown + No → unsupported persisted, no probe ran',
    out.state === 'unsupported' && row.state === 'unsupported' && row.source === 'user');

  // unknown → I don't know → probe supported.
  const probeRegistry = new C.ModelCapabilityRegistry({ persistence: new P.PersistenceService() });
  await probeRegistry.ready;
  const probeOk = fakeProbe('supported');
  const probeGate = G({ registry: probeRegistry, approvals: fakeApprovals('unsure'), probe: probeOk });
  out = await probeGate.ensure({ askCache: new Map() });
  row = await probeRegistry.lookup(unknownId);
  check('G4 unsure + successful probe → supported persisted (source probe), exactly one probe',
    out.state === 'supported' && out.source === 'probe' && row.state === 'supported'
      && probeOk.calls.length === 1);

  // unknown → I don't know → probe inconclusive: unknown, NO loop within a run.
  const unkRegistry = new C.ModelCapabilityRegistry({ persistence: new P.PersistenceService() });
  await unkRegistry.ready;
  const probeBad = fakeProbe('unknown', 'timeout');
  const badGate = G({ registry: unkRegistry, approvals: fakeApprovals('unsure'), probe: probeBad });
  const askCache = new Map();
  out = await badGate.ensure({ askCache });
  check('G5 unsure + inconclusive probe → unknown, no supported write',
    out.state === 'unknown' && out.decision === 'probe-unknown'
      && (await unkRegistry.lookup(unknownId)).state === 'unknown');
  await badGate.ensure({ askCache });
  check('G5b the SAME RUN does not re-ask or re-probe (askCache)',
    probeBad.calls.length === 1);
  // ...but a NEW run may ask again (fresh askCache).
  await badGate.ensure({ askCache: new Map() });
  check('G5c a new run may ask again (bounded per run, not forever)', probeBad.calls.length === 2);

  // cancelled decision: nothing written, state stays unknown.
  const cancelRegistry = new C.ModelCapabilityRegistry({ persistence: new P.PersistenceService() });
  await cancelRegistry.ready;
  const cancelGate = G({ registry: cancelRegistry, approvals: fakeApprovals('cancelled'), probe: fakeProbe('supported') });
  out = await cancelGate.ensure({ askCache: new Map() });
  const cancelRow = await cancelRegistry.persistence.get('capabilities', C.capabilityIdentityKey(unknownId));
  check('G6 a cancelled capability question writes NOTHING to the registry (not a No)',
    out.decision === 'cancelled' && out.state === 'unknown' && cancelRow === null, JSON.stringify(out));

  // A deterministic notice per outcome (one domain helper, no per-caller strings).
  check('N1 notices distinguish user-No from provider-rejection and unknown',
    C.imageInputUnavailableNotice({ state: 'unsupported', source: 'user' }).includes('marked as not supporting')
    && C.imageInputUnavailableNotice({ state: 'unsupported', source: 'provider-rejection' }).includes('provider rejected')
    && C.imageInputUnavailableNotice({ state: 'unknown' }).includes('could not be verified')
    && C.imageInputUnavailableNotice({ state: 'unknown', decision: 'cancelled' }).includes('cancelled'));

  // Conservative provider-rejection classifier: capability evidence only.
  check('N2 classifier: explicit image validation rejection counts',
    C.isImageUnsupportedProviderError({ status: 400, message: 'image content is not supported by this model', providerError: { param: 'content' } }));
  check('N2b classifier: auth/quota/5xx/size never downgrade capability',
    !C.isImageUnsupportedProviderError({ status: 401, message: 'invalid api key' })
    && !C.isImageUnsupportedProviderError({ status: 429, message: 'rate limited' })
    && !C.isImageUnsupportedProviderError({ status: 500, message: 'internal error' })
    && !C.isImageUnsupportedProviderError({ status: 400, message: 'image too large: 9 MB exceeds the 5 MB limit' })
    && !C.isImageUnsupportedProviderError({ status: 400, message: 'tools payload is unsupported' }));

  // ============================================================
  //  F-I21 — builtin endpoint identity: URL-parsed hostname, exact match
  // ============================================================
  const OPENAI_ID = (endpoint, model) => identity({
    provider: 'openai', adapterId: 'openai-compatible', dialect: 'openai',
    endpointIdentity: endpoint, model: model || 'gpt-4o',
    protocolVersion: 'chat-completions-v1',
  });
  const ANTHROPIC_ID = (endpoint, model) => identity({
    endpointIdentity: endpoint, model: model || 'claude-sonnet-4-5',
  });

  check('E1 official DeepSeek hostname matches exactly (bare + /v1 + path variants)',
    C.isOfficialProviderEndpoint('https://api.deepseek.com', 'api.deepseek.com')
    && (await registry.lookup(OPENAI_ID('https://api.deepseek.com/v1', 'deepseek-flash'))).state === 'supported'
    && (await registry.lookup(DEEPSEEK_FLASH)).state === 'supported');
  check('E1b OpenAI/Anthropic official hostnames still seed',
    (await registry.lookup(OPENAI_ID('https://api.openai.com/v1'))).state === 'supported'
    && (await registry.lookup(ANTHROPIC_ID('https://api.anthropic.com'))).state === 'supported');

  // The audit's exact repro set — all three must stay unknown.
  check('E2 (T5) deepseek lookalike SUBDOMAIN is unknown',
    (await registry.lookup(DEEPSEEK_FLASH, ) && true)
    && (await registry.lookup(identity({ endpointIdentity: 'https://api.deepseek.com.evil.com', model: 'deepseek-flash' }))).state === 'unknown'
    && (await registry.lookup(identity({ endpointIdentity: 'https://evil-api.deepseek.com', model: 'deepseek-flash' }))).state === 'unknown');
  check('E3 (T6) deepseek PATH-EMBEDDED host is unknown',
    (await registry.lookup(identity({ endpointIdentity: 'https://evil.com/api.deepseek.com/v1', model: 'deepseek-flash' }))).state === 'unknown'
    && (await registry.lookup(identity({ endpointIdentity: 'https://attacker.example/api.deepseek.com', model: 'deepseek-chat' }))).state === 'unknown');
  check('E4 (T7) deepseek USERINFO attack is unknown (userinfo is rejected outright; real hostname is evil.com)',
    C.parseEndpointIdentity('https://api.deepseek.com@evil.com/v1') === null
    && (await registry.lookup(identity({ endpointIdentity: 'https://api.deepseek.com@evil.com/v1', model: 'deepseek-flash' }))).state === 'unknown'
    && (await registry.lookup(identity({ endpointIdentity: 'https://deepseek-flash@api.deepseek.com.evil.com', model: 'deepseek-flash' }))).state === 'unknown');
  check('E5 near-miss hostnames never official-match: apex / typo / port',
    (await registry.lookup(identity({ endpointIdentity: 'https://deepseek.com', model: 'deepseek-flash' }))).state === 'unknown'
    && (await registry.lookup(identity({ endpointIdentity: 'https://api.deepseek.co', model: 'deepseek-flash' }))).state === 'unknown'
    && (await registry.lookup(OPENAI_ID('https://api.openai.com:8080/v1'))).state === 'unknown');
  check('E6 (T8) OpenAI lookalikes stay unknown',
    (await registry.lookup(OPENAI_ID('https://api.openai.com.evil.com/v1'))).state === 'unknown'
    && (await registry.lookup(OPENAI_ID('https://evil.com/api.openai.com/v1'))).state === 'unknown'
    && (await registry.lookup(OPENAI_ID('https://api.openai.com@evil.com/v1'))).state === 'unknown'
    && (await registry.lookup(OPENAI_ID('https://api.openai.com.evil.com', 'gpt-4o-2024-08-06'))).state === 'unknown');
  check('E7 Anthropic lookalikes stay unknown',
    (await registry.lookup(ANTHROPIC_ID('https://api.anthropic.com.evil.com'))).state === 'unknown'
    && (await registry.lookup(ANTHROPIC_ID('https://evil.com/api.anthropic.com/v1'))).state === 'unknown'
    && (await registry.lookup(ANTHROPIC_ID('https://api.anthropic.com@evil.com'))).state === 'unknown');
  check('E8 non-http(s) or garbage endpoints never match',
    C.parseEndpointIdentity('ftp://api.deepseek.com') === null
    && C.parseEndpointIdentity('api.deepseek.com') === null
    && C.parseEndpointIdentity('') === null
    && (await registry.lookup(identity({ endpointIdentity: 'not a url', model: 'deepseek-flash' }))).state === 'unknown');
  check('E9 the seed never matches on a substring of the model name (prefix anchoring kept)',
    (await registry.lookup(OPENAI_ID('https://api.openai.com/v1', 'my-gpt-4o-clone'))).state === 'unknown'
    && (await registry.lookup(identity({ model: 'xdeepseek-flash' }))).state === 'unknown');

  // ============================================================
  //  F-I56 — classifyImageProviderError: conservative categories
  // ============================================================
  const kindOf = (e) => C.classifyImageProviderError(e).kind;

  check('K1 (T9) explicit model-level rejections → model_unsupported',
    kindOf({ status: 400, message: 'this model does not support image input' }) === 'model_unsupported'
    && kindOf({ status: 400, message: 'Image input is not supported by this model.' }) === 'model_unsupported'
    && kindOf({ status: 400, message: 'vision is not available for this model' }) === 'model_unsupported'
    && kindOf({ status: 400, message: 'This model only supports text input.' }) === 'model_unsupported'
    && kindOf({ status: 400, message: 'image content is unsupported for the selected model' }) === 'model_unsupported'
    && kindOf({ status: 400, message: "Invalid 'messages[0].content[1].image_url': image input is only supported by models that support vision" }) === 'model_unsupported'
    && kindOf({ status: 422, message: 'this is a text-only model' }) === 'model_unsupported');

  check('K2 (T10) corrupt/bad image rejections → invalid_image, capability evidence NO',
    kindOf({ status: 400, code: 'invalid_image', message: 'Invalid image: the image file is corrupted or missing data.' }) === 'invalid_image'
    && kindOf({ status: 400, message: 'failed to decode truncated image' }) === 'invalid_image'
    && kindOf({ status: 400, message: 'bad base64 in image data' }) === 'invalid_image'
    && kindOf({ status: 400, message: 'image too large: 9 MB exceeds the 5 MB limit' }) === 'invalid_image'
    && kindOf({ status: 400, message: 'invalid image dimensions' }) === 'invalid_image'
    && kindOf({ status: 422, message: 'malformed image payload' }) === 'invalid_image');

  check('K3 (T11) format/media-type rejections → mime_unsupported, capability evidence NO',
    kindOf({ status: 400, message: 'Unsupported media_type: image/gif' }) === 'mime_unsupported'
    && kindOf({ status: 400, message: 'unsupported image format' }) === 'mime_unsupported'
    && kindOf({ status: 400, message: 'this image format is unsupported' }) === 'mime_unsupported'
    && kindOf({ status: 400, message: 'GIF not supported' }) === 'mime_unsupported'
    && kindOf({ status: 422, message: 'invalid media type' }) === 'mime_unsupported'
    && kindOf({ status: 400, message: 'this model does not support image/gif' }) === 'mime_unsupported');

  check('K4 (T12) auth/quota/model/server/timeout/network/tools → ambiguous',
    kindOf({ status: 401, message: 'invalid api key' }) === 'ambiguous'
    && kindOf({ status: 403, message: 'forbidden' }) === 'ambiguous'
    && kindOf({ status: 404, message: 'model not found: gpt-nonexistent' }) === 'ambiguous'
    && kindOf({ status: 429, message: 'rate limited' }) === 'ambiguous'
    && kindOf({ status: 500, message: 'internal server error' }) === 'ambiguous'
    && kindOf(Object.assign(new Error('timed out'), { timeout: true })) === 'ambiguous'
    && kindOf(new TypeError('failed to fetch')) === 'ambiguous'
    && kindOf({ status: 400, message: 'tools payload is not supported by this endpoint' }) === 'ambiguous'
    && kindOf({ status: 422, message: 'invalid request: max_tokens is too large' }) === 'ambiguous');

  check('K5 status alone is NEVER evidence; generic 400 stays ambiguous',
    kindOf({ status: 400, message: 'invalid request' }) === 'ambiguous'
    && kindOf({ status: 400, message: 'the request could not be processed' }) === 'ambiguous'
    && kindOf({ status: 400 }) === 'ambiguous'
    && kindOf({ status: 400, message: 'image', providerError: {} }) === 'ambiguous');

  check('K6 the boolean seam is true ONLY for model_unsupported',
    C.isImageUnsupportedProviderError({ status: 400, message: 'this model does not support image input' })
    && !C.isImageUnsupportedProviderError({ status: 400, code: 'invalid_image', message: 'Invalid image: the image file is corrupted or missing data.' })
    && !C.isImageUnsupportedProviderError({ status: 400, message: 'Unsupported media_type: image/gif' }));

  check('K7 classification detail is a bounded debug summary (no payload semantics change)',
    C.classifyImageProviderError({ status: 400, message: 'x'.repeat(1000) }).detail.length <= 300
    && typeof C.classifyImageProviderError({ status: 400, message: 'boom' }).detail === 'string');

  console.log('---');
  console.log('capabilities.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
