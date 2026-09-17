// ============================================================
//  Vue bootstrap + test/demo hooks.
//
//  The app mounts a Cowork-style agent workspace over the runtime's
//  event stream. Query-param hooks exist ONLY for automated tests and
//  visual QA screenshots:
//
//    ?e2e=1       expose window.__locus { store, actions, session, vfs },
//                 honor window.__e2eReplies / __e2eToolExecutor fakes,
//                 collect console errors into window.__e2eErrors
//    ?e2e=1&wire=1 use the production callModel adapter/serializer/header
//                 path with a deterministic in-page transport queue
//    ?demo=task   scripted fake model + tool, auto-mount an OPFS demo
//                 folder and run one demo task (screenshot fixture)
//    ?demo=plus   open the composer "+" menu after mount
//
//  Runtime code never sees these hooks; they plug in at the documented
//  AgentSession dependency boundary (modelClient / toolExecutor) via
//  window.__LOCUS_HOOKS__.
// ============================================================

import { createApp, nextTick } from 'vue';
import App from './App.vue';
import * as ui from './ui/store.js';
import './ui/theme.css';

const params = new URLSearchParams(window.location.search);
const e2eMode = params.get('e2e') === '1';
const wireMode = e2eMode && params.get('wire') === '1';
const demoMode = params.get('demo');

function normalizeEnvelope(partial) {
  const p = partial || {};
  const content = typeof p.content === 'string' ? p.content : '';
  return {
    content: content,
    reasoning: p.reasoning || null,
    reasoningType: p.reasoningType || 'raw',
    toolCalls: p.toolCalls || null,
    rawMessage: p.rawMessage || { role: 'assistant', content: content },
    stopReason: p.stopReason || 'end_turn',
    usage: p.usage || null,
    providerMetadata: p.providerMetadata || null,
    truncated: !!p.truncated,
  };
}

// ---------- e2e hooks ----------
if (e2eMode) {
  window.__e2eErrors = [];
  window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => window.__e2eErrors.push('unhandledrejection: ' + String(e.reason && e.reason.message || e.reason)));
  window.__e2eReplies = [];
  const hooks = {
    toolExecutor: (tool, input, ws, opts) => {
      // null → delegate to the REAL tool layer (telemetry, workspace authority)
      if (typeof window.__e2eToolExecutor === 'function') return window.__e2eToolExecutor(tool, input, ws, opts);
      return executeTool(tool, input, ws, opts); // eslint-disable-line no-undef
    },
    pickDirectory: async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('e2e-workspace', { create: true });
    },
  };
  if (!wireMode) {
    hooks.modelClient = (body, opts) => {
      const q = window.__e2eReplies;
      const next = q.length ? q.shift() : { content: 'e2e default answer' };
      if (typeof next === 'function') return next(body, opts);
      return Promise.resolve(normalizeEnvelope(next));
    };
  } else {
    // Keep the transport fake below the real model boundary. callModel still
    // selects the adapter, builds provider-native JSON and auth headers; only
    // the final network hop is deterministic for browser integration tests.
    window.__locusWire = { calls: [], responses: [] };
    Model.transport = async (url, init) => {
      const wire = window.__locusWire;
      const headers = {};
      for (const [key, value] of Object.entries(init.headers || {})) headers[key] = value;
      const body = JSON.parse(init.body || '{}');
      wire.calls.push({ url, headers, body });
      const response = wire.responses.length ? wire.responses.shift() : {
        choices: [{ message: { role: 'assistant', content: 'wire default answer' }, finish_reason: 'stop' }],
      };
      return new Response(JSON.stringify(response), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
  }
  window.__LOCUS_HOOKS__ = hooks;
}

// ---------- demo hooks (screenshot fixtures; deterministic, offline) ----------
if (demoMode) {
  const DEMO_REPLIES = [
    normalizeEnvelope({
      content: '```json\n{"tool":"bash","input":"ls -la"}\n```',
      reasoning: 'The user wants a summary of the Q3 sales data. First I should see what files are in the workspace — the CSV is probably there along with previous reports. Then I can load it with pandas, compute the aggregates and write a short report file.',
    }),
    normalizeEnvelope({
      content: '```json\n{"tool":"bash","input":"python <<\'PY\'\\nimport pandas as pd\\ndf = pd.read_csv(\'q3-sales.csv\')\\nsummary = df.groupby(\'region\')[\'revenue\'].sum()\\nprint(summary.to_string())\\nsummary.to_csv(\'q3-report.csv\')\\nPY"}\n```',
    }),
    normalizeEnvelope({
      content: 'Done. I read `q3-sales.csv`, aggregated revenue by region and saved the result to `q3-report.csv`.\n\n**Revenue by region**\n\n- North — 184,200\n- South — 96,450\n- East — 152,300\n- West — 121,880\n\nNorth leads this quarter, about 21% ahead of East. The full per-region table is in `q3-report.csv` in your workspace.',
    }),
  ];
  let demoIdx = 0;
  const demoToolOutputs = [
    'total 4\n-rw-r--r--  q3-sales.csv      84,120 bytes\n-rw-r--r--  q2-report.csv      2,304 bytes\n-rw-r--r--  notes.txt            412 bytes',
    'region\nEast     152300\nNorth    184200\nSouth     96450\nWest     121880\nName: revenue, dtype: int64',
  ];
  window.__LOCUS_HOOKS__ = {
    modelClient: () => Promise.resolve(DEMO_REPLIES[Math.min(demoIdx++, DEMO_REPLIES.length - 1)]),
    toolExecutor: (tool, input) => Promise.resolve({
      output: demoToolOutputs.shift() || '',
      success: true,
      backend: 'browser',
      operation: 'shell',
    }),
    pickDirectory: async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('demo-workspace', { create: true });
    },
  };
}

// ---------- mount ----------
const app = createApp(App);
app.mount('#app');

if (e2eMode || demoMode) {
  window.__locus = { store: ui.store, actions: ui, session: ui.session, vfs: ui.vfs };
}

// Python worker status is owned by the runtime (plain object); mirror it
// into the store for display.
setInterval(() => {
  if (typeof PythonRuntime !== 'undefined') ui.store.pythonStatus = PythonRuntime.status;
}, 1000);

// ---------- demo automation ----------
if (demoMode === 'task') {
  nextTick(async () => {
    await ui.mountFolder();
    await ui.submit('Summarize the Q3 sales data and save a report');
  });
} else if (demoMode === 'plus') {
  nextTick(() => { ui.store.plusMenuOpen = true; });
}
