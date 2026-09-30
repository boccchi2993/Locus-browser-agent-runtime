// Runtime DEPENDENCY-BOUNDARY gate (M2a, repository split — gate G).
//
// Structural checks over the Runtime source set AND the built dist/
// copies, paired with the real execution proof in
// tests/runtime-standalone.test.mjs (structure + behavior, not grep
// alone). Forbidden for Runtime files:
//   - imports of / references to Harness or Product modules
//     (agent, model, model-adapters, approval, tools-as-registry,
//      extensions, capability*, attachments, persistence, mutation-policy,
//      ui/, harness/, Vue)
//   - the product page DOM: worker-source elements (#py-worker-src /
//     #grep-worker-src), the status element (#sb-python),
//     document.getElementById DOM reads
//   - the product home-skeleton global (LOCUS_HOME_SKELETON) and the
//     Harness identity-pattern globals (EXTENSION_ID_PATTERN /
//     EXTENSION_PY_MODULE_PATTERN)
// Declared exceptions (the one Runtime-internal seam): the frozen
// __LOCUS_RUNTIME_CORE__ registry shell.js publishes and the entry reads.
// Run: node tests/runtime-boundary.test.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
}

// The Runtime file set (source of truth: INVENTORY §2 ownership + the M2a
// design record). telemetry.js is the shared util the runtime consumes.
// core.js (M2a review) is the self-assembly module: the SAME five sources
// imported as ES modules when a host carries no classic copies.
const RUNTIME_FILES = [
  'src/runtime/index.js',
  'src/runtime/worker-assets.js',
  'src/runtime/core.js',
  'src/telemetry.js',
  'src/workspace.js',
  'src/vfs.js',
  'src/network.js',
  'src/shell.js',
];

// Harness/Product module names that must NEVER appear as a dependency of
// a Runtime file (import specifiers or global-name references).
const FORBIDDEN_MODULES = [
  'agent', 'model-adapters', 'model.', 'approval', 'tools',
  'extensions', 'capability-package', 'capability',
  'attachments', 'persistence', 'mutation-policy', 'capabilities',
  'conversation-history-workspace',
  'task-runner', 'provider-session',
  'projector', 'markdown', 'store',
];

function findReferences(src, names) {
  const hits = [];
  for (const line of src.split('\n')) {
    for (const n of names) {
      const bare = n.replace(/\.$/, '');
      const re = new RegExp('\\b(?:from\\s+[\'"][^\'"]*|require\\(\\s*[\'"][^\'"]*|window\\.|globalThis\\.)?'
        + bare + '\\b');
      if (re.test(line)) hits.push(line.trim().slice(0, 160));
    }
  }
  return hits;
}

// Strip comments so explanatory mentions (e.g. "carries NO chat identity")
// don't mask real code references; the scan is over CODE. CRLF is
// normalized first — a trailing \r would otherwise break the line regex.
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ---------- G1: no Harness/Product module references ----------
// Import/require forms only: a quoted bare word (e.g. the 'capabilities'
// DIRECTORY in the VFS skeleton) is data, not a module reference.
for (const f of RUNTIME_FILES) {
  const src = stripComments(read(f));
  const esc = (m) => m.replace(/\./g, '\\.').replace(/-/, '\\-');
  const forbidden = FORBIDDEN_MODULES.filter((m) => new RegExp('(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)[\'"][^\'"]*\\b' + esc(m) + '(\\.js)?[\'"]').test(src));
  check('G1 ' + f + ' imports no Harness/Product module', forbidden.length === 0, JSON.stringify(forbidden));
}

// ---------- G2: no product globals or DOM ids ----------
{
  const domIdHits = [];
  const globalHits = [];
  for (const f of RUNTIME_FILES) {
    const lines = stripComments(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (/getElementById\(|sb-python|py-worker-src|grep-worker-src/.test(line)) {
        domIdHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
      }
      if (/\bLOCUS_HOME_SKELETON\b|EXTENSION_ID_PATTERN|EXTENSION_PY_MODULE_PATTERN|PersistenceServiceInstance|SkillInstanceWorkspace|CapabilityManager|LocusMutationPolicy|AgentSession|ApprovalController|executeTool|AGENT_TOOL_DEFINITIONS/.test(line)) {
        globalHits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 120));
      }
    });
  }
  check('G2 no product DOM ids or page-element reads in Runtime', domIdHits.length === 0, JSON.stringify(domIdHits));
  check('G2b no Harness/Product globals in Runtime', globalHits.length === 0, JSON.stringify(globalHits));
}

// ---------- G3: the conversation identity never enters the Runtime ----------
{
  const hits = [];
  for (const f of RUNTIME_FILES) {
    const lines = stripComments(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (/\bconversationId\b|\btaskGeneration\b/.test(line)) hits.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 140));
    });
  }
  check('G3 no chat-identity field names in Runtime sources', hits.length === 0, JSON.stringify(hits));
}

