// Capability Package Core v1 unit tests (node):
// project validation (strict source schema, graph, paths, bounds),
// deterministic bundle build (builder-computed size/SHA-256, lock),
// CapabilityBundle byte isolation, safe inspect, canonical lock
// serialization, and a REAL synthetic pure-Python wheel fixture
// (zip layout + dist-info + RECORD integrity verified from bytes).
// The fixture project lives at
// tests/fixtures/capability-package/minimal (TEST ONLY, never a
// production catalog).
// Run: node tests/capability-package.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---- module under test (workspace.js + vfs.js + extensions.js are base) ----
const src = ['src/workspace.js', 'src/vfs.js', 'src/extensions.js', 'src/capability-package.js']
  .map((f) => read(f)).join('\n;\n');
const M = eval(src + '\n;({ LocusCapabilityPackage: globalThis.LocusCapabilityPackage,'
  + ' MemoryWorkspace, WorkspaceAdapter });');
const LCP = M.LocusCapabilityPackage;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capability-package', 'minimal');
const WHEEL_REL = 'plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl';
const SKILL_REL = 'skills/test-workflow/SKILL.md';
const WHEEL_LOGICAL = 'plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl';
const SKILL_LOGICAL = 'skills/test-workflow/SKILL.md';

function sha256HexNode(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ---- fixture loading (real files -> MemoryWorkspace) ----
function walkFixture(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFixture(full, r, out);
    else out.set(r, new Uint8Array(fs.readFileSync(full)));
  }
  return out;
}

const FIXTURE_FILES = walkFixture(FIXTURE_DIR, '', new Map());

// Generous provider caps: package-layer bounds are tested explicitly
// below and must not collide with MemoryWorkspace defaults (16 MiB).
async function makeWorkspace(files, opts) {
  const ws = new M.MemoryWorkspace({
    maxFileBytes: 512 * 1024 * 1024,
    maxBytes: 1024 * 1024 * 1024,
    ...(opts || {}),
  });
  for (const [rel, data] of files) await ws.write(rel, data);
  return ws;
}

function fixtureWorkspace() { return makeWorkspace(FIXTURE_FILES); }

// A provider whose list() order is deliberately different (reversed):
// validation/build results must never depend on provider list order.
class ReversedWorkspace extends M.MemoryWorkspace {
  async list(p) { return (await super.list(p)).slice().reverse(); }
}
async function makeReversedWorkspace(files) {
  const ws = new ReversedWorkspace({ maxFileBytes: 512 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024 });
  for (const [rel, data] of files) await ws.write(rel, data);
  return ws;
}

// Zero-write proof: full provider fingerprint (files+bytes+dirs).
function workspaceFingerprint(ws) {
  const files = [...ws.files.keys()].sort().map((rel) => {
    const b = ws.files.get(rel);
    return rel + ':' + b.byteLength + ':' + sha256HexNode(b);
  });
  return JSON.stringify({ dirs: [...ws.dirs].sort(), files: files });
}

function diagOf(result, code, pathPart) {
  return (result.diagnostics || []).find((d) => d.code === code
    && (!pathPart || d.path.includes(pathPart)));
}

function jsonDiag(result) {
  return JSON.stringify((result.diagnostics || []).map((d) => [d.path, d.code, d.message]));
}

// Manifest patch helper: read -> transform -> write back as JSON/LF.
async function patchManifest(ws, rel, transform) {
  const parsed = JSON.parse(await ws.read(rel));
  transform(parsed);
  await ws.write(rel, JSON.stringify(parsed, null, 2) + '\n');
}

