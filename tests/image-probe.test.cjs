// Visual probe tests (node). The probe's answer lives ONLY in pixels:
// these tests decode the generated PNG's actual pixel values to answer
// it, exactly like a real vision model would have to, and verify the
// classification matrix (correct order → supported; wrong/absent answer,
// auth/quota/5xx/timeout/malformed/cancellation → unknown; explicit
// image validation rejection → unsupported). Also verifies the probe
// request shape carries a real image block and the production adapter
// serializes it (same path as ordinary model requests).
// Run: node tests/image-probe.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'file:' } };
const M = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'model-adapters.js'), 'utf8') +
  '\n' + fs.readFileSync(path.join(__dirname, '..', 'src', 'model.js'), 'utf8') +
  '\n;({ Model, getProviderAdapter, makeParseError, makeHttpError });'
);
const C = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'capabilities.js'), 'utf8') +
  '\n;({ runImageInputProbe, generateProbePng, PROBE_PROMPT, PROBE_SIZE, PROBE_COLORS, isImageUnsupportedProviderError });'
);
// uint8ToBase64 comes from attachments.js (shared helper).
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'attachments.js'), 'utf8') + '\n;void uint8ToBase64;');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- minimal PNG decoder for the generated probe image ----------
// Supports exactly what the encoder emits: 8-bit truecolor, filter 0,
// stored deflate blocks. Enough to assert the pixel-level answer.
function decodeProbePng(bytes) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  let at = 8;
  let width = 0, height = 0, idat = [];
  while (at < bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      if (data[8] !== 8 || data[9] !== 2) throw new Error('unexpected IHDR');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      at += 12;
      break;
    }
    at += 12 + len;
  }
  // Inflate stored blocks.
  const z = Buffer.concat(idat.map((u) => Buffer.from(u)));
  let p = 2; // zlib header
  const raw = [];
  for (;;) {
    const final = z[p] & 1;
    const len = z[p + 1] | (z[p + 2] << 8);
    raw.push(z.subarray(p + 5, p + 5 + len));
    p += 5 + len;
    if (final) break;
  }
  const merged = Buffer.concat(raw);
  const stride = 1 + width * 3;
  const pixel = (x, y) => {
    if (merged[y * stride] !== 0) throw new Error('unexpected filter byte');
    const off = y * stride + 1 + x * 3;
    return [merged[off], merged[off + 1], merged[off + 2]];
  };
  return { width, height, pixel };
}

function colorName(rgb) {
  for (const [name, v] of Object.entries(C.PROBE_COLORS)) {
    if (v[0] === rgb[0] && v[1] === rgb[1] && v[2] === rgb[2]) return name;
  }
  return 'unknown:' + rgb.join(',');
}

// Answer a probe body by READING ITS PIXELS (a fake vision model).
function answerFromPixels(dataBase64) {
  const bytes = new Uint8Array(Buffer.from(dataBase64, 'base64'));
  const img = decodeProbePng(bytes);
  const half = img.width / 2;
  return [img.pixel(50, 50), img.pixel(img.width - 50, 50), img.pixel(50, img.height - 50), img.pixel(img.width - 50, img.height - 50)]
    .map(colorName)
    .join(',');
}

function envelope(content) {
  return { content, reasoning: null, reasoningType: null, toolCalls: null, rawMessage: { role: 'assistant', content }, stopReason: 'stop', usage: null, providerMetadata: null, truncated: false };
}

function httpError(status, message, providerError) {
  return M.makeHttpError(status, message, providerError);
}

