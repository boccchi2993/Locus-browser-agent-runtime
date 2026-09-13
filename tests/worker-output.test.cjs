// Worker output-collection tests (Finding 1): drives the REAL worker
// source from index.html with a fake Pyodide FS, and the REAL shell.js
// commit logic with the worker boundary stubbed.
//
// Scenarios:
//  - >200 output files: the 201st (a rename target) must be reported as a
//    STRUCTURED uncollected path, and the shell commit must refuse deletions.
//  - output volume cap: same structured reporting.
//  - size is checked BEFORE reading/base64-encoding a huge file.
//  - normal rename and plain delete still work.
// Run: node tests/worker-output.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ---------- real worker source with a fake Pyodide ----------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const workerSrc = html.match(/<script type="text\/worker" id="py-worker-src">([\s\S]*?)<\/script>/)[1];

function makeFakePy(mutate) {
  const files = new Map(); // full path -> Uint8Array | 'DIR' | any raw value
  const reads = [];
  const api = {
    FS: {
      mkdirTree(p) { files.set(p, 'DIR'); },
      writeFile(p, data) { files.set(p, data); },
      readFile(p) {
        const v = files.get(p);
        if (v === undefined || v === 'DIR') throw new Error('readFile: no such file ' + p);
        reads.push(p);
        return v;
      },
      readdir(dir) {
        const out = ['.', '..'];
        const prefix = dir === '/' ? '/' : dir + '/';
        for (const k of files.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          if (rest && !rest.includes('/')) out.push(rest);
        }
        return out;
      },
      stat(p) {
        const v = files.get(p);
        if (v === undefined) throw new Error('stat: no such file ' + p);
        return { mode: v === 'DIR' ? 1 : 2, size: v === 'DIR' ? 0 : v.byteLength };
      },
      isDir(mode) { return mode === 1; },
      unlink(p) { files.delete(p); },
    },
    _reads: reads,
    runPython() {},
    async runPythonAsync(code) { if (mutate) mutate(api.FS, files); },
    async loadPackagesFromImports() {},
    setStdout() {},
    setStderr() {},
  };
  return api;
}

// Run one worker job; returns { result, reads } — reads records every file
// the worker actually readFile()'d (proves size checks happen BEFORE reads).
async function runWorkerJob(mutate, inputFiles) {
  const posted = [];
  let py = null;
  const c = vm.createContext({
    self: { postMessage(msg) { if (msg.type === 'result') posted.push(msg); } },
    importScripts() {},
    loadPyodide: async () => { py = makeFakePy(mutate); return py; },
    atob, btoa, TextEncoder, TextDecoder,
  });
  vm.runInContext(workerSrc, c);
  await vm.runInContext(`self.onmessage({ data: ${JSON.stringify({ id: 7, cmd: 'run', code: 'x', files: inputFiles || [] })} })`, Object.assign(c, { inputFiles }));
  // onmessage is async; wait until the result is posted
  for (let i = 0; i < 100 && !posted.length; i++) await new Promise((r) => setTimeout(r, 5));
  if (!posted.length) throw new Error('worker posted no result');
  return { result: posted[0], reads: py._reads };
}

// ---------- real shell.js commit path (worker boundary stubbed) ----------
global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };
const src = ['telemetry.js', 'workspace.js', 'network.js', 'shell.js', 'tools.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ WorkspaceAdapter, normalizeWorkspacePath, PythonRuntime, executeTool });');

class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) { p = M.normalizeWorkspacePath(p); this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data); }
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async exists(p) { try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; } return p in this.files; }
  async stat(p) { p = M.normalizeWorkspacePath(p); if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; } return { kind: 'file', size: this.files[p].byteLength, modified: 0 }; }
}

