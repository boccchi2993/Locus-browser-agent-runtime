// Provider adapter rich-content serialization tests (node, no network).
// Semantic resolved image parts → provider wire shapes; text-only and
// provider-native replay regressions stay untouched; unresolved refs fail
// loudly. Run: node tests/model-adapters-image.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'file:' } };
const M = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'model-adapters.js'), 'utf8') +
  '\n;({ OpenAIAdapter, AnthropicAdapter, projectNormalizedHistory });'
);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const B64_A = Buffer.from('sentinel-image-bytes-alpha').toString('base64');
const B64_B = Buffer.from('sentinel-image-bytes-beta').toString('base64');

const RICH_USER = {
  role: 'user',
  content: [
    { type: 'text', text: '帮我看一下这个截图' },
    { type: 'image', attachmentId: 'att_a', mimeType: 'image/png', sha256: 'aa', size: 25, dataBase64: B64_A },
    { type: 'text', text: 'and this chart' },
    { type: 'image', attachmentId: 'att_b', mimeType: 'image/jpeg', sha256: 'bb', size: 27, dataBase64: B64_B },
  ],
};

function openaiRequest(messages) {
  return M.OpenAIAdapter.serializeRequest({ model: 'm', messages, max_tokens: 10 });
}
function anthropicRequest(messages) {
  return M.AnthropicAdapter.serializeRequest({ model: 'm', messages, max_tokens: 10 });
}

async function main() {
  // ---------- OpenAI-compatible ----------
  let wire = openaiRequest([RICH_USER]);
  let parts = wire.messages[0].content;
  check('O1 OpenAI: text ordering preserved around images',
    parts.length === 4 && parts[0].type === 'text' && parts[0].text === '帮我看一下这个截图'
      && parts[2].type === 'text' && parts[2].text === 'and this chart');
  check('O2 OpenAI: image → image_url data URL with exact MIME + exact base64',
    parts[1].type === 'image_url' && parts[1].image_url.url === 'data:image/png;base64,' + B64_A
      && parts[3].type === 'image_url' && parts[3].image_url.url === 'data:image/jpeg;base64,' + B64_B,
    JSON.stringify(parts[1]).slice(0, 120));
  check('O3 OpenAI: semantic fields (attachmentId/sha256) never reach the wire',
    !JSON.stringify(parts).includes('attachmentId') && !JSON.stringify(parts).includes('sha256'));

  // Text-only regression: string content stays a string everywhere.
  wire = openaiRequest([{ role: 'user', content: 'plain' }]);
  check('O4 OpenAI: text-only history is unchanged', wire.messages[0].content === 'plain');
  // Assistant raw replay with reasoning_content + tool_calls rides along.
  const assistantRaw = {
    role: 'assistant', content: null, reasoning_content: 'opaque',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"input":"ls"}' } }],
  };
  wire = openaiRequest([{ role: 'user', content: 'q' }, assistantRaw,
    { role: 'tool_result', toolCallId: 'c1', toolName: 'bash', content: 'out', success: true }]);
  check('O5 OpenAI: native tool replay unchanged alongside rich content',
    wire.messages[1].tool_calls[0].id === 'c1' && wire.messages[1].reasoning_content === 'opaque'
      && wire.messages[2].role === 'tool' && wire.messages[2].tool_call_id === 'c1');

  // Unresolved semantic ref → loud failure, never a silent image-less send.
  let threw = null;
  try {
    openaiRequest([{ role: 'user', content: [
      { type: 'text', text: 'x' },
      { type: 'image', attachmentId: 'att_missing', mimeType: 'image/png' },
    ] }]);
  } catch (e) { threw = e; }
  check('O6 OpenAI: unresolved attachment fails loudly', !!threw && /unresolved image attachment/.test(threw.message), threw && threw.message);
  threw = null;
  try { openaiRequest([{ role: 'user', content: [{ type: 'bogus', x: 1 }] }]); }
  catch (e) { threw = e; }
  check('O6b OpenAI: unknown part type fails loudly', !!threw && /unsupported rich content part/.test(threw.message));

  // ---------- Anthropic-compatible ----------
  wire = anthropicRequest([RICH_USER]);
  parts = wire.messages[0].content;
  check('A1 Anthropic: text ordering preserved around images',
    parts.length === 4 && parts[0].type === 'text' && parts[0].text === '帮我看一下这个截图');
  check('A2 Anthropic: image → base64 source block with exact media_type + data',
    parts[1].type === 'image' && parts[1].source.type === 'base64'
      && parts[1].source.media_type === 'image/png' && parts[1].source.data === B64_A
      && parts[3].source.media_type === 'image/jpeg' && parts[3].source.data === B64_B,
    JSON.stringify(parts[1]).slice(0, 140));

  wire = anthropicRequest([{ role: 'user', content: 'plain' }]);
  check('A3 Anthropic: text-only history is unchanged', wire.messages[0].content === 'plain');

  // Provider-native assistant block arrays (thinking/tool_use) replay verbatim.
  const anthropicAssistant = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'secret-thought', signature: 'sig' },
    { type: 'text', text: 'calling' },
    { type: 'tool_use', id: 't1', name: 'bash', input: { input: 'ls' } },
  ] };
  wire = anthropicRequest([anthropicAssistant,
    { role: 'tool_result', toolCallId: 't1', toolName: 'bash', content: 'out', success: true }]);
  check('A4 Anthropic: thinking/tool_use replay untouched (same provider fidelity)',
    wire.messages[0].content[0].signature === 'sig'
      && wire.messages[0].content[2].tool_use_id === undefined
      && wire.messages[1].content[0].type === 'tool_result' && wire.messages[1].content[0].tool_use_id === 't1');

  threw = null;
  try {
    anthropicRequest([{ role: 'user', content: [
      { type: 'image', attachmentId: 'att_missing', mimeType: 'image/png' },
    ] }]);
  } catch (e) { threw = e; }
  check('A5 Anthropic: unresolved attachment fails loudly', !!threw && /unresolved image attachment/.test(threw.message));

  // ---------- cross-provider projection ----------
  const projected = M.projectNormalizedHistory([
    { role: 'user', kind: 'message', text: 'look', contentParts: [
      { type: 'text', text: 'look' },
      { type: 'image', attachmentId: 'att_a', mimeType: 'image/png', sha256: 'aa', size: 25 },
    ] },
    { role: 'user', kind: 'message', text: 'plain turn', contentParts: null },
  ], 'openai');
  check('X1 projection keeps semantic image refs (no base64, gate decides later)',
    projected[0].role === 'user' && Array.isArray(projected[0].content)
      && projected[0].content[1].attachmentId === 'att_a' && !JSON.stringify(projected).includes('dataBase64'));
  check('X1b plain turns project to strings as before', projected[1].content === 'plain turn');

  console.log('---');
  console.log('model-adapters-image.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
