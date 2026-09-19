// ============================================================
//  MODEL IMAGE-CAPABILITY LAYER (Image Feedback v1)
//
//  Three cooperating pieces (docs/IMAGE-INPUT.md):
//
//   1. ModelCapabilityRegistry — the Harness control-plane table that
//      remembers, per provider identity, whether the CURRENT provider
//      path can accept image input: supported / unsupported / unknown
//      (never a boolean, never "unknown == unsupported").
//   2. ImageInputGate — the boundary decision. Runs exactly where an
//      image is about to enter a model request; consults the registry;
//      asks the human (Approval Framework, kind 'capability') when
//      unknown; runs a low-cost visual probe on "I don't know".
//   3. runImageInputProbe — an isolated, synthetic 400×400
//      four-quadrant control call through the PRODUCTION provider path
//      (same adapter, endpoint, model, protocol). It never touches the
//      conversation, history or replay state.
//
//  Hard rules enforced here:
//    - TOOL AVAILABILITY DOES NOT DEPEND ON IMAGE CAPABILITY. This
//      module never adds/removes tools; it only decides whether an
//      image may cross the current model-input boundary.
//    - Capability decisions are NOT approval grants. The Approval
//      Framework only suspends for the human decision; all persistence
//      belongs to the registry (docs/IMAGE-INPUT.md, "Two registries").
//    - The model cannot write this registry. Model text ("I support
//      images") and tool output have no effect; only a human decision,
//      an active probe, or an authoritative provider rejection writes.
//    - Probe answers are carried ONLY by pixels — never in the prompt,
//      filename, metadata or any model-visible string.
// ============================================================

// ---------- capability identity ----------
// Reuses the provider identity (model-adapters.js). The key deliberately
// includes MORE than the model name: same model id + different endpoint
// may have different multimodal support.
function capabilityIdentityKey(identity) {
  var i = identity || {};
  return 'capability:' + encodeURIComponent([
    String(i.provider || ''), String(i.adapterId || ''), String(i.dialect || ''),
    String(i.endpointIdentity || ''), String(i.model || ''), String(i.protocolVersion || ''),
  ].join('|'));
}

// ---------- endpoint identity (F-I21) ----------
// Builtin seeds may only ever match OFFICIAL provider endpoints. Matching
// happens on the URL-PARSED hostname — never on raw substring/regex
// contains, because strings like "https://api.deepseek.com@evil.com" or
// "https://evil.com/api.deepseek.com/v1" embed a trusted-looking host in
// a URL whose REAL hostname is attacker-controlled. `new URL()` resolves
// userinfo, paths and ports for us; the host must then be an EXACT
// case-insensitive match of the official hostname (default port only).
// Returns null for anything that is not an absolute http(s) URL.
function parseEndpointIdentity(endpoint) {
  var raw = String(endpoint || '').trim();
  if (!raw) return null;
  var url;
  try { url = new URL(raw); } catch (e) { return null; }
  var scheme = String(url.protocol || '').toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') return null;
  if (url.username || url.password) return null; // userinfo = never official
  if (url.port) return null; // official seeds match the default port only
  return { hostname: String(url.hostname || '').toLowerCase() };
}

function isOfficialProviderEndpoint(endpoint, officialHostname) {
  var parsed = parseEndpointIdentity(endpoint);
  return !!parsed && parsed.hostname === String(officialHostname || '').toLowerCase();
}

