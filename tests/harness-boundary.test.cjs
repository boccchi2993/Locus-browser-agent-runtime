// Harness boundary gate (M2b, H10): the public entry's transitive ESM
// import closure stays inside the Harness-owned file set and the harness
// sources read NO Runtime/Product/DOM/telemetry globals — paired with the
// real execution proof in tests/harness-standalone.test.mjs (structure +
// behavior, never grep alone).
// Run: node tests/harness-boundary.test.cjs

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
// Comment-stripped, CRLF-normalized source (same normalization as the
// runtime boundary gate — M2a's CRLF lesson).
function clean(rel) {
  const src = read(rel).replace(/\r\n/g, '\n');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------- B1. the entry's transitive ESM import closure ----------
// Walk `import ... from '...'` and `import('...')` specifiers by hand (each
// file gets a FRESH regex — shared /g regexes carry lastIndex state, the
// M2a lesson).
const ENTRY = 'src/harness/index.js';
const HARNESS_OWNED = new Set([
  'src/harness/index.js',
  'src/harness/task-runner.js',
  'src/harness/provider-session.js',
  'src/harness/core.js',
  'src/model-adapters.js',
  'src/model.js',
  'src/capabilities.js',
  'src/extension-composition.js',
  'src/approval.js',
  'src/agent.js',
]);
const CLOSURE_REQUIRED = [
  'src/harness/task-runner.js',
  'src/harness/provider-session.js',
  'src/harness/core.js',
  'src/model-adapters.js',
  'src/model.js',
  'src/capabilities.js',
  'src/extension-composition.js',
  'src/approval.js',
  'src/agent.js',
];

function importSpecifiers(rel) {
  const src = clean(rel);
  const out = [];
  for (const m of src.matchAll(/import\s+[^'"]*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/export\s+[^'"]*from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null; // bare package (none expected)
  const dir = path.dirname(path.join(root, fromRel));
  let p = path.resolve(dir, spec).replace(/\\/g, '/');
  if (!p.endsWith('.js')) p += '.js';
  const rootSlash = root.replace(/\\/g, '/') + '/';
  return p.startsWith(rootSlash) ? p.slice(rootSlash.length) : p;
}

{
  const seen = new Set([ENTRY]);
  const queue = [ENTRY];
  let nonHarness = [];
  let bareSpecifiers = [];
  while (queue.length) {
    const rel = queue.shift();
    for (const spec of importSpecifiers(rel)) {
      if (!spec.startsWith('.')) { bareSpecifiers.push(rel + ' -> ' + spec); continue; }
      const resolved = resolveRel(rel, spec);
      if (!resolved || !HARNESS_OWNED.has(resolved)) nonHarness.push(rel + ' -> ' + spec);
      if (resolved && HARNESS_OWNED.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  check('B1 entry import closure stays inside the Harness-owned set',
    nonHarness.length === 0, JSON.stringify(nonHarness));
  check('B1 no bare-package imports in the closure',
    bareSpecifiers.length === 0, JSON.stringify(bareSpecifiers));
  check('B1 the closure covers the whole harness core',
    CLOSURE_REQUIRED.every((f) => seen.has(f)), JSON.stringify([...seen].sort()));
  check('B1 the product tool layer is NOT in the closure (tools.js is Product)',
    !seen.has('src/tools.js'));
}

// ---------- B2. no Runtime/Product/DOM/telemetry global reads ----------
{
  const findings = [];
  for (const rel of HARNESS_OWNED) {
    const src = clean(rel);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const where = rel + ':' + (i + 1);
      // Runtime coupling
      if (/__LOCUS_RUNTIME_CORE__|shellSystemPromptSection|runShellCommand|runPythonCode|createPythonRuntime/.test(line)) {
        findings.push(where + ' runtime ref: ' + line.trim().slice(0, 90));
      }
      if (/runtime\/(index|core|worker-assets)\.js/.test(line)) {
        findings.push(where + ' runtime import: ' + line.trim().slice(0, 90));
      }
      // Product coupling
      if (/executeTool|AGENT_TOOL_DEFINITIONS|PersistenceServiceInstance|AttachmentStore|renderDebugPanel|Telemetry\b/.test(line)) {
        findings.push(where + ' product/telemetry ref: ' + line.trim().slice(0, 90));
      }
      if (/(src\/)?tools\.js|ui\/store|persistence\.js|attachments\.js|mutation-policy|from '\.\.\/ui\//.test(line)) {
        findings.push(where + ' product import: ' + line.trim().slice(0, 90));
      }
      // DOM / framework. DECLARED EXCEPTION (M3 removal): model.js's
      // legacyModelClient() keeps the GUARDED window.location relay check
      // for the Product-side callModel/verifyConnection wrappers.
      // model.js's window reads are the guarded legacy wrapper's (continuation
      // lines included); B3 separately pins the exact form and count.
      const declaredWindowGuard = rel === 'src/model.js'
        && /window\.location/.test(line);
      if (!declaredWindowGuard && /document\.|getElementById|window\./.test(line)) {
        findings.push(where + ' DOM/global ref: ' + line.trim().slice(0, 90));
      }
      if (/\bVue\b|from 'vue'/.test(line)) {
        findings.push(where + ' vue ref: ' + line.trim().slice(0, 90));
      }
      // Worker-source reads (the runtime's own assets never enter the harness)
      if (/pyWorkerSource|grepWorkerSource/.test(line)) {
        findings.push(where + ' runtime worker asset ref: ' + line.trim().slice(0, 90));
      }
    });
  }
  check('B2 harness sources read no Runtime/Product/DOM/telemetry globals',
    findings.length === 0, JSON.stringify(findings.slice(0, 8)));
}

// ---------- B3. the one declared exception (legacy compat, M3 removal) ----------
// model.js keeps the GUARDED window.location read inside legacyModelClient()
// (the Product-side callModel/verifyConnection wrappers). It must be exactly
// that guarded form — the generic factory path never touches window.
{
  const src = clean('src/model.js');
  const guarded = src.includes("typeof window !== 'undefined' && !!window.location")
    && src.includes("String(window.location.protocol) !== 'file:'");
  const windowRefs = (src.match(/window\./g) || []).length;
  check('B3 window reads in model.js are the declared legacy-compat guard only',
    !!guarded && windowRefs === 2,
    'windowRefs=' + windowRefs + ' guarded=' + !!guarded);
}

// ---------- B4. probe deps are explicit (no global fallbacks) ----------
{
  const caps = clean('src/capabilities.js');
  check('B4 ModelCapabilityRegistry requires its persistence dependency',
    /persistence backend is required/.test(caps));
  check('B4 the image probe takes an explicit model client (no callModel fallback)',
    !/typeof callModel/.test(caps) && /typeof o\.callModelFn === 'function'/.test(caps));
}

// ---------- B5. the declared harness table is the only registry seam ----------
{
  const agent = clean('src/agent.js');
  check('B5 agent.js publishes the frozen __LOCUS_HARNESS_CORE__ table',
    /globalThis\.__LOCUS_HARNESS_CORE__ = Object\.freeze\(__harnessTable\)/.test(agent));
  check('B5 agent.js reads no tool registry global (ToolPort only)',
    !/AGENT_TOOL_DEFINITIONS/.test(agent) && /createToolSnapshot/.test(agent));
  const idx = clean('src/harness/index.js');
  check('B5 the entry resolves through the declared table only',
    /globalThis\.__LOCUS_HARNESS_CORE__/.test(idx) && !/globalThis\.AgentSession/.test(idx));
}

// ---------- B6. behavior pairing: the entry really runs (H1 is the proof) ----------
check('B6 structural gate paired with tests/harness-standalone.test.mjs (real execution)',
  fs.existsSync(path.join(root, 'tests', 'harness-standalone.test.mjs')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
