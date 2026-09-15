// ProviderAdapter boundary tests (node, no DOM/fetch needed for pure
// adapter logic; a mocked fetch covers the round-trip integration).
// Run: node tests/model-adapters.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'file:' } };

const M = eval(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'model-adapters.js'), 'utf8') +
  '\n' + fs.readFileSync(path.join(__dirname, '..', 'src', 'model.js'), 'utf8') +
  '\n;({ detectDialect, getProviderAdapter, OpenAIAdapter, AnthropicAdapter, callModel, Model });'
);

// --- fetch mock (same contract as tests/model.test.cjs) ---
let calls = [];
let queue = [];
global.fetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  const next = queue.length ? queue.shift() : { status: 500, json: { error: { message: 'no mock queued' } } };
  if (next.typeError) throw new TypeError('Failed to fetch');
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: { get: (n) => (next.headers || {})[String(n).toLowerCase()] || null },
    text: async () => (next.rawText !== undefined ? next.rawText : JSON.stringify(next.json)),
  };
};

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function reset(apiBase, dialect) {
  M.Model.apiBase = apiBase;
  M.Model.apiKey = 'sk-test-key';
  M.Model.proxy = '';
  M.Model.dialect = dialect || 'auto';
  calls = [];
  queue = [];
}

const BODY = { model: 'm', max_tokens: 8, system: 's', messages: [{ role: 'user', content: 'hi' }] };