// ---------- G4: contract data stays in sync (declared mechanism) ----------
{
  const shellSrc = read('src/shell.js');
  // M2b: the Harness identity-pattern copy lives in the composition core now.
  const extSrc = read('src/extension-composition.js');
  const runtimeId = shellSrc.match(/RUNTIME_PLUGIN_ID_PATTERN\s*=\s*(\/[^/]+\/)\s*;/);
  const extId = extSrc.match(/EXTENSION_ID_PATTERN\s*=\s*(\/[^/]+\/)\s*;/);
  const runtimeMod = shellSrc.match(/RUNTIME_PY_MODULE_PATTERN\s*=\s*(\/[\s\S]*?\/)\s*;/);
  const extMod = extSrc.match(/EXTENSION_PY_MODULE_PATTERN\s*=\s*(\/[\s\S]*?\/)\s*;/);
  check('G4 plugin-id pattern: the Runtime copy equals the Harness copy',
    !!runtimeId && !!extId && runtimeId[1] === extId[1],
    JSON.stringify({ runtime: runtimeId && runtimeId[1], harness: extId && extId[1] }));
  check('G4b py-module pattern: the Runtime copy equals the Harness copy',
    !!runtimeMod && !!extMod && runtimeMod[1] === extMod[1],
    JSON.stringify({ runtime: runtimeMod && runtimeMod[1], harness: extMod && extMod[1] }));
  // Byte-stable error texts embed the pattern — pinned through the real
  // configure gate with an invalid id.
  globalThis.window = { location: { protocol: 'https:' } };
  globalThis.document = { getElementById: () => null };
  const M = (0, eval)(['src/telemetry.js', 'src/workspace.js', 'src/vfs.js', 'src/network.js', 'src/shell.js']
    .map(read).join('\n;\n') + '\n;({ createPythonRuntime })');
  const rt = M.createPythonRuntime({ pyWorkerSource: 'x' });
  let msg = null;
  try { rt.configureExtensions({ key: 'k', modules: [{ pluginId: 'BAD ID', imports: [] }] }); }
  catch (e) { msg = e.message; }
  check('G4c invalid payload ids fail with the SAME message text as before the split',
    !!msg && msg.includes('module pluginId must match /^[a-z0-9][a-z0-9._-]*$/'),
    msg);
}

// ---------- G5: dist copies obey the same boundary ----------
{
  // The classic runtime scripts are COPIED verbatim into dist/src (the
  // ESM entry + worker assets are BUNDLED into the app chunk instead —
  // the product bundle legitimately contains Product code, so only the
  // copied runtime-only files are scannable here).
  const distFiles = ['src/telemetry.js', 'src/workspace.js', 'src/vfs.js', 'src/network.js', 'src/shell.js']
    .map((f) => 'dist/' + f).filter((f) => fs.existsSync(path.join(ROOT, f)));
  check('G5 all copied runtime files are present in dist', distFiles.length === 5,
    JSON.stringify(distFiles));
  const hits = [];
  for (const f of distFiles) {
    const src = stripComments(read(f));
    if (/getElementById\(|sb-python|py-worker-src|grep-worker-src|LOCUS_HOME_SKELETON|EXTENSION_ID_PATTERN|conversationId|taskGeneration/.test(src)) {
      hits.push(f);
    }
  }
  check('G5b the built dist runtime copies stay inside the boundary', hits.length === 0, JSON.stringify(hits));
}

// ---------- G6: the declared registry is the ONLY global seam ----------
{
  const shellSrc = read('src/shell.js');
  check('G6 shell.js publishes exactly the declared core registry',
    (shellSrc.match(/__LOCUS_RUNTIME_CORE__/g) || []).length === 1
    && /globalThis\.__LOCUS_RUNTIME_CORE__ = Object\.freeze/.test(shellSrc), '');
  const entrySrc = read('src/runtime/index.js');
  check('G6b the entry reads the core ONLY through the declared registry',
    /globalThis\.__LOCUS_RUNTIME_CORE__/.test(entrySrc)
    && !/\bwindow\b/.test(entrySrc.replace(/^\s*\/\/.*$/gm, '')), 'window reference in entry');
  check('G6c the entry performs no DOM work at import or construction',
    !/document\./.test(entrySrc), 'document reference in entry');
}

// ---------- G7: the entry's TRANSITIVE ESM dependency closure (review round) ----------
// The self-assembling entry must never reach a Harness/Product file: walk
// the import graph from src/runtime/index.js (static imports, re-exports
// and dynamic import() calls) and require every reached file to be part of
// the Runtime set — and the closure to actually COVER the core (the
// publishes only work when the five files load in order).
{
  const resolveFrom = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null; // bare specifiers are out of scope here
    const base = path.join(path.dirname(path.join(ROOT, fromFile)), spec);
    return path.relative(ROOT, base).split(path.sep).join('/');
  };
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // Fresh regex per file: a shared /g regex's lastIndex is corrupted by
    // the inline recursion below.
    const IMPORT_RE = /(?:from\s*|import\s+|import\()\s*['"]([^'"]+)['"]/g;
    const src = read(file);
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const rel = resolveFrom(file, m[1]);
      if (rel) walk(rel);
    }
  };
  walk('src/runtime/index.js');
  const ALLOWED = new Set(RUNTIME_FILES);
  const outside = Array.from(seen).filter((f) => !ALLOWED.has(f));
  check('G7 the entry\u2019s transitive import closure stays inside the Runtime set',
    outside.length === 0, JSON.stringify(outside));
  // worker-assets.js is deliberately ABSENT from the closure: its sources
  // travel as host-injected strings (createRuntime workerAssets), never as
  // an import of the entry.
  const CORE_CLOSURE = [
    'src/runtime/core.js',
    'src/telemetry.js',
    'src/workspace.js',
    'src/vfs.js',
    'src/network.js',
    'src/shell.js',
  ];
  const MISSING = CORE_CLOSURE.filter((f) => !seen.has(f));
  check('G7b the closure covers the whole core (self-assembly is complete)',
    MISSING.length === 0, JSON.stringify(MISSING));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