// ---------- builtin seed ----------
// A small, deliberately conservative seed so common configurations skip
// the interactive ask. Bound to known provider families + OFFICIAL
// hostnames (exact URL-host match via parseEndpointIdentity) + known
// model id patterns (verified against current vendor docs, see
// docs/IMAGE-INPUT.md). It is a fallback ONLY: any persisted user
// decision, probe result or provider rejection outranks it, and unknown
// models fall through to the lazy ask. Never a bare substring heuristic
// like /vision/, and never a hostname CONTAINS test.
var BUILTIN_MODEL_CAPABILITIES = [
  {
    family: 'deepseek',
    officialHostname: 'api.deepseek.com',
    // Official DeepSeek API docs: the deepseek-flash model accepts image
    // input (PNG/JPEG/GIF/WebP); the V3-series deepseek-chat /
    // deepseek-reasoner models are text-only.
    models: [
      { pattern: /^deepseek-flash(\b|[-_])/i, state: 'supported' },
      { pattern: /^(deepseek-chat|deepseek-reasoner)(\b|[-_])/i, state: 'unsupported' },
    ],
  },
  {
    family: 'openai',
    officialHostname: 'api.openai.com',
    // Official OpenAI vision-capable model families (image_url content
    // parts on Chat Completions): GPT-4o family, GPT-4.1 family, the
    // reasoning o-series and the legacy GPT-4 vision variants. The
    // GPT-3.5 family is text-only. Anything unlisted stays unknown.
    models: [
      { pattern: /^(gpt-4o|chatgpt-4o|gpt-4\.1|o1|o3|o4-mini|gpt-4-turbo|gpt-4-vision)(\b|[-_.])/i, state: 'supported' },
      { pattern: /^gpt-3\.5/i, state: 'unsupported' },
    ],
  },
  {
    family: 'anthropic',
    officialHostname: 'api.anthropic.com',
    // Official Anthropic vision docs: the Claude 3+ generations accept
    // base64 image blocks on Messages API.
    models: [
      { pattern: /^claude-(3|4|opus|sonnet|haiku|fast)(\b|[-_.])/i, state: 'supported' },
    ],
  },
];

// First matching rule wins; no match → null (the lazy flow decides).
// Builtin seed invariant: known provider family + OFFICIAL hostname
// (exact URL-host match) + known model rule. A third-party compatible
// endpoint never inherits the official builtin, no matter what model
// string or path it carries — those stay unknown.
function builtinImageCapability(identity) {
  var i = identity || {};
  var model = String(i.model || '');
  if (!model) return null;
  var parsed = parseEndpointIdentity(i.endpointIdentity || '');
  if (!parsed) return null;
  for (var r = 0; r < BUILTIN_MODEL_CAPABILITIES.length; r++) {
    var rule = BUILTIN_MODEL_CAPABILITIES[r];
    if (parsed.hostname !== rule.officialHostname) continue;
    for (var m = 0; m < rule.models.length; m++) {
      if (rule.models[m].pattern.test(model)) return rule.models[m].state;
    }
    // The endpoint family matches but the model is not in the seed:
    // never guess a capability from the hostname alone.
    return null;
  }
  return null;
}

// ------------------------------------------------------------
//  ModelCapabilityRegistry
//
//  new ModelCapabilityRegistry({ persistence })
//
//  Records: { key, identity, imageInput: { state, source, checkedAt,
//  lastProbeAt?, lastProbeFailure? }, updatedAt }
//
//  Precedence (docs/IMAGE-INPUT.md, documented + tested):
//    provider rejection  = authoritative runtime evidence, always written
//    user decision       = the human correction path, always written
//    probe result        = runtime evidence from the lazy flow; never
//                          overwrites a user decision or a provider
//                          rejection (probes only run when lookup was
//                          unknown anyway — enforced again here)
//    builtin seed        = consulted only when NO record exists; can
//                          never overwrite runtime evidence
//    unknown             = no record, no builtin match
//  ------------------------------------------------------------
class ModelCapabilityRegistry {
  constructor(opts) {
    var o = opts || {};
    this.persistence = o.persistence
      || (typeof PersistenceServiceInstance !== 'undefined' ? PersistenceServiceInstance : null);
    if (!this.persistence) throw new Error('ModelCapabilityRegistry: no persistence backend available');
  }

  identityKey(identity) { return capabilityIdentityKey(identity); }

  async lookup(identity) {
    var key = capabilityIdentityKey(identity);
    var record = await this.persistence.get('capabilities', key);
    if (record && record.imageInput && record.imageInput.state) {
      return {
        state: record.imageInput.state,
        source: record.imageInput.source || 'user',
        checkedAt: record.imageInput.checkedAt || null,
        lastProbeAt: record.imageInput.lastProbeAt || null,
        lastProbeFailure: record.imageInput.lastProbeFailure || null,
        recorded: true,
      };
    }
    var seeded = builtinImageCapability(identity);
    if (seeded) return { state: seeded, source: 'builtin', recorded: false };
    return { state: 'unknown', source: 'none', recorded: false };
  }

