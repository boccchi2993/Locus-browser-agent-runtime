// Single-source-of-truth loader for the pinned Python bootstrap manifest
// (F04c): every suite derives its asset list from src/shell.js instead of
// keeping a duplicate copy. Throws loudly if the manifest is missing or
// malformed, so a broken manifest fails every consumer immediately.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPythonManifest() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shell.js'), 'utf8');
  const block = src.match(/const PYTHON_BOOTSTRAP_MANIFEST = Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error('PYTHON_BOOTSTRAP_MANIFEST not found in src/shell.js');
  const base = src.match(/const PYODIDE_BASE = '([^']+)';/);
  if (!base) throw new Error('PYODIDE_BASE not found in src/shell.js');
  const manifest = vm.runInNewContext('[' + block[1] + ']', Object.freeze({}));
  if (!Array.isArray(manifest) || manifest.length !== 10) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST must hold exactly 10 entries, found ' + manifest.length);
  }
  for (const e of manifest) {
    if (!e.name || !/^[0-9a-f]{64}$/.test(e.sha256) || !(e.size > 0)) {
      throw new Error('malformed manifest entry: ' + JSON.stringify(e));
    }
  }
  return { base: base[1], manifest };
}

module.exports = { loadPythonManifest };