(async () => {
  // ===================== P1 valid project validate =====================
  const ws1 = await fixtureWorkspace();
  const v1 = await LCP.validateProject({ workspace: ws1, root: '' });
  check('P1 valid project validates with empty diagnostics', v1.ok === true
    && Array.isArray(v1.diagnostics) && v1.diagnostics.length === 0
    && !!v1.normalized, jsonDiag(v1));
  check('P1b normalized capability is the runtime-normalized descriptor',
    v1.normalized.capability.id === 'package-test-capability'
    && v1.normalized.capability.kind === 'capability'
    && JSON.stringify(v1.normalized.capability.plugins) === '["locus-test-plugin"]'
    && JSON.stringify(v1.normalized.capability.skills) === '["test-workflow"]'
    && JSON.stringify(v1.normalized.capability.mcps) === '[]');
  check('P1c source plan is deterministic and root-contained',
    JSON.stringify(v1.normalized.sourcePlan.map((e) => e.logicalPath))
      === JSON.stringify([WHEEL_LOGICAL, SKILL_LOGICAL])
    && v1.normalized.sourcePlan.every((e) => !e.providerPath.startsWith('/')));

  // ===================== P2 build success =====================
  const b2 = await LCP.buildProject({ workspace: ws1, root: '' });
  check('P2 build succeeds and yields a bundle', b2.ok === true
    && b2.diagnostics.length === 0
    && b2.bundle instanceof LCP.CapabilityBundle, jsonDiag(b2));
  check('P2b bundle carries exactly the planned runtime files',
    JSON.stringify(b2.bundle.listFiles()) === JSON.stringify([WHEEL_LOGICAL, SKILL_LOGICAL]));

  // ===================== P3 inspect success =====================
  const insp3 = LCP.inspectBundle(b2.bundle);
  const insp3Str = JSON.stringify(insp3);
  const wheelDisk = FIXTURE_FILES.get(WHEEL_REL);
  const skillDisk = FIXTURE_FILES.get(SKILL_REL);
  check('P3 inspect reports capability identity', insp3.valid === true
    && insp3.capability.id === 'package-test-capability'
    && insp3.capability.version === '1'
    && insp3.capability.displayName === 'Package Test Capability'
    && typeof insp3.capability.description === 'string');
  check('P3b inspect reports plugin with imports and artifact integrity',
    insp3.plugins.length === 1
    && insp3.plugins[0].id === 'locus-test-plugin'
    && insp3.plugins[0].version === '1.0.0'
    && insp3.plugins[0].runtime === 'python'
    && JSON.stringify(insp3.plugins[0].pythonImports) === '["locus_test_plugin"]'
    && insp3.plugins[0].artifacts.length === 1
    && insp3.plugins[0].artifacts[0].path === WHEEL_LOGICAL
    && insp3.plugins[0].artifacts[0].format === 'python-wheel'
    && insp3.plugins[0].artifacts[0].size === wheelDisk.byteLength
    && insp3.plugins[0].artifacts[0].sha256 === sha256HexNode(wheelDisk));
  check('P3c inspect reports skill integrity and MCP requirements',
    insp3.skills.length === 1
    && insp3.skills[0].id === 'test-workflow'
    && insp3.skills[0].sourcePath === SKILL_LOGICAL
    && insp3.skills[0].size === skillDisk.byteLength
    && insp3.skills[0].sha256 === sha256HexNode(skillDisk)
    && Array.isArray(insp3.mcps) && insp3.mcps.length === 0
    && insp3.totalBytes === wheelDisk.byteLength + skillDisk.byteLength);
  check('P3d inspect never leaks skill bodies or raw bytes',
    !insp3Str.includes('Import the plugin module')
    && !insp3Str.includes('PK\\u0003\\u0004')
    && typeof insp3Str === 'string');

  // ===================== P4 repeated build deterministic lock =====================
  const lock4a = b2.bundle.serializeLock();
  const b4 = await LCP.buildProject({ workspace: ws1, root: '' });
  check('P4 repeated build serializes byte-identical locks',
    b4.ok && lock4a === b4.bundle.serializeLock());

  // ===================== P5 provider list order independence =====================
  const ws5 = await makeReversedWorkspace(FIXTURE_FILES);
  const b5 = await LCP.buildProject({ workspace: ws5, root: '' });
  check('P5 shuffled provider list order yields identical lock bytes',
    b5.ok && b5.bundle.serializeLock() === lock4a, jsonDiag(b5));

  // ===================== P6 artifact exact size/hash =====================
  const wheel6 = b2.bundle.readBytes(WHEEL_LOGICAL);
  check('P6 artifact bytes are exact (size + SHA-256 over exact bytes)',
    wheel6.byteLength === wheelDisk.byteLength
    && Buffer.compare(Buffer.from(wheel6), Buffer.from(wheelDisk)) === 0
    && b2.bundle.lock.plugins[0].artifacts[0].sha256 === sha256HexNode(wheelDisk)
    && b2.bundle.lock.plugins[0].artifacts[0].size === wheelDisk.byteLength);

  // ===================== P7 skill exact UTF-8 size/hash =====================
  const skill7 = b2.bundle.readBytes(SKILL_LOGICAL);
  check('P7 skill bytes are exact UTF-8 (size + SHA-256 over exact bytes)',
    skill7.byteLength === skillDisk.byteLength
    && Buffer.compare(Buffer.from(skill7), Buffer.from(skillDisk)) === 0
    && b2.bundle.lock.skills[0].sha256 === sha256HexNode(skillDisk)
    && b2.bundle.lock.skills[0].size === skillDisk.byteLength);

  // ===================== P8 readBytes mutation isolation =====================
  const copy8 = b2.bundle.readBytes(SKILL_LOGICAL);
  const before8 = b2.bundle.readBytes(SKILL_LOGICAL);
  copy8[0] = 0x21; // '!'

  copy8[1] = 0x21;
  const after8 = b2.bundle.readBytes(SKILL_LOGICAL);
  check('P8 mutating a readBytes copy cannot alter bundle bytes',
    before8[0] === after8[0] && before8[1] === after8[1]
    && Buffer.compare(Buffer.from(before8), Buffer.from(after8)) === 0);

  // ---- adversarial helpers: patch the fixture workspace ----
  async function patchedWs(mutator) {
    const ws = await fixtureWorkspace();
    await mutator(ws);
    return ws;
  }

  // ===================== P9 malformed JSON =====================
  {
    const ws = await patchedWs((w) => w.write('plugins/locus-test-plugin/plugin.json', '{ not json'));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    const d = diagOf(v, 'package_json_invalid', 'plugins/locus-test-plugin/plugin.json');
    check('P9 malformed manifest JSON yields a structured diagnostic',
      v.ok === false && !!d && d.severity === 'error' && !!d.message, jsonDiag(v));
  }

  // ===================== P10 unsupported schemaVersion =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.schemaVersion = 2; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P10 unsupported source schemaVersion is rejected',
      v.ok === false && !!diagOf(v, 'package_schema_version', 'capability.json'), jsonDiag(v));
  }

  // ===================== P11 unknown top-level field =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.note = 'extra'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P11 unknown top-level manifest field fails validation',
      v.ok === false && !!diagOf(v, 'package_field_unknown', 'capability.json'), jsonDiag(v));
  }

  // ===================== P12 unknown nested descriptor field =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.capability.authors = ['x']; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P12 unknown nested descriptor field fails validation',
      v.ok === false && !!diagOf(v, 'package_field_unknown', 'capability.json'), jsonDiag(v));
  }

  // ===================== P13 invalid id =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'skills/test-workflow/skill.json', (j) => { j.skill.id = 'Test Workflow'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    const d = diagOf(v, 'package_descriptor_invalid', 'skills/test-workflow/skill.json');
    check('P13 invalid component id is rejected by the runtime validator contract',
      v.ok === false && !!d && /id must match/.test(d.message), jsonDiag(v));
  }

  // ===================== P14 directory/id mismatch =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json', (j) => { j.plugin.id = 'other-plugin'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P14 directory/id mismatch is rejected',
      v.ok === false && !!diagOf(v, 'package_id_mismatch', 'plugins/locus-test-plugin/plugin.json'),
      jsonDiag(v));
  }

  // ===================== P15/P16/P17 missing references =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.capability.plugins = ['locus-test-plugin', 'ghost-plugin']; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P15 missing plugin reference is rejected',
      v.ok === false && !!diagOf(v, 'package_ref_missing', 'capability.json'), jsonDiag(v));
  }
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.capability.skills = ['ghost-skill']; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P16 missing skill reference is rejected',
      v.ok === false && !!diagOf(v, 'package_ref_missing', 'capability.json'), jsonDiag(v));
  }
  {
    const ws = await patchedWs((w) => patchManifest(w, 'capability.json', (j) => { j.capability.mcps = ['ghost-service']; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P17 missing local MCP metadata for a referenced requirement is rejected',
      v.ok === false && !!diagOf(v, 'package_ref_missing', 'capability.json')
      && /mcp/.test(diagOf(v, 'package_ref_missing', 'capability.json').message), jsonDiag(v));
  }

  // ===================== P18/P19/P20 unreferenced components =====================
  const EXTRA_PLUGIN = {
    schemaVersion: 1,
    plugin: {
      id: 'extra-plugin', version: '1', displayName: 'Extra', description: 'x',
      runtime: 'python', authority: 'none', provides: { pythonImports: ['extra_plugin'] },
    },
    artifacts: [{ path: 'artifacts/extra_plugin-1-py3-none-any.whl', format: 'python-wheel' }],
  };
  const EXTRA_SKILL = {
    schemaVersion: 1,
    skill: { id: 'extra-skill', version: '1', displayName: 'Extra', description: 'x' },
    source: 'SKILL.md',
  };
  const EXTRA_MCP = {
    schemaVersion: 1,
    mcp: { id: 'extra-service', displayName: 'Extra', description: 'x' },
  };
  {
    const ws = await patchedWs(async (w) => {
      await w.write('plugins/extra-plugin/plugin.json', JSON.stringify(EXTRA_PLUGIN, null, 2) + '\n');
      await w.write('plugins/extra-plugin/artifacts/extra_plugin-1-py3-none-any.whl',
        FIXTURE_FILES.get(WHEEL_REL));
    });
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P18 unreferenced plugin is rejected',
      v.ok === false && !!diagOf(v, 'package_component_unreferenced', 'plugins/extra-plugin'),
      jsonDiag(v));
  }
  {
    const ws = await patchedWs(async (w) => {
      await w.write('skills/extra-skill/skill.json', JSON.stringify(EXTRA_SKILL, null, 2) + '\n');
      await w.write('skills/extra-skill/SKILL.md', '# extra\n');
    });
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P19 unreferenced skill is rejected',
      v.ok === false && !!diagOf(v, 'package_component_unreferenced', 'skills/extra-skill'),
      jsonDiag(v));
  }
  {
    const ws = await patchedWs(async (w) => {
      await w.write('mcp/extra-service/mcp.json', JSON.stringify(EXTRA_MCP, null, 2) + '\n');
    });
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P20 unreferenced mcp is rejected',
      v.ok === false && !!diagOf(v, 'package_component_unreferenced', 'mcp/extra-service'),
      jsonDiag(v));
  }

  // ===================== P21-P23 artifact path rules =====================
  for (const [idx, badPath] of [
    ['P21', 'artifacts/../../evil.whl'],
    ['P22', '/etc/locus/evil.whl'],
    ['P23', 'artifacts\\evil.whl'],
  ].entries()) {
    const label = badPath[0];
    const value = badPath[1];
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.artifacts[0].path = value; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check(label + ' hostile artifact path is rejected loudly (' + value + ')',
      v.ok === false && !!diagOf(v, 'package_path_invalid', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }

  // ===================== P24 source-supplied sha256/size reject =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.artifacts[0].sha256 = 'aa'.repeat(32); j.artifacts[0].size = 1; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P24 source manifests cannot supply sha256/size (build output only)',
      v.ok === false && !!diagOf(v, 'package_field_unknown', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }

  // ===================== P25 authority != none =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.plugin.authority = 'network'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    const d = diagOf(v, 'package_descriptor_invalid', 'plugins/locus-test-plugin');
    check('P25 plugin authority other than none is rejected',
      v.ok === false && !!d && /authority/.test(d.message), jsonDiag(v));
  }

  // ===================== P26 non-python package runtime =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.plugin.runtime = 'javascript'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P26 non-python package runtime is rejected in package v1',
      v.ok === false && !!diagOf(v, 'package_runtime_unsupported', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }

  // ===================== P27 artifact missing =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.artifacts[0].path = 'artifacts/missing-1.0.0-py3-none-any.whl'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P27 missing artifact file is rejected',
      v.ok === false && !!diagOf(v, 'package_artifact_missing', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }

  // ===================== P28 artifact over cap =====================
  {
    const overCap = new Uint8Array(LCP.PACKAGE_CONSTANTS.ARTIFACT_MAX_BYTES + 1);
    overCap[0] = 0x50; overCap[1] = 0x4b; // zip magic, content irrelevant to the bound
    const ws = await makeWorkspace(new Map([
      ['capability.json', FIXTURE_FILES.get('capability.json')],
      ['plugins/locus-test-plugin/plugin.json', FIXTURE_FILES.get('plugins/locus-test-plugin/plugin.json')],
      [WHEEL_REL, overCap],
      ['skills/test-workflow/skill.json', FIXTURE_FILES.get('skills/test-workflow/skill.json')],
      [SKILL_REL, FIXTURE_FILES.get(SKILL_REL)],
    ]));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    const b = await LCP.buildProject({ workspace: ws, root: '' });
    check('P28 artifact over the 64 MiB cap is rejected before full materialization',
      v.ok === false && !!diagOf(v, 'package_artifact_too_large')
      && b.ok === false && !!diagOf(b, 'package_artifact_too_large')
      && ws.files.get(WHEEL_REL).byteLength === overCap.byteLength, jsonDiag(b));
  }

  // ===================== P29 package total over cap =====================
  {
    const bigWheel = new Uint8Array(50 * 1024 * 1024); // under the 64 MiB per-file cap
    bigWheel[0] = 0x50; bigWheel[1] = 0x4b;
    const files = new Map([
      ['capability.json', Buffer.from(JSON.stringify({
        schemaVersion: 1,
        capability: {
          id: 'too-big-capability', version: '1', displayName: 'Too Big',
          description: 'TEST ONLY total-bound fixture.',
          plugins: ['p-one', 'p-two', 'p-three'], skills: [], mcps: [],
        },
      }, null, 2) + '\n')],
    ]);
    for (const id of ['p-one', 'p-two', 'p-three']) {
      files.set('plugins/' + id + '/plugin.json', Buffer.from(JSON.stringify({
        schemaVersion: 1,
        plugin: {
          id: id, version: '1', displayName: id, description: 'x',
          runtime: 'python', authority: 'none', provides: { pythonImports: [id.replace(/-/g, '_')] },
        },
        artifacts: [{ path: 'artifacts/big.whl', format: 'python-wheel' }],
      }, null, 2) + '\n'));
      files.set('plugins/' + id + '/artifacts/big.whl', bigWheel);
    }
    const ws = await makeWorkspace(files);
    const b = await LCP.buildProject({ workspace: ws, root: '' });
    check('P29 project over the 128 MiB total bound is rejected',
      b.ok === false && !!diagOf(b, 'package_total_too_large'), jsonDiag(b));
  }

  // ===================== P30 binary SKILL reject =====================
  {
    const ws = await patchedWs((w) => w.write(SKILL_REL, new Uint8Array([0xff, 0xfe, 0x00, 0x01])));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P30 binary/non-UTF8 skill source is rejected',
      v.ok === false && !!diagOf(v, 'package_skill_source_invalid', SKILL_REL), jsonDiag(v));
  }

  // ===================== P31 skill > 256 KiB =====================
  {
    const ws = await patchedWs((w) => w.write(SKILL_REL, 'a'.repeat(256 * 1024 + 1)));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P31 skill source over the 256 KiB contract is rejected',
      v.ok === false && !!diagOf(v, 'package_skill_too_large', SKILL_REL), jsonDiag(v));
  }

  // ===================== P32 inline skill body reject =====================
  {
    const ws = await patchedWs((w) => patchManifest(w, 'skills/test-workflow/skill.json',
      (j) => { j.skill.body = '# inline'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P32 inline skill body on the descriptor is rejected',
      v.ok === false && !!diagOf(v, 'package_field_unknown', 'skills/test-workflow/skill.json')
      && !!diagOf(v, 'package_descriptor_invalid', 'skills/test-workflow/skill.json'),
      jsonDiag(v));
  }

  // ===================== P33 build revalidates =====================
  {
    const ws = await fixtureWorkspace();
    const preValidate = await LCP.validateProject({ workspace: ws, root: '' });
    await patchManifest(ws, 'plugins/locus-test-plugin/plugin.json', (j) => { j.plugin.authority = 'network'; });
    const b = await LCP.buildProject({ workspace: ws, root: '' });
    check('P33 build revalidates and never trusts a prior validate result',
      preValidate.ok === true && b.ok === false && b.diagnostics.length > 0, jsonDiag(b));
  }

  // ===================== P34/P35/P36 zero writes =====================
  {
    const ws = await fixtureWorkspace();
    const fp = workspaceFingerprint(ws);
    await LCP.validateProject({ workspace: ws, root: '' });
    check('P34 validate does ZERO writes', workspaceFingerprint(ws) === fp);
    await LCP.buildProject({ workspace: ws, root: '' });
    check('P35 build does ZERO writes', workspaceFingerprint(ws) === fp);
    const b = await LCP.buildProject({ workspace: ws, root: '' });
    LCP.inspectBundle(b.bundle);
    check('P36 inspect does ZERO writes', workspaceFingerprint(ws) === fp);
  }

  // ===================== P37 diagnostics deterministic =====================
  {
    const broken = async (Ctor) => {
      const ws = new Ctor({ maxFileBytes: 512 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024 });
      const files = new Map(FIXTURE_FILES);
      files.set('capability.json', Buffer.from(JSON.stringify({
        schemaVersion: 1,
        note: 'unknown top field',
        capability: {
          id: 'package-test-capability', version: '1', displayName: 'X', description: 'Y',
          plugins: ['locus-test-plugin', 'ghost-plugin'], skills: ['ghost-skill'], mcps: [],
        },
      }, null, 2) + '\n'));
      files.set('skills/test-workflow/skill.json', Buffer.from('{ broken'));
      for (const [rel, data] of files) await ws.write(rel, data);
      return ws;
    };
    const vA = await LCP.validateProject({ workspace: await broken(M.MemoryWorkspace), root: '' });
    const vB = await LCP.validateProject({ workspace: await broken(ReversedWorkspace), root: '' });
    const diagA = vA.diagnostics;
    const sortedCopy = diagA.slice().sort((x, y) => {
      if (x.path !== y.path) return x.path < y.path ? -1 : 1;
      if (x.code !== y.code) return x.code < y.code ? -1 : 1;
      return x.message < y.message ? -1 : x.message > y.message ? 1 : 0;
    });
    check('P37 diagnostics are deterministic across provider orders and sorted',
      jsonDiag(vA) === jsonDiag(vB)
      && JSON.stringify(diagA) === JSON.stringify(sortedCopy)
      && diagA.length >= 3, jsonDiag(vA));
  }

  // ===================== P38/P39 lock contains no bodies/bytes =====================
  {
    const lockStr = b2.bundle.serializeLock();
    const lock = b2.bundle.lock;
    check('P38 lock carries skill metadata but never the skill body',
      typeof lock.skills[0].sha256 === 'string' && lock.skills[0].size > 0
      && !lockStr.includes('Import the plugin module')
      && !lockStr.includes('answer()')
      && !JSON.stringify(lock).includes('Import the plugin module'));
    check('P39 lock carries artifact identity but never artifact bytes',
      !lockStr.includes('PK\u0003\u0004')
      && !lockStr.includes('UEsDBB') // base64("PK\x03\x04")
      && lockStr.length < 8192
      && lock.files.every((f) => typeof f.path === 'string'
        && typeof f.size === 'number' && typeof f.sha256 === 'string')
      && lockStr === lockStr); // trivial stability guard for lint symmetry
  }

  // ===================== P40 synthetic wheel fixture is a REAL wheel =====================
  // Boundary: these checks prove the FIXTURE artifact prepared for the
  // next milestone (Trusted Plugin Runtime) is a genuine wheel. They
  // do NOT mean buildProject validates arbitrary author-supplied wheel
  // bytes - Package Core checks only the declared format, bounds and
  // exact identity; wheel installability is verified by the Trusted
  // Plugin Runtime (offline install + smoke import before READY).
  {
    const buf = FIXTURE_FILES.get(WHEEL_REL);
    const u8 = Buffer.from(buf);
    // ZIP magic + EOCD scan
    check('P40 fixture bytes are a ZIP container (PK magic + EOCD)',
      u8.readUInt32LE(0) === 0x04034b50);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (u8.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    const count = eocd >= 0 ? u8.readUInt16LE(eocd + 10) : -1;
    const cdOffset = eocd >= 0 ? u8.readUInt32LE(eocd + 16) : -1;
    const entries = [];
    let okCentral = eocd >= 0;
    let p = cdOffset;
    for (let i = 0; okCentral && i < count; i++) {
      if (u8.readUInt32LE(p) !== 0x02014b50) { okCentral = false; break; }
      const method = u8.readUInt16LE(p + 10);
      const modTime = u8.readUInt16LE(p + 12);
      const modDate = u8.readUInt16LE(p + 14);
      const compSize = u8.readUInt32LE(p + 20);
      const nameLen = u8.readUInt16LE(p + 28);
      const extraLen = u8.readUInt16LE(p + 30);
      const commentLen = u8.readUInt16LE(p + 32);
      const lho = u8.readUInt32LE(p + 42);
      const name = u8.slice(p + 46, p + 46 + nameLen).toString('utf8');
      if (u8.readUInt32LE(lho) !== 0x04034b50) { okCentral = false; break; }
      const lNameLen = u8.readUInt16LE(lho + 26);
      const lExtraLen = u8.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const comp = u8.slice(dataStart, dataStart + compSize);
      const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
      entries.push({ name, data, modTime, modDate });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const names = entries.map((e) => e.name);
    const DIST = 'locus_test_plugin-1.0.0.dist-info';
    const expected = [
      'locus_test_plugin/__init__.py',
      DIST + '/METADATA',
      DIST + '/WHEEL',
      DIST + '/RECORD',
    ];
    const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
    check('P40 wheel is a real wheel: expected module + dist-info entries, fixed timestamps',
      okCentral && count === 4
      && JSON.stringify(names) === JSON.stringify(expected)
      && entries.every((e) => e.modTime === 0 && e.modDate === dosDate));
    const init = entries.find((e) => e.name === 'locus_test_plugin/__init__.py');
    check('P40b wheel module provides deterministic answer() == 42',
      !!init && init.data.toString('utf8').includes('def answer():')
      && init.data.toString('utf8').includes('return 42'));
    const record = entries.find((e) => e.name === DIST + '/RECORD');
    const rows = record ? record.data.toString('utf8').trim().split('\n') : [];
    let recordOk = rows.length === 4; // 3 hashed members + the bare RECORD self-row
    if (recordOk) {
      for (const row of rows) {
        const cols = row.split(',');
        if (cols[0] === DIST + '/RECORD') { if (cols[1] !== '' || cols[2] !== '') recordOk = false; continue; }
        const entry = entries.find((e) => e.name === cols[0]);
        const expectedHash = 'sha256=' + crypto.createHash('sha256').update(entry.data)
          .digest('base64url');
        if (!entry || cols[1] !== expectedHash || Number(cols[2]) !== entry.data.byteLength) {
          recordOk = false;
        }
      }
    }
    check('P40c wheel RECORD hashes/sizes match the actual member bytes', recordOk);
    const metadata = entries.find((e) => e.name === DIST + '/METADATA');
    const wheelMeta = entries.find((e) => e.name === DIST + '/WHEEL');
    check('P40d wheel METADATA/WHEEL dist-info are coherent',
      !!metadata && metadata.data.toString('utf8').includes('Name: locus-test-plugin')
      && metadata.data.toString('utf8').includes('Version: 1.0.0')
      && !!wheelMeta && wheelMeta.data.toString('utf8').includes('Wheel-Version: 1.0')
      && wheelMeta.data.toString('utf8').includes('Tag: py3-none-any')
      && wheelMeta.data.toString('utf8').includes('Root-Is-Purelib: true'));
  }

  // ===================== error-contract extras =====================
  {
    let threw1 = false, threw2 = false, threw3 = false;
    try { LCP.inspectBundle({ lock: {} }); } catch (e) { threw1 = true; }
    try { await LCP.validateProject({ workspace: { list() {} }, root: '' }); } catch (e) { threw2 = true; }
    try { await LCP.validateProject({ workspace: await fixtureWorkspace(), root: '../escape' }); } catch (e) { threw3 = true; }
    check('P41 programmer errors throw (non-bundle inspect, non-adapter workspace, traversal root)',
      threw1 && threw2 && threw3);
    const b = await LCP.buildProject({ workspace: await fixtureWorkspace(), root: '' });
    let threw4 = false;
    try { b.bundle.readBytes('../../evil'); } catch (e) { threw4 = true; }
    let threw5 = false;
    try { b.bundle.readBytes('nope/missing.bin'); } catch (e) { threw5 = e.name === 'NotFoundError'; }
    check('P41b bundle readBytes rejects traversal and missing paths',
      threw4 && threw5);
  }
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.artifacts.push({ path: 'artifacts/second-1.0.0-py3-none-any.whl', format: 'python-wheel' }); }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P42 more than one artifact is rejected by the exactly-one-wheel policy',
      v.ok === false && !!diagOf(v, 'package_artifact_policy', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }
  {
    const ws = await patchedWs((w) => patchManifest(w, 'plugins/locus-test-plugin/plugin.json',
      (j) => { j.artifacts[0].format = 'tar.gz'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P43 unsupported artifact format is rejected',
      v.ok === false && !!diagOf(v, 'package_artifact_policy', 'plugins/locus-test-plugin'),
      jsonDiag(v));
  }
  {
    const ws = await makeWorkspace(new Map([['README.md', 'not a project\n']]));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P44 missing capability.json / empty root is a diagnostic, not a throw',
      v.ok === false && !!diagOf(v, 'package_manifest_missing', 'capability.json'), jsonDiag(v));
  }
  {
    const ws = await patchedWs((w) => w.write('plugins/stray-file.txt', 'not a component dir'));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P45 stray file inside a component directory is rejected',
      v.ok === false && !!diagOf(v, 'package_component_dir_invalid', 'plugins/stray-file.txt'),
      jsonDiag(v));
  }
  {
    const ws = await patchedWs(async (w) => {
      await w.write('mcp/extra-service/mcp.json', JSON.stringify({
        schemaVersion: 1,
        mcp: { id: 'extra-service', displayName: 'X', description: 'Y', token: 'secret', auth: 'oauth' },
      }, null, 2) + '\n');
      await patchManifest(w, 'capability.json', (j) => { j.capability.mcps = ['extra-service']; });
    });
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P46 credential-ish MCP fields are rejected by the strict whitelist (no secrets in packages)',
      v.ok === false && !!diagOf(v, 'package_field_unknown', 'mcp/extra-service/mcp.json'),
      jsonDiag(v));
  }
  {
    const ws = await patchedWs((w) => patchManifest(w, 'skills/test-workflow/skill.json',
      (j) => { j.source = 'other.md'; }));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P47 arbitrary skill source paths are rejected (exactly SKILL.md in v1)',
      v.ok === false && !!diagOf(v, 'package_source_invalid', 'skills/test-workflow/skill.json'),
      jsonDiag(v));
  }
  {
    // skill dir with a valid id but referenced with a matching subdirectory
    // still needs its manifest: <id>/skill.json missing -> loud diagnostic
    const ws = await patchedWs((w) => w.remove('skills/test-workflow/skill.json'));
    const v = await LCP.validateProject({ workspace: ws, root: '' });
    check('P48 component directory without its manifest is rejected',
      v.ok === false && !!diagOf(v, 'package_manifest_missing', 'skills/test-workflow/skill.json'),
      jsonDiag(v));
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SUITE ERROR', e);
  process.exit(1);
});
