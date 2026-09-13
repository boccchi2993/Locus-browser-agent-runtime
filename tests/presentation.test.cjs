// Presentation projector tests (node, NO DOM / Vue):
// runtime event stream → timeline projection, plus a full AgentSession →
// projector integration pass proving the real runtime events land as
// expected. Run: node tests/presentation.test.cjs

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const projectorSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'projector.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(root, 'src', 'agent.js'), 'utf8');
const Projector = eval(projectorSrc + '\n;LocusProjector');
const A = eval(agentSrc + '\n;({ AgentSession, buildSystemPrompt });');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function projectAll(events) {
  const conv = Projector.createConversation(1);
  for (const e of events) Projector.projectEvent(conv, e);
  return conv;
}

// ---------- P1. every runtime event type projects ----------
{
  const long_reasoning = 'r'.repeat(5000);
  const conv = projectAll([
    { type: 'task_start', input: 'analyze sales.csv' },
    { type: 'reasoning', content: long_reasoning, presentation: 'raw' },
    { type: 'tool_call', tool: 'bash', input: 'ls' },
    { type: 'tool_result', tool: 'bash', backend: 'browser', success: true, output: 'sales.csv', operation: 'shell' },
    { type: 'reasoning', content: 'summary text', presentation: 'summary' },
    { type: 'warning', code: 'model_truncated', message: 'truncated' },
    { type: 'assistant_text', content: 'done: revenue 200' },
    { type: 'error', code: 'model_call_failed', message: 'boom' },
    { type: 'task_end', reason: 'completed' },
  ]);
  const kinds = conv.items.map((i) => i.kind);
  check('P1 all event kinds present',
    JSON.stringify(kinds) === JSON.stringify(['user', 'reasoning', 'tool', 'reasoning', 'warning', 'assistant', 'error']),
    kinds.join(','));
  check('P1 task_end sets status', conv.status === 'completed');

  // ---------- P2. reasoning stored complete, never truncated ----------
  check('P2 reasoning full length kept', conv.items[1].content.length === 5000,
    'len=' + conv.items[1].content.length);
  check('P2 reasoning presentation passthrough',
    conv.items[1].presentation === 'raw' && conv.items[3].presentation === 'summary');

  // ---------- P3. tool result attaches to its call, backend from event only ----------
  const tool = conv.items[2];
  check('P3 tool_call item', tool.tool === 'bash' && tool.input === 'ls');
  check('P3 result attached to call', tool.result && tool.result.output === 'sales.csv' && tool.state === 'done');
  check('P3 backend badge only from event metadata', tool.result.backend === 'browser');
  check('P3 meta derives from real events',
    conv.meta.toolCount === 1 && conv.meta.lastTool === 'bash'
    && conv.meta.lastBackend === 'browser' && conv.meta.lastOperation === 'shell');
}

// ---------- P4. no backend metadata → badge stays null (never guessed) ----------
{
  const conv = projectAll([
    { type: 'tool_call', tool: 'bash', input: 'ls' },
    { type: 'tool_result', tool: 'bash', success: false, output: 'nope' },
  ]);
  check('P4 missing backend stays null', conv.items[0].result.backend === null);
  check('P4 failed result state', conv.items[0].state === 'failed');
}

// ---------- P5. conversation separation across sessions ----------
// Each session/reset gets its own conversation object; timelines never
// share items, and neither one is the provider history.
{
  const c1 = projectAll([{ type: 'task_start', input: 'first task' }, { type: 'assistant_text', content: 'a1' }, { type: 'task_end', reason: 'completed' }]);
  const c2 = Projector.createConversation(2);
  Projector.projectEvent(c2, { type: 'task_start', input: 'second task' });
  check('P5 timelines separated', c1.items.length === 2 && c2.items.length === 1
    && c2.items[0].content === 'second task' && c1.items[0].content === 'first task');
  check('P5 statuses independent', c1.status === 'completed' && c2.status === 'running');
}