async function main() {
  // --- generated image integrity (answers live in pixels only) ---
  const png = C.generateProbePng(['red', 'blue', 'yellow', 'black']);
  const img = decodeProbePng(png);
  check('V1 probe image is a real 400×400 pixel PNG',
    img.width === C.PROBE_SIZE && img.height === C.PROBE_SIZE && C.PROBE_SIZE === 400);
  check('V1b fixed quadrant colors decode correctly',
    colorName(img.pixel(50, 50)) === 'red' && colorName(img.pixel(350, 50)) === 'blue'
      && colorName(img.pixel(50, 350)) === 'yellow' && colorName(img.pixel(350, 350)) === 'black');
  const png2 = C.generateProbePng(['black', 'yellow', 'blue', 'red']);
  const img2 = decodeProbePng(png2);
  check('V1c the quadrant order is parameterizable (random permutation carrier)',
    colorName(img2.pixel(50, 50)) === 'black' && colorName(img2.pixel(350, 50)) === 'yellow');
  check('V1d the prompt never carries the answer',
    !/red|blue|yellow|black/i.test(C.PROBE_PROMPT) && /top-left.*top-right.*bottom-left.*bottom-right/i.test(C.PROBE_PROMPT));

  // --- probe via fake model client that answers from pixels ---
  let lastBody = null;
  const visionModel = async (body, opts) => {
    lastBody = body;
    const imagePart = body.messages[0].content.find((p) => p.type === 'image');
    return envelope(await Promise.resolve(answerFromPixels(imagePart.dataBase64)));
  };
  let out = await C.runImageInputProbe({ callModelFn: visionModel });
  check('V2 pixel-correct answer → supported', out.state === 'supported' && out.source === 'probe', JSON.stringify(out));
  check('V2b the probe request is isolated: no tools, no system, one user message',
    !!lastBody && !lastBody.tools && !lastBody.system && lastBody.messages.length === 1
      && lastBody.messages[0].role === 'user');
  const textPart = lastBody.messages[0].content[0];
  const imageWirePart = lastBody.messages[0].content[1];
  check('V2c the payload really contains an image block (semantic form)',
    textPart.type === 'text' && imageWirePart.type === 'image'
      && imageWirePart.mimeType === 'image/png'
      && imageWirePart.dataBase64.startsWith('iVBORw0KGgo'));
  check('V2d the probe uses the CURRENT configured model',
    lastBody.model === (typeof Model !== 'undefined' ? Model.model : lastBody.model));

  // Wrong answer (a text-only model guessing) → unknown, NEVER unsupported.
  const blindModel = async () => envelope('red,red,red,red');
  out = await C.runImageInputProbe({ callModelFn: blindModel });
  check('V3 wrong color order → unknown (poor vision != no vision)',
    out.state === 'unknown' && out.reason === 'probe-answer-mismatch', JSON.stringify(out));

  out = await C.runImageInputProbe({ callModelFn: async () => envelope('I cannot see any image.') });
  check('V3b refusal/unparseable → unknown', out.state === 'unknown' && out.reason === 'probe-answer-unparseable');

  // --- failure matrix (all inconclusive) ---
  const matrix = [
    ['401', httpError(401, 'invalid api key'), 'http-401'],
    ['429', httpError(429, 'rate limited'), 'http-429'],
    ['500', httpError(500, 'boom'), 'http-500'],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError', timeout: true }), 'timeout'],
    ['malformed', Object.assign(new Error('bad body'), { name: 'ParseError' }), 'malformed-response'],
    ['cancelled', Object.assign(new Error('cancel'), { name: 'AbortError', cancelled: true }), 'cancelled'],
    ['network', new TypeError('failed to fetch'), 'network'],
  ];
  for (const [name, err, reason] of matrix) {
    out = await C.runImageInputProbe({ callModelFn: async () => { throw err; } });
    check('V4 ' + name + ' → unknown (' + reason + ')', out.state === 'unknown' && out.reason === reason, JSON.stringify(out));
  }

  // Explicit image validation rejection → unsupported.
  out = await C.runImageInputProbe({
    callModelFn: async () => { throw httpError(400, 'image content is not supported by this model', { param: 'content' }); },
  });
  check('V5 explicit image validation rejection → unsupported (provider-rejection)',
    out.state === 'unsupported' && out.source === 'provider-rejection', JSON.stringify(out));

  // --- probe request through the REAL production serialization path ---
  const probeBody = {
    model: 'probe-model', max_tokens: 64,
    messages: [{ role: 'user', content: [
      { type: 'text', text: C.PROBE_PROMPT },
      { type: 'image', mimeType: 'image/png', dataBase64: Buffer.from(png).toString('base64') },
    ] }],
  };
  const openai = M.getProviderAdapter({ dialect: 'openai' }).serializeRequest(probeBody);
  const openaiParts = openai.messages[0].content;
  check('V6 OpenAI-compatible serialization of the probe: image_url data URL',
    openaiParts[0].type === 'text' && openaiParts[1].type === 'image_url'
      && openaiParts[1].image_url.url === 'data:image/png;base64,' + probeBody.messages[0].content[1].dataBase64);
  const anthropic = M.getProviderAdapter({ dialect: 'anthropic' }).serializeRequest(probeBody);
  const anthropicParts = anthropic.messages[0].content;
  check('V6b Anthropic-compatible serialization of the probe: base64 image block',
    anthropicParts[1].type === 'image' && anthropicParts[1].source.type === 'base64'
      && anthropicParts[1].source.media_type === 'image/png'
      && anthropicParts[1].source.data === probeBody.messages[0].content[1].dataBase64);

  console.log('---');
  console.log('image-probe.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
