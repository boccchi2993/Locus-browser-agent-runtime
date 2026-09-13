// Shell regression tests (node): quoted-aware tokenizer, python write-back
// failure semantics (F04), external-edit conflicts (F11), skipped-path
// overwrite protection (F10), cancellation.
// PythonRuntime's worker is stubbed at the message boundary — the same
// technique as the audit's R3 reproduction.
// Run: node tests/shell.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null }; // PythonRuntime._setStatus touches the status bar

const src = ['telemetry.js', 'workspace.js', 'network.js', 'shell.js', 'tools.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ WorkspaceAdapter, normalizeWorkspacePath, PythonRuntime, runShellCommand, executeTool, Telemetry });');

// --- byte-exact in-memory workspace ---
class MemWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'mem';
    this.files = {};
    this.writeFail = new Set(); // paths whose write() throws
    for (const k in (files || {})) this.files[k] = new TextEncoder().encode(files[k]);
  }
  async list() { return Object.keys(this.files).map((n) => ({ name: n, kind: 'file' })); }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    if (this.writeFail.has(p)) throw new Error('disk full');
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
  async exists(p) { try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; } return p in this.files; }
  async stat(p) { p = M.normalizeWorkspacePath(p); if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; } return { kind: 'file', size: this.files[p].byteLength, modified: 0 }; }
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// Stub the worker boundary: postMessage resolves the pending request with
// the given result (after running mutate() to simulate external edits).
function mockWorkerResult(result, mutate) {
  M.PythonRuntime._ensureWorker = () => {};
  M.PythonRuntime.worker = {
    postMessage(msg) {
      const p = M.PythonRuntime._pending.get(msg.id);
      queueMicrotask(async () => {
        if (mutate) await mutate();
        clearTimeout(p.timer);
        M.PythonRuntime._pending.delete(msg.id);
        p.resolve(result);
      });
    },
  };
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  // ---------- T. tokenizer: quoted > / >> are text, never redirects (F15) ----------
  const ws = new MemWS();
  const t1 = await M.executeTool('bash', 'echo ">" victim.txt', ws);
  check('T1 quoted > prints text, writes nothing', t1.success && t1.output === '> victim.txt'
    && !('victim.txt' in ws.files), JSON.stringify(t1.output));

  const t2 = await M.executeTool('bash', 'echo "a >> b"', ws);
  check('T2 quoted >> inside text', t2.success && t2.output === 'a >> b' && Object.keys(ws.files).length === 0,
    JSON.stringify(t2.output));

  const t3 = await M.executeTool('bash', "echo '>' victim.txt", ws);
  check('T3 single-quoted > also text', t3.success && t3.output === '> victim.txt' && !('victim.txt' in ws.files));

  const t4 = await M.executeTool('bash', 'echo "unclosed', ws);
  check('T4 unclosed quote → clear error', !t4.success && t4.output.includes('unclosed quote'), t4.output);

  const t5 = await M.executeTool('bash', 'echo done > out.txt', ws);
  check('T5 real redirect still works', t5.success && new TextDecoder().decode(ws.files['out.txt'] || []) === 'done\n');

  const t6 = await M.executeTool('bash', 'echo hi >> out.txt', ws);
  check('T6 real append still works', t6.success && new TextDecoder().decode(ws.files['out.txt']) === 'done\nhi\n');

  // ---------- T2x. unsupported syntax fails loudly ----------
  const t7 = await M.executeTool('bash', 'ls | grep x', ws);
  check('T7 pipe rejected', !t7.success && t7.output.includes('unsupported shell syntax'), t7.output);
  const t8 = await M.executeTool('bash', 'ls; pwd', ws);
  check('T8 semicolon rejected', !t8.success && t8.output.includes('unsupported shell syntax'), t8.output);
  const t9 = await M.executeTool('bash', 'cat out.txt > other.txt', ws);
  check('T9 redirect only for echo', !t9.success && t9.output.includes('only supported for echo'), t9.output);

  // ---------- P. python write-back: failed target stops deletions (F04) ----------
  const wsP = new MemWS({ 'old.txt': 'original' });
  wsP.writeFail.add('new.txt');
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: 'new.txt', b64: b64('renamed') }], deleted: ['old.txt'] });
  const p1 = await M.executeTool('bash', "python -c 'print(1)'", wsP);
  check('P1 failed write → tool reports failure', p1.success === false, JSON.stringify(p1.output));
  check('P1b source file preserved', new TextDecoder().decode(wsP.files['old.txt'] || []) === 'original');
  check('P1c deletions explicitly skipped', p1.output.includes('deletions skipped'), p1.output);
  check('P1d write failure reported', p1.output.includes('write-back failed: new.txt'), p1.output);

  // successful rename still commits both sides
  const wsP2 = new MemWS({ 'old.txt': 'original' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: 'new.txt', b64: b64('original') }], deleted: ['old.txt'] });
  const p2 = await M.executeTool('bash', "python -c 'print(1)'", wsP2);
  check('P2 rename commits both sides', p2.success === true && !('old.txt' in wsP2.files)
    && new TextDecoder().decode(wsP2.files['new.txt']) === 'original', JSON.stringify(p2.output));

  // ---------- C. external edits during the run are never overwritten (F11) ----------
  const wsC = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult(
    { stdout: '', stderr: '', error: null, files: [{ path: 'a.txt', b64: b64('python version') }], deleted: [] },
    () => { wsC.files['a.txt'] = new TextEncoder().encode('user edit'); }, // external edit mid-run
  );
  const c1 = await M.executeTool('bash', "python -c 'print(1)'", wsC);
  check('C1 external edit conflict reported', c1.success === false && c1.output.includes('conflict: a.txt'),
    JSON.stringify(c1.output));
  check('C1b user content preserved', new TextDecoder().decode(wsC.files['a.txt']) === 'user edit');

  // deletion of an externally modified file is refused
  const wsC2 = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult(
    { stdout: '', stderr: '', error: null, files: [], deleted: ['a.txt'] },
    () => { wsC2.files['a.txt'] = new TextEncoder().encode('user edit'); },
  );
  const c2 = await M.executeTool('bash', "python -c 'print(1)'", wsC2);
  check('C2 external edit blocks deletion', c2.success === false && ('a.txt' in wsC2.files)
    && c2.output.includes('deletion skipped'), JSON.stringify(c2.output));

  // unchanged file: python edit commits cleanly
  const wsC3 = new MemWS({ 'a.txt': 'before' });
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: 'a.txt', b64: b64('after') }], deleted: [] });
  const c3 = await M.executeTool('bash', "python -c 'print(1)'", wsC3);
  check('C3 clean modify commits', c3.success === true && new TextDecoder().decode(wsC3.files['a.txt']) === 'after');

  // ---------- S. unsynced (skipped) paths are never overwritten (F10) ----------
  const bigFile = new Uint8Array(6 * 1024 * 1024).fill(7); // over the 5 MiB per-file sync limit
  const wsS = new MemWS();
  wsS.files['big.bin'] = bigFile;
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: 'big.bin', b64: b64('python created') }], deleted: [] });
  const s1 = await M.executeTool('bash', "python -c 'print(1)'", wsS);
  check('S1 python file at skipped path refused', s1.success === false && s1.output.includes('conflict: big.bin')
    && s1.output.includes('not synced into Python'), JSON.stringify(s1.output));
  check('S1b real file untouched', wsS.files['big.bin'].byteLength === bigFile.byteLength
    && wsS.files['big.bin'][0] === 7);
  check('S1c skip reported with path', s1.output.includes('NOT visible to Python') && s1.output.includes('big.bin'),
    JSON.stringify(s1.output).slice(0, 200));

  // ---------- N. generated files without a workspace are reported, not faked ----------
  mockWorkerResult({ stdout: '', stderr: '', error: null, files: [{ path: 'out.txt', b64: b64('x') }], deleted: [] });
  const n1 = await M.executeTool('bash', "python -c 'print(1)'", null);
  check('N1 no workspace → not persisted + failure', n1.success === false && n1.output.includes('not persisted'),
    JSON.stringify(n1.output));

  // ---------- X. cancellation before the run ----------
  const ac = new AbortController();
  ac.abort();
  const x1 = await M.runShellCommand("python -c 'print(1)'", new MemWS(), { signal: ac.signal });
  check('X1 pre-aborted python → cancelled', x1.isError && x1.output.includes('cancelled'), x1.output);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