  async _write(identity, imageInput) {
    var key = capabilityIdentityKey(identity);
    await this.persistence.put('capabilities', {
      key: key,
      id: key,
      identity: {
        provider: identity.provider, adapterId: identity.adapterId,
        dialect: identity.dialect, endpointIdentity: identity.endpointIdentity,
        model: identity.model, protocolVersion: identity.protocolVersion,
      },
      imageInput: imageInput,
      updatedAt: new Date().toISOString(),
    });
  }

  async setUserDecision(identity, state) {
    if (state !== 'supported' && state !== 'unsupported') {
      throw new Error('registry: invalid user decision state ' + String(state));
    }
    await this._write(identity, { state: state, source: 'user', checkedAt: new Date().toISOString() });
    return this.lookup(identity);
  }

  async recordProviderRejection(identity, reason) {
    await this._write(identity, {
      state: 'unsupported', source: 'provider-rejection',
      checkedAt: new Date().toISOString(), reason: String(reason || '').slice(0, 300) || null,
    });
    return this.lookup(identity);
  }

  // Probe results are runtime evidence for the lazy flow. A successful
  // probe records 'supported'; an inconclusive probe keeps the state
  // unknown and only records WHY (so the UI can explain without asking
  // again in the same run). Never overwrites user/provider decisions.
  async recordProbeResult(identity, result) {
    var existing = await this.persistence.get('capabilities', capabilityIdentityKey(identity));
    if (existing && existing.imageInput
        && (existing.imageInput.source === 'user' || existing.imageInput.source === 'provider-rejection')) {
      return this.lookup(identity);
    }
    var now = new Date().toISOString();
    if (result && result.state === 'supported') {
      await this._write(identity, { state: 'supported', source: 'probe', checkedAt: now, lastProbeAt: now });
    } else if (result && result.state === 'unsupported') {
      await this._write(identity, {
        state: 'unsupported', source: 'provider-rejection', checkedAt: now, lastProbeAt: now,
        reason: String(result.reason || '').slice(0, 300) || null,
      });
    } else {
      await this._write(identity, {
        state: 'unknown', source: 'probe', checkedAt: now, lastProbeAt: now,
        lastProbeFailure: String(result && result.reason || 'inconclusive').slice(0, 300),
      });
    }
    return this.lookup(identity);
  }

  // "Recheck image capability": clear the persisted override for THIS
  // identity only. The next lookup falls back to the builtin seed (if
  // any) or unknown — never to another model's record.
  async forget(identity) {
    await this.persistence.delete('capabilities', capabilityIdentityKey(identity));
    return this.lookup(identity);
  }
}

// ---------- deterministic model-facing notices (spec: one domain helper) ----------
// One notice per outcome — callers must not hand-write per-site strings.
// Model-facing text is stable; UI can show richer reasons from the gate
// result object.
function imageInputUnavailableNotice(result) {
  var r = result || {};
  if (r.state === 'unsupported') {
    if (r.source === 'provider-rejection') {
      return 'Image input is unavailable: the provider rejected image content for this model. The image was not sent to the model.';
    }
    return 'Image input is unavailable because this model is marked as not supporting image input. The image was not sent to the model.';
  }
  if (r.decision === 'cancelled') {
    return 'Image input could not be confirmed because the capability question was cancelled. The image was not sent to the model.';
  }
  return 'Image capability could not be verified for this model, so the image was not sent to the model.';
}

