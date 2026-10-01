// Store settings-defaults tests (node, NO DOM / real Vue):
// loads the REAL src/ui/store.js with `vue` and the runtime globals stubbed,
// then exercises the actual settings initialization path:
//   D1 fresh defaults        → deepseek-flash @ https://api.deepseek.com/anthropic, dialect auto
//   D2 user override          → custom model beats the default; empty falls back to default
//   D3 remembered session     → saved user model beats the new default
//   D4 test connection        → verifies the user-configured model, never a hardcoded one
// Run: node tests/store-defaults.test.cjs

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'ui', 'store.js'), 'utf8');
// The store module now boots the real VFS at module scope — load the REAL
// classic scripts it depends on (workspace.js defines WorkspaceAdapter /
// normalizeWorkspacePath used by vfs.js) plus a tiny SHELL_COMMANDS stub,
// exactly like index.html's script order.
const workspaceSrc = fs.readFileSync(path.join(root, 'src', 'workspace.js'), 'utf8');
const vfsSrc = fs.readFileSync(path.join(root, 'src', 'vfs.js'), 'utf8');
const approvalSrc = fs.readFileSync(path.join(root, 'src', 'approval.js'), 'utf8');
const taskRunnerSrc = fs.readFileSync(path.join(root, 'src', 'harness', 'task-runner.js'), 'utf8');
const providerSessionSrc = fs.readFileSync(path.join(root, 'src', 'harness', 'provider-session.js'), 'utf8');
// Review round F3: the validator algorithms are a harness module now —
// inline the REAL implementation (its own import is stripped below).
const replayValidationSrc = fs.readFileSync(path.join(root, 'src', 'harness', 'replay-validation.js'), 'utf8');
const productPromptSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'product-prompt.js'), 'utf8');
const modelAdaptersSrc = fs.readFileSync(path.join(root, 'src', 'model-adapters.js'), 'utf8');
const modelSrc = fs.readFileSync(path.join(root, 'src', 'model.js'), 'utf8');
// M2c: the store composes its ToolPort through the product tool-adapter
// factory and runs the compatibility check through the product checker —
// inline the REAL implementations (pure ESM modules, no vue).
const toolAdapterSrc = fs.readFileSync(path.join(root, 'src', 'product', 'tool-adapter.js'), 'utf8');
const coreCompatSrc = fs.readFileSync(path.join(root, 'src', 'product', 'core-compatibility.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function fakeSessionStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Evaluate the real store module with stubs. Vue's reactive/computed are
// reduced to identity/getter stubs — settings logic never depends on
// reactivity semantics. Runtime globals (Model, AgentSession, …) are the
// same globals index.html provides via classic scripts.
function loadStore(sessionData) {
  globalThis.sessionStorage = fakeSessionStorage(sessionData);
  globalThis.Model = { apiKey: '', apiBase: '', model: '', proxy: '', dialect: '' };
  globalThis.AgentSession = class { constructor(opts) { this.opts = opts; } reset() {} cancel() {} };
  globalThis.buildSystemPrompt = () => '';
  globalThis.LocusProjector = {
    createConversation: (id) => ({ id: id, items: [], status: 'idle', meta: {} }),
    projectEvent: () => {},
  };

  // M2b: strip import declarations INCLUDING multi-line ones (the harness
  // entry import spans several lines).
  const code = src
    .replace(/^import[\s\S]*?from\s+'[^']*';[\s\S]*?\n/gm, '')
    .replace(/^export /gm, '');
  return eval(
    'const reactive = (o) => o;\n' +
    'const computed = (fn) => ({ get value() { return fn(); } });\n' +
    // M2b: the entry functions the store imports, mapped over this eval scope.
    'const createAgentSession = (o) => new AgentSession(o);\n' +
    'const createApprovalController = (o) => new ApprovalController(o);\n' +
    'const historyBudgetBytes = () => 768 * 1024;\n' +
    'const createModelCapabilityRegistry = () => { throw new Error("registry not expected in store-defaults"); };\n' +
    'const createImageInputGate = () => { throw new Error("image gate not expected in store-defaults"); };\n' +
    'const runImageInputProbe = () => { throw new Error("probe not expected in store-defaults"); };\n' +
    'const classifyImageProviderError = () => ({ kind: "none" });\n' +
    'const imageInputUnavailableNotice = () => "notice";\n' +
    // M2c: the store reads the harness declaration through the entry —
    // never exercised by these settings suites.
    'const harnessCapabilities = () => { throw new Error("harness entry not expected in store-defaults"); };' +
    modelAdaptersSrc + '\n' +
    modelSrc + '\n' +
    workspaceSrc + '\n' +
    vfsSrc + '\n' +
    approvalSrc + '\n' +
    // M1a: the store imports the harness task-runner/provider-session ESM
    // modules; strip their export keywords and inline them like the rest.
    // Review round F3: provider-session imports the validator algorithms —
    // inline the REAL implementation and strip the import statement.
    taskRunnerSrc.replace(/^export /gm, '') + '\n' +
    replayValidationSrc.replace(/^export /gm, '') + '\n' +
    providerSessionSrc.replace(/^import[\s\S]*?from\s+'[^']*';[\s\S]*?\n/gm, '').replace(/^export /gm, '') + '\n' +
    // M2b: the product prompt inputs module (pure, no vue).
    productPromptSrc.replace(/^export /gm, '') + '\n' +
    // M2c: the product tool-adapter factory + compatibility checker (REAL).
    toolAdapterSrc.replace(/^export /gm, '') + '\n' +
    coreCompatSrc.replace(/^export /gm, '') + '\n' +
    'const SHELL_COMMANDS = {};\n' +
    code + '\n;({ store, vfs, applySettings, persistSettingsIfNeeded, testConnection, addUploadFiles, removeAttachment, refreshArtifacts, downloadArtifact });'
  );
}

(async () => {
  // ---------- D1. fresh defaults (nothing in sessionStorage) ----------
  {
    const m = loadStore(null); // boot runs applySettings() with the defaults
    check('D1 fresh apiBase', m.store.settings.apiBase === 'https://api.deepseek.com/anthropic',
      m.store.settings.apiBase);
    check('D1 fresh model is deepseek-flash', m.store.settings.model === 'deepseek-flash',
      m.store.settings.model);
    check('D1 fresh dialect is auto', m.store.settings.dialect === 'auto', m.store.settings.dialect);
    check('D1 boot applies default model to runtime', globalThis.Model.model === 'deepseek-flash',
      globalThis.Model.model);
    check('D1 boot keeps endpoint', globalThis.Model.apiBase === 'https://api.deepseek.com/anthropic');
  }

  // ---------- D2. user override wins; empty falls back to default ----------
  {
    const m = loadStore(null);
    m.store.settings.model = 'custom-model-x';
    m.applySettings();
    check('D2 user model override wins', globalThis.Model.model === 'custom-model-x',
      globalThis.Model.model);
    m.store.settings.model = '   ';
    m.applySettings();
    check('D2 blank model falls back to default', globalThis.Model.model === 'deepseek-flash',
      globalThis.Model.model);
  }

  // ---------- D3. remembered session config beats the new default ----------
  {
    const m = loadStore({
      'bar.v0.rememberSessionKey.v1': '1',
      'bar.v0.sessionConfig.v1': JSON.stringify({ model: 'saved-user-model' }),
    });
    check('D3 remembered model survives default upgrade', m.store.settings.model === 'saved-user-model',
      m.store.settings.model);
    check('D3 boot applies remembered model to runtime', globalThis.Model.model === 'saved-user-model',
      globalThis.Model.model);
  }

  // ---------- D4. test connection uses the user-configured model ----------
  // M2b: the check goes through the REAL entry client; a recorded
  // transport fake stands in for the network hop and captures the request.
  {
    const m = loadStore(null);
    m.store.settings.model = 'user-picked-model';
    const bodies = [];
    globalThis.Model.transport = async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }),
      };
    };
    await m.testConnection();
    check('D4 test connection targets the user model',
      bodies.length >= 1 && bodies[0].body.model === 'user-picked-model',
      JSON.stringify(bodies.map((b) => b.body.model)));
    check('D4 test connection reports that model',
      m.store.settingsResult && m.store.settingsResult.ok === true
        && m.store.settingsResult.message.includes('user-picked-model'),
      m.store.settingsResult && m.store.settingsResult.message);
    delete globalThis.Model.transport;
  }

  // ---------- D5. store boots ONE persistent VFS ----------
  {
    const m = loadStore(null);
    check('D5 store exposes the VFS', !!m.vfs && m.vfs.isLocusVFS === true);
    check('D5 unmounted defaultCwd is /home/locus', m.vfs.defaultCwd() === '/home/locus',
      m.vfs.defaultCwd());
    check('D5 uploads wired', m.store.attachmentsWired === true);
    check('D5 artifacts start empty', Array.isArray(m.store.artifacts)
      && m.store.artifacts.length === 0);
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
