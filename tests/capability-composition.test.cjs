// Capability Composition Runtime v1 unit tests (node):
// descriptor validators, registry load-time validation, CapabilityManager
// lifecycle (enable/disable/states), TaskEnvironment immutability,
// shared-component dedupe/reference semantics, MCP requirement states,
// system-prompt capability index (lazy skills — bodies NEVER in prompt),
// task VFS mounts (read-only skills/plugins/capabilities), the python
// extension payload/key seam and the worker's pre-READY plugin install.
// Run: node tests/capability-composition.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---- module under test (workspace.js + vfs.js are its base classes) ----
const extSrc = ['src/workspace.js', 'src/vfs.js', 'src/extensions.js']
  .map((f) => read(f)).join('\n;\n');
const M = eval(extSrc + '\n;({ CapabilityManager, StaticFileWorkspace, validatePluginDescriptor,'
  + ' validateSkillDescriptor, validateCapabilityDescriptor, validateCatalogSet, registerPluginRuntimeProvider,'
  + ' unregisterPluginRuntimeProvider, pluginRuntimeProvider, CAPABILITY_CATALOG, PLUGIN_CATALOG,'
  + ' SKILL_CATALOG, MCP_CATALOG, CAPABILITY_STATES, MCP_STATES });');

// agent.js for prompt tests (tools.js supplies the tool registry global)
const A = eval(read('src/tools.js') + '\n' + read('src/agent.js')
  + '\n;({ buildSystemPrompt, AgentSession, AGENT_TOOL_DEFINITIONS });');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
async function throwsWith(name, fn, namePart, msgPart) {
  try {
    await fn();
    check(name, false, 'expected throw');
  } catch (e) {
    const ok = (!namePart || e.name === namePart || String(e.message).includes(namePart))
      && (!msgPart || String(e.message).includes(msgPart));
    check(name, ok, e.name + ': ' + e.message);
  }
}

// ---- synthetic TEST-ONLY catalog (never part of production) ----
const SYNTH_SKILL_BODY = [
  '# Synthetic skill (TEST ONLY)',
  '',
  'Marker: SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91',
  '',
  'Use the Python package `locus_test_plugin` for this capability.',
].join('\n');

const SYNTH_CATALOGS = () => ({
  plugins: [
    {
      id: 'synthetic-python-plugin', version: '1', displayName: 'Synthetic Python Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: ['locus_test_plugin'] },
    },
    {
      id: 'shared-plugin', version: '2', displayName: 'Shared Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: [] },
    },
  ],
  skills: [
    {
      id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill',
      description: 'How to use the synthetic capability.',
      path: '/usr/local/share/locus/skills/synthetic-skill/SKILL.md',
      body: SYNTH_SKILL_BODY,
    },
    {
      id: 'shared-skill', version: '1',
      description: 'Shared guidance.',
      path: '/usr/local/share/locus/skills/shared-skill/SKILL.md',
      body: '# shared\n',
    },
  ],
  mcps: [
    { id: 'synthetic-service', displayName: 'Synthetic Service', description: 'TEST ONLY authority' },
  ],
  capabilities: [
    {
      id: 'synthetic-capability', version: '1', displayName: 'Synthetic Capability',
      description: 'TEST ONLY composition proof.',
      plugins: ['synthetic-python-plugin'],
      skills: ['synthetic-skill'],
      mcps: [],
    },
    {
      id: 'cap-a', version: '1', displayName: 'Capability A',
      description: 'Shares plugin X with B.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    {
      id: 'cap-b', version: '1', displayName: 'Capability B',
      description: 'Also shares plugin X.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    {
      id: 'synthetic-mcp-capability', version: '1', displayName: 'Synthetic MCP Capability',
      description: 'Requires an external authority.',
      plugins: [], skills: ['synthetic-skill'], mcps: ['synthetic-service'],
    },
  ],
});

