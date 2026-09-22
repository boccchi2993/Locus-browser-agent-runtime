// Capability Composition v1 BROWSER e2e (self-contained: own build, own
// servers, own Chrome). Drives the REAL built app (dist + real UI + real
// shell + real Python worker booting real Pyodide from harness-delivered
// bytes) through the ?e2e=1 seams with a TEST-ONLY synthetic catalog:
//
//   E1  production catalog empty: clean boot, "No optional capabilities"
//   E2  synthetic catalog injection: UI lists the capability
//   E3  Add -> state ready; durable instance + install marker materialized
//   E4  system prompt contains the capability index + skill instance path
//   E5  system prompt does NOT contain the skill body marker
//   E6  cat ~/.skills/... during the task -> body readable (lazy loading)
//   E7  ordinary `import locus_test_plugin` inside python -> 42
//       (pre-READY install, no lazy-install-on-import, no network)
//   E8  Remove -> NEXT task's prompt/environment no longer carry it
//   E9  the old task snapshot stays frozen and unchanged
//   E10 shared plugin referenced by two capabilities resolves ONCE
//   E11 MCP requirement -> needs-connection; prompt never claims it is
//       available; no connector call, no auto-authorization
//   E12 explicit connect -> ready in the NEXT snapshot only
//   E13 /mnt/plugins introspection read-only (real shell, real fork)
//   E14 the old read-only skill mount is gone; instances live under ~/.skills
//   E15 capability introspection read-only
//
// Mutable-skill-instance approval/lifecycle proofs live in
// tests/e2e-skill-instances.cjs.
//
// Run: node tests/e2e-capabilities.cjs
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, closeManagedProcess, connectToTarget,
  launchChrome, launchManagedProcess, waitForCdp, waitForHttp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');

const ROOT = path.join(__dirname, '..');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const { base: PYODIDE_CDN, manifest: PY_MANIFEST } = loadPythonManifest();
// Disk caches: this repo's own, then the primary checkout's (best effort).
const ASSET_CACHE_DIRS = [
  path.join(ROOT, 'tmp-f04b-probe', 'pyodide'),
  path.join(ROOT, '..', 'Locus-browser-agent-runtime', 'tmp-f04b-probe', 'pyodide'),
];

const SYNTH_PLUGIN_SRC = 'def answer():\n    return 42\n';
// The skill's default Markdown source lives in a real fixture file; the
// descriptor is metadata ONLY and the source is injected into the
// SkillSourceStore (never inline on the catalog entry). Loaded in main().
const FIXTURE_SKILL_PATH = path.join(__dirname, 'fixtures', 'skills', 'synthetic-skill', 'SKILL.md');
let SYNTH_SKILL_BODY = '';

const SYNTH_CATALOGS = {
  plugins: [
    { id: 'synthetic-python-plugin', version: '1', displayName: 'Synthetic Python Plugin', runtime: 'python', authority: 'none', provides: { pythonImports: ['locus_test_plugin'] } },
    { id: 'shared-plugin', version: '2', displayName: 'Shared Plugin', runtime: 'python', authority: 'none', provides: { pythonImports: [] } },
  ],
  skills: [
    { id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'How to use the synthetic capability.' },
  ],
  mcps: [
    { id: 'synthetic-service', displayName: 'Synthetic Service', description: 'TEST ONLY authority' },
  ],
  capabilities: [
    { id: 'synthetic-capability', version: '1', displayName: 'Synthetic Capability', description: 'TEST ONLY composition proof.', plugins: ['synthetic-python-plugin'], skills: ['synthetic-skill'], mcps: [] },
    { id: 'cap-a', version: '1', displayName: 'Capability A', description: 'Shares a plugin and the skill definition.', plugins: ['shared-plugin'], skills: ['synthetic-skill'], mcps: [] },
    { id: 'cap-b', version: '1', displayName: 'Capability B', description: 'Shares the same plugin and skill definition.', plugins: ['shared-plugin'], skills: ['synthetic-skill'], mcps: [] },
    { id: 'synthetic-mcp-capability', version: '1', displayName: 'Synthetic MCP Capability', description: 'Requires an external authority.', plugins: [], skills: ['synthetic-skill'], mcps: ['synthetic-service'] },
  ],
};

