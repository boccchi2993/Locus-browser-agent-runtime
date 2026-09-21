// F04c maintainer tool: verifies the Python bootstrap manifest pinned in
// src/shell.js against independently fetched bytes. VERIFY ONLY by default —
// it never edits the manifest; `--generate` prints a manifest literal built
// from fresh CDN bytes for HUMAN REVIEW (apply by hand).
//
//   node scripts/verify-python-bootstrap-manifest.mjs
//       Fetch the 10 pinned assets from the pinned CDN, check exact size +
//       SHA-256 against the manifest, check the pinned pyodide-lock.json,
//       verify the pandas dependency closure == declared package wheel set,
//       and re-verify tests/fixtures/pyodide-lock-snapshot.json.
//
//   node scripts/verify-python-bootstrap-manifest.mjs --release-dir <dir>
//       Additionally prove provenance: <dir> holds the files extracted from
//       the OFFICIAL pyodide release artifact (github.com/pyodide/pyodide
//       releases, e.g. pyodide-core-<v>.tar.bz2 + pyodide-<v>.tar.bz2,
//       extracted: <dir>/pyodide/<file>). Every file is byte-compared
//       against the CDN bytes. The archive itself is never committed.
//
//   node scripts/verify-python-bootstrap-manifest.mjs --generate
//       Print a ready-to-paste manifest literal computed from fresh CDN
//       bytes (still requires manual review + full gates before commit).
//
// No npm dependencies: node builtins only (crypto, fs, fetch). Deterministic
// output; exit 0 only when everything checks out.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_SRC = path.join(ROOT, 'src', 'shell.js');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'pyodide-lock-snapshot.json');

const args = process.argv.slice(2);
const generate = args.includes('--generate');
const releaseDirIdx = args.indexOf('--release-dir');
const releaseDir = releaseDirIdx !== -1 ? args[releaseDirIdx + 1] : null;

function fail(msg) {
  console.error('VERIFY-FAIL: ' + msg);
  process.exit(1);
}

// ---- manifest extraction (same literal the runtime freezes) --------------
const src = readFileSync(SHELL_SRC, 'utf8');
const mBlock = src.match(/const PYTHON_BOOTSTRAP_MANIFEST = Object\.freeze\(\[([\s\S]*?)\]\);/);
if (!mBlock) fail('PYTHON_BOOTSTRAP_MANIFEST not found in src/shell.js');
const mBase = src.match(/const PYODIDE_BASE = '([^']+)';/);
if (!mBase) fail('PYODIDE_BASE not found in src/shell.js');
const BASE = mBase[1];
const manifest = vm.runInNewContext('[' + mBlock[1] + ']', Object.freeze({}));
if (manifest.length !== 10) fail('manifest must hold exactly 10 entries, found ' + manifest.length);

