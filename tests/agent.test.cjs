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
const M = eval(src + '\n;({ Agent, runAgentTask, resetAgentSession, cancelAgentTask, parseToolCall, enforceHistoryBudget, historyRequestBytes, stripInternalFields, HISTORY_BUDGET_BYTES });');

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

  // ---------- G5. history budget trims whole oldest TASKS, byte-based (Finding 5) ----------
  resetState();
  for (let i = 0; i < 40; i++) {
    M.Agent.history.push({ role: 'user', content: 'task' + i + ' ' + 'x'.repeat(30000), _taskStart: true });
    M.Agent.history.push({ role: 'assistant', content: 'y'.repeat(30000) });
  }
  global.callModel = async () => FINAL;
  global.executeTool = async () => ({ output: '', success: true });
  await M.runAgentTask(term, 'final question');
  check('G5 request bytes bounded by budget', M.historyRequestBytes() <= M.HISTORY_BUDGET_BYTES,
    'bytes=' + M.historyRequestBytes());
  check('G5b first surviving message is a task boundary', M.Agent.history[0]._taskStart === true
    && M.Agent.history[0].role === 'user', JSON.stringify(M.Agent.history[0]).slice(0, 60));
  check('G5c whole tasks dropped (no orphan assistant first)',
    M.Agent.history.every((m, i) => i === 0 || !m._taskStart || m.role === 'user'), '');

  // ---------- G6. reasoning_content counts toward the budget ----------
  resetState();
  M.Agent.history.push({ role: 'user', content: 'tiny visible task', _taskStart: true });
  M.Agent.history.push({ role: 'assistant', content: 'ok',
    reasoning_content: 'R'.repeat(800 * 1024) }); // huge reasoning, tiny visible text
  M.Agent.history.push({ role: 'user', content: 'current task', _taskStart: true });
  M.enforceHistoryBudget();
  check('G6 giant reasoning task trimmed despite tiny visible content',
    M.Agent.history.length === 1 && M.Agent.history[0].content === 'current task',
    'len=' + M.Agent.history.length);

  // ---------- G7. UTF-8 bytes, not chars (Chinese ≈ 3 bytes/char) ----------
  resetState();
  M.Agent.history.push({ role: 'user', content: '汉'.repeat(100000), _taskStart: true });
  const g7bytes = M.historyRequestBytes();
  check('G7 multibyte content counted as UTF-8 bytes', g7bytes >= 300000, 'bytes=' + g7bytes);

  // ---------- G8. user-role tool feedback is NOT a task boundary ----------
  resetState();
  const big = 'z'.repeat(300 * 1024);
  M.Agent.history.push({ role: 'user', content: 'old task ' + big, _taskStart: true });
  M.Agent.history.push({ role: 'assistant', content: 'call ' + big });
  M.Agent.history.push({ role: 'user', content: '<tool_result>feedback ' + big + '</tool_result>' });
  M.Agent.history.push({ role: 'user', content: 'current', _taskStart: true });
  M.enforceHistoryBudget();
  check('G8 partial task never survives: feedback dropped with its task',
    M.Agent.history.length === 1 && M.Agent.history[0].content === 'current'
    && M.Agent.history[0]._taskStart === true, JSON.stringify(M.Agent.history.map((m) => m.role)));

  // ---------- G9. current task alone over budget → explicit error, no send ----------
  resetState();
  let g9called = false;
  global.callModel = async () => { g9called = true; return FINAL; };
  let g9err = null;
  try {
    await M.runAgentTask(term, 'huge '.repeat(200 * 1024)); // ~1 MB user input
  } catch (e) { g9err = e; }
  check('G9 oversized single task fails loudly', g9err && g9err.message.includes('transport budget'),
    g9err && g9err.message);
  check('G9b oversized request never sent to the model', g9called === false);
  resetState();

  // ---------- G10. internal _taskStart marker never sent to the provider ----------
  resetState();
  let captured = null;
  global.callModel = async (body) => { captured = body; return FINAL; };
  await M.runAgentTask(term, 'marker check');
  check('G10 marker kept internally', M.Agent.history[0]._taskStart === true);
  check('G10b marker stripped from the wire',
    captured && captured.messages.every((m) => !Object.keys(m).some((k) => k.startsWith('_'))),
    JSON.stringify(captured && captured.messages[0] && Object.keys(captured.messages[0])));

  // ---------- G11. cancel mid-tool: completed commit report is shown, loop stops ----------
  // The tool is cancelled mid-run but still finishes with a REAL partial
  // commit report. That report must reach the user (and history), and no
  // further model call may happen. Cancellation is not a rollback.
  resetState();
  modelCalls = 0;
  global.callModel = async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; };
  global.executeTool = () => new Promise((r) => setTimeout(() =>
    r({ output: '[written to workspace: a.txt]\n[not persisted: b.txt (cancelled before write)]',
      success: false }), 40));
  task = M.runAgentTask(term, 'make two files');
  await new Promise((r) => setTimeout(r, 10)); // tool started
  M.cancelAgentTask();
  await task;
  check('G11 no second model call after cancel', modelCalls === 1, 'modelCalls=' + modelCalls);
  check('G11b commit report shown to the user',
    term.lines.some((l) => l.includes('written to workspace: a.txt'))
    && term.lines.some((l) => l.includes('not persisted: b.txt (cancelled before write)')),
    term.lines.join(' | '));
  check('G11c cancel note does not claim rollback',
    term.lines.some((l) => l.includes('任务已取消') && l.includes('不会回滚'))
    && !term.lines.some((l) => l.includes('丢弃后续结果')),
    term.lines.join(' | '));
  check('G11d commit report recorded in history (same session continues)',
    M.Agent.history.length === 3
    && M.Agent.history[2].content.includes('<tool_result>')
    && M.Agent.history[2].content.includes('[written to workspace: a.txt]'),
    JSON.stringify(M.Agent.history.map((h) => h.role)));

  // ---------- G12. session switch mid-tool: report never leaks into the new session ----------
  resetState();
  modelCalls = 0;
  global.callModel = async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; };
  let resolveToolG12;
  global.executeTool = () => new Promise((r) => { resolveToolG12 = () =>
    r({ output: '[written to workspace: secret.txt]', success: true }); });
  task = M.runAgentTask(term, 'task in A');
  await new Promise((r) => setTimeout(r, 10)); // tool started
  global.App.workspace = { name: 'B' };
  M.resetAgentSession();
  resolveToolG12();
  await task;
  check('G12 switch discards the old result entirely',
    !term.lines.some((l) => l.includes('secret.txt'))
    && term.lines.some((l) => l.includes('会话已切换')),
    term.lines.join(' | '));
  check('G12b new session history stays clean, no extra model call',
    M.Agent.history.length === 0 && modelCalls === 1,
    'history=' + M.Agent.history.length + ' modelCalls=' + modelCalls);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