// ---------- P6. title derives from first task input ----------
{
  const conv = projectAll([{ type: 'task_start', input: 'line one\nline two' }]);
  check('P6 title from first line', conv.title === 'line one', conv.title);
}

// ---------- P7. unknown events are ignored ----------
{
  const conv = projectAll([{ type: 'future_delta', x: 1 }, null, { type: 'task_start', input: 't' }]);
  check('P7 unknown events ignored', conv.items.length === 1 && conv.status === 'running');
}

// ---------- M1..M5: markdown-lite safety + grammar ----------
{
  const MD = eval(fs.readFileSync(path.join(root, 'src', 'ui', 'markdown.js'), 'utf8') + '\n;LocusMarkdown');
  const html = MD.render('Done. **Bold** and `code`.\n\n- one\n- two\n\n## Head\n<script>alert(1)</script>');
  check('M1 escapes raw HTML', html.includes('&lt;script&gt;') && !html.includes('<script>'), html);
  check('M2 bold/code inline', html.includes('<strong>Bold</strong>') && html.includes('<code>code</code>'));
  check('M3 list rendering', html.includes('<ul><li>one</li><li>two</li></ul>'));
  check('M4 header rendering', html.includes('<h4>Head</h4>'));
  check('M5 plain text survives', MD.render('just text') === '<p>just text</p>');
}

// ---------- P8. REAL AgentSession events → projector integration ----------
// The runtime emits; the projector consumes. Fakes are injected at the
// documented AgentSession dependency boundary — no Vue, no DOM.
{
  const envelope = (text, extra) => Object.assign({
    content: text, reasoning: null, stopReason: 'end_turn', usage: null,
    rawMessage: { role: 'assistant', content: text }, truncated: false,
  }, extra || {});
  const replies = [
    envelope('```json\n{"tool":"bash","input":"ls"}\n```', { reasoning: 'I should list files first.', reasoningType: 'raw' }),
    envelope('Here are your files: sales.csv'),
  ];
  const conv = Projector.createConversation(1);
  const session = new A.AgentSession({
    modelClient: async () => replies.shift(),
    toolExecutor: async (tool, input) => ({ output: 'sales.csv', success: true, backend: 'browser', operation: 'shell' }),
    buildSystemPrompt: A.buildSystemPrompt,
    emit: (e) => Projector.projectEvent(conv, e),
  });
  session.run('list my files', { workspace: null }).then(() => {
    const kinds = conv.items.map((i) => i.kind);
    check('P8 runtime→projector full loop',
      JSON.stringify(kinds) === JSON.stringify(['user', 'reasoning', 'tool', 'assistant'])
      && conv.status === 'completed', kinds.join(',') + ' status=' + conv.status);
    check('P8 reasoning content complete', conv.items[1].content === 'I should list files first.');
    check('P8 tool result wired', conv.items[2].result.output === 'sales.csv'
      && conv.items[2].result.backend === 'browser');

    // P9: session.reset() (New task) clears provider history while the
    // projected timeline of the previous conversation stays intact —
    // the two histories are separate structures.
    const itemsBefore = conv.items.length;
    session.reset();
    check('P9 reset clears provider history only',
      session.history.length === 0 && conv.items.length === itemsBefore);

    // P10: cancelled task projects warning + task_end(cancelled)
    const conv2 = Projector.createConversation(2);
    const hanging = new A.AgentSession({
      modelClient: (body, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
      toolExecutor: async () => ({ output: '', success: true }),
      buildSystemPrompt: A.buildSystemPrompt,
      emit: (e) => Projector.projectEvent(conv2, e),
    });
    const p = hanging.run('hang', { workspace: null });
    hanging.cancel();
    p.then(() => {
      check('P10 cancel projects warning + cancelled end',
        conv2.items.some((i) => i.kind === 'warning' && i.code === 'task_cancelled')
        && conv2.status === 'cancelled', conv2.status);

      console.log('---');
      console.log('presentation.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    }).catch((e) => { console.log('FAIL P10 threw: ' + e.message); process.exit(1); });
  }).catch((e) => { console.log('FAIL P8 threw: ' + e.message); process.exit(1); });
}