function mockWorkerResult(result) {
  M.PythonRuntime._ensureWorker = () => {};
  M.PythonRuntime.worker = {
    postMessage(msg) {
      const p = M.PythonRuntime._pending.get(msg.id);
      queueMicrotask(() => {
        clearTimeout(p.timer);
        M.PythonRuntime._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
}

async function run() {
  // ---------- O1. >200 outputs: rename target becomes the 201st → structured uncollected ----------
  const o1 = (await runWorkerJob((FS) => {
    FS.unlink('/workspace/old.txt'); // python renamed old.txt → renamed
    for (let i = 1; i <= 200; i++) {
      FS.writeFile('/workspace/f' + String(i).padStart(3, '0') + '.txt', new TextEncoder().encode('x'));
    }
    FS.writeFile('/workspace/renamed', new TextEncoder().encode('original'));
  }, [{ path: 'old.txt', b64: btoa('original') }])).result;
  check('O1 rename target reported as STRUCTURED uncollected path',
    Array.isArray(o1.uncollectedFiles) && o1.uncollectedFiles.indexOf('renamed') !== -1,
    'uncollectedFiles=' + JSON.stringify(o1.uncollectedFiles) + ' warnings=' + JSON.stringify(o1.syncWarnings));
  check('O1b deletion list still returned (shell must decide, not worker)',
    Array.isArray(o1.deleted) && o1.deleted.indexOf('old.txt') !== -1, JSON.stringify(o1.deleted));

  // shell commit: with an incomplete changeset, the source must survive and the run must FAIL
  const ws1 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [], // the rename target was never collected
    deleted: ['old.txt'],
    uncollectedFiles: ['renamed'],
    stdoutTruncated: false, stderrTruncated: false,
  });
  const r1 = await M.executeTool('bash', "python -c 'x'", ws1);
  check('O1c incomplete changeset → source preserved',
    !!ws1.files['old.txt'] && new TextDecoder().decode(ws1.files['old.txt']) === 'original');
  check('O1d incomplete changeset → tool reports failure', r1.success === false, JSON.stringify(r1.output));
  check('O1e uncollected path surfaced', r1.output.includes('renamed'), JSON.stringify(r1.output));

  // ---------- O2. volume cap: uncollected files block deletes too ----------
  const ws2 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [{ path: 'part1.bin', b64: btoa('part') }],
    deleted: ['old.txt'],
    uncollectedFiles: ['part2.bin', 'part3.bin'],
  });
  const r2 = await M.executeTool('bash', "python -c 'x'", ws2);
  check('O2 volume-cap uncollected → source preserved + failure',
    r2.success === false && !!ws2.files['old.txt'] && new TextDecoder().decode(ws2.files['old.txt']) === 'original'
    && !!ws2.files['part1.bin'] && new TextDecoder().decode(ws2.files['part1.bin']) === 'part',
    JSON.stringify(r2.output));

  // ---------- O3. huge file: size checked BEFORE read/base64 ----------
  const o3job = await runWorkerJob((FS) => {
    const big = {
      get byteLength() { return 30 * 1024 * 1024; },
    };
    FS.writeFile('/workspace/huge.bin', big);
    // normal small file still collected
    FS.writeFile('/workspace/small.txt', new TextEncoder().encode('ok'));
  }, []);
  const o3 = o3job.result;
  check('O3 huge file uncollected without reading it',
    Array.isArray(o3.uncollectedFiles) && o3.uncollectedFiles.indexOf('huge.bin') !== -1
    && o3job.reads.indexOf('/workspace/huge.bin') === -1,
    JSON.stringify(o3.uncollectedFiles) + ' reads=' + JSON.stringify(o3job.reads));
  check('O3b small file still collected',
    (o3.files || []).some((f) => f.path === 'small.txt'), JSON.stringify((o3.files || []).map((f) => f.path)));

  // ---------- O4. stdout truncation is NOT a changeset failure ----------
  const ws4 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: 'lots', stderr: '', error: null,
    files: [{ path: 'new.txt', b64: btoa('n') }],
    deleted: ['old.txt'],
    uncollectedFiles: [],
    stdoutTruncated: true,
  });
  const r4 = await M.executeTool('bash', "python -c 'x'", ws4);
  check('O4 stdout truncation alone stays success, rename commits',
    r4.success === true && !('old.txt' in ws4.files) && !!ws4.files['new.txt']
    && r4.output.includes('stdout truncated'), JSON.stringify(r4.output).slice(0, 200));

  // ---------- O5. plain delete and normal rename unaffected ----------
  const ws5 = new MemWS({ 'gone.txt': 'x' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [], deleted: ['gone.txt'], uncollectedFiles: [] });
  const r5 = await M.executeTool('bash', "python -c 'x'", ws5);
  check('O5 plain delete still works', r5.success === true && !('gone.txt' in ws5.files));

  const ws6 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({
    stdout: '', stderr: '', error: null,
    files: [{ path: 'renamed', b64: btoa('original') }],
    deleted: ['old.txt'],
    uncollectedFiles: [],
  });
  const r6 = await M.executeTool('bash', "python -c 'x'", ws6);
  check('O6 normal rename still works', r6.success === true && !('old.txt' in ws6.files)
    && new TextDecoder().decode(ws6.files['renamed']) === 'original');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
