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

  const code = src
    .replace(/^import[^\n]*\n/m, '')
    .replace(/^export /gm, '');
  return eval(
    'const reactive = (o) => o;\n' +
    'const computed = (fn) => ({ get value() { return fn(); } });\n' +
    code + '\n;({ store, applySettings, persistSettingsIfNeeded, testConnection });'
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
  {
    const m = loadStore(null);
    m.store.settings.model = 'user-picked-model';
    let testedModel = null;
    globalThis.verifyConnection = async () => { testedModel = globalThis.Model.model; };
    await m.testConnection();
    check('D4 test connection targets the user model', testedModel === 'user-picked-model',
      String(testedModel));
    check('D4 test connection reports that model',
      m.store.settingsResult && m.store.settingsResult.ok === true
        && m.store.settingsResult.message.includes('user-picked-model'),
      m.store.settingsResult && m.store.settingsResult.message);
    delete globalThis.verifyConnection;
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