// ------------------------------------------------------------
//  ImageInputGate
//
//  createImageInputGate({ registry, approvals, runProbe, identityOf })
//    runProbe({ signal }) → { state, source?, reason? }
//    identityOf() → current provider identity (captured per call so a
//                   mid-task settings change is judged as itself)
//
//  ensure({ signal, conversationId, taskGeneration, askCache }) →
//    { state: 'supported'|'unsupported'|'unknown', source, decision? }
//
//  askCache (a Map owned by ONE task run) prevents same-run re-ask
//  loops: once an identity has been asked (or probed) this run, the
//  outcome is reused until the task ends. Persisted answers live in the
//  registry across runs and reloads.
//
//  The caller owns task liveness: after ensure() resolves (approval +
//  registry persistence are the "safe preparation"), the caller MUST
//  re-check the AbortSignal before the provider request begins
//  (docs/APPROVALS.md, "Consumer execution contract").
// ------------------------------------------------------------
function createImageInputGate(deps) {
  var d = deps || {};
  if (!d.registry) throw new Error('createImageInputGate: registry is required');
  var registry = d.registry;
  var approvals = d.approvals || null;
  var runProbe = typeof d.runProbe === 'function' ? d.runProbe : null;
  var identityOf = typeof d.identityOf === 'function' ? d.identityOf : function () { return null; };

  return {
    registry: registry,
    async ensure(opts) {
      var o = opts || {};
      var identity = identityOf();
      if (!identity) return { state: 'unknown', source: 'none', decision: 'no-identity' };
      var key = registry.identityKey(identity);
      if (o.askCache && o.askCache.has(key)) return o.askCache.get(key);

      var result = await registry.lookup(identity);
      var out;
      if (result.state !== 'unknown') {
        out = { state: result.state, source: result.source };
      } else if (!approvals || !runProbe) {
        // Registry-less/test harnesses and probe-less configurations:
        // stay unknown, never ask, never send images.
        out = { state: 'unknown', source: 'none', decision: 'no-ask' };
      } else {
        var decision = await approvals.request({
          kind: 'capability',
          action: {
            type: 'image_input_capability',
            summary: 'Image capability check',
            detail: 'The next model request would include an image, but Locus does not know whether the current model ('
              + String(identity.model || 'unknown') + ') supports image input. Is this an image-capable model?',
          },
          resource: { type: 'capability', key: key, label: String(identity.model || identity.endpointIdentity || 'current provider') },
          conversationId: o.conversationId || null,
          taskGeneration: Number.isFinite(o.taskGeneration) ? o.taskGeneration : null,
        }, { signal: o.signal || null });

        if (decision.outcome === 'confirm') {
          // Safe preparation first (durable registry write), then the
          // caller performs the final AbortSignal liveness check.
          await registry.setUserDecision(identity, 'supported');
          out = { state: 'supported', source: 'user', decision: 'yes' };
        } else if (decision.outcome === 'decline') {
          await registry.setUserDecision(identity, 'unsupported');
          out = { state: 'unsupported', source: 'user', decision: 'no' };
        } else if (decision.outcome === 'unsure') {
          var probe = await runProbe({ signal: o.signal || null });
          if (probe.state === 'supported') {
            await registry.recordProbeResult(identity, probe);
            out = { state: 'supported', source: 'probe', decision: 'probe' };
          } else if (probe.state === 'unsupported') {
            await registry.recordProbeResult(identity, probe);
            out = { state: 'unsupported', source: 'provider-rejection', decision: 'probe', reason: probe.reason };
          } else {
            // Inconclusive: no infinite loops. Record why, do not send
            // the image, do not ask again this run (askCache).
            await registry.recordProbeResult(identity, probe);
            out = { state: 'unknown', source: 'probe', decision: 'probe-unknown', reason: probe.reason };
          }
        } else {
          // 'cancelled' (task cancel / Escape / session boundary): NOT a
          // "No" — nothing is written to the registry.
          out = { state: 'unknown', source: 'none', decision: 'cancelled' };
        }
      }
      if (o.askCache) o.askCache.set(key, out);
      return out;
    },
  };
}

// ---------- visual probe (v1) ----------
// Four solid-color quadrants, shuffled every probe. The pixel layout is
// the ONLY carrier of the answer: the prompt, the generated bytes'
// metadata and every model-visible string are answer-free. Full blind
// guessing succeeds with probability 1/24.

var PROBE_SIZE = 400;
var PROBE_COLORS = {
  red: [222, 49, 49],
  blue: [49, 80, 222],
  yellow: [240, 200, 40],
  black: [20, 20, 20],
};
var PROBE_COLOR_NAMES = Object.keys(PROBE_COLORS);
var PROBE_PROMPT = 'The image contains four solid-color quadrants. '
  + 'Return their colors in order: top-left, top-right, bottom-left, bottom-right. '
  + 'Return only four lowercase color names separated by commas.';

