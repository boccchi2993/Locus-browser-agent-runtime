// Agent session regression tests (node): task↔workspace binding (F02),
// cancellation, history budget (F17).
// Model and tool execution are stubbed at the module boundary; the real
// agent.js loop runs unchanged.
// Run: node tests/agent.test.cjs

const fs = require('fs');
const path = require('path');

// --- stubs the agent loop reads from the environment ---
global.App = { workspace: { name: 'A' }, busy: false };
global.Model = { model: 'm' };
global.PythonRuntime = { resetCalls: 0, reset() { this.resetCalls++; } };

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
const M = eval(src + '\n;({ Agent, runAgentTask, resetAgentSession, cancelAgentTask, parseToolCall, HISTORY_BUDGET_CHARS });');

const term = { lines: [], echo(s) { this.lines.push(String(s)); }, update() {} };

function envelope(text, extra) {
  return Object.assign({
    content: text,
    reasoning: null,
    stopReason: 'end_turn',
    usage: null,
    rawMessage: { role: 'assistant', content: text },
    truncated: false,
  }, extra || {});
}
const TOOL_CALL = envelope('```json\n{"tool":"bash","input":"ls"}\n```');
const FINAL = envelope('done');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function resetState() {
  M.Agent.history = [];
  M.Agent.task = null;
  global.App.workspace = { name: 'A' };
  term.lines = [];
}

async function run() {
  // ---------- G1. switch during MODEL wait: late response is discarded (F02) ----------
  resetState();
  let resolveModel;
  const toolCalls = [];
  global.callModel = () => new Promise((r) => { resolveModel = r; });
  global.executeTool = async (t, input, ws) => { toolCalls.push(ws && ws.name); return { output: 'ok', success: true }; };

  let task = M.runAgentTask(term, 'do something in A');
  await Promise.resolve();
  // user switches workspace mid-wait (session reset happens in ui.js)
  global.App.workspace = { name: 'B' };
  M.resetAgentSession();
  resolveModel(TOOL_CALL); // old response arrives late
  await task;
  check('G1 late model response never executes (0 tool calls)', toolCalls.length === 0, toolCalls.join(','));
  check('G1b new session history not polluted by old reply',
    M.Agent.history.length === 0, JSON.stringify(M.Agent.history));
  check('G1c Python runtime reset at session boundary', global.PythonRuntime.resetCalls >= 1);

  // ---------- G2. switch during TOOL execution: result is discarded (F02) ----------
  resetState();
  let resolveTool;
  let modelCalls = 0;
  global.callModel = async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; };
  global.executeTool = async (t, input, ws) => {
    toolCalls.push(ws && ws.name);
    return new Promise((r) => { resolveTool = () => r({ output: 'ok', success: true }); });
  };
  toolCalls.length = 0;
  task = M.runAgentTask(term, 'task in A');
  await new Promise((r) => setTimeout(r, 10)); // let the tool start
  global.App.workspace = { name: 'B' };
  M.resetAgentSession();
  resolveTool();
  await task;
  check('G2 tool ran against the ORIGINAL workspace A', toolCalls.length === 1 && toolCalls[0] === 'A',
    toolCalls.join(','));
  check('G2b tool result never enters new session history', M.Agent.history.length === 0,
    JSON.stringify(M.Agent.history));
  check('G2c no second model call after switch', modelCalls === 1, 'modelCalls=' + modelCalls);

  // ---------- G3. cancellation aborts the model request ----------
  resetState();
  let sawSignal = null;
  global.callModel = (body, opts) => new Promise((resolve, reject) => {
    sawSignal = opts && opts.signal;
    opts.signal.addEventListener('abort', () => {
      const e = new Error('model request cancelled'); e.name = 'AbortError'; e.cancelled = true; reject(e);
    });
  });
  global.executeTool = async () => { throw new Error('must not run'); };
  task = M.runAgentTask(term, 'long task');
  await new Promise((r) => setTimeout(r, 10));
  M.cancelAgentTask();
  await task;
  check('G3 cancel aborts in-flight model request', sawSignal && sawSignal.aborted === true);
  check('G3b cancelled task noted, no failure dump',
    term.lines.some((l) => l.includes('已取消')) && !term.lines.some((l) => l.includes('模型调用失败')),
    term.lines.join(' | '));

  // ---------- G4. normal flow: tool call → feedback → final answer ----------
  resetState();
  modelCalls = 0;
  const seen = [];
  global.callModel = async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; };
  global.executeTool = async (t, input, ws) => { seen.push([t, input, ws && ws.name]); return { output: 'file.txt', success: true }; };
  await M.runAgentTask(term, 'list files');
  check('G4 tool executed against bound workspace', seen.length === 1 && seen[0][2] === 'A', JSON.stringify(seen));
  check('G4b history has user/assistant/feedback/final', M.Agent.history.length === 4
    && M.Agent.history[0].role === 'user' && M.Agent.history[1].role === 'assistant'
    && M.Agent.history[2].role === 'user' && M.Agent.history[2].content.includes('<tool_result>')
    && M.Agent.history[3].role === 'assistant',
    JSON.stringify(M.Agent.history.map((h) => h.role)));

  // ---------- G5. history budget trims oldest turns, keeps user-first shape (F17) ----------
  resetState();
  for (let i = 0; i < 50; i++) {
    M.Agent.history.push({ role: 'user', content: 'x'.repeat(10000) });
    M.Agent.history.push({ role: 'assistant', content: 'y'.repeat(10000) });
  }
  global.callModel = async () => FINAL;
  global.executeTool = async () => ({ output: '', success: true });
  await M.runAgentTask(term, 'final question');
  let chars = 0;
  for (const m of M.Agent.history) chars += String(m.content).length;
  check('G5 history bounded by budget', chars <= M.HISTORY_BUDGET_CHARS + 25000, 'chars=' + chars);
  check('G5b first surviving message is a user turn', M.Agent.history[0].role === 'user',
    M.Agent.history[0].role);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
