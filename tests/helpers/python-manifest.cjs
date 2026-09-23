// Single-source-of-truth loader for the pinned Python bootstrap manifest
// (F04c): every suite derives its asset list from src/shell.js instead of
// keeping a duplicate copy. Throws loudly if the manifest is missing or
// malformed, so a broken manifest fails every consumer immediately.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractFreezeArray(src, name) {
  const block = src.match(new RegExp('const ' + name + ' = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);'));
  if (!block) throw new Error(name + ' not found in src/shell.js');
  return vm.runInNewContext('[' + block[1] + ']', Object.freeze({}));
}

function loadPythonManifest() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shell.js'), 'utf8');
  const block = src.match(/const PYTHON_BOOTSTRAP_MANIFEST = Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error('PYTHON_BOOTSTRAP_MANIFEST not found in src/shell.js');
  const base = src.match(/const PYODIDE_BASE = '([^']+)';/);
  if (!base) throw new Error('PYODIDE_BASE not found in src/shell.js');
  const manifest = vm.runInNewContext('[' + block[1] + ']', Object.freeze({}));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST is missing or empty');
  }
  const names = manifest.map((e) => e.name);
  if (new Set(names).size !== names.length) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST holds duplicate asset names');
  }
  const coreAssets = extractFreezeArray(src, 'PYTHON_BOOTSTRAP_CORE_ASSETS');
  const runtimePackageFiles = extractFreezeArray(src, 'PYTHON_RUNTIME_PACKAGE_FILES');
  const installerSupportFiles = extractFreezeArray(src, 'PYTHON_INSTALLER_SUPPORT_FILES');
  const known = new Set([...coreAssets, ...runtimePackageFiles, ...installerSupportFiles]);
  if (names.length !== known.size || names.some((n) => !known.has(n))) {
    throw new Error('PYTHON_BOOTSTRAP_MANIFEST does not partition into core + runtime packages + installer support');
  }
  for (const e of manifest) {
    if (!e.name || !/^[0-9a-f]{64}$/.test(e.sha256) || !(e.size > 0)) {
      throw new Error('malformed manifest entry: ' + JSON.stringify(e));
    }
  }
  return {
    base: base[1],
    manifest,
    coreAssets,
    runtimePackageFiles,
    installerSupportFiles,
  };
}

module.exports = { loadPythonManifest };