// Injected together with the catalog: immutable default sources for the
// synthetic SkillDefinitions (body loaded in main()).
let SYNTH_SOURCES = null;

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result?.result?.value;
}

async function loadAsset(name) {
  for (const dir of ASSET_CACHE_DIRS) {
    try { return await fs.readFile(path.join(dir, name)); } catch (e) { /* next */ }
  }
  const res = await fetch(PYODIDE_CDN + name);
  if (!res.ok) throw new Error('asset download failed: ' + name + ' -> ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    await fs.mkdir(ASSET_CACHE_DIRS[0], { recursive: true });
    await fs.writeFile(path.join(ASSET_CACHE_DIRS[0], name), bytes);
  } catch (e) { /* cache is best-effort */ }
  return bytes;
}

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
  };

  SYNTH_SKILL_BODY = await fs.readFile(FIXTURE_SKILL_PATH, 'utf8');
  SYNTH_SOURCES = { 'synthetic-skill': { version: '1', source: SYNTH_SKILL_BODY } };

  // ---- build (always fresh, same policy as e2e-network) ----
  console.log('# building dist (vite build)');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
  if (build.status !== 0) { console.error('build failed'); process.exit(1); }

  // ---- asset server (serves the pinned Pyodide set locally) ----
  const assetPort = await allocateFreePort();
  const assetBytes = new Map();
  const assetServer = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/assets\//, ''));
    const bytes = assetBytes.get(name);
    if (!bytes) { res.statusCode = 404; res.end('unknown asset'); return; }
    const entry = PY_MANIFEST.find((a) => a.name === name);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('content-type', entry ? entry.mime : 'application/octet-stream');
    res.setHeader('content-length', bytes.length);
    res.end(bytes);
  });
  await new Promise((r) => assetServer.listen(assetPort, '127.0.0.1', r));
  console.log('# loading pinned pyodide assets (' + PY_MANIFEST.length + ' files, cache or CDN)');
  for (const a of PY_MANIFEST) assetBytes.set(a.name, await loadAsset(a.name));

  // ---- vite preview (the built app) ----
  const appPort = await allocateFreePort();
  const preview = launchManagedProcess(process.execPath, [
    VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
  ], { cwd: ROOT, port: appPort, label: 'Vite preview (capabilities)', env: process.env });
  const appRoot = 'http://127.0.0.1:' + appPort + '/';
  await waitForHttp(appRoot, { process: preview, timeoutMs: 15000 });

  let profileDir = null;
  let chrome = null;
  let cdp = null;
  try {
    const appUrl = appRoot + '?e2e=1';
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-cap-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'capabilities Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    // Rewrite the runtime's PINNED CDN fetches onto the local asset server
    // for every future document (production code untouched — the pinned
    // URL list stays the only thing the page ever asks for).
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(function () { var native = window.fetch.bind(window);'
        + ' var prefix = ' + JSON.stringify(PYODIDE_CDN) + ';'
        + ' var local = ' + JSON.stringify('http://127.0.0.1:' + assetPort + '/assets/') + ';'
        + ' window.fetch = function (input, init) {'
        + '   var url = typeof input === "string" ? input : (input && input.url) || String(input);'
        + '   if (url.indexOf(prefix) === 0) url = local + url.slice(prefix.length);'
        + '   return native(url, init); }; })();',
    });
    await evaluate(cdp, 'location.reload(); "reloading"');
    await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.capabilityComposition)',
      { process: chrome, phase: 'cap-app-boot', timeoutMs: 20000 });
    // Durable home mount is the last boot step; after it the VFS topology is final.
    await waitForRuntimeCondition(cdp,
      'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
      { process: chrome, phase: 'cap-durable-home', timeoutMs: 20000 });

    // Install the request-capturing model client (production model path is
    // the injected seam; tools stay REAL).
    await evaluate(cdp,
      'window.__capE2E = { requests: [], replies: [] };'
      + 'window.__LOCUS_HOOKS__.modelClient = function (body) {'
      + '  window.__capE2E.requests.push({ system: body.system, caps: window.__locus.capabilityComposition.list().filter(function (c) { return c.enabled; }).map(function (c) { return c.id; }) });'
      + '  var next = window.__capE2E.replies.length ? window.__capE2E.replies.shift() : "done.";'
      + '  return Promise.resolve({ content: next, rawMessage: { role: "assistant", content: next }, stopReason: "end_turn", truncated: false });'
      + '}; "capturer installed"');

    // ---- E1: production catalog is empty ----
    const e1list = await evaluate(cdp, 'window.__locus.capabilityComposition.list().map(function (c) { return c.id; })');
    check('E1a production catalog empty at boot', Array.isArray(e1list) && e1list.length === 0, JSON.stringify(e1list));
    await evaluate(cdp, 'window.__locus.store.settingsOpen = true; "open"');
    const e1empty = await waitForRuntimeCondition(cdp,
      '(document.querySelector(\'[data-testid="capabilities-empty"]\')||{}).textContent || ""',
      { process: chrome, phase: 'cap-empty-ui', timeoutMs: 10000, predicate: (v) => String(v).includes('No optional capabilities available yet') });
    check('E1b empty-catalog UI message', String(e1empty).includes('No optional capabilities available yet'), e1empty);

    // ---- E2: inject the TEST-ONLY synthetic catalog + sources + provider ----
    await evaluate(cdp,
      'window.__locus.capabilityComposition.injectTestCatalog(' + JSON.stringify(SYNTH_CATALOGS) + ', ' + JSON.stringify(SYNTH_SOURCES) + ');'
      + 'registerPluginRuntimeProvider("python", { prepare: async function () {'
      + '  return { files: { "locus_test_plugin.py": ' + JSON.stringify(SYNTH_PLUGIN_SRC) + ' }, imports: ["locus_test_plugin"] };'
      + '} }); "injected"');
    const e2list = await evaluate(cdp, 'window.__locus.capabilityComposition.list().map(function (c) { return c.id + ":" + c.state; })');
    check('E2a injected catalog lists four capabilities, all disabled',
      e2list.length === 4 && e2list.every((s) => s.endsWith(':disabled')), JSON.stringify(e2list));
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="capability-synthetic-capability"]\')',
      { process: chrome, phase: 'cap-ui-item', timeoutMs: 10000 });
    check('E2b UI lists Synthetic Capability', true);

    // ---- E3: Add -> ready ----
    await evaluate(cdp, 'document.querySelector(\'[data-testid="capability-add-synthetic-capability"]\').click(); "clicked"');
    const e3state = await waitForRuntimeCondition(cdp,
      '(window.__locus.capabilityComposition.list().find(function (c) { return c.id === "synthetic-capability"; }) || {}).state',
      { process: chrome, phase: 'cap-ready', timeoutMs: 10000, predicate: (v) => v === 'ready' });
    check('E3 Add resolves local components -> ready', e3state === 'ready', e3state);
    const e3badge = await evaluate(cdp,
      '(document.querySelector(\'[data-testid="capability-synthetic-capability"] .capability-state\')||{}).dataset ? document.querySelector(\'[data-testid="capability-synthetic-capability"] .capability-state\').dataset.state : null');
    check('E3b UI badge shows Ready', e3badge === 'ready', String(e3badge));
    const e3includes = await evaluate(cdp,
      '(document.querySelector(\'[data-testid="capability-includes-synthetic-capability"]\')||{}).textContent || ""');
    check('E3c component counts rendered from the resolved set', /1 local software/.test(String(e3includes)) && /1 guidance/.test(String(e3includes)), e3includes);
    const e3inst = await evaluate(cdp,
      '(async function () { return await window.__locus.vfs.read("/home/locus/.skills/synthetic-capability/synthetic-skill.skill"); })()');
    check('E3d Add materialized the durable capability-private instance',
      e3inst === SYNTH_SKILL_BODY, String(e3inst).slice(0, 120));
    const e3marker = await evaluate(cdp,
      '(async function () { return await window.__locus.vfs.exists("/home/locus/.skills/synthetic-capability/.locus-installed.json"); })()');
    check('E3e install marker written', e3marker === true, String(e3marker));

    // ---- task 1: the full lazy-skill + ordinary-import trajectory ----
    await evaluate(cdp,
      'window.__capEnvTask1 = window.__locus.capabilityComposition.taskEnvironment();'
      + 'window.__capE2E.replies = ' + JSON.stringify([
        '```json\n{"tool":"bash","input":"cat /home/locus/.skills/synthetic-capability/synthetic-skill.skill"}\n```',
        // The fenced JSON must escape newlines exactly like a real model
        // would — raw control characters inside a JSON string literal are
        // invalid and the strict text fallback would reject the call.
        '```json\n{"tool":"bash","input":"python <<\'PY\'\\nimport locus_test_plugin\\nprint(locus_test_plugin.answer())\\nPY"}\n```',
        'Task complete.',
      ]) + '; "armed"');
    console.log('# running task 1 (cat skill -> python import; boots real Pyodide)');
    const t1 = Date.now();
    await evaluate(cdp,
      'window.__locus.actions.submit("Use the synthetic capability: read its skill guide, then demonstrate the plugin.")', 300000);
    console.log('# task 1 took ' + Math.round((Date.now() - t1) / 100) / 10 + 's');

    const sys1 = await evaluate(cdp, 'window.__capE2E.requests.length ? window.__capE2E.requests[0].system : null');
    check('E4 system prompt contains the capability index + instance path',
      typeof sys1 === 'string' && sys1.includes('Synthetic Capability')
      && sys1.includes('/home/locus/.skills/synthetic-capability/synthetic-skill.skill')
      && sys1.includes('## Capabilities'), typeof sys1 === 'string' ? sys1.slice(-600) : sys1);
    check('E4b prompt points at NO other skill location', typeof sys1 === 'string' && !sys1.includes('/usr/local/share/locus/skills'));
    check('E4c prompt states the behavior-mutation rule', typeof sys1 === 'string'
      && /customized when the user asks/i.test(sys1) && /explicit user confirmation/i.test(sys1));
    check('E5 system prompt does NOT contain the skill body marker',
      typeof sys1 === 'string' && !sys1.includes('SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91'));
    check('E5b system prompt does NOT leak plugin ids or internal APIs',
      !sys1.includes('synthetic-python-plugin') && !sys1.includes('CapabilityManager') && !sys1.includes('TaskEnvironment'));
    const items1 = await evaluate(cdp,
      'JSON.parse(JSON.stringify(window.__locus.store.conversations.find(function (c) { return c.id === window.__locus.store.liveConversationId; }).items))');
    const toolOutputs = (items1 || []).filter((i) => i.kind === 'tool' && i.result).map((i) => String(i.result.output || ''));
    check('E6 cat SKILL.md during the task returns the body (lazy read)',
      toolOutputs.some((o) => o.includes('SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91')), JSON.stringify(toolOutputs).slice(0, 300));
    const pyOut = toolOutputs.find((o) => /42/.test(o));
    check('E7 ordinary python import of the plugin package -> 42',
      !!pyOut && !/ModuleNotFoundError|Traceback/i.test(pyOut), JSON.stringify(pyOut));
    check('E7b no network/bootstrap chatter in the plugin run',
      !!pyOut && !/loadPackage|download|pyodide/i.test(pyOut), JSON.stringify(pyOut));

    // ---- E8: Remove (two-step: Remove -> Confirm remove) -> only the NEXT task changes ----
    await evaluate(cdp, 'document.querySelector(\'[data-testid="capability-remove-synthetic-capability"]\').click(); "clicked"');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="capability-remove-confirm-synthetic-capability"]\')',
      { process: chrome, phase: 'cap-remove-confirm', timeoutMs: 5000 });
    const e8warn = await evaluate(cdp,
      '(document.querySelector(\'[data-testid="capability-remove-warning"]\')||{}).textContent || ""');
    check('E8a0 destructive removal semantics are stated in the UI',
      /deletes its customized guidance/.test(String(e8warn)) && /restores the default guidance/.test(String(e8warn)), e8warn);
    await evaluate(cdp, 'document.querySelector(\'[data-testid="capability-remove-confirm-synthetic-capability"]\').click(); "confirmed"');
    const e8state = await waitForRuntimeCondition(cdp,
      '(window.__locus.capabilityComposition.list().find(function (c) { return c.id === "synthetic-capability"; }) || {}).state',
      { process: chrome, phase: 'cap-removed', timeoutMs: 10000, predicate: (v) => v === 'disabled' });
    check('E8a Remove -> state disabled', e8state === 'disabled', e8state);
    const e8dirGone = await evaluate(cdp,
      '(async function () { return await window.__locus.vfs.exists("/home/locus/.skills/synthetic-capability"); })()');
    check('E8a1 Remove deleted the capability skill instance directory', e8dirGone === false, String(e8dirGone));
    await evaluate(cdp, 'window.__capE2E.mark2 = window.__capE2E.requests.length; window.__capE2E.replies = ["ok."]; "armed"');
    await evaluate(cdp, 'window.__locus.actions.submit("second task")', 60000);
    const sys2 = await evaluate(cdp, 'JSON.stringify(window.__capE2E.requests[window.__capE2E.mark2] || null)');
    const sys2r = JSON.parse(sys2);
    check('E8b next task prompt carries no capability section',
      sys2r && !sys2r.system.includes('Synthetic Capability') && !sys2r.system.includes('## Capabilities')
      && sys2r.caps.length === 0, sys2 ? sys2.slice(0, 300) : sys2);
    const envNow = await evaluate(cdp, 'window.__locus.capabilityComposition.taskEnvironment()');
    check('E8c next environment has no plugins/skills',
      envNow.plugins.length === 0 && envNow.skills.length === 0 && envNow.capabilities.length === 0, JSON.stringify(envNow).slice(0, 200));

    // ---- E9: the old snapshot is frozen and untouched ----
    const e9 = await evaluate(cdp,
      '(function () { var e = window.__capEnvTask1;'
      + ' return { frozen: Object.isFrozen(e) && Object.isFrozen(e.capabilities) && Object.isFrozen(e.plugins),'
      + ' caps: e.capabilities.length, plugins: e.plugins.length, skills: e.skills.length }; })()');
    check('E9 old task snapshot remains frozen + unchanged',
      e9.frozen && e9.caps === 1 && e9.plugins === 1 && e9.skills === 1, JSON.stringify(e9));
    check('E9b task-1 request (its own snapshot era) still shows the capability',
      typeof sys1 === 'string' && sys1.includes('Synthetic Capability'));

    // ---- E10: shared component dedupe ----
    await evaluate(cdp,
      '(async function () { await window.__locus.capabilityComposition.enable("cap-a"); await window.__locus.capabilityComposition.enable("cap-b"); return "on"; })()');
    const e10 = await evaluate(cdp,
      '(function () { var e = window.__locus.capabilityComposition.taskEnvironment();'
      + ' return { caps: e.capabilities.length, plugins: e.plugins.map(function (p) { return p.id; }) }; })()');
    check('E10 shared plugin resolves ONCE across two capabilities',
      e10.caps === 2 && e10.plugins.length === 1 && e10.plugins[0] === 'shared-plugin', JSON.stringify(e10));
    await evaluate(cdp,
      '(async function () { await window.__locus.capabilityComposition.disable("cap-a"); await window.__locus.capabilityComposition.disable("cap-b"); return "off"; })()');
    const e10b = await evaluate(cdp, 'window.__locus.capabilityComposition.taskEnvironment().plugins.length');
    check('E10b disabling both removes the shared plugin', e10b === 0, String(e10b));

    // ---- E11: MCP requirement -> needs-connection ----
    await evaluate(cdp, '(async function () { await window.__locus.capabilityComposition.enable("synthetic-mcp-capability"); return "on"; })()');
    const e11state = await evaluate(cdp,
      'window.__locus.capabilityComposition.list().find(function (c) { return c.id === "synthetic-mcp-capability"; }).state');
    check('E11a capability with unconnected MCP requirement is needs-connection', e11state === 'needs-connection', String(e11state));
    await evaluate(cdp, 'window.__capEnvMcp = window.__locus.capabilityComposition.taskEnvironment(); "saved"');
    await evaluate(cdp, 'window.__capE2E.mark3 = window.__capE2E.requests.length; window.__capE2E.replies = ["ok."]; "armed"');
    await evaluate(cdp, 'window.__locus.actions.submit("third task")', 60000);
    const sys3r = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__capE2E.requests[window.__capE2E.mark3] || null)'));
    const sys3 = sys3r ? sys3r.system : null;
    check('E11b prompt lists the capability but does NOT claim the authority',
      typeof sys3 === 'string' && sys3.includes('Synthetic MCP Capability') && sys3.includes('NOT connected'),
      typeof sys3 === 'string' ? sys3.slice(-500) : JSON.stringify(sys3r));
    check('E11c prompt never claims the external connection is available',
      typeof sys3 === 'string' && !/already connected|is connected/.test(sys3));

    // ---- E12: explicit connect -> NEXT snapshot only ----
    await evaluate(cdp, 'window.__locus.capabilityComposition.connectMcp("synthetic-service"); "connected"');
    const e12 = await evaluate(cdp,
      '(function () { return {'
      + ' manager: window.__locus.capabilityComposition.list().find(function (c) { return c.id === "synthetic-mcp-capability"; }).state,'
      + ' old: window.__capEnvMcp.mcps[0].state,'
      + ' fresh: window.__locus.capabilityComposition.taskEnvironment().mcps[0].state }; })()');
    check('E12 connect flips manager + NEXT snapshot, old snapshot untouched',
      e12.manager === 'ready' && e12.old === 'needs-connection' && e12.fresh === 'connected', JSON.stringify(e12));

    // ---- E13-E15: read-only introspection/skill mounts via the REAL shell ----
    await evaluate(cdp,
      '(async function () { await window.__locus.capabilityComposition.enable("synthetic-capability");'
      + ' var env = window.__locus.capabilityComposition.taskEnvironment();'
      + ' var fork = window.__locus.vfs.fork();'
      + ' var mounts = window.__locus.capabilityComposition.manager().taskVfsMounts(env);'
      + ' for (var i = 0; i < mounts.length; i++) fork.mount(mounts[i].path, mounts[i].provider, mounts[i].authority);'
      + ' window.__capFork = fork; return mounts.length; })()');
    const e13 = await evaluate(cdp, '(async function () {'
      + ' var w = await window.executeTool("bash", "echo patched > /mnt/plugins/synthetic-python-plugin/plugin.json", window.__capFork, {});'
      + ' var r = await window.executeTool("bash", "cat /mnt/plugins/synthetic-python-plugin/plugin.json", window.__capFork, {});'
      + ' return { writeBlocked: !w.success && /read-only/i.test(w.output), read: r.success && r.output.indexOf("\\"authority\\": \\"none\\"") !== -1 }; })()', 60000);
    check('E13 /mnt/plugins introspection readable + write refused', e13.writeBlocked && e13.read, JSON.stringify(e13));
    const e14 = await evaluate(cdp, '(async function () {'
      + ' var mounts = window.__locus.capabilityComposition.manager().taskVfsMounts(window.__locus.capabilityComposition.taskEnvironment());'
      + ' var paths = mounts.map(function (m) { return m.path; });'
      + ' var r = await window.executeTool("bash", "cat /home/locus/.skills/synthetic-capability/synthetic-skill.skill", window.__capFork, {});'
      + ' return { oldMountGone: paths.indexOf("/usr/local/share/locus/skills") === -1,'
      + '  read: r.success && r.output.indexOf("SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91") !== -1 }; })()', 60000);
    check('E14 old skill body mount is gone; instance readable under ~/.skills (read is free)',
      e14.oldMountGone && e14.read, JSON.stringify(e14));
    const e15 = await evaluate(cdp, '(async function () {'
      + ' var r = await window.executeTool("bash", "cat /usr/local/share/locus/capabilities/synthetic-capability/capability.json", window.__capFork, {});'
      + ' var w = await window.executeTool("bash", "echo x > /usr/local/share/locus/capabilities/synthetic-capability/capability.json", window.__capFork, {});'
      + ' return { read: r.success && r.output.indexOf("\\"state\\": \\"ready\\"") !== -1, writeBlocked: !w.success && /read-only/i.test(w.output) }; })()', 60000);
    check('E15 capability introspection readable + read-only', e15.read && e15.writeBlocked, JSON.stringify(e15));

    await evaluate(cdp, 'window.__locus.store.settingsOpen = false; "closed"');
  } catch (e) {
    console.error(e && e.stack || e);
    failed++;
  } finally {
    const cleanupChrome = await closeChrome(chrome);
    if (!cleanupChrome.exited) console.error('capabilities Chrome did not exit after bounded cleanup');
    const cleanupPreview = await closeManagedProcess(preview);
    if (!cleanupPreview.exited) console.error('Vite preview did not exit after bounded cleanup');
    assetServer.close();
  }

  console.log('===');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' capability e2e checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
