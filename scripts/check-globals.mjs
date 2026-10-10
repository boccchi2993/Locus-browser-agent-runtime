// Inventory classic-script dependencies without evaluating application code.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';
import { analyze } from 'eslint-scope';
import globals from 'globals';
import { parse as parseHtml } from 'parse5';
import { parse as parseSfc, compileScript } from '@vue/compiler-sfc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = 'scripts/globals-baseline.json';
const read = (file) => readFile(resolve(root, file), 'utf8');
const builtins = new Set(Object.keys({ ...globals.browser, ...globals.node, ...globals.es2026 }));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const key = (entry) => JSON.stringify(entry);
const sorted = (entries) => [...new Map(entries.map((entry) => [key(entry), entry])).values()]
  .sort((a, b) => compare(key(a), key(b)));

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node);
    } else if (value && typeof value === 'object') {
      walk(value, visit, node);
    }
  }
}

function javascript(source, sourceType, file) {
  try {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType, range: true, loc: true });
    const scopes = analyze(ast, { ecmaVersion: 2026, sourceType, optimistic: true });
    const parents = new WeakMap();
    walk(ast, (node, parent) => parents.set(node, parent));
    return { file, ast, scopes, parents };
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

async function scriptOrder() {
  const html = parseHtml(await read('index.html'));
  const fromHtml = [];
  function visit(node) {
    if (node.tagName === 'script') {
      const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      const type = (attrs.type || '').trim().toLowerCase();
      if (attrs.src && ['', 'text/javascript', 'application/javascript'].includes(type)) {
        const path = posix.normalize(attrs.src.startsWith('/') ? attrs.src.slice(1) : attrs.src);
        if (!path.startsWith('src/') || !path.endsWith('.js')) {
          throw new Error(`Unsupported classic-script source: ${attrs.src}`);
        }
        fromHtml.push(path);
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(html);
  const config = javascript(await read('vite.config.js'), 'module', 'vite.config.js');
  const lists = [];
  walk(config.ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.name !== 'RUNTIME_SCRIPTS') return;
    if (node.init?.type !== 'ArrayExpression' || node.init.elements.some((item) =>
      item?.type !== 'Literal' || typeof item.value !== 'string')) {
      throw new Error('RUNTIME_SCRIPTS must be a literal array of strings');
    }
    lists.push(node.init.elements.map((item) => item.value));
  });
  if (lists.length !== 1) throw new Error('Expected exactly one RUNTIME_SCRIPTS declaration');
  const fromVite = lists[0];
  if (key(fromHtml) !== key(fromVite)) {
    console.error('index.html classic scripts:', JSON.stringify(fromHtml, null, 2));
    console.error('vite.config.js RUNTIME_SCRIPTS:', JSON.stringify(fromVite, null, 2));
    for (let i = 0; i < Math.max(fromHtml.length, fromVite.length); i++) {
      if (fromHtml[i] !== fromVite[i]) {
        console.error(`Order difference at ${i}: HTML=${fromHtml[i] ?? '<missing>'}, Vite=${fromVite[i] ?? '<missing>'}`);
      }
    }
    throw new Error('Classic-script lists differ; reconcile both lists before updating the baseline');
  }
  if (!fromHtml.length || new Set(fromHtml).size !== fromHtml.length) {
    throw new Error('Classic-script list must be nonempty and contain no repeated files');
  }
  return fromHtml;
}

function propertyName(node, unresolved) {
  if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier'
    || !['window', 'globalThis'].includes(node.object.name) || !unresolved.has(node.object)) return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  throw new Error('Dynamic window/globalThis property access cannot be inventoried statically');
}