// ---- streaming download with exact-size bound + SHA-256 ------------------
async function fetchVerified(entry) {
  const res = await fetch(BASE + entry.name);
  if (!res.ok) fail(`CDN fetch ${entry.name}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const hash = createHash('sha256');
  let received = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > entry.size) {
      try { reader.cancel(); } catch { /* best effort */ }
      fail(`${entry.name}: body exceeds manifest size ${entry.size} (oversized/corrupt CDN response)`);
    }
    hash.update(value);
    chunks.push(value);
  }
  if (received !== entry.size) fail(`${entry.name}: expected ${entry.size} bytes, CDN returned ${received}`);
  return { bytes: Buffer.concat(chunks), sha256: hash.digest('hex') };
}

console.log('# python bootstrap manifest verify');
console.log('# base: ' + BASE);

// ---- 1. manifest structure -----------------------------------------------
for (const e of manifest) {
  if (!/^[0-9a-f]{64}$/.test(e.sha256)) fail(`${e.name}: sha256 must be 64 lowercase hex chars`);
  if (!Number.isInteger(e.size) || e.size <= 0) fail(`${e.name}: size must be a positive integer`);
  if (e.kind !== 'text' && e.kind !== 'bytes') fail(`${e.name}: kind must be text|bytes`);
}
console.log(`# [1] manifest structure: ${manifest.length} entries OK`);

// ---- 2. CDN bytes vs manifest --------------------------------------------
const cdn = new Map();
for (const e of manifest) {
  const { bytes, sha256 } = await fetchVerified(e);
  if (sha256 !== e.sha256) fail(`${e.name}: CDN sha256 ${sha256} != manifest ${e.sha256}`);
  cdn.set(e.name, bytes);
  console.log(`# [2] ${e.name}: ${e.size}B sha256 OK`);
}

// ---- 3. provenance: official release artifact vs CDN (optional flag) -----
if (releaseDir) {
  for (const e of manifest) {
    let releaseBytes;
    try {
      releaseBytes = readFileSync(path.join(releaseDir, 'pyodide', e.name));
    } catch {
      fail(`--release-dir: cannot read ${path.join(releaseDir, 'pyodide', e.name)} (extract the official pyodide release archives first)`);
    }
    if (releaseBytes.length !== e.size) fail(`${e.name}: release artifact size ${releaseBytes.length} != manifest ${e.size}`);
    const releaseHash = createHash('sha256').update(releaseBytes).digest('hex');
    if (releaseHash !== e.sha256) fail(`${e.name}: release artifact sha256 ${releaseHash} != manifest ${e.sha256}`);
    if (!releaseBytes.equals(cdn.get(e.name))) fail(`${e.name}: release artifact bytes DIFFER from CDN bytes`);
    console.log(`# [3] ${e.name}: release artifact == CDN bytes (provenance OK)`);
  }
} else {
  console.log('# [3] provenance: pass --release-dir <extracted official release> to byte-compare the official artifacts');
}

// ---- 4. lockfile: pin + pandas dependency closure -------------------------
const lockBytes = cdn.get('pyodide-lock.json');
const lock = JSON.parse(lockBytes.toString('utf8'));
console.log(`# [4] lockfile: pyodide ${lock.info.version} abi ${lock.info.abi_version} ${lock.info.arch}/${lock.info.platform} python ${lock.info.python}`);

const wheelEntries = manifest.filter((e) => e.name.endsWith('.whl'));
const coreNames = manifest.map((e) => e.name).filter((n) => !n.endsWith('.whl'));
const expectedCore = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip'];
if (JSON.stringify([...coreNames].sort()) !== JSON.stringify([...expectedCore].sort())) {
  fail('core set must be exactly ' + expectedCore.join(', ') + ' — found ' + coreNames.join(', '));
}

const closure = new Set();
const walk = (name) => {
  if (closure.has(name)) return;
  const p = lock.packages[name];
  if (!p) fail(`pandas dependency ${name} missing from the pinned lockfile`);
  closure.add(name);
  for (const d of p.depends || []) walk(d);
};
walk('pandas');

const lockFiles = [...closure].map((n) => lock.packages[n].file_name).sort();
const manifestWheels = wheelEntries.map((e) => e.name).sort();
if (JSON.stringify(lockFiles) !== JSON.stringify(manifestWheels)) {
  fail(`pandas closure (${lockFiles.join(', ')}) != manifest wheels (${manifestWheels.join(', ')})`);
}
for (const name of closure) {
  const p = lock.packages[name];
  const e = manifest.find((x) => x.name === p.file_name);
  if (!e) fail(`lockfile package ${name} wheel ${p.file_name} not pinned in manifest`);
  if (p.sha256 && p.sha256 !== e.sha256) fail(`${p.file_name}: lockfile sha256 ${p.sha256} != manifest ${e.sha256}`);
  console.log(`# [4] ${name}@${p.version} -> ${p.file_name} sha256 OK`);
}
console.log('# [4] pandas dependency closure == manifest wheel set EXACTLY');

// ---- 5. offline snapshot fixture stays in sync ----------------------------
const snap = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const lockEntry = manifest.find((e) => e.name === 'pyodide-lock.json');
if (snap.lockfile.sha256 !== lockEntry.sha256) {
  fail(`snapshot fixture is for lockfile ${snap.lockfile.sha256}, manifest pins ${lockEntry.sha256} — regenerate tests/fixtures/pyodide-lock-snapshot.json and review`);
}
const snapFiles = Object.values(snap.closure).map((p) => p.file_name).sort();
if (JSON.stringify(snapFiles) !== JSON.stringify(manifestWheels)) {
  fail('snapshot fixture closure differs from manifest wheels: ' + snapFiles.join(', '));
}
for (const [pkg, p] of Object.entries(snap.closure)) {
  const e = manifest.find((x) => x.name === p.file_name);
  if (!e || e.sha256 !== p.sha256) fail(`snapshot fixture wheel ${p.file_name} hash differs from manifest`);
}
console.log('# [5] offline snapshot fixture (tests/fixtures/pyodide-lock-snapshot.json) in sync');

// ---- --generate: print a manifest literal (never written automatically) ---
if (generate) {
  console.log('# ---- manifest literal below is GENERATED — review by hand, then apply ----');
  console.log('const PYTHON_BOOTSTRAP_MANIFEST = Object.freeze([');
  for (const e of manifest) {
    const bytes = cdn.get(e.name);
    const sha = createHash('sha256').update(bytes).digest('hex');
    console.log(`  { name: '${e.name}', kind: '${e.kind}', mime: '${e.mime}', size: ${bytes.length}, sha256: '${sha}' },`);
  }
  console.log(']);');
}

console.log('# VERIFY-PASS: manifest matches CDN bytes'
  + (releaseDir ? ', official release artifacts, lockfile closure and snapshot fixture' : ', lockfile closure and snapshot fixture'));
