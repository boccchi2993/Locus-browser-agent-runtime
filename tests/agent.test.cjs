// AgentSession regression tests (node, NO DOM / jQuery / terminal):
// UI-independent agent loop, runtime event stream, task↔workspace binding
// (F02), cancellation vs session-switch semantics, history budget (F17),
// provider-native replay state preservation.
// Model and tool execution are injected fakes; the real agent.js session
// runs unchanged. Run: node tests/agent.test.cjs

const fs = require('fs');
const path = require('path');

const toolsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools.js'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
const M = eval(toolsSrc + '\n' + src + '\n;({ AgentSession, buildSystemPrompt, parseToolCall, stripInternalFields, truncateFor, HISTORY_BUDGET_BYTES, MAX_TOOL_ITERATIONS, AGENT_TOOL_DEFINITIONS });');

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

// A session wired only with injected fakes — no globals of any kind.
function newSession(overrides) {
  const events = [];
  const resetCalls = { n: 0 };
  const session = new M.AgentSession(Object.assign({
    modelClient: async () => FINAL,
    toolExecutor: async () => ({ output: 'ok', success: true }),
    buildSystemPrompt: M.buildSystemPrompt,
    emit: (e) => events.push(e),
    onSessionReset: () => { resetCalls.n++; },
  }, overrides || {}));
  return { session, events, resetCalls };
}

const evTypes = (events) => events.map((e) => e.type).join(',');
const WS_A = { name: 'A' };

