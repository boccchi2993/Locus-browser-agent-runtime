const fs = require('fs');
const path = require('path');

const adapterSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'model-adapters.js'), 'utf8');
const A = (0, eval)(adapterSource + '\n;({ OpenAIAdapter, AnthropicAdapter, projectNormalizedHistory });');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

const rawAnthropic = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'returned only', signature: 'sig-1' },
    { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'pwd' } },
    { type: 'future_vendor_block', nested: { value: 7 } },
  ],
};
const antMeta = { adapterId: A.AnthropicAdapter.adapterId, dialect: 'anthropic', provider: 'anthropic' };
const oaiMeta = { adapterId: A.OpenAIAdapter.adapterId, dialect: 'openai', provider: 'openai' };

check('R1 same adapter accepts raw replay', A.AnthropicAdapter.isRawReplayCompatible(antMeta, { dialect: 'anthropic' }));
check('R2 cross adapter rejects foreign raw replay', !A.OpenAIAdapter.isRawReplayCompatible(antMeta, { dialect: 'openai' }));

const normalized = [
  { conversationId: 'c', sequence: 1, role: 'user', kind: 'message', text: 'run pwd' },
  { conversationId: 'c', sequence: 2, role: 'assistant', kind: 'tool_call', text: '', toolCalls: [{ id: 'tool-1', name: 'bash', input: { command: 'pwd' } }] },
  { conversationId: 'c', sequence: 3, role: 'tool_result', kind: 'tool_result', toolCallId: 'tool-1', toolName: 'bash', toolResult: '/home/locus', success: true },
];
const projected = A.projectNormalizedHistory(normalized, 'openai');
check('R3 cross-provider projection has no foreign block array', !JSON.stringify(projected).includes('future_vendor_block') && !JSON.stringify(projected).includes('signature'));
check('R4 cross-provider projection preserves semantic tool id', projected[1].tool_calls[0].id === 'tool-1');
check('R5 cross-provider projection uses neutral tool result', projected[2].role === 'tool_result' && projected[2].toolCallId === 'tool-1');

const noReasoning = A.AnthropicAdapter.parseResponse({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' });
check('R6 provider without reasoning does not gain a thinking field', !Object.prototype.hasOwnProperty.call(noReasoning.rawMessage.content[0], 'thinking') && noReasoning.reasoning === null);
check('R7 raw archive retains the complete Anthropic block array', JSON.stringify(A.AnthropicAdapter.parseResponse({ content: rawAnthropic.content }).rawMessage.content) === JSON.stringify(rawAnthropic.content));

console.log('---');
console.log('provider-replay-persistence.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

