// ============================================================
//  UI
//  Setup screen, workspace selection, terminal wiring, debug panel.
//  Terminal chrome adapted from Whoami_Cli_game.
// ============================================================

const App = {
  term: null,
  workspace: null, // LocalDirectoryWorkspace | null
  busy: false,
};

const REMEMBER_SESSION_KEY = 'bar.v0.rememberSessionKey.v1';
const SESSION_CONFIG_KEY = 'bar.v0.sessionConfig.v1';

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) {}
}
function sessionRemove(key) {
  try { sessionStorage.removeItem(key); } catch (e) {}
}

function loadSessionConfig() {
  if (sessionGet(REMEMBER_SESSION_KEY) !== '1') return;
  let cfg = null;
  try { cfg = JSON.parse(sessionGet(SESSION_CONFIG_KEY) || 'null'); } catch (e) {}
  if (!cfg) return;
  const map = { apiKey: 'api-key-input', apiBase: 'api-base-input', model: 'model-input', proxy: 'proxy-input' };
  for (const k in map) {
    const el = document.getElementById(map[k]);
    if (el && cfg[k]) el.value = cfg[k];
  }
  const remember = document.getElementById('remember-session-key-check');
  if (remember) remember.checked = true;
}

function saveSessionConfigIfNeeded() {
  const remember = document.getElementById('remember-session-key-check');
  if (!remember || !remember.checked) {
    sessionRemove(REMEMBER_SESSION_KEY);
    sessionRemove(SESSION_CONFIG_KEY);
    return;
  }
  // SECURITY NOTE: the API key is stored in sessionStorage (per-tab,
  // cleared when the tab closes) only because the user explicitly opted
  // in. It is never written to localStorage, cookies, or any server.
  const cfg = {
    apiKey: document.getElementById('api-key-input').value.trim(),
    apiBase: document.getElementById('api-base-input').value.trim(),
    model: document.getElementById('model-input').value.trim(),
    proxy: document.getElementById('proxy-input').value.trim(),
  };
  sessionSet(REMEMBER_SESSION_KEY, '1');
  sessionSet(SESSION_CONFIG_KEY, JSON.stringify(cfg));
}

// ---------- setup screen ----------
function initSetup() {
  const advToggle = document.getElementById('adv-toggle');
  const advPanel = document.getElementById('adv-panel');
  advToggle.addEventListener('click', () => {
    advPanel.classList.toggle('open');
    advToggle.textContent = (advPanel.classList.contains('open') ? '▾ ' : '▸ ') + '高级设置';
  });

  loadSessionConfig();
  document.getElementById('setup-go').addEventListener('click', startApp);
}

function showInitResult(msg, isError) {
  const el = document.getElementById('init-result');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : 'var(--accent)';
  el.classList.add('show');
}

async function startApp() {
  Model.apiKey = document.getElementById('api-key-input').value.trim();
  Model.apiBase = document.getElementById('api-base-input').value.trim() || 'https://api.deepseek.com/anthropic';
  Model.model = document.getElementById('model-input').value.trim() || 'deepseek-v4-pro';
  Model.proxy = document.getElementById('proxy-input').value.trim();

  if (!Model.apiKey) {
    showInitResult('请输入 API Key。', true);
    return;
  }

  const btn = document.getElementById('setup-go');
  btn.classList.add('testing');
  btn.textContent = '测试连接中...';
  try {
    await verifyConnection();
    saveSessionConfigIfNeeded();
    document.getElementById('screen-zero').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    initTerminal();
  } catch (e) {
    showInitResult('连接失败: ' + e.message, true);
  } finally {
    btn.classList.remove('testing');
    btn.textContent = '连接模型';
  }
}