async function run() {
  // ---------- S1. complete loop: events + history + DI, no DOM (P1-11) ----------
  {
    const seen = { tools: [], bodies: [] };
    let modelCalls = 0;
    const longReasoning = 'thinking '.repeat(100); // > 400 chars: must NOT be truncated by the runtime
    const { session, events } = newSession({
      modelClient: async (body) => {
        modelCalls++;
        seen.bodies.push(body);
        return modelCalls === 1
          ? envelope('```json\n{"tool":"bash","input":"ls"}\n```', { reasoning: longReasoning })
          : envelope('done');
      },
      toolExecutor: async (tool, input, ws) => {
        seen.tools.push([tool, input, ws && ws.name]);
        return { output: 'file.txt', success: true, backend: 'browser-direct', operation: 'network' };
      },
    });
    await session.run('list files', { workspace: WS_A });

    check('S1 event chain order', evTypes(events) ===
      'task_start,reasoning,tool_call,tool_result,assistant_text,task_end', evTypes(events));
    check('S1b tool ran against the bound workspace',
      seen.tools.length === 1 && seen.tools[0][2] === 'A', JSON.stringify(seen.tools));
    check('S1c reasoning event carries FULL untruncated reasoning',
      events[1].content === longReasoning && events[1].presentation === 'raw');
    check('S1d tool_result event carries backend/operation/output',
      events[3].tool === 'bash' && events[3].backend === 'browser-direct'
      && events[3].success === true && events[3].output === 'file.txt'
      && events[3].operation === 'network', JSON.stringify(events[3]));
    check('S1e task_end reason completed', events[5].reason === 'completed');
    check('S1f history: user/assistant(rawMessage)/feedback/final',
      session.history.length === 4
      && session.history[0].role === 'user' && session.history[1].role === 'assistant'
      && session.history[2].role === 'user' && session.history[2].content.includes('<tool_result>')
      && session.history[3].role === 'assistant',
      JSON.stringify(session.history.map((h) => h.role)));
    check('S1g tool result entered history BEFORE the second model call',
      seen.bodies.length === 2
      && seen.bodies[1].messages.some((m) => m.content && m.content.includes('<tool_result>')));
    check('S1h system prompt built from the bound workspace (no UI globals)',
      seen.bodies[0].system.includes('An external folder "A" is currently mounted at /mnt/workspace'));
    check('S1i assistant rawMessage preserved verbatim in history',
      session.history[1].content.includes('"tool"'));
  }

  // ---------- S2. provider-native replay state preserved (P1-5/P1-13) ----------
  {
    const nativeMsg = {
      role: 'assistant',
      content: 'done',
      reasoning_content: 'native reasoning',
      opaque_state: { sig: 'abc' }, // provider-specific continuation field
    };
    let captured = null;
    const { session } = newSession({
      modelClient: async (body) => { captured = body; return envelope('done', { rawMessage: nativeMsg }); },
    });
    await session.run('task', { workspace: WS_A });
    check('S2 rawMessage object enters provider history verbatim',
      session.history[1] === nativeMsg);
    check('S2b reasoning_content still on the wire next request would send',
      JSON.stringify(M.stripInternalFields(session.history)).includes('reasoning_content'));
    check('S2c opaque state preserved, never emitted as an event',
      captured !== null && session.history[1].opaque_state.sig === 'abc');
  }

  // ---------- S3. switch during MODEL wait: late response is discarded (F02) ----------
  {
    let resolveModel;
    const toolCalls = [];
    const { session, events, resetCalls } = newSession({
      modelClient: () => new Promise((r) => { resolveModel = r; }),
      toolExecutor: async (t, input, ws) => { toolCalls.push(ws && ws.name); return { output: 'ok', success: true }; },
    });
    const task = session.run('do something in A', { workspace: WS_A });
    await Promise.resolve();
    // user switches workspace mid-wait (session reset happens in the UI layer)
    session.reset();
    resolveModel(TOOL_CALL); // old response arrives late
    await task;
    check('S3 late model response never executes (0 tool calls)', toolCalls.length === 0, toolCalls.join(','));
    check('S3b new session history not polluted by old reply',
      session.history.length === 0, JSON.stringify(session.history));
    check('S3c runtime reset hook fired at session boundary', resetCalls.n >= 1);
    check('S3d discard reported as session_changed warning + task_end',
      events.some((e) => e.type === 'warning' && e.code === 'session_changed')
      && events.some((e) => e.type === 'task_end' && e.reason === 'session_changed'), evTypes(events));
  }

  // ---------- S4. switch during TOOL execution: result is discarded (F02) ----------
  {
    let resolveTool;
    let modelCalls = 0;
    const toolCalls = [];
    const { session, events } = newSession({
      modelClient: async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; },
      toolExecutor: async (t, input, ws) => {
        toolCalls.push(ws && ws.name);
        return new Promise((r) => { resolveTool = () => r({ output: 'ok', success: true }); });
      },
    });
    const task = session.run('task in A', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // let the tool start
    session.reset();
    resolveTool();
    await task;
    check('S4 tool ran against the ORIGINAL workspace A', toolCalls.length === 1 && toolCalls[0] === 'A',
      toolCalls.join(','));
    check('S4b tool result never enters new session history', session.history.length === 0,
      JSON.stringify(session.history));
    check('S4c no second model call after switch', modelCalls === 1, 'modelCalls=' + modelCalls);
    check('S4d no tool_result event leaked after switch',
      !events.some((e) => e.type === 'tool_result'), evTypes(events));
  }

  // ---------- S5. cancellation aborts the in-flight model request ----------
  {
    let sawSignal = null;
    const { session, events } = newSession({
      modelClient: (body, opts) => new Promise((resolve, reject) => {
        sawSignal = opts && opts.signal;
        opts.signal.addEventListener('abort', () => {
          const e = new Error('model request cancelled'); e.name = 'AbortError'; e.cancelled = true; reject(e);
        });
      }),
      toolExecutor: async () => { throw new Error('must not run'); },
    });
    const task = session.run('long task', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10));
    session.cancel();
    await task;
    check('S5 cancel aborts in-flight model request', sawSignal && sawSignal.aborted === true);
    check('S5b cancelled task noted, no failure dump',
      events.some((e) => e.type === 'warning' && e.code === 'task_cancelled')
      && events.some((e) => e.type === 'task_end' && e.reason === 'cancelled')
      && !events.some((e) => e.type === 'error'), evTypes(events));
    check('S5c task cleared after run', session.task === null);
  }

  // ---------- S6. history budget trims whole oldest TASKS, byte-based ----------
  {
    const { session } = newSession();
    for (let i = 0; i < 40; i++) {
      session.history.push({ role: 'user', content: 'task' + i + ' ' + 'x'.repeat(30000), _taskStart: true });
      session.history.push({ role: 'assistant', content: 'y'.repeat(30000) });
    }
    await session.run('final question', { workspace: WS_A });
    check('S6 request bytes bounded by budget', session.historyRequestBytes(WS_A) <= M.HISTORY_BUDGET_BYTES,
      'bytes=' + session.historyRequestBytes(WS_A));
    check('S6b first surviving message is a task boundary', session.history[0]._taskStart === true
      && session.history[0].role === 'user', JSON.stringify(session.history[0]).slice(0, 60));
    check('S6c whole tasks dropped (no orphan assistant first)',
      session.history.every((m, i) => i === 0 || !m._taskStart || m.role === 'user'), '');
  }

  // ---------- S7. reasoning_content counts toward the budget ----------
  {
    const { session } = newSession();
    session.history.push({ role: 'user', content: 'tiny visible task', _taskStart: true });
    session.history.push({ role: 'assistant', content: 'ok',
      reasoning_content: 'R'.repeat(800 * 1024) }); // huge reasoning, tiny visible text
    session.history.push({ role: 'user', content: 'current task', _taskStart: true });
    session.enforceHistoryBudget(WS_A);
    check('S7 giant reasoning task trimmed despite tiny visible content',
      session.history.length === 1 && session.history[0].content === 'current task',
      'len=' + session.history.length);
  }

  // ---------- S8. UTF-8 bytes, not chars (Chinese ≈ 3 bytes/char) ----------
  {
    const { session } = newSession();
    session.history.push({ role: 'user', content: '汉'.repeat(100000), _taskStart: true });
    const bytes = session.historyRequestBytes(WS_A);
    check('S8 multibyte content counted as UTF-8 bytes', bytes >= 300000, 'bytes=' + bytes);
  }

  // ---------- S9. user-role tool feedback is NOT a task boundary ----------
  {
    const { session } = newSession();
    const big = 'z'.repeat(300 * 1024);
    session.history.push({ role: 'user', content: 'old task ' + big, _taskStart: true });
    session.history.push({ role: 'assistant', content: 'call ' + big });
    session.history.push({ role: 'user', content: '<tool_result>feedback ' + big + '</tool_result>' });
    session.history.push({ role: 'user', content: 'current', _taskStart: true });
    session.enforceHistoryBudget(WS_A);
    check('S9 partial task never survives: feedback dropped with its task',
      session.history.length === 1 && session.history[0].content === 'current'
      && session.history[0]._taskStart === true, JSON.stringify(session.history.map((m) => m.role)));
  }

  // ---------- S10. current task alone over budget → error event, no send ----------
  {
    let modelCalled = false;
    const { session, events } = newSession({
      modelClient: async () => { modelCalled = true; return FINAL; },
    });
    await session.run('huge '.repeat(200 * 1024), { workspace: WS_A }); // ~1 MB user input
    check('S10 oversized single task reported as error event',
      events.some((e) => e.type === 'error' && e.code === 'history_budget'
        && e.message.includes('transport budget')), evTypes(events));
    check('S10b oversized request never sent to the model', modelCalled === false);
    check('S10c task_end after error',
      events.some((e) => e.type === 'task_end' && e.reason === 'error'), evTypes(events));
  }

  // ---------- S11. internal _taskStart marker never sent to the provider ----------
  {
    let captured = null;
    const { session } = newSession({
      modelClient: async (body) => { captured = body; return FINAL; },
    });
    await session.run('marker check', { workspace: WS_A });
    check('S11 marker kept internally', session.history[0]._taskStart === true);
    check('S11b marker stripped from the wire',
      captured && captured.messages.every((m) => !Object.keys(m).some((k) => k.startsWith('_'))),
      JSON.stringify(captured && captured.messages[0] && Object.keys(captured.messages[0])));
  }

  // ---------- S12. cancel mid-tool: completed commit report survives, loop stops ----------
  // The tool is cancelled mid-run but still finishes with a REAL partial
  // commit report. That report must reach the event stream (and history),
  // and no further model call may happen. Cancellation is not a rollback.
  {
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; },
      toolExecutor: () => new Promise((r) => setTimeout(() =>
        r({ output: '[written to workspace: a.txt]\n[not persisted: b.txt (cancelled before write)]',
          success: false }), 40)),
    });
    const task = session.run('make two files', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // tool started
    session.cancel();
    await task;
    check('S12 no second model call after cancel', modelCalls === 1, 'modelCalls=' + modelCalls);
    const tr = events.find((e) => e.type === 'tool_result');
    check('S12b commit report still emitted as tool_result event',
      !!tr && tr.output.includes('written to workspace: a.txt')
      && tr.output.includes('not persisted: b.txt (cancelled before write)')
      && tr.success === false, JSON.stringify(tr));
    check('S12c cancel note does not claim rollback',
      events.some((e) => e.type === 'warning' && e.code === 'task_cancelled_committed'
        && e.message.includes('不会回滚'))
      && !events.some((e) => e.message && e.message.includes('丢弃后续结果')), evTypes(events));
    check('S12d commit report recorded in history (same session continues)',
      session.history.length === 3
      && session.history[2].content.includes('<tool_result>')
      && session.history[2].content.includes('[written to workspace: a.txt]'),
      JSON.stringify(session.history.map((h) => h.role)));
    check('S12e task_end reason cancelled',
      events.some((e) => e.type === 'task_end' && e.reason === 'cancelled'), evTypes(events));
  }

  // ---------- S13. session switch mid-tool: report never leaks into the new session ----------
  {
    let modelCalls = 0;
    let resolveTool;
    const { session, events } = newSession({
      modelClient: async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; },
      toolExecutor: () => new Promise((r) => { resolveTool = () =>
        r({ output: '[written to workspace: secret.txt]', success: true }); }),
    });
    const task = session.run('task in A', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // tool started
    session.reset();
    resolveTool();
    await task;
    check('S13 switch discards the old result entirely',
      !events.some((e) => e.output && e.output.includes('secret.txt'))
      && events.some((e) => e.type === 'warning' && e.code === 'session_changed'), evTypes(events));
    check('S13b new session history stays clean, no extra model call',
      session.history.length === 0 && modelCalls === 1,
      'history=' + session.history.length + ' modelCalls=' + modelCalls);
  }

  // ---------- S14. iteration limit (MAX_TOOL_ITERATIONS = 32) ----------
  {
    let modelCalls = 0;
    let toolExecs = 0;
    const { session, events } = newSession({
      modelClient: async () => { modelCalls++; return TOOL_CALL; },
      toolExecutor: async () => { toolExecs++; return { output: 'ok', success: true }; },
    });
    await session.run('loop forever', { workspace: WS_A });
    check('S14 iteration cap stops the loop at MAX_TOOL_ITERATIONS',
      M.MAX_TOOL_ITERATIONS === 32 && modelCalls === 32 && toolExecs === 32,
      'max=' + M.MAX_TOOL_ITERATIONS + ' model=' + modelCalls + ' tools=' + toolExecs);
    check('S14b iteration_limit warning + task_end',
      events.some((e) => e.type === 'warning' && e.code === 'iteration_limit')
      && events.some((e) => e.type === 'task_end' && e.reason === 'iteration_limit'), evTypes(events));
  }

  // ---------- S14c. more than 15 progressing tool calls must NOT hit the cap ----------
  {
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls <= 20 ? TOOL_CALL : FINAL; // 20 tool rounds, then the answer
      },
    });
    await session.run('long but finite exploration', { workspace: WS_A });
    check('S14c 20 tool calls complete normally (no premature iteration_limit)',
      modelCalls === 21 && events.some((e) => e.type === 'task_end' && e.reason === 'completed')
      && !events.some((e) => e.code === 'iteration_limit'), 'model=' + modelCalls + ' ' + evTypes(events));
  }

  // ---------- S15. truncated model output → warning events, still completed ----------
  {
    const { session, events } = newSession({
      modelClient: async () => envelope('partial answer', { truncated: true, stopReason: 'max_tokens' }),
    });
    await session.run('task', { workspace: WS_A });
    check('S15 model_truncated + answer_truncated warnings emitted',
      events.some((e) => e.type === 'warning' && e.code === 'model_truncated' && e.stopReason === 'max_tokens')
      && events.some((e) => e.type === 'warning' && e.code === 'answer_truncated'), evTypes(events));
    check('S15b assistant_text still emitted', events.some((e) => e.type === 'assistant_text'));
  }

  // ---------- S16. model failure → error event, no throw ----------
  {
    const { session, events } = newSession({
      modelClient: async () => { const e = new Error('HTTP 500'); e.name = 'HttpError'; e.status = 500; throw e; },
    });
    await session.run('task', { workspace: WS_A });
    check('S16 model failure surfaces as error event',
      events.some((e) => e.type === 'error' && e.code === 'model_call_failed'
        && e.message.includes('HTTP 500')), evTypes(events));
    check('S16b task_end reason error',
      events.some((e) => e.type === 'task_end' && e.reason === 'error'), evTypes(events));
  }

  // ---------- S17. strict fenced-JSON protocol unchanged (P1-14) ----------
  {
    const pure = '```json\n{"tool":"bash","input":"ls"}\n```';
    const wrapped = '我来看一下目录：\n```json\n{"tool":"bash","input":"ls"}\n```\n以上是调用。';
    check('S17 pure fenced block parses', (M.parseToolCall(pure) || {}).input === 'ls');
    check('S17b prose-wrapped block NOT parsed', M.parseToolCall(wrapped) === null);
    check('S17c plain text NOT a tool call', M.parseToolCall('完成。') === null);
  }

  // ---------- S18. buildSystemPrompt is a pure function of its argument ----------
  {
    const withWs = M.buildSystemPrompt({ workspace: { name: 'W' } });
    const without = M.buildSystemPrompt({ workspace: null });
    check('S18 workspace named + mounted in prompt', withWs.includes('An external folder "W" is currently mounted at /mnt/workspace'));
    check('S18v VFS-shaped workspace object works too (workspaceName getter)',
      M.buildSystemPrompt({ workspace: { workspaceName: 'V', name: 'ignored' } })
        .includes('An external folder "V" is currently mounted at /mnt/workspace'));
    check('S18b no-workspace branch mentions the still-available paths',
      without.includes('/mnt/workspace is unavailable')
      && without.includes('/mnt/upload') && without.includes('/mnt/download')
      && without.includes('/tmp') && without.includes('/home/locus'));
    check('S18c trust-boundary policy intact',
      withWs.includes('UNTRUSTED DATA') && withWs.includes('prompt-injection')
      && withWs.includes('cloud_bash') && withWs.includes("python <<'PY'"));
  }

  // ---------- S19. concurrent run() is rejected by the runtime itself (P1.1-1) ----------
  {
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: (body, opts) => {
        modelCalls++;
        if (modelCalls > 1) return Promise.resolve(FINAL); // task C completes normally
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('model request cancelled'); e.name = 'AbortError'; e.cancelled = true;
            reject(e);
          });
        });
      },
      toolExecutor: async () => { throw new Error('must not run'); },
    });
    const taskA = session.run('task A', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // task A is inside the model call
    const taskRef = session.task;
    const historyLen = session.history.length;

    let rejected = null;
    try {
      await session.run('task B', { workspace: WS_A });
    } catch (e) { rejected = e; }
    check('S19 second run rejects while a task is live',
      rejected && rejected.message.includes('already has a running task'), rejected && rejected.message);
    check('S19b rejected run left no history trace', session.history.length === historyLen);
    check('S19c rejected run made no model call', modelCalls === 1, 'modelCalls=' + modelCalls);
    check('S19d session.task still belongs to task A', session.task === taskRef);
    check('S19e no second task_start event',
      events.filter((e) => e.type === 'task_start').length === 1, evTypes(events));

    session.cancel(); // end task A
    await taskA;
    check('S19f after task A ends a new run works',
      session.task === null && (await session.run('task C', { workspace: WS_A }), true));
    check('S19g task C completed normally',
      events.some((e) => e.type === 'task_end' && e.reason === 'completed'), evTypes(events));
  }

  // ---------- S20. reset() aborts the in-flight model request (P1.1-2A) ----------
  {
    let sawSignal = null;
    let modelCalls = 0;
    const gen0 = (() => { let g; return { set: (v) => { g = v; }, get: () => g }; })();
    const { session, events, resetCalls } = newSession({
      modelClient: (body, opts) => {
        modelCalls++;
        if (modelCalls > 1) return Promise.resolve(FINAL); // post-reset run completes
        return new Promise((resolve, reject) => {
          sawSignal = opts.signal;
          opts.signal.addEventListener('abort', () => {
            const e = new Error('model request cancelled'); e.name = 'AbortError'; e.cancelled = true;
            reject(e);
          });
        });
      },
    });
    gen0.set(session.generation);
    const task = session.run('task', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // inside the model call
    session.reset();
    check('S20 reset aborts the in-flight model request', sawSignal && sawSignal.aborted === true);
    check('S20b history cleared synchronously', session.history.length === 0);
    check('S20c generation bumped', session.generation === gen0.get() + 1);
    check('S20d reset hook fired', resetCalls.n === 1);
    await task;
    check('S20e old task ends stale (session_changed), writes nothing back',
      session.history.length === 0
      && events.some((e) => e.type === 'warning' && e.code === 'session_changed')
      && events.some((e) => e.type === 'task_end' && e.reason === 'session_changed'), evTypes(events));
    await session.run('fresh task', { workspace: WS_A });
    check('S20f new run works after reset',
      events.filter((e) => e.type === 'task_end' && e.reason === 'completed').length === 1, evTypes(events));
  }

  // ---------- S21. reset() during tool execution: abort + late result discarded (P1.1-2B) ----------
  {
    let toolSignal = null;
    let resolveTool;
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => { modelCalls++; return modelCalls === 1 ? TOOL_CALL : FINAL; },
      toolExecutor: (t, input, ws, opts) => {
        toolSignal = opts && opts.signal;
        return new Promise((r) => { resolveTool = () => r({ output: 'late secret', success: true }); });
      },
    });
    const task = session.run('task', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // tool started
    session.reset();
    check('S21 reset aborts the in-flight tool', toolSignal && toolSignal.aborted === true);
    resolveTool(); // late tool result arrives AFTER the reset
    await task;
    check('S21b late tool result never enters new history', session.history.length === 0,
      JSON.stringify(session.history));
    check('S21c no tool_result presentation event from the old session',
      !events.some((e) => e.type === 'tool_result'), evTypes(events));
    check('S21d old task reported as session_changed',
      events.some((e) => e.type === 'warning' && e.code === 'session_changed')
      && events.some((e) => e.type === 'task_end' && e.reason === 'session_changed'), evTypes(events));
    check('S21e no further model call from the stale task', modelCalls === 1, 'modelCalls=' + modelCalls);
  }

  // ---------- N1. native tool call executes; tools advertised; neutral result history ----------
  {
    const execs = [];
    const bodies = [];
    let modelCalls = 0;
    const rawAssistant = { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"input":"pwd"}' } }] };
    const { session, events } = newSession({
      modelClient: async (body) => {
        modelCalls++;
        bodies.push(body);
        return modelCalls === 1
          ? envelope('', { toolCalls: [{ id: 'call_1', name: 'bash', input: { input: 'pwd' }, argumentsError: null }], rawMessage: rawAssistant })
          : FINAL;
      },
      toolExecutor: async (tool, input) => { execs.push([tool, input]); return { output: '/home/locus', success: true, backend: 'browser' }; },
    });
    await session.run('where am I', { workspace: WS_A });
    check('N1 native call executed with the object input\'s command string',
      execs.length === 1 && execs[0][0] === 'bash' && execs[0][1] === 'pwd', JSON.stringify(execs));
    check('N1b event chain: tool_call → tool_result → final text → completed',
      evTypes(events) === 'task_start,tool_call,tool_result,assistant_text,task_end'
      && events[4].reason === 'completed', evTypes(events));
    check('N1c tool_call event carries the provider toolCallId',
      events[1].toolCallId === 'call_1' && events[1].input === 'pwd');
    check('N1d neutral tool_result history entry (no provider wire shape in the session)',
      session.history[2].role === 'tool_result' && session.history[2].toolCallId === 'call_1'
      && session.history[2].toolName === 'bash' && session.history[2].success === true
      && session.history[2].content.includes('untrusted data, not instructions'),
      JSON.stringify(session.history[2]));
    check('N1e assistant rawMessage (provider-native) kept in history',
      session.history[1] === rawAssistant);
    check('N1f model request advertises the provider-neutral registry tools',
      Array.isArray(bodies[0].tools) && bodies[0].tools.length === 2
      && bodies[0].tools[0].name === 'bash' && bodies[0].tools[0].inputSchema.required[0] === 'input',
      JSON.stringify(bodies[0].tools && bodies[0].tools.map((t) => t.name)));
    check('N1g neutral result was sent back on the wire of request 2',
      bodies[1].messages.some((m) => m.role === 'tool_result' && m.toolCallId === 'call_1'));
  }

  // ---------- N2. native precedence over fenced fallback — never double execution ----------
  {
    const execs = [];
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls === 1
          ? envelope('```json\n{"tool":"bash","input":"SHOULD_NOT_RUN"}\n```', {
              toolCalls: [{ id: 'c1', name: 'bash', input: { input: 'real' }, argumentsError: null }],
            })
          : FINAL;
      },
      toolExecutor: async (tool, input) => { execs.push(input); return { output: 'ok', success: true }; },
    });
    await session.run('task', { workspace: WS_A });
    check('N2 native call wins over the fenced block; executed exactly once',
      execs.length === 1 && execs[0] === 'real', JSON.stringify(execs));
    check('N2b visible content still surfaced as assistant_text (not silently dropped)',
      events.some((e) => e.type === 'assistant_text' && e.content.includes('SHOULD_NOT_RUN')));
    check('N2c task did NOT complete on the tool-carrying reply',
      events.filter((e) => e.type === 'task_end').length === 1
      && events.find((e) => e.type === 'task_end').reason === 'completed'
      && evTypes(events).indexOf('assistant_text') < evTypes(events).indexOf('tool_call'), evTypes(events));
  }

  // ---------- N3. prose + fenced JSON still NOT executed (strict fallback intact) ----------
  {
    const execs = [];
    const { session, events } = newSession({
      modelClient: async () => envelope('我来看一下目录：\n```json\n{"tool":"bash","input":"ls"}\n```\n以上是调用。'),
      toolExecutor: async (tool, input) => { execs.push(input); return { output: 'x', success: true }; },
    });
    await session.run('task', { workspace: WS_A });
    check('N3 prose-wrapped fenced JSON never executes',
      execs.length === 0 && events.some((e) => e.type === 'task_end' && e.reason === 'completed'),
      JSON.stringify(execs));
  }

  // ---------- N4. unknown native tool: never executed, honest failed result, model recovers ----------
  {
    const execs = [];
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls === 1
          ? envelope('', { toolCalls: [{ id: 'c9', name: 'delete_all', input: { input: 'rm -rf /' }, argumentsError: null }] })
          : FINAL;
      },
      toolExecutor: async (tool, input) => { execs.push([tool, input]); return { output: 'x', success: true }; },
    });
    await session.run('task', { workspace: WS_A });
    check('N4 unknown tool NEVER executed and never mapped to bash', execs.length === 0, JSON.stringify(execs));
    const tr = events.find((e) => e.type === 'tool_result');
    check('N4b failed tool_result event emitted (unknown tool ...)',
      !!tr && tr.success === false && tr.output.includes('unknown tool') && tr.output.includes('delete_all'),
      JSON.stringify(tr));
    check('N4c failed neutral result recorded with matching id; model got a next turn',
      session.history[2].role === 'tool_result' && session.history[2].toolCallId === 'c9'
      && session.history[2].success === false && modelCalls === 2
      && events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- N5. malformed native arguments: never executed, never coerced ----------
  {
    const execs = [];
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls === 1
          ? envelope('', { toolCalls: [
              { id: 'b1', name: 'bash', input: null, argumentsError: 'tool arguments are not valid JSON' },
              { id: 'b2', name: 'bash', input: { input: 123 }, argumentsError: null },
              { id: 'b3', name: 'bash', input: 'rm -rf /', argumentsError: null },
            ] })
          : FINAL;
      },
      toolExecutor: async (tool, input) => { execs.push(input); return { output: 'x', success: true }; },
    });
    await session.run('task', { workspace: WS_A });
    check('N5 malformed arguments never execute (no coercion to shell)',
      execs.length === 0, JSON.stringify(execs));
    const results = events.filter((e) => e.type === 'tool_result');
    check('N5b three failed results with matching ids, all invalid-arguments',
      results.length === 3 && results.every((r) => r.success === false && r.output.includes('invalid tool arguments'))
      && session.history.filter((h) => h.role === 'tool_result').map((h) => h.toolCallId).join(',') === 'b1,b2,b3',
      JSON.stringify(results.map((r) => r.output)));
    check('N5c session recovered to a final answer', modelCalls === 2
      && events.some((e) => e.type === 'task_end' && e.reason === 'completed'));
  }

  // ---------- N6. multiple native calls: sequential provider order, matching results ----------
  {
    const execs = [];
    const bodies = [];
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async (body) => {
        modelCalls++;
        bodies.push(body);
        return modelCalls === 1
          ? envelope('', { toolCalls: [
              { id: 'm1', name: 'bash', input: { input: 'cmdA' }, argumentsError: null },
              { id: 'm2', name: 'bash', input: { input: 'cmdB' }, argumentsError: null },
              { id: 'm3', name: 'bash', input: { input: 'cmdC' }, argumentsError: null },
            ] })
          : FINAL;
      },
      toolExecutor: async (tool, input) => { execs.push(input); return { output: 'out:' + input, success: true }; },
    });
    await session.run('task', { workspace: WS_A });
    check('N6 batch executed sequentially in provider order',
      execs.join(',') === 'cmdA,cmdB,cmdC', execs.join(','));
    check('N6b three results in history, ids in the same order',
      session.history.filter((h) => h.role === 'tool_result').map((h) => h.toolCallId).join(',') === 'm1,m2,m3');
    check('N6c results delivered to the next model request in order',
      bodies[1].messages.filter((m) => m.role === 'tool_result').map((m) => m.toolCallId).join(',') === 'm1,m2,m3');
    check('N6d three tool_result events, success preserved',
      events.filter((e) => e.type === 'tool_result').length === 3
      && events.filter((e) => e.type === 'tool_result').every((e) => e.success === true));
  }

  // ---------- N7. tool cap counts CALLS, not turns; oversized batch never partially executes ----------
  {
    let execs = 0;
    const { session, events } = newSession({
      modelClient: async () => envelope('', { toolCalls: [1, 2, 3, 4, 5].map((n) => ({
        id: 'b' + n, name: 'bash', input: { input: 'cmd' + n }, argumentsError: null })) }),
      toolExecutor: async () => { execs++; return { output: 'ok', success: true }; },
    });
    await session.run('loop', { workspace: WS_A });
    check('N7 total executions bounded by 32 across batches (6×5=30, 7th batch refused)',
      execs === 30, 'execs=' + execs);
    check('N7b iteration_limit warning + task_end, no partial batch',
      events.some((e) => e.type === 'warning' && e.code === 'iteration_limit' && e.message.includes('未执行'))
      && events.some((e) => e.type === 'task_end' && e.reason === 'iteration_limit'), evTypes(events));
  }

  // ---------- N8. cancel between batch items: A committed, B/C honestly not executed ----------
  {
    const execs = [];
    let resolveTool;
    const { session, events } = newSession({
      modelClient: async () => envelope('', { toolCalls: [
        { id: 'k1', name: 'bash', input: { input: 'first' }, argumentsError: null },
        { id: 'k2', name: 'bash', input: { input: 'second' }, argumentsError: null },
        { id: 'k3', name: 'bash', input: { input: 'third' }, argumentsError: null },
      ] }),
      toolExecutor: (tool, input) => {
        execs.push(input);
        return new Promise((r) => { resolveTool = () => r({ output: 'committed: ' + input, success: true }); });
      },
    });
    const task = session.run('task', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10)); // first tool started
    session.cancel();
    resolveTool();
    await task;
    check('N8 only the first call executed', execs.join(',') === 'first', execs.join(','));
    const results = events.filter((e) => e.type === 'tool_result');
    check('N8b A result real; B/C results honestly "not executed"',
      results.length === 3 && results[0].success === true && results[0].output.includes('committed: first')
      && results[1].success === false && results[1].output.includes('not executed')
      && results[2].success === false, JSON.stringify(results));
    check('N8c history keeps protocol-valid results for every id',
      session.history.filter((h) => h.role === 'tool_result').map((h) => h.toolCallId).join(',') === 'k1,k2,k3');
    check('N8d committed-cancel warning + cancelled end',
      events.some((e) => e.type === 'warning' && e.code === 'task_cancelled_committed')
      && events.some((e) => e.type === 'task_end' && e.reason === 'cancelled'), evTypes(events));
  }

  // ---------- N9. session switch mid-batch: nothing leaks into the new session ----------
  {
    const execs = [];
    let resolveTool;
    let modelCalls = 0;
    const { session, events } = newSession({
      modelClient: async () => {
        modelCalls++;
        return modelCalls === 1
          ? envelope('', { toolCalls: [
              { id: 's1', name: 'bash', input: { input: 'one' }, argumentsError: null },
              { id: 's2', name: 'bash', input: { input: 'two' }, argumentsError: null },
            ] })
          : FINAL;
      },
      toolExecutor: (tool, input) => {
        execs.push(input);
        return new Promise((r) => { resolveTool = () => r({ output: 'late: ' + input, success: true }); });
      },
    });
    const task = session.run('task', { workspace: WS_A });
    await new Promise((r) => setTimeout(r, 10));
    session.reset();
    resolveTool();
    await task;
    check('N9 late native result discarded on session switch',
      session.history.length === 0 && !events.some((e) => e.type === 'tool_result')
      && events.some((e) => e.type === 'task_end' && e.reason === 'session_changed'), evTypes(events));
    check('N9b second batch call never started after the switch',
      execs.join(',') === 'one' && modelCalls === 1, execs.join(',') + ' model=' + modelCalls);
  }

  // ---------- N10. synthetic safe id when the provider omits one ----------
  {
    const { session } = newSession({
      modelClient: (() => { let n = 0; return async () => ++n === 1
        ? envelope('', { toolCalls: [{ id: '', name: 'bash', input: { input: 'x' }, argumentsError: null }] })
        : FINAL; })(),
    });
    await session.run('task', { workspace: WS_A });
    check('N10 missing provider id gets a synthetic safe id, paired in history',
      session.history[2].role === 'tool_result' && typeof session.history[2].toolCallId === 'string'
      && session.history[2].toolCallId.length > 0, JSON.stringify(session.history[2].toolCallId));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