function probeShuffle(list) {
  var out = list.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

// ---------- minimal PNG encoder (truecolor RGB, stored deflate) ----------
// No image dependency: PNG allows zlib streams built from stored
// (uncompressed) deflate blocks, so a correct encoder is small and runs
// in the browser and Node alike.

var PROBE_CRC_TABLE = null;
function probeCrc32(bytes) {
  if (!PROBE_CRC_TABLE) {
    PROBE_CRC_TABLE = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      PROBE_CRC_TABLE[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = PROBE_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function probeAdler32(bytes) {
  var a = 1, b = 0;
  for (var i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function probeChunk(type, data) {
  var out = new Uint8Array(12 + data.length);
  var len = data.length;
  out[0] = (len >>> 24) & 0xFF; out[1] = (len >>> 16) & 0xFF;
  out[2] = (len >>> 8) & 0xFF; out[3] = len & 0xFF;
  for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  var crcInput = out.subarray(4, 8 + data.length);
  var crc = probeCrc32(crcInput);
  out[8 + data.length] = (crc >>> 24) & 0xFF;
  out[9 + data.length] = (crc >>> 16) & 0xFF;
  out[10 + data.length] = (crc >>> 8) & 0xFF;
  out[11 + data.length] = crc & 0xFF;
  return out;
}

function probeZlibStored(raw) {
  var maxBlock = 65535;
  var blocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  var out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  var p = 0;
  out[p++] = 0x78; out[p++] = 0x01;
  var offset = 0;
  for (var b = 0; b < blocks; b++) {
    var len = Math.min(maxBlock, raw.length - offset);
    var final = b === blocks - 1 ? 1 : 0;
    out[p++] = final;
    out[p++] = len & 0xFF; out[p++] = (len >>> 8) & 0xFF;
    var nlen = (~len) & 0xFFFF;
    out[p++] = nlen & 0xFF; out[p++] = (nlen >>> 8) & 0xFF;
    out.set(raw.subarray(offset, offset + len), p);
    p += len;
    offset += len;
  }
  var adler = probeAdler32(raw);
  out[p++] = (adler >>> 24) & 0xFF;
  out[p++] = (adler >>> 16) & 0xFF;
  out[p++] = (adler >>> 8) & 0xFF;
  out[p++] = adler & 0xFF;
  return out.subarray(0, p);
}

// Generate one probe image: 400×400, four 200×200 quadrants in the
// given color order [topLeft, topRight, bottomLeft, bottomRight].
function generateProbePng(quadrantNames) {
  var size = PROBE_SIZE;
  var half = size / 2;
  var raw = new Uint8Array(size * (1 + size * 3));
  var p = 0;
  for (var y = 0; y < size; y++) {
    raw[p++] = 0; // filter type 0 (None)
    for (var x = 0; x < size; x++) {
      var name = (y < half) ? (x < half ? quadrantNames[0] : quadrantNames[1])
                            : (x < half ? quadrantNames[2] : quadrantNames[3]);
      var rgb = PROBE_COLORS[name];
      raw[p++] = rgb[0]; raw[p++] = rgb[1]; raw[p++] = rgb[2];
    }
  }
  var ihdr = new Uint8Array(13);
  var w = size, h = size;
  ihdr[0] = (w >>> 24) & 0xFF; ihdr[1] = (w >>> 16) & 0xFF; ihdr[2] = (w >>> 8) & 0xFF; ihdr[3] = w & 0xFF;
  ihdr[4] = (h >>> 24) & 0xFF; ihdr[5] = (h >>> 16) & 0xFF; ihdr[6] = (h >>> 8) & 0xFF; ihdr[7] = h & 0xFF;
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var signature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  var ihdrChunk = probeChunk('IHDR', ihdr);
  var idatChunk = probeChunk('IDAT', probeZlibStored(raw));
  var iendChunk = probeChunk('IEND', new Uint8Array(0));
  var total = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  var png = new Uint8Array(total);
  var at = 0;
  for (var c = 0; c < 4; c++) {
    var part = [signature, ihdrChunk, idatChunk, iendChunk][c];
    png.set(part, at);
    at += part.length;
  }
  return png;
}

function probeColorWords(text) {
  var m = String(text || '').toLowerCase().match(/red|blue|yellow|black/g);
  return m || [];
}

// ---------- provider image-rejection classification (F-I56) ----------
// CONSERVATIVE PRINCIPLE (docs/IMAGE-INPUT.md): a FALSE NEGATIVE in
// capability detection is acceptable — a missed downgrade only means the
// human is asked again. A FALSE POSITIVE persistent downgrade is not: a
// healthy vision model must never be permanently marked text-only. When
// a rejection cannot be attributed with confidence → 'ambiguous'.
//
// Categories:
//   'model_unsupported' — an explicit MODEL/path capability attribution
//     ("this model does not support image input"). The ONLY category
//     that may persist unsupported/provider-rejection.
//   'mime_unsupported' — the image's FORMAT/media type was rejected
//     ("unsupported media_type image/gif"). Input-instance failure:
//     the request fails, the model's overall image capability is NOT
//     changed (no per-MIME registry in v1).
//   'invalid_image' — the image BYTES were rejected (corrupt, truncated,
//     undecodable, oversized, bad base64). Input-instance failure;
//     capability NOT changed.
//   'ambiguous' — everything else: auth (401/403), model-not-found
//     (404), quota (429), 5xx, timeouts, network, parse errors,
//     tool-schema rejections, generic 400/422 validation and any text
//     without explicit image semantics. Never capability evidence.
//
// HTTP status is a HINT only: non-400/422 can never be evidence, and a
// 400/422 becomes evidence solely through the explicit model-level
// semantics below — never through the status code alone. A bad image
// must not read as "no image support".
//
// `detail` is a truncated debug/UI summary. It is never returned to the
// model and never contains payload bytes.
function classifyImageProviderError(e) {
  var status = e && typeof e.status === 'number' ? e.status : null;
  var pe = (e && e.providerError) || {};
  var raw = [e && e.message, pe.message, pe.param, pe.type, pe.code]
    .filter(function (v) { return v !== undefined && v !== null && v !== ''; })
    .map(function (v) { return String(v); }).join(' | ');
  var detail = raw.slice(0, 300);
  if (status !== 400 && status !== 422) return { kind: 'ambiguous', detail: detail };
  var text = raw.toLowerCase();
  if (!text) return { kind: 'ambiguous', detail: detail };

  // 1) Format/media-type failures FIRST: they may name the model too
  //    ("model does not support image/gif" is a format fact), and must
  //    never be read as a whole-model capability rejection.
  var formatNoun = /(image ?formats?|media ?_?types?|image\/[a-z0-9.+-]+|\b(gif|jpe?g|png|webp|bmp|tiff|heic|heif|avif)\b)/.test(text);
  if (formatNoun && /(unsupported|not\s+support|invalid|unexpected|unknown|bad|wrong)/.test(text)) {
    return { kind: 'mime_unsupported', detail: detail };
  }

  // 2) The image BYTES themselves are bad (input-instance failure).
  if (/\binvalid[ _-]?image/.test(text)
    || /image[^.\n]{0,60}(corrupt|truncat|malformed|unparsable|undecodable|decod|damaged|missing data|cannot be read|failed to (process|decode|parse)|is not valid)/.test(text)
    || /(corrupt|truncat|malformed|unparsable|decod|damaged)[^.\n]{0,60}image/.test(text)
    || /(bad|invalid|malformed)[^.\n]{0,20}base64/.test(text)
    || /image[^.\n]{0,40}(too large|exceeds)/.test(text)
    || /dimensions?[^.\n]{0,30}(invalid|too large|exceed)/.test(text)) {
    return { kind: 'invalid_image', detail: detail };
  }

  // 3) Explicit MODEL/path capability attribution. Every pattern demands
  //    BOTH a model-level subject AND image-input semantics in the same
  //    clause; anything looser stays 'ambiguous' (conservative).
  var modelImageUnsupported = [
    /\b(model|deployment|endpoint)\b[^.\n]{0,80}\b(does\s?not|doesn'?t|do not|cannot|can'?t|can not|unable to|won'?t|will not)\b[^.\n]{0,60}\b(support|accept|process|handle|ingest|take)\b[^.\n]{0,80}\b(image|vision|multimodal|visual|picture|photo)/,
    /\bimage[s]?\b[^.\n]{0,60}\b(is|are)\s+(not\s+supported|unsupported|not\s+accepted|not\s+available|no longer supported)\b[^.\n]{0,80}\b(by|for|on|with|in)\b[^.\n]{0,40}\b(this|the|that|selected|current|chosen|target|requested)\b[^.\n]{0,40}\b(model|deployment)/,
    /\bvision\b[^.\n]{0,60}\bnot\s+available\b[^.\n]{0,60}\b(model|deployment)\b/,
    /\b(model|deployment)\b[^.\n]{0,80}\bonly\s+supports?\b[^.\n]{0,60}\btext\b/,
    /\btext[-\s]only\b[^.\n]{0,60}\b(model|deployment)\b/,
    /\bnot\s+(a|an)\s+(vision|multimodal|image-capable|image)\b/,
    /\bimage[ _]?(url|input|content|part)s?\b[^.\n]{0,80}\bonly\b[^.\n]{0,60}\b(supported|accepted|available)\b[^.\n]{0,80}\b(vision|multimodal|image)/,
  ];
  for (var i = 0; i < modelImageUnsupported.length; i++) {
    if (modelImageUnsupported[i].test(text)) return { kind: 'model_unsupported', detail: detail };
  }

  // 4) Everything else — "tools not supported", generic "invalid
  //    request", model-not-found, token errors, … — stays ambiguous.
  return { kind: 'ambiguous', detail: detail };
}

// Boolean seam over the classifier (kept for the probe + error paths):
// TRUE only for an explicit model-level capability rejection. Corrupt
// images and unsupported MIME types are NOT model capability evidence
// (F-I56): they never downgrade the registry.
function isImageUnsupportedProviderError(e) {
  return classifyImageProviderError(e).kind === 'model_unsupported';
}

function classifyProbeFailure(e) {
  if (!e) return 'unknown-error';
  if (e.timeout) return 'timeout';
  if (e.name === 'AbortError' || e.cancelled) return 'cancelled';
  if (e.name === 'ParseError' || e.name === 'BodyReadError') return 'malformed-response';
  if (typeof e.status === 'number') return 'http-' + e.status;
  if (e instanceof TypeError) return 'network';
  return 'error';
}

// ------------------------------------------------------------
//  runImageInputProbe({ signal, model, callModelFn })
//
//  An isolated Harness control-plane diagnostic call. Strong
//  invariant: it goes through the PRODUCTION provider path — the same
//  callModel/adapter/endpoint/model/protocol as ordinary model
//  requests — so it detects whether the CURRENT provider path accepts
//  image input, not whether some model family is philosophically
//  multimodal. The request carries NO tools and NO conversation state;
//  its result never enters history, frames or events.
// ------------------------------------------------------------
async function runImageInputProbe(opts) {
  var o = opts || {};
  var modelCall = o.callModelFn
    || (typeof callModel === 'function' ? callModel : null);
  if (!modelCall) return { state: 'unknown', reason: 'no-model-client' };
  var quadrantNames = probeShuffle(PROBE_COLOR_NAMES);
  var png = generateProbePng(quadrantNames);
  var body = {
    model: o.model || (typeof Model !== 'undefined' ? Model.model : ''),
    // Small but nonzero: a vision model only needs four words.
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROBE_PROMPT },
        { type: 'image', mimeType: 'image/png', dataBase64: uint8ToBase64(png) },
      ],
    }],
  };
  var envelope;
  try {
    envelope = await modelCall(body, { signal: o.signal || null });
  } catch (e) {
    if (isImageUnsupportedProviderError(e)) {
      return { state: 'unsupported', source: 'provider-rejection', reason: classifyProbeFailure(e) + ': image input explicitly rejected' };
    }
    // Auth/quota/5xx/timeout/network/parse/cancellation: inconclusive —
    // a wrong answer must never mean "text-only model".
    return { state: 'unknown', reason: classifyProbeFailure(e) };
  }
  var words = probeColorWords(envelope && envelope.content);
  if (words.length === 4 && words.every(function (w, i) { return w === quadrantNames[i]; })) {
    return { state: 'supported', source: 'probe' };
  }
  // A wrong/absent answer means the model could not SEE (or could not
  // follow) the probe — capability stays unknown, never unsupported.
  return { state: 'unknown', reason: words.length === 4 ? 'probe-answer-mismatch' : 'probe-answer-unparseable' };
}