function synthProvider() {
  return {
    runtime: 'python',
    async prepare(plugin) {
      if (plugin.id === 'synthetic-python-plugin') {
        return {
          files: { 'locus_test_plugin.py': 'def answer():\n    return 42\n' },
          imports: ['locus_test_plugin'],
        };
      }
      return { files: { ['shared_' + plugin.id.replace(/[^a-z0-9]/g, '_') + '.py']: 'x = 1\n' }, imports: [] };
    },
  };
}

function newManager(catalogs) {
  return new M.CapabilityManager({ catalogs: catalogs || SYNTH_CATALOGS() });
}

async function run() {
  // ================= production catalogs =================
  check('P1 production capability catalog is empty', M.CAPABILITY_CATALOG.length === 0);
  check('P2 production plugin catalog is empty', M.PLUGIN_CATALOG.length === 0);
  check('P3 production skill catalog is empty', M.SKILL_CATALOG.length === 0);
  check('P4 production mcp catalog is empty', M.MCP_CATALOG.length === 0);
  check('P5 production catalogs are frozen', Object.isFrozen(M.CAPABILITY_CATALOG) && Object.isFrozen(M.PLUGIN_CATALOG));
  const prod = newManager({});
  check('P6 empty production manager lists nothing', prod.listCapabilities().length === 0);
  check('P7 empty environment has no python key', prod.buildTaskEnvironment().pythonExtensionKey === null);
  check('P8 empty environment mounts nothing', prod.taskVfsMounts(prod.buildTaskEnvironment()).length === 0);
  check('P9 state vocabularies', M.CAPABILITY_STATES.join(',') === 'disabled,needs-connection,ready,error'
    && M.MCP_STATES.join(',') === 'connected,needs-connection,unavailable');

  // ================= descriptor validation =================
  await throwsWith('V1 plugin authority other than none is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'network', provides: { pythonImports: [] } }),
    'authority');
  await throwsWith('V2 plugin authority undefined is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python' }),
    'authority');
  await throwsWith('V3 unsupported plugin runtime is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'java', authority: 'none' }),
    'runtime');
  await throwsWith('V4 python plugin without pythonImports is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none' }),
    'pythonImports');
  await throwsWith('V5 plugin with non-array provides entry is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: 'x' } }),
    'provides');
  await throwsWith('V6 plugin with bad module name is rejected',
    () => M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: ['bad name'] } }),
    'module name');
  check('V7 valid plugin descriptor normalizes', (() => {
    const p = M.validatePluginDescriptor({ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: ['m'] } });
    return p.authority === 'none' && p.runtime === 'python' && p.displayName === 'p';
  })());
  await throwsWith('V8 skill path outside the skills root is rejected',
    () => M.validateSkillDescriptor({ id: 's', version: '1', description: 'd', path: '/mnt/workspace/s/SKILL.md', body: 'b' }),
    'path must be exactly');
  await throwsWith('V9 skill path traversal is rejected',
    () => M.validateSkillDescriptor({ id: 's', version: '1', description: 'd', path: '/usr/local/share/locus/skills/../s/SKILL.md', body: 'b' }),
    'path must be exactly');
  await throwsWith('V10 skill path not SKILL.md is rejected',
    () => M.validateSkillDescriptor({ id: 's', version: '1', description: 'd', path: '/usr/local/share/locus/skills/s/other.md', body: 'b' }),
    'path must be exactly');
  await throwsWith('V11 skill without body is rejected',
    () => M.validateSkillDescriptor({ id: 's', version: '1', description: 'd', path: '/usr/local/share/locus/skills/s/SKILL.md' }),
    'body');
  check('V12 valid skill descriptor keeps path + body', (() => {
    const s = M.validateSkillDescriptor({
      id: 's', version: '1', description: 'd',
      path: '/usr/local/share/locus/skills/s/SKILL.md', body: 'hello',
    });
    return s.path === '/usr/local/share/locus/skills/s/SKILL.md' && s.body === 'hello';
  })());
  await throwsWith('V13 capability referencing unknown plugin fails catalog load',
    () => M.validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd', plugins: ['nope'] }] }),
    'unknown plugin');
  await throwsWith('V14 capability referencing unknown skill fails catalog load',
    () => M.validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd', skills: ['nope'] }] }),
    'unknown skill');
  await throwsWith('V15 duplicate plugin id fails catalog load',
    () => M.validateCatalogSet({ plugins: [{ id: 'p', version: '1', runtime: 'python', authority: 'none', provides: { pythonImports: [] } }, { id: 'p', version: '2', runtime: 'python', authority: 'none', provides: { pythonImports: [] } }] }),
    'duplicate plugin id');
  await throwsWith('V16 duplicate capability id fails catalog load',
    () => M.validateCatalogSet({ capabilities: [{ id: 'c', version: '1', displayName: 'C', description: 'd' }, { id: 'c', version: '2', displayName: 'C2', description: 'd' }] }),
    'duplicate capability id');
  await throwsWith('V17 invalid mcp ref id fails capability validation',
    () => M.validateCapabilityDescriptor({ id: 'c', version: '1', displayName: 'C', description: 'd', mcps: ['../evil'] }),
    'valid ids');
  check('V18 duplicate component refs normalize/dedupe', (() => {
    const c = M.validateCapabilityDescriptor({
      id: 'c', version: '1', displayName: 'C', description: 'd',
      plugins: ['p', 'p'], skills: ['s', 's', 's'],
    });
    return c.plugins.length === 1 && c.skills.length === 1;
  })());
  await throwsWith('V19 missing version fails validation',
    () => M.validateCapabilityDescriptor({ id: 'c', displayName: 'C', description: 'd' }),
    'version');

  // ================= manager lifecycle =================
  // NOTE: the "no provider" case runs BEFORE any provider registration.
  const bare = newManager();
  const bareState = await bare.enable('synthetic-capability');
  check('M1 python plugin without runtime provider -> capability state error', bareState === 'error', bareState);
  check('M2 error capability names the missing provider', /no runtime provider registered for "python"/.test(bare.listCapabilities().find((c) => c.id === 'synthetic-capability').error || ''));
  const bareEnv = bare.buildTaskEnvironment();
  const bareCap = bareEnv.capabilities.find((c) => c.id === 'synthetic-capability');
  check('M3 error capability contributes no components to the environment',
    bareCap && bareCap.state === 'error' && bareCap.pluginIds.length === 0 && bareCap.skillIds.length === 0
    && bareEnv.plugins.length === 0 && bareEnv.skills.length === 0);

  M.registerPluginRuntimeProvider('python', synthProvider());
  const m4 = newManager();
  check('M4 provider (re-)registration enables resolution', await m4.enable('synthetic-capability') === 'ready');

  const mgr = newManager();
  const list0 = mgr.listCapabilities();
  check('M5 all catalog capabilities start disabled', list0.length === 4 && list0.every((c) => c.state === 'disabled' && !c.enabled));
  check('M6 includes counts come from the descriptor refs', (() => {
    const c = list0.find((x) => x.id === 'synthetic-capability');
    return c.includes.plugins === 1 && c.includes.skills === 1 && c.includes.mcps === 0;
  })());

  const st = await mgr.enable('synthetic-capability');
  check('M7 enable resolves local components -> ready', st === 'ready', st);
  check('M8 enable of unknown id throws', await (async () => {
    try { await mgr.enable('nope'); return false; } catch (e) { return /unknown capability/.test(e.message); }
  })());

  const env = mgr.buildTaskEnvironment();
  check('M9 environment carries the capability (ready)', env.capabilities.length === 1 && env.capabilities[0].state === 'ready');
  check('M10 environment carries the plugin descriptor (authority none)',
    env.plugins.length === 1 && env.plugins[0].id === 'synthetic-python-plugin' && env.plugins[0].authority === 'none');
  check('M11 environment carries the prepared payload',
    env.plugins[0].payload.files['locus_test_plugin.py'].includes('return 42')
    && env.plugins[0].payload.imports.join() === 'locus_test_plugin');
  check('M12 environment carries the skill with path + body',
    env.skills.length === 1 && env.skills[0].path === '/usr/local/share/locus/skills/synthetic-skill/SKILL.md'
    && env.skills[0].body === SYNTH_SKILL_BODY);
  check('M13 environment carries the skill path per capability', env.capabilities[0].skillPaths.join() === env.skills[0].path);
  check('M14 pythonExtensionKey identifies the payload set', env.pythonExtensionKey === 'synthetic-python-plugin@1');

  // ---- frozen TaskEnvironment ----
  const envFrozen = Object.isFrozen(env) && Object.isFrozen(env.capabilities) && Object.isFrozen(env.plugins)
    && Object.isFrozen(env.skills) && Object.isFrozen(env.mcps) && Object.isFrozen(env.capabilities[0])
    && Object.isFrozen(env.plugins[0]) && Object.isFrozen(env.plugins[0].payload)
    && Object.isFrozen(env.plugins[0].payload.files);
  check('M15 TaskEnvironment is deeply frozen', envFrozen);
  const mutationOK = await (async () => {
    'use strict';
    try {
      const e = mgr.buildTaskEnvironment();
      e.capabilities.push({ id: 'intruder' });
      e.plugins[0].authority = 'network';
      return false;
    } catch (e) {
      return e instanceof TypeError;
    }
  })();
  check('M16 mutating a frozen environment throws (strict mode)', mutationOK);
  const env2 = mgr.buildTaskEnvironment();
  check('M17 after mutation attempt a fresh build is unchanged',
    env2.capabilities.length === 1 && env2.plugins[0].authority === 'none');

  // ---- dedupe / reference semantics (C1/C2/C3) ----
  await mgr.enable('cap-a');
  await mgr.enable('cap-b');
  const dedupe = mgr.buildTaskEnvironment();
  check('M18 C1: shared plugin resolves once across capabilities',
    dedupe.plugins.length === 2 && dedupe.plugins.filter((p) => p.id === 'shared-plugin').length === 1, JSON.stringify(dedupe.plugins.map((p) => p.id)));
  check('M19 C1: shared skill resolves once across capabilities',
    dedupe.skills.filter((s) => s.id === 'shared-skill').length === 1);
  mgr.disable('cap-a');
  const afterA = mgr.buildTaskEnvironment();
  check('M20 C2: disabling A keeps the shared plugin while B needs it',
    !afterA.capabilities.some((c) => c.id === 'cap-a') && afterA.capabilities.some((c) => c.id === 'cap-b')
    && afterA.plugins.some((p) => p.id === 'shared-plugin')
    && afterA.skills.some((s) => s.id === 'shared-skill'));
  mgr.disable('cap-b');
  const afterB = mgr.buildTaskEnvironment();
  check('M21 C3: disabling B removes the shared components',
    afterB.capabilities.length === 1 && afterB.capabilities[0].id === 'synthetic-capability'
    && afterB.plugins.length === 1 && afterB.plugins[0].id === 'synthetic-python-plugin');
  check('M22 disable of unknown id throws', (() => {
    try { mgr.disable('nope'); return false; } catch (e) { return /unknown capability/.test(e.message); }
  })());
  check('M23 disable is idempotent for disabled ids', (mgr.disable('cap-a'), mgr.disable('cap-a'), true));
  const synthetic = mgr.buildTaskEnvironment();
  check('M24 old snapshot (cap-a+cap-b era) was never mutated by disables',
    synthetic.capabilities.length === 1 && synthetic.capabilities[0].id === 'synthetic-capability');

  // ---- MCP requirement semantics ----
  const mmgr = newManager();
  await mmgr.enable('synthetic-mcp-capability');
  check('M25 unconnected MCP requirement -> needs-connection (never ready)',
    mmgr.capabilityState('synthetic-mcp-capability') === 'needs-connection');
  const mEnv1 = mmgr.buildTaskEnvironment();
  check('M26 environment carries the requirement state',
    mEnv1.mcps.length === 1 && mEnv1.mcps[0].id === 'synthetic-service' && mEnv1.mcps[0].state === 'needs-connection');
  check('M27 needs-connection snapshot is frozen too', Object.isFrozen(mEnv1.mcps[0]));
  mmgr.setMcpState('synthetic-service', 'connected');
  check('M28 explicit connection flips the manager state to ready',
    mmgr.capabilityState('synthetic-mcp-capability') === 'ready');
  const mEnv2 = mmgr.buildTaskEnvironment();
  check('M29 connected status appears only in the NEXT snapshot',
    mEnv2.mcps[0].state === 'connected' && mEnv1.mcps[0].state === 'needs-connection');
  await throwsWith('M30 invalid MCP state is rejected', () => mmgr.setMcpState('synthetic-service', 'authorized'), 'invalid MCP state');
  const umgr = newManager();
  await umgr.enable('synthetic-mcp-capability');
  umgr.setMcpState('synthetic-service', 'unavailable');
  check('M31 unavailable authority also keeps needs-connection', umgr.capabilityState('synthetic-mcp-capability') === 'needs-connection');

  // ---- catalog replacement (test/e2e injection path) ----
  const rmgr = newManager();
  await rmgr.enable('synthetic-capability');
  rmgr.replaceCatalogs({ capabilities: [] });
  check('M32 replaceCatalogs resets enabled-state', rmgr.listCapabilities().length === 0 && rmgr.buildTaskEnvironment().capabilities.length === 0);
  await throwsWith('M33 broken replacement catalog fails loudly and keeps state', async () => {
    try {
      rmgr.replaceCatalogs({ capabilities: [{ id: 'x', version: '1', displayName: 'X', description: 'd', plugins: ['ghost'] }] });
    } finally {
      if (rmgr.listCapabilities().length !== 0) throw new Error('state was mutated by a failed replace');
    }
  }, 'unknown plugin');

  // ================= system prompt =================
  const readyMgr = newManager();
  await readyMgr.enable('synthetic-capability');
  const readyEnv = readyMgr.buildTaskEnvironment();
  const pMgr = newManager();
  await pMgr.enable('synthetic-capability');
  await pMgr.enable('synthetic-mcp-capability');
  const pEnv = pMgr.buildTaskEnvironment();
  const promptReady = A.buildSystemPrompt({ workspace: null, taskEnvironment: readyEnv });
  check('S1 prompt contains the capability display name', promptReady.includes('Synthetic Capability'));
  check('S2 prompt contains the skill guide path', promptReady.includes('/usr/local/share/locus/skills/synthetic-skill/SKILL.md'));
  check('S3 prompt tells the model to read the guide on demand', /read a guide with cat only when/i.test(promptReady));
  check('S4 prompt does NOT contain the skill body marker', !promptReady.includes('SHOULD_ONLY_APPEAR_AFTER_SKILL_READ_7F91'));
  check('S5 prompt does NOT contain plugin ids', !promptReady.includes('synthetic-python-plugin'));
  check('S6 prompt does NOT contain internal APIs', !promptReady.includes('CapabilityManager') && !promptReady.includes('TaskEnvironment'));
  const promptMcp = A.buildSystemPrompt({ workspace: null, taskEnvironment: pEnv });
  check('S7 needs-connection capability is NOT claimed available', promptMcp.includes('NOT connected') || promptMcp.includes('are not connected'));
  const promptNone = A.buildSystemPrompt({ workspace: null });
  check('S8 no capabilities -> no extension section at all', !promptNone.includes('## Capabilities'));
  const promptEmpty = A.buildSystemPrompt({ workspace: null, taskEnvironment: prod.buildTaskEnvironment() });
  check('S9 empty environment -> no extension section', !promptEmpty.includes('## Capabilities'));
  // error-state capability stays out of the prompt (S11 below)
  const errMgr = newManager();
  M.unregisterPluginRuntimeProvider('python');
  await errMgr.enable('synthetic-capability');
  const errPrompt = A.buildSystemPrompt({ workspace: null, taskEnvironment: errMgr.buildTaskEnvironment() });
  check('S11 error-state capability adds no prompt section', !errPrompt.includes('## Capabilities'));
  M.registerPluginRuntimeProvider('python', synthProvider());

  // budget integration: the index is inside the counted system prompt
  const session = new A.AgentSession({
    modelClient: async () => ({ content: 'done', rawMessage: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', truncated: false }),
    toolExecutor: async () => ({ output: 'ok', success: true }),
  });
  const bytesWithout = session.historyRequestBytes(null, null);
  const bytesWith = session.historyRequestBytes(null, pEnv);
  check('S12 capability index counts into the request byte budget', bytesWith > bytesWithout && bytesWith - bytesWithout < 4096,
    String(bytesWith - bytesWithout));

  // ================= task VFS mounts =================
  const { VirtualWorkspace, MemoryWorkspace } = eval(extSrc + '\n;({ VirtualWorkspace, MemoryWorkspace })');
  const vEnv = readyEnv;
  const mounts = readyMgr.taskVfsMounts(vEnv);
  check('F1 three mounts for a full environment (skills/plugins/capabilities)', mounts.length === 3, String(mounts.length));
  check('F2 mount paths + system-read-only authority', mounts.every((m) => m.authority === 'system-read-only')
    && mounts.map((m) => m.path).sort().join() === '/mnt/plugins,/usr/local/share/locus/capabilities,/usr/local/share/locus/skills');

  const vfs = new VirtualWorkspace({ listCommands: () => [] });
  const fork = vfs.fork();
  for (const m of mounts) fork.mount(m.path, m.provider, m.authority);
  check('F3 skill body readable at the documented path',
    (await fork.read('/usr/local/share/locus/skills/synthetic-skill/SKILL.md')) === SYNTH_SKILL_BODY);
  check('F4 ls lists the skill directory', (() => fork.list('/usr/local/share/locus/skills').then((e) => e.length === 1 && e[0].name === 'synthetic-skill' && e[0].kind === 'directory')()));
  const st1 = await fork.stat('/usr/local/share/locus/skills/synthetic-skill/SKILL.md');
  check('F5 stat reports the byte size', st1.kind === 'file' && st1.size === Buffer.byteLength(SYNTH_SKILL_BODY, 'utf8'));
  const rb = await fork.readBytes('/usr/local/share/locus/skills/synthetic-skill/SKILL.md');
  check('F6 readBytes is byte-exact', rb.length === Buffer.byteLength(SYNTH_SKILL_BODY, 'utf8'));
  check('F7 plugin introspection json is safe metadata', (() => fork.read('/mnt/plugins/synthetic-python-plugin/plugin.json').then((t) => {
    const j = JSON.parse(t);
    return j.id === 'synthetic-python-plugin' && j.runtime === 'python' && j.authority === 'none'
      && JSON.stringify(j.provides) === JSON.stringify({ pythonImports: ['locus_test_plugin'] })
      && !t.includes('return 42');
  })()));
  check('F8 capability introspection json carries resolved state', (() => fork.read('/usr/local/share/locus/capabilities/synthetic-capability/capability.json').then((t) => {
    const j = JSON.parse(t);
    return j.id === 'synthetic-capability' && j.state === 'ready' && Array.isArray(j.skills) && j.skills[0].endsWith('/SKILL.md');
  })()));
  await throwsWith('F9 write into the skill mount is refused (provider layer)',
    () => fork.write('/usr/local/share/locus/skills/synthetic-skill/SKILL.md', 'overwrite'), 'ReadOnlyError');
  await throwsWith('F10 write into the plugin mount is refused (VFS authority layer)',
    () => fork.write('/mnt/plugins/synthetic-python-plugin/plugin.json', '{}'), 'ReadOnlyError');
  await throwsWith('F11 rm into the capability mount is refused',
    () => fork.remove('/usr/local/share/locus/capabilities/synthetic-capability/capability.json'), 'ReadOnlyError');
  await throwsWith('F12 mkdir into the skill mount is refused',
    () => fork.mkdir('/usr/local/share/locus/skills/intruder'), 'ReadOnlyError');
  await throwsWith('F13 a workspace file can never shadow a skill',
    () => fork.write('/usr/local/share/locus/skills/synthetic-skill/SKILL.md', 'injected'), 'ReadOnlyError');
  check('F14 skill mount authority is system-read-only',
    fork.authorityOf('/usr/local/share/locus/skills/synthetic-skill/SKILL.md') === 'system-read-only');
  check('F15 the live VFS stays untouched by task mounts',
    (await vfs.list('/usr/local/share/locus/skills')).length === 0
    && vfs.resolveMount('/mnt/plugins') === null);
  check('F16 without capabilities the fork gains no mounts', (() => {
    const v2 = new VirtualWorkspace({ listCommands: () => [] });
    const f2 = v2.fork();
    const before = f2.mounts.length;
    for (const m of newManager().taskVfsMounts(prod.buildTaskEnvironment())) f2.mount(m.path, m.provider, m.authority);
    return f2.mounts.length === before;
  })());
  check('F17 mount count follows the resolved set (skills-only env)', (async () => {
    const mOnly = new M.CapabilityManager({ catalogs: {
      skills: SYNTH_CATALOGS().skills,
      capabilities: [{ id: 's-only', version: '1', displayName: 'S', description: 'd', skills: ['synthetic-skill'] }],
    } });
    await mOnly.enable('s-only');
    return mOnly.taskVfsMounts(mOnly.buildTaskEnvironment()).length === 2; // skills + capabilities, no plugins
  })());
  check('F18 StaticFileWorkspace byte tree works standalone', (() => {
    const w = new M.StaticFileWorkspace({ files: { 'a/SKILL.md': 'x' } });
    return w.stat('a/SKILL.md').then((s) => s.size === 1);
  })());

  // ================= python extension payload/key =================
  const payload = newManager().pythonExtensionPayload(vEnv);
  check('K1 payload key matches the environment', payload.key === vEnv.pythonExtensionKey);
  check('K2 payload carries files + imports', payload.modules.length === 1
    && payload.modules[0].pluginId === 'synthetic-python-plugin'
    && payload.modules[0].files['locus_test_plugin.py'].includes('return 42')
    && payload.modules[0].imports.join() === 'locus_test_plugin');
  check('K3 payload is frozen', Object.isFrozen(payload) && Object.isFrozen(payload.modules) && Object.isFrozen(payload.modules[0]));
  check('K4 key is null without python plugins', prod.buildTaskEnvironment().pythonExtensionKey === null);
  check('K5 key changes with plugin version', (async () => {
    const c = SYNTH_CATALOGS();
    c.plugins[0].version = '2';
    const m = newManager(c);
    await m.enable('synthetic-capability');
    return m.buildTaskEnvironment().pythonExtensionKey === 'synthetic-python-plugin@2';
  })());

  // ================= worker plugin install (real worker source, VM) =================
  const html = read('index.html');
  const wm = html.match(/<script type="text\/worker" id="py-worker-src">([\s\S]*?)<\/script>/);
  check('W0 worker source present in index.html', !!wm);

  function bootWorker(extensionModules, loadPyodideImpl) {
    let recorded = null;
    const c = vm.createContext({
      self: { postMessage() {} },
      fetch: function () {},
      XMLHttpRequest: function () {},
      WebSocket: function () {},
      importScripts() {},
      loadPyodide: loadPyodideImpl || (async () => ({
        FS: {
          mkdirTree() {}, writeFile(path2, data) { recorded = recorded || []; recorded.push({ kind: 'write', path: path2, data }); },
          readFile() { return new Uint8Array(); }, readdir() { return []; },
          stat() { return { mode: 0, size: 0 }; }, unlink() {}, chmod() {}, isDir() { return false; },
        },
        runPython(code) {
          recorded = recorded || [];
          recorded.push({ kind: 'runPython', code });
          if (code.includes('sysconfig')) return '/lib/python3.12/site-packages';
          return undefined;
        },
        setStdout() {}, setStderr() {},
        loadPackage: async () => { recorded = recorded || []; recorded.push({ kind: 'loadPackage' }); },
      })),
    });
    vm.runInContext(wm[1], c);
    const boot = vm.runInContext('ensureLockedPyodide()', c);
    vm.runInContext(`self.onmessage({ data: ${JSON.stringify({
      id: 1, cmd: 'bootstrap',
      assets: {
        'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
        'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
      },
      extensionModules,
    })} })`, c);
    return { boot, recorded: () => recorded, ctx: c };
  }

  {
    const w = bootWorker([
      { pluginId: 'synthetic-python-plugin', files: { 'locus_test_plugin.py': 'def answer():\n    return 42\n' }, imports: ['locus_test_plugin'] },
    ]);
    let bootErr = null;
    try { await w.boot; } catch (e) { bootErr = e; }
    check('W1 boot with a plugin payload succeeds', !bootErr, bootErr && bootErr.message);
    const rec = w.recorded() || [];
    const writes = rec.filter((r) => r.kind === 'write');
    const imports = rec.filter((r) => r.kind === 'runPython' && r.code.startsWith('import '));
    check('W2 plugin file written into site-packages',
      writes.length === 1 && writes[0].path === '/lib/python3.12/site-packages/locus_test_plugin.py'
      && String(writes[0].data).includes('return 42'), JSON.stringify(writes));
    check('W3 smoke import ran for the declared module', imports.some((r) => r.code === 'import locus_test_plugin'), JSON.stringify(imports));
    check('W4 runtime package load precedes plugin install', (() => {
      const i = rec.findIndex((r) => r.kind === 'loadPackage');
      const j = rec.findIndex((r) => r.kind === 'write');
      return i !== -1 && j !== -1 && i < j;
    })());
    check('W5 post-boot lockdown applied (worker fetch denied)', vm.runInContext(
      "(function () { try { fetch('http://127.0.0.1:9/probe'); return 'allowed'; } catch (e) { return 'denied'; } })()", w.ctx) === 'denied');
  }
  {
    const w = bootWorker([
      { pluginId: 'bad', files: { '../evil.py': 'x' }, imports: [] },
    ]);
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    check('W7 invalid payload path fails the boot closed', !!err && /invalid payload path/.test(err.message), err && err.message);
  }
  {
    const w = bootWorker([
      { pluginId: 'broken', files: { 'mod.py': 'raise ImportError("nope")\n' }, imports: ['mod'] },
    ], async () => ({
      FS: { mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); }, readdir() { return []; }, stat() { return { mode: 0, size: 0 }; }, unlink() {}, chmod() {}, isDir() { return false; } },
      runPython(code) {
        if (code.includes('sysconfig')) return '/lib/python3.12/site-packages';
        throw new Error('ModuleNotFoundError: no module named mod');
      },
      setStdout() {}, setStderr() {}, loadPackage: async () => {},
    }));
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    check('W8 failed smoke import fails the boot closed', !!err && /smoke import failed/.test(err.message) && /plugin broken/.test(err.message), err && err.message);
  }
  {
    const w = bootWorker(undefined);
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    const rec = w.recorded() || [];
    check('W9 no extensionModules -> core-only boot unchanged (no FS writes)',
      !err && rec.filter((r) => r.kind === 'write').length === 0, err && err.message);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