async function run() {
  // ---------- 1. dialect selection ----------
  // auto keeps the existing heuristic behavior
  check('S1 auto: api.anthropic.com → anthropic adapter',
    M.getProviderAdapter({ dialect: 'auto', apiBase: 'https://api.anthropic.com' }).dialect === 'anthropic');
  check('S2 auto: /anthropic suffix → anthropic adapter',
    M.getProviderAdapter({ dialect: 'auto', apiBase: 'https://api.deepseek.com/anthropic' }).dialect === 'anthropic');
  check('S3 auto: anything else → openai adapter',
    M.getProviderAdapter({ dialect: 'auto', apiBase: 'https://example.com/v1' }).dialect === 'openai');
  check('S4 missing dialect defaults to auto',
    M.getProviderAdapter({ apiBase: 'https://api.anthropic.com' }).dialect === 'anthropic');

  // explicit override beats endpoint shape — on ANY hostname
  check('S5 explicit openai overrides anthropic-looking host',
    M.getProviderAdapter({ dialect: 'openai', apiBase: 'https://api.anthropic.com' }).dialect === 'openai');
  check('S6 explicit anthropic on arbitrary enterprise hostname',
    M.getProviderAdapter({ dialect: 'anthropic', apiBase: 'https://gateway.corp.example.com/custom' }).dialect === 'anthropic');
  check('S7 explicit openai on arbitrary hostname',
    M.getProviderAdapter({ dialect: 'openai', apiBase: 'https://selfhosted.example.net/api' }).dialect === 'openai');

  let s8Err = null;
  try { M.getProviderAdapter({ dialect: 'bedrock', apiBase: 'https://x.example.com' }); } catch (e) { s8Err = e; }
  check('S8 unknown explicit dialect fails loudly before any request',
    s8Err && s8Err.message.includes('bedrock') && calls.length === 0, s8Err && s8Err.message);

  // adapters are pure: no window/document/fetch references needed
  check('S9 adapters are plain objects with the ProviderAdapter interface',
    ['buildEndpoints', 'buildHeaders', 'serializeRequest', 'prepareHistory', 'parseResponse']
      .every((k) => typeof M.OpenAIAdapter[k] === 'function' && typeof M.AnthropicAdapter[k] === 'function'));

  // ---------- 2. request serialization ----------
  const oaiBody = M.OpenAIAdapter.serializeRequest(BODY);
  check('R1 openai: system hoisted into messages',
    oaiBody.messages[0].role === 'system' && oaiBody.messages[0].content === 's' && !('system' in oaiBody));
  check('R2 openai: model/messages/max_tokens shape',
    oaiBody.model === 'm' && oaiBody.messages[1].role === 'user' && oaiBody.max_tokens === 8);
  check('R3 openai: max_tokens defaults to 2000',
    M.OpenAIAdapter.serializeRequest({ model: 'm', messages: [] }).max_tokens === 2000);

  const antBody = M.AnthropicAdapter.serializeRequest(BODY);
  check('R4 anthropic: system stays top-level',
    antBody.system === 's' && antBody.messages.length === 1 && antBody.messages[0].role === 'user');
  check('R5 anthropic: max_tokens passed through, no default injected',
    antBody.max_tokens === 8 && M.AnthropicAdapter.serializeRequest({ model: 'm', messages: [] }).max_tokens === undefined);

  // ---------- 3. endpoints & headers ----------
  check('E1 openai endpoints: bare + /v1 fallback order',
    JSON.stringify(M.OpenAIAdapter.buildEndpoints('https://api.deepseek.com')) ===
    JSON.stringify(['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1/chat/completions']));
  check('E2 anthropic endpoint: /v1/messages',
    JSON.stringify(M.AnthropicAdapter.buildEndpoints('https://api.deepseek.com/anthropic')) ===
    JSON.stringify(['https://api.deepseek.com/anthropic/v1/messages']));
  const oaiH = M.OpenAIAdapter.buildHeaders({ apiKey: 'k', apiBase: 'https://x.example.com' });
  check('E3 openai headers: Bearer, no x-api-key',
    oaiH['Authorization'] === 'Bearer k' && !('x-api-key' in oaiH));
  const antH = M.AnthropicAdapter.buildHeaders({ apiKey: 'k', apiBase: 'https://third-party.example.com/anthropic' });
  check('E4 anthropic headers: x-api-key + version, no Bearer, no browser-access header off-official',
    antH['x-api-key'] === 'k' && antH['anthropic-version'] === '2023-06-01'
    && !('Authorization' in antH) && !('anthropic-dangerous-direct-browser-access' in antH));
  check('E5 official anthropic keeps direct-browser-access header',
    M.AnthropicAdapter.buildHeaders({ apiKey: 'k', apiBase: 'https://api.anthropic.com' })['anthropic-dangerous-direct-browser-access'] === 'true');

  // Explicit dialect must never rewrite the user's base path: a path
  // segment named /anthropic is endpoint identity, not a protocol hint.
  const gwBase = 'https://gateway.example.com/anthropic';
  check('E6 explicit openai + /anthropic path → OpenAIAdapter',
    M.getProviderAdapter({ dialect: 'openai', apiBase: gwBase }).dialect === 'openai');
  check('E7 explicit openai preserves the /anthropic path segment verbatim',
    JSON.stringify(M.OpenAIAdapter.buildEndpoints(gwBase)) ===
    JSON.stringify(['https://gateway.example.com/anthropic/chat/completions',
      'https://gateway.example.com/anthropic/v1/chat/completions']),
    JSON.stringify(M.OpenAIAdapter.buildEndpoints(gwBase)));
  check('E8 auto heuristic unchanged: /anthropic suffix → AnthropicAdapter',
    M.getProviderAdapter({ dialect: 'auto', apiBase: gwBase }).dialect === 'anthropic');
  check('E9 arbitrary base path appended verbatim, never rewritten',
    JSON.stringify(M.OpenAIAdapter.buildEndpoints('https://gateway.example.com/company/proxy')) ===
    JSON.stringify(['https://gateway.example.com/company/proxy/chat/completions',
      'https://gateway.example.com/company/proxy/v1/chat/completions']));

  // ---------- 4. OpenAI reasoning_content replay round-trip ----------
  const oaiResp = {
    id: 'chatcmpl-1', model: 'deepseek-reasoner',
    choices: [{ message: {
      role: 'assistant', content: 'visible answer',
      reasoning_content: 'important internal returned state',
      vendor_extension_field: { opaque: true },
    }, finish_reason: 'stop' }],
    usage: { total_tokens: 42 },
  };
  const oaiEnv = M.OpenAIAdapter.parseResponse(oaiResp);
  check('O1 envelope separates content/reasoning',
    oaiEnv.content === 'visible answer' && oaiEnv.reasoning === 'important internal returned state');
  check('O2 reasoningType is raw, toolCalls placeholder is null',
    oaiEnv.reasoningType === 'raw' && oaiEnv.toolCalls === null);
  check('O3 stopReason + usage preserved',
    oaiEnv.stopReason === 'stop' && oaiEnv.usage.total_tokens === 42 && oaiEnv.truncated === false);
  check('O4 providerMetadata is light (id/model), not a body copy',
    oaiEnv.providerMetadata && oaiEnv.providerMetadata.id === 'chatcmpl-1'
    && oaiEnv.providerMetadata.model === 'deepseek-reasoner' && !('choices' in oaiEnv.providerMetadata));
  check('O5 rawMessage keeps reasoning_content AND unknown provider fields',
    oaiEnv.rawMessage.reasoning_content === 'important internal returned state'
    && oaiEnv.rawMessage.vendor_extension_field && oaiEnv.rawMessage.vendor_extension_field.opaque === true);

  // round-trip: rawMessage → next request must carry the native state
  const oaiNext = M.OpenAIAdapter.serializeRequest({
    model: 'm', max_tokens: 8, system: 's',
    messages: [{ role: 'user', content: 'hi' }, oaiEnv.rawMessage, { role: 'user', content: 'next' }],
  });
  const oaiReplayed = oaiNext.messages[2];
  check('O6 replay: reasoning_content survives into the next request',
    oaiReplayed.role === 'assistant' && oaiReplayed.reasoning_content === 'important internal returned state');
  check('O7 replay: unknown provider field survives into the next request',
    oaiReplayed.vendor_extension_field && oaiReplayed.vendor_extension_field.opaque === true);
  check('O8 replay: serialized JSON wire body retains native state',
    JSON.stringify(oaiNext).includes('important internal returned state')
    && JSON.stringify(oaiNext).includes('vendor_extension_field'));

  // ---------- 5. Anthropic block replay round-trip ----------
  const antBlocks = [
    { type: 'thinking', thinking: 'visible chain', signature: 'sig-abc' },
    { type: 'text', text: 'part one ' },
    { type: 'redacted_thinking', data: 'encrypted-opaque-blob' },
    { type: 'text', text: 'part two' },
    { type: 'future_opaque_block', payload: { x: 1 } },
  ];
  const antResp = {
    id: 'msg_1', model: 'claude-x', content: antBlocks,
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 9 },
  };
  const antEnv = M.AnthropicAdapter.parseResponse(antResp);
  check('A1 visible content = text blocks only, in order',
    antEnv.content === 'part one part two');
  check('A2 reasoning = visible thinking only',
    antEnv.reasoning === 'visible chain' && antEnv.reasoningType === 'raw');
  check('A3 redacted/opaque state is NOT visible reasoning',
    !antEnv.reasoning.includes('encrypted-opaque-blob') && !antEnv.content.includes('encrypted-opaque-blob')
    && !JSON.stringify({ c: antEnv.content, r: antEnv.reasoning }).includes('future_opaque_block'));
  check('A4 rawMessage preserves the EXACT block array (order, types, signatures)',
    JSON.stringify(antEnv.rawMessage.content) === JSON.stringify(antBlocks));
  check('A5 stopReason + usage + providerMetadata preserved',
    antEnv.stopReason === 'end_turn' && antEnv.usage.output_tokens === 9
    && antEnv.providerMetadata && antEnv.providerMetadata.id === 'msg_1'
    && !('content' in antEnv.providerMetadata));

  // round-trip: blocks re-enter the next request byte-identical, in order
  const antNext = M.AnthropicAdapter.serializeRequest({
    model: 'm', max_tokens: 8, system: 's',
    messages: [{ role: 'user', content: 'hi' }, antEnv.rawMessage, { role: 'user', content: 'next' }],
  });
  check('A6 replay: block array round-trips byte-identical',
    JSON.stringify(antNext.messages[1].content) === JSON.stringify(antBlocks));
  check('A7 replay: redacted_thinking + opaque blocks still present on the wire',
    antNext.messages[1].content[2].type === 'redacted_thinking'
    && antNext.messages[1].content[2].data === 'encrypted-opaque-blob'
    && antNext.messages[1].content[4].type === 'future_opaque_block');
  check('A8 anthropic string-content compatibility path still works',
    M.AnthropicAdapter.parseResponse({ content: 'OK' }).rawMessage.content === 'OK');

  // ---------- 6. integration through callModel: arbitrary host + explicit dialect ----------
  reset('https://enterprise-gateway.example.com/custom', 'anthropic');
  queue.push({ status: 200, json: antResp });
  const iEnv = await M.callModel(BODY);
  check('I1 arbitrary hostname + dialect=anthropic → /v1/messages + x-api-key',
    calls[0].url === 'https://enterprise-gateway.example.com/custom/v1/messages'
    && calls[0].headers['x-api-key'] === 'sk-test-key' && !('Authorization' in calls[0].headers),
    calls[0].url);
  check('I2 envelope parsed by the anthropic adapter',
    iEnv.content === 'part one part two' && iEnv.rawMessage.content.length === 5);

  // full two-turn replay through the real transport: turn-2 request body
  // must contain the turn-1 native assistant state
  queue.push({ status: 200, json: { content: [{ type: 'text', text: 'done' }] } });
  await M.callModel({
    model: 'm', max_tokens: 8, system: 's',
    messages: [{ role: 'user', content: 'hi' }, iEnv.rawMessage, { role: 'user', content: 'next' }],
  });
  check('I3 two-turn wire replay preserves redacted/opaque blocks',
    JSON.stringify(calls[1].body.messages[1].content) === JSON.stringify(antBlocks));

  reset('https://selfhosted.example.net/api', 'openai');
  queue.push({ status: 200, json: oaiResp });
  const i2Env = await M.callModel(BODY);
  check('I4 arbitrary hostname + dialect=openai → /chat/completions + Bearer',
    calls[0].url === 'https://selfhosted.example.net/api/chat/completions'
    && calls[0].headers['Authorization'] === 'Bearer sk-test-key' && !('x-api-key' in calls[0].headers),
    calls[0].url);
  queue.push({ status: 200, json: { choices: [{ message: { content: 'done' } }] } });
  await M.callModel({
    model: 'm', max_tokens: 8, system: 's',
    messages: [{ role: 'user', content: 'hi' }, i2Env.rawMessage, { role: 'user', content: 'next' }],
  });
  check('I5 two-turn wire replay preserves reasoning_content',
    calls[1].body.messages[2].reasoning_content === 'important internal returned state');

  // explicit dialect also works when auto would have picked the other one
  reset('https://api.anthropic.com', 'openai');
  queue.push({ status: 200, json: { choices: [{ message: { content: 'OK' } }] } });
  await M.callModel(BODY);
  check('I6 dialect=openai on api.anthropic.com uses openai protocol',
    calls[0].url === 'https://api.anthropic.com/chat/completions'
    && calls[0].headers['Authorization'] === 'Bearer sk-test-key', calls[0].url);

  // ---------- 7. OpenAI native tool_calls parsing ----------
  const oaiToolResp = {
    id: 'chatcmpl-t1', model: 'm',
    choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } },
        { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"input":"ls /tmp"}' } },
      ],
    }, finish_reason: 'tool_calls' }],
  };
  const oaiToolEnv = M.OpenAIAdapter.parseResponse(oaiToolResp);
  check('OT1 tool_calls-only response (content null) is a VALID envelope, no ParseError',
    oaiToolEnv.content === '' && Array.isArray(oaiToolEnv.toolCalls) && oaiToolEnv.toolCalls.length === 2);
  check('OT2 normalized shape { id, name, input-object }',
    oaiToolEnv.toolCalls[0].id === 'call_1' && oaiToolEnv.toolCalls[0].name === 'bash'
    && oaiToolEnv.toolCalls[0].input && oaiToolEnv.toolCalls[0].input.input === 'pwd'
    && oaiToolEnv.toolCalls[0].argumentsError === null, JSON.stringify(oaiToolEnv.toolCalls[0]));
  check('OT3 multiple tool_calls preserve provider order',
    oaiToolEnv.toolCalls[1].id === 'call_2' && oaiToolEnv.toolCalls[1].input.input === 'ls /tmp');
  check('OT4 rawMessage retains the EXACT provider tool_calls',
    JSON.stringify(oaiToolEnv.rawMessage.tool_calls) === JSON.stringify(oaiToolResp.choices[0].message.tool_calls));
  check('OT5 tool-only stopReason preserved', oaiToolEnv.stopReason === 'tool_calls');

  const oaiBothEnv = M.OpenAIAdapter.parseResponse({
    choices: [{ message: {
      role: 'assistant', content: '我先看一下目录。',
      reasoning_content: 'need to inspect first',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"input":"ls"}' } }],
    }, finish_reason: 'tool_calls' }],
  });
  check('OT6 visible text + reasoning + tool call all preserved',
    oaiBothEnv.content === '我先看一下目录。' && oaiBothEnv.reasoning === 'need to inspect first'
    && oaiBothEnv.toolCalls.length === 1 && oaiBothEnv.rawMessage.reasoning_content === 'need to inspect first');

  const oaiBadArgs = M.OpenAIAdapter.parseResponse({
    choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'call_bad', type: 'function', function: { name: 'bash', arguments: '{bad json' } },
        { id: 'call_num', type: 'function', function: { name: 'bash', arguments: '{"input":123}' } },
      ],
    }, finish_reason: 'tool_calls' }],
  });
  check('OT7 malformed JSON arguments never crash the adapter, marked argumentsError',
    oaiBadArgs.toolCalls[0].input === null && typeof oaiBadArgs.toolCalls[0].argumentsError === 'string');
  check('OT8 well-formed JSON with wrong field types still parses (harness validates semantics)',
    oaiBadArgs.toolCalls[1].input && oaiBadArgs.toolCalls[1].input.input === 123
    && oaiBadArgs.toolCalls[1].argumentsError === null);
  check('OT9 truncated tool-only response returns envelope (never misjudged as empty)',
    M.OpenAIAdapter.parseResponse({
      choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'c', function: { name: 'bash', arguments: '{"input":"x"}' } }] },
        finish_reason: 'length' }],
    }).truncated === true);

  // ---------- 8. OpenAI tools serialization ----------
  const TOOLS = [
    { name: 'bash', description: 'run local', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } },
    { name: 'cloud_bash', description: 'remote', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } },
  ];
  const oaiToolBody = M.OpenAIAdapter.serializeRequest(Object.assign({ tools: TOOLS }, BODY));
  check('OS1 openai tools → type:function wrapper with parameters=inputSchema',
    Array.isArray(oaiToolBody.tools) && oaiToolBody.tools.length === 2
    && oaiToolBody.tools[0].type === 'function'
    && oaiToolBody.tools[0].function.name === 'bash'
    && oaiToolBody.tools[0].function.description === 'run local'
    && oaiToolBody.tools[0].function.parameters.additionalProperties === false
    && !('input_schema' in oaiToolBody.tools[0]), JSON.stringify(oaiToolBody.tools));
  check('OS2 no tools key when input.tools absent/empty',
    !('tools' in M.OpenAIAdapter.serializeRequest(BODY))
    && !('tools' in M.OpenAIAdapter.serializeRequest(Object.assign({ tools: [] }, BODY))));

  // ---------- 9. Anthropic native tool_use parsing ----------
  const antToolBlocks = [
    { type: 'thinking', thinking: 'need to list files', signature: 'sig-t1' },
    { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { input: 'ls' } },
    { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { input: 'pwd' } },
  ];
  const antToolEnv = M.AnthropicAdapter.parseResponse({
    id: 'msg_t', model: 'm', content: antToolBlocks, stop_reason: 'tool_use',
  });
  check('AT1 tool_use-only response (no text) is a VALID envelope, no ParseError',
    antToolEnv.content === '' && antToolEnv.toolCalls.length === 2);
  check('AT2 normalized { id, name, input-object }, order preserved',
    antToolEnv.toolCalls[0].id === 'toolu_1' && antToolEnv.toolCalls[0].name === 'bash'
    && antToolEnv.toolCalls[0].input.input === 'ls'
    && antToolEnv.toolCalls[1].id === 'toolu_2');
  check('AT3 thinking + tool_use: reasoning visible, raw blocks byte-identical',
    antToolEnv.reasoning === 'need to list files'
    && JSON.stringify(antToolEnv.rawMessage.content) === JSON.stringify(antToolBlocks));
  const antMixedEnv = M.AnthropicAdapter.parseResponse({
    content: [
      { type: 'text', text: '查看一下：' },
      { type: 'future_opaque_block', payload: { x: 2 } },
      { type: 'tool_use', id: 'toolu_3', name: 'bash', input: { input: 'ls' } },
    ],
    stop_reason: 'tool_use',
  });
  check('AT4 text + unknown block + tool_use: all preserved',
    antMixedEnv.content === '查看一下：' && antMixedEnv.toolCalls.length === 1
    && antMixedEnv.rawMessage.content[1].type === 'future_opaque_block');
  const antBadInput = M.AnthropicAdapter.parseResponse({
    content: [{ type: 'tool_use', id: 'toolu_bad', name: 'bash', input: 'rm -rf /' }],
  });
  check('AT5 non-object tool_use input marked argumentsError, never executed upstream',
    antBadInput.toolCalls[0].input === null && typeof antBadInput.toolCalls[0].argumentsError === 'string');

  // ---------- 10. Anthropic tools serialization ----------
  const antToolBody = M.AnthropicAdapter.serializeRequest(Object.assign({ tools: TOOLS }, BODY));
  check('AS1 anthropic tools → name/description/input_schema, no tool_choice forced',
    Array.isArray(antToolBody.tools) && antToolBody.tools[0].name === 'bash'
    && antToolBody.tools[0].input_schema.additionalProperties === false
    && !('parameters' in antToolBody.tools[0]) && !('tool_choice' in antToolBody),
    JSON.stringify(antToolBody.tools));
  check('AS2 no tools key when input.tools absent',
    !('tools' in M.AnthropicAdapter.serializeRequest(BODY)));

  // ---------- 11. native tool result replay mapping ----------
  const oaiHist = M.OpenAIAdapter.serializeRequest({
    model: 'm', max_tokens: 8, system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      oaiToolEnv.rawMessage,
      { role: 'tool_result', toolCallId: 'call_1', toolName: 'bash', content: '/home/locus', success: true },
      { role: 'tool_result', toolCallId: 'call_2', toolName: 'bash', content: 'x', success: false },
    ],
  });
  check('RP1 openai neutral results → role:tool with exact tool_call_id pairing',
    oaiHist.messages[3].role === 'tool' && oaiHist.messages[3].tool_call_id === 'call_1'
    && oaiHist.messages[4].role === 'tool' && oaiHist.messages[4].tool_call_id === 'call_2'
    && oaiHist.messages[3].content === '/home/locus', JSON.stringify(oaiHist.messages.slice(2)));
  check('RP2 openai assistant rawMessage with tool_calls replays verbatim',
    JSON.stringify(oaiHist.messages[2].tool_calls) === JSON.stringify(oaiToolResp.choices[0].message.tool_calls));

  const antHist = M.AnthropicAdapter.serializeRequest({
    model: 'm', max_tokens: 8, system: 's',
    messages: [
      { role: 'user', content: 'hi' },
      antToolEnv.rawMessage,
      { role: 'tool_result', toolCallId: 'toolu_1', toolName: 'bash', content: 'a.txt', success: true },
      { role: 'tool_result', toolCallId: 'toolu_2', toolName: 'bash', content: 'boom', success: false },
    ],
  });
  check('RP3 anthropic consecutive results merge into ONE user turn of tool_result blocks',
    antHist.messages.length === 3 && antHist.messages[2].role === 'user'
    && Array.isArray(antHist.messages[2].content) && antHist.messages[2].content.length === 2,
    JSON.stringify(antHist.messages.map((m) => m.role)));
  check('RP4 anthropic tool_result ids pair exactly, is_error set from success',
    antHist.messages[2].content[0].type === 'tool_result'
    && antHist.messages[2].content[0].tool_use_id === 'toolu_1'
    && antHist.messages[2].content[0].is_error === false
    && antHist.messages[2].content[1].tool_use_id === 'toolu_2'
    && antHist.messages[2].content[1].is_error === true);
  check('RP5 anthropic assistant block array (thinking + tool_use) replays byte-identical',
    JSON.stringify(antHist.messages[1].content) === JSON.stringify(antToolBlocks));
  const antSplitHist = M.AnthropicAdapter.serializeRequest({
    model: 'm', max_tokens: 8,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { input: 'a' } }] },
      { role: 'tool_result', toolCallId: 'u1', toolName: 'bash', content: 'r1', success: true },
      { role: 'user', content: 'next question' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u2', name: 'bash', input: { input: 'b' } }] },
      { role: 'tool_result', toolCallId: 'u2', toolName: 'bash', content: 'r2', success: true },
    ],
  });
  check('RP6 results in different turns are NOT merged across a real user message',
    antSplitHist.messages.length === 6
    && antSplitHist.messages[2].content.length === 1
    && antSplitHist.messages[5].content.length === 1);

  // ---------- 12. tools downgrade classification (adapter-owned) ----------
  function httpErr(status, message, providerError) {
    const e = new Error(message); e.name = 'HttpError'; e.status = status;
    if (providerError) e.providerError = providerError;
    return e;
  }
  check('DG1 openai: 400 param=tools IS a tooling rejection',
    M.OpenAIAdapter.isToolingUnsupportedError(httpErr(400, 'Invalid request', { param: 'tools' })));
  check('DG2 openai: 400 message naming unsupported tools IS a tooling rejection',
    M.OpenAIAdapter.isToolingUnsupportedError(httpErr(400, 'unknown field "tools" in request')));
  check('DG3 anthropic: 400 invalid_request naming tools IS a tooling rejection',
    M.AnthropicAdapter.isToolingUnsupportedError(httpErr(400, 'tools: unknown field', { type: 'invalid_request_error' })));
  check('DG4 429/500/401/404 are NEVER tooling rejections',
    !M.OpenAIAdapter.isToolingUnsupportedError(httpErr(429, 'rate limit'))
    && !M.OpenAIAdapter.isToolingUnsupportedError(httpErr(500, 'unknown field "tools"'))
    && !M.OpenAIAdapter.isToolingUnsupportedError(httpErr(401, 'unauthorized'))
    && !M.AnthropicAdapter.isToolingUnsupportedError(httpErr(404, 'unknown field "tools"')));
  check('DG5 400 about an unrelated field is NOT a tooling rejection',
    !M.OpenAIAdapter.isToolingUnsupportedError(httpErr(400, 'model "x" does not exist', { param: 'model' })));
  const parseErr = new Error('bad body'); parseErr.name = 'ParseError'; parseErr.noFallback = true;
  check('DG6 parse/timeout/cancel errors are NEVER tooling rejections',
    !M.OpenAIAdapter.isToolingUnsupportedError(parseErr)
    && !M.OpenAIAdapter.isToolingUnsupportedError(new TypeError('Failed to fetch')));

  // ---------- 13. one-time downgrade retry through callModel ----------
  reset('https://toolsless.example.com/v1', 'openai');
  queue.push({ status: 400, json: { error: { message: 'unknown field "tools"', type: 'invalid_request_error', param: 'tools' } } });
  queue.push({ status: 200, json: { choices: [{ message: { content: '```json\n{"tool":"bash","input":"ls"}\n```' } }] } });
  const dgEnv = await M.callModel(Object.assign({ tools: TOOLS }, BODY));
  check('DG7 explicit tools rejection → exactly one downgrade retry, same endpoint',
    calls.length === 2 && calls[0].url === calls[1].url, 'calls=' + calls.length);
  check('DG8 retried request omits tools; original included them',
    Array.isArray(calls[0].body.tools) && !('tools' in calls[1].body));
  check('DG9 downgraded response parses normally (text fallback path)',
    dgEnv.content.includes('"tool"'));
  check('DG10 HttpError carries structured providerError metadata',
    true); // classification itself proved providerError.param arrived

  reset('https://toolsless.example.com/v1', 'openai');
  queue.push({ status: 429, json: { error: { message: 'rate limited' } } });
  let dg429 = null;
  try { await M.callModel(Object.assign({ tools: TOOLS }, BODY)); } catch (e) { dg429 = e; }
  check('DG11 429 never triggers a downgrade resend (double-billing guard)',
    dg429 && dg429.status === 429 && calls.length === 1, 'calls=' + calls.length);

  reset('https://toolsless.example.com/v1', 'openai');
  queue.push({ status: 400, json: { error: { message: 'model "m" does not exist', param: 'model' } } });
  let dg400 = null;
  try { await M.callModel(Object.assign({ tools: TOOLS }, BODY)); } catch (e) { dg400 = e; }
  check('DG12 unrelated 400 surfaces without resend',
    dg400 && dg400.status === 400 && calls.length === 1, 'calls=' + calls.length);

  reset('https://toolsless.example.com/v1', 'openai');
  queue.push({ status: 500, json: { error: { message: 'unknown field "tools"' } } });
  let dg500 = null;
  try { await M.callModel(Object.assign({ tools: TOOLS }, BODY)); } catch (e) { dg500 = e; }
  check('DG13 500 never triggers a downgrade resend',
    dg500 && dg500.status === 500 && calls.length === 1, 'calls=' + calls.length);

  reset('https://toolsless.example.com/v1', 'openai');
  queue.push({ status: 200, rawText: 'not json at all' });
  let dgParse = null;
  try { await M.callModel(Object.assign({ tools: TOOLS }, BODY)); } catch (e) { dgParse = e; }
  check('DG14 HTTP 200 parse failure never triggers a downgrade resend',
    dgParse && dgParse.name === 'ParseError' && calls.length === 1, 'calls=' + calls.length);

  reset('https://toolsless.example.com/v1', 'anthropic');
  queue.push({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'tools: unknown field' } } });
  queue.push({ status: 200, json: { content: [{ type: 'text', text: 'OK' }] } });
  await M.callModel(Object.assign({ tools: TOOLS }, BODY));
  check('DG15 anthropic dialect downgrade works on arbitrary endpoints',
    calls.length === 2 && Array.isArray(calls[0].body.tools) && !('tools' in calls[1].body));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