async function inventory() {
  const classic = await scriptOrder();
  const modules = ['src/main.js', 'src/ui/store.js', 'src/App.vue',
    ...(await readdir(resolve(root, 'src/components'))).filter((file) => file.endsWith('.vue'))
      .sort(compare).map((file) => `src/components/${file}`)];
  const files = [...classic, ...modules];
  const layers = JSON.parse(await read('scripts/layer-map.json'));
  for (const file of files) {
    if (!['runtime', 'harness', 'product', 'mixed'].includes(layers[file]?.layer)) {
      throw new Error(`Missing or invalid layer mapping: ${file}`);
    }
  }
  for (const file of Object.keys(layers)) {
    if (!files.includes(file)) throw new Error(`Stale layer mapping: ${file}`);
  }
  const units = [];
  const definitions = new Map();
  for (const file of files) {
    const source = await read(file);
    let sources = [source];
    if (file.endsWith('.vue')) {
      const { descriptor, errors } = parseSfc(source, { filename: file });
      if (errors.length) throw new Error(`${file}: ${errors.map(String).join('; ')}`);
      for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
        if (block.src || (block.lang && block.lang !== 'js')) {
          throw new Error(`${file}: external or non-JavaScript script blocks are unsupported`);
        }
      }
      // Vue macros are compile-time syntax, not unresolved runtime globals.
      // Compile only the script blocks; never analyze templates or styles.
      sources = descriptor.scriptSetup
        ? [compileScript(descriptor, { id: file }).content]
        : [descriptor.script?.content].filter((source) => source !== undefined);
    }
    for (const source of sources) {
      const unit = javascript(source, classic.includes(file) ? 'script' : 'module', file);
      units.push(unit);
      if (classic.includes(file)) {
        for (const variable of unit.scopes.globalScope.variables) {
          if (!variable.defs.length) continue;
          const owners = definitions.get(variable.name) || new Set();
          owners.add(file);
          definitions.set(variable.name, owners);
        }
      }
    }
  }
  // Explicit global-object assignments also identify property producers in modules.
  // They are not lexical global definitions and do not hide undefined identifiers.
  const properties = new Map();
  for (const unit of units) {
    unit.unresolved = new Set(unit.scopes.globalScope.through.map((ref) => ref.identifier));
    walk(unit.ast, (node, parent) => {
      const name = propertyName(node, unit.unresolved);
      if (name === null || parent?.type !== 'AssignmentExpression' || parent.left !== node) return;
      const owners = properties.get(name) || new Set();
      owners.add(unit.file);
      properties.set(name, owners);
    });
  }
  const edges = [];
  const undefinedReferences = [];
  const edge = (from, to, symbol, kind) => ({ from, to, symbol, kind,
    fromLayer: layers[from].layer, toLayer: to === null ? null : layers[to].layer });
  for (const unit of units) {
    for (const ref of unit.scopes.globalScope.through) {
      const symbol = ref.identifier.name;
      const parent = unit.parents.get(ref.identifier);
      const kind = parent?.type === 'UnaryExpression' && parent.operator === 'typeof' ? 'guarded' : 'direct';
      const owners = definitions.get(symbol);
      if (owners) {
        for (const to of owners) if (to !== unit.file) edges.push(edge(unit.file, to, symbol, kind));
      } else if (!builtins.has(symbol)) {
        undefinedReferences.push({ from: unit.file, symbol, kind });
      }
    }
    walk(unit.ast, (node) => {
      const symbol = propertyName(node, unit.unresolved);
      if (symbol === null) return;
      const owners = definitions.get(symbol) || properties.get(symbol);
      if (owners) {
        for (const to of owners) edges.push(edge(unit.file, to, symbol, 'window-property'));
      } else {
        // Browser properties and externally supplied hooks have no scanned owner.
        edges.push(edge(unit.file, null, symbol, 'window-property'));
      }
    });
  }
  return {
    edges: sorted(edges),
    duplicates: sorted([...definitions].filter(([, owners]) => owners.size > 1)
      .map(([symbol, owners]) => ({ symbol, files: [...owners].sort(compare) }))),
    undefined: sorted(undefinedReferences),
  };
}

function printStats(current) {
  const counts = new Map();
  for (const edge of current.edges) {
    const group = `${edge.fromLayer} -> ${edge.toLayer ?? '(external property)'}`;
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  console.log('Dependency edges by layer (informational):');
  console.table(Object.fromEntries([...counts].sort(([a], [b]) => compare(a, b))));
  console.log(`Edges: ${current.edges.length}; guarded: ${current.edges.filter((edge) => edge.kind === 'guarded').length}; window-property: ${current.edges.filter((edge) => edge.kind === 'window-property').length}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--write')) {
    throw new Error('Usage: node scripts/check-globals.mjs [--write]');
  }
  const current = await inventory();
  printStats(current);
  if (args[0] === '--write') {
    await writeFile(resolve(root, baselinePath), JSON.stringify(current, null, 2) + '\n');
    console.log(`Wrote ${baselinePath}`);
    return;
  }
  let baseline;
  try { baseline = JSON.parse(await read(baselinePath)); }
  catch (error) { throw new Error(`Cannot read baseline: ${error.message}. Run --write in the same PR.`); }
  let failed = false;
  for (const category of ['edges', 'duplicates', 'undefined']) {
    if (!Array.isArray(baseline[category])) throw new Error(`Invalid baseline category: ${category}`);
    const old = new Set(baseline[category].map(key));
    const next = new Set(current[category].map(key));
    for (const entry of current[category]) {
      if (!old.has(key(entry))) { console.error(`Added ${category}: ${key(entry)}`); failed = true; }
    }
    for (const entry of baseline[category]) {
      if (!next.has(key(entry))) { console.error(`Removed ${category}: ${key(entry)}`); failed = true; }
    }
  }
  // Also reject reordered arrays, extra fields and other baseline schema drift.
  if (key(baseline) !== key(current)) {
    console.error('Baseline differs from the canonical inventory; run --write in the same PR and review its diff.');
    failed = true;
  }
  for (const category of ['duplicates', 'undefined']) {
    for (const entry of current[category]) {
      console.error(`Forbidden ${category}: ${key(entry)}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('Global dependency baseline matches; no duplicate or undefined globals.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