// ---------- workspace ----------
async function selectWorkspace() {
  if (!window.showDirectoryPicker) {
    App.term && App.term.echo('[[;var(--red);]当前浏览器不支持 File System Access API（请使用 Chrome / Edge 桌面版）。]');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // The picker is async: a task may have STARTED (or still be running)
    // after the picker was opened. Never switch under a live task — cancel
    // it first and wait until it has actually stopped, so no late model
    // response, tool result or write-back can land in the new workspace.
    if (App.busy) {
      App.term && App.term.echo('[[;var(--text-dim);]正在取消当前任务以切换 Workspace…]');
      cancelAgentTask();
      updateCancelButton();
      const stopped = await waitFor(() => !App.busy, 10000);
      if (!stopped) {
        App.term && App.term.echo('[[;var(--red);]当前任务未能停止，已放弃切换 Workspace（原 Workspace 保持不变）。]');
        return;
      }
    }

    const granted = await ensureWorkspacePermission(handle);
    if (!granted) {
      App.term && App.term.echo('[[;var(--red);]未获得目录读写权限。]');
      return;
    }
    App.workspace = new LocalDirectoryWorkspace(handle);
    // Full session boundary: conversation history, generation, AND the
    // Python interpreter (globals / modules / /tmp) are all reset, so
    // nothing from the previous workspace leaks into the new one. Only on
    // success — picker cancellation and failures never reset.
    resetAgentSession();
    document.getElementById('sb-workspace').textContent = 'Workspace: ' + App.workspace.name;
    if (App.term) {
      App.term.echo('[[;var(--accent);]Workspace 已挂载: ' + escapeTerm(App.workspace.name) + '/]');
      App.term.echo('[[;var(--text-dim);]Workspace changed. Agent context and Python state have been reset.]');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    App.term && App.term.echo('[[;var(--red);]选择目录失败: ' + escapeTerm(e.message || String(e)) + ']');
  }
}

function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------- debug panel ----------
function renderDebugPanel() {
  const list = document.getElementById('dp-list');
  if (!list) return;
  const recs = Telemetry.records.slice(-30).reverse();
  if (!recs.length) {
    list.innerHTML = '<div class="dp-empty">尚无执行记录。</div>';
    return;
  }
  list.innerHTML = recs.map((r) => {
    const cls = r.success ? 'ok' : 'fail';
    const mark = r.success ? '✓' : '✗';
    return '<div class="dp-item"><span class="' + cls + '">' + mark + '</span> ' +
      escapeHtml(r.tool) + ' [' + r.backend + '] ' + r.duration_ms + 'ms' +
      ' in:' + r.input_bytes + 'B out:' + r.output_bytes + 'B' +
      (r.error ? '\n  err: ' + escapeHtml(r.error) : '') +
      '\n  ' + escapeHtml(r.ts) + '</div>';
  }).join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toggleDebugPanel() {
  const panel = document.getElementById('debug-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderDebugPanel();
}

// ---------- task cancellation (reachable while a task is running) ----------
// The terminal input is paused during a task, so `cancel` typed at the
// prompt can never arrive mid-task. The ALWAYS-mounted cancel button in
// the status bar and the Escape shortcut are the real in-flight entries;
// the local `cancel` command only covers the (rare) non-paused case.
function updateCancelButton() {
  const btn = document.getElementById('btn-cancel');
  if (!btn) return;
  const task = Agent.task;
  if (App.busy && task && task.controller.signal.aborted) {
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
  } else if (App.busy) {
    btn.disabled = false;
    btn.textContent = 'Cancel (Esc)';
  } else {
    btn.disabled = true;
    btn.textContent = 'Cancel';
  }
}

function requestTaskCancel(term) {
  const out = term || App.term;
  if (!App.busy || !Agent.task) {
    out && out.echo('[[;var(--text-dim);]当前没有正在执行的任务。]');
    updateCancelButton();
    return;
  }
  if (!Agent.task.controller.signal.aborted) {
    cancelAgentTask();
    out && out.echo('[[;var(--text-dim);]已请求取消当前任务。]');
  }
  updateCancelButton();
}

// ---------- local terminal commands ----------
function printHelp(term) {
  [
    '本地命令（直接由 harness 处理，不经过模型）:',
    '  help        显示本帮助',
    '  clear       清空终端（不影响会话历史）',
    '  reset       开始新会话：清空对话历史并重置 Python 状态（Workspace 保持挂载）',
    '  cancel      取消当前正在执行的任务',
    '  workspace   显示当前 workspace',
    '  telemetry   打开/关闭 execution log 面板',
    '',
    '其他所有输入都会作为任务发送给 Agent。',
    'Agent 通过本地 bash 工具（pwd / ls / cat / echo / python）操作为你授权的 workspace。',
  ].forEach((l) => term.echo('[[;var(--text-dim);]' + escapeTerm(l) + ']'));
}

const LOCAL_COMMANDS = {
  help: (args, term) => printHelp(term),
  clear: (args, term) => term.clear(), // fully local, never sent to the model
  reset: (args, term) => {
    if (App.busy) {
      term.echo('[[;var(--text-dim);]正在取消当前任务并重置会话…]');
      cancelAgentTask();
    }
    resetAgentSession();
    term.echo('[[;var(--accent);]会话已重置：对话历史与 Python 状态已清空。]');
  },
  cancel: (args, term) => requestTaskCancel(term),
  telemetry: (args, term) => toggleDebugPanel(),
  workspace: (args, term) => {
    term.echo(App.workspace
      ? '[[;var(--text-dim);]Workspace: ' + escapeTerm(App.workspace.name) + '/ (local directory, readwrite)]'
      : '[[;var(--text-dim);]Workspace: Not selected. 点击右上角 Select Workspace。]');
  },
};

// ---------- terminal ----------
function initTerminal() {
  App.term = $('#terminal').terminal(async function (input) {
    if (App.busy) return;
    input = input.trim();
    if (!input) return;

    const cmd = input.split(/\s+/)[0].toLowerCase();
    if (LOCAL_COMMANDS[cmd]) {
      LOCAL_COMMANDS[cmd](input.split(/\s+/).slice(1), this);
      return;
    }

    App.busy = true;
    this.pause();
    updateCancelButton();
    try {
      await runAgentTask(this, input);
    } catch (e) {
      this.echo('[[;var(--red);][错误: ' + escapeTerm(e.message || String(e)) + ']]');
    }
    App.busy = false;
    updateCancelButton();
    this.resume();
  }, {
    prompt: '[[;var(--accent);]>] ',
    greetings: false,
    scrollOnEcho: true,
    height: '100%',
    completion: ['help', 'clear', 'reset', 'cancel', 'workspace', 'telemetry'],
    onInit: function () {
      this.echo('[[;var(--text-dim);]Browser Agent Runtime v0.3.2]');
      this.echo('[[;var(--text-dim);]所有文件与 Python 执行均在浏览器本地完成，云端仅用于 LLM 推理。]');
      this.echo('[[;var(--text-dim);]1) 点击右上角 Select Workspace 授权一个本地目录]');
      this.echo('[[;var(--text-dim);]2) 直接用自然语言描述任务，例如: 分析 sales.csv，计算每列平均值，保存到 summary.csv]');
      this.echo('[[;var(--text-dim);]输入 help 查看本地命令。]');
      this.echo('');
    },
  });
}

// ---------- boot ----------
window.addEventListener('DOMContentLoaded', () => {
  initSetup();
  document.getElementById('btn-workspace').addEventListener('click', selectWorkspace);
  document.getElementById('btn-log').addEventListener('click', toggleDebugPanel);
  const cancelBtn = document.getElementById('btn-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => requestTaskCancel());
  // Escape cancels the running task even while the terminal is paused.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && App.busy) requestTaskCancel();
  });
});
