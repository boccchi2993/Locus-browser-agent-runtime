// Shell compatibility round 2 tests (node): stdout/stderr separation at the
// executor level, || fallback, mv / rm (bounds, confinement, cancellation),
// and generalized redirection (> >> 2> 2>> 2>&1, left-to-right order).
// Run: node tests/shell-compat2.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

const src = ['telemetry.js', 'workspace.js', 'network.js', 'shell.js', 'tools.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ WorkspaceAdapter, normalizeWorkspacePath, PythonRuntime, runShellCommand, executeTool,'
  + ' Telemetry, SHELL_COMMANDS, shellHelpText, shellSystemPromptSection, shellTokenize, parseShellLine, runPipeline });');

// --- hierarchical in-memory workspace (same model as shell-compat.test.cjs) ---
class TreeWS extends M.WorkspaceAdapter {
  constructor(files) {
    super();
    this.name = 'tree';
    this.files = {};
    for (const k in (files || {})) {
      this.files[k] = typeof files[k] === 'string' ? new TextEncoder().encode(files[k]) : files[k];
    }
  }
  _dirs() {
    const dirs = new Set(['']);
    for (const p in this.files) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  }
  async list(p) {
    p = p ? M.normalizeWorkspacePath(p) : '';
    if (p && !this._dirs().has(p)) { const e = new Error('No such dir: ' + p); e.name = 'NotFoundError'; throw e; }
    const seen = new Map();
    const prefix = p ? p + '/' : '';
    for (const f in this.files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.split('/')[0];
      const kind = rest.includes('/') ? 'directory' : 'file';
      if (!seen.has(seg) || kind === 'directory') seen.set(seg, { name: seg, kind: seen.has(seg) && seen.get(seg).kind === 'directory' ? 'directory' : kind });
    }
    const entries = [...seen.values()];
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return entries;
  }
  async read(p) { return new TextDecoder().decode(await this.readBytes(p)); }
  async readBytes(p) {
    p = M.normalizeWorkspacePath(p);
    if (!(p in this.files)) { const e = new Error('No such file: ' + p); e.name = 'NotFoundError'; throw e; }
    return this.files[p];
  }
  async write(p, data) {
    p = M.normalizeWorkspacePath(p);
    this.files[p] = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  }
  async remove(p) {
    p = M.normalizeWorkspacePath(p);
    // Directories are implicit (derived from file paths): removing one is a
    // no-op once its files are gone, matching how the real adapter removes
    // an emptied directory.
    delete this.files[p];
  }
  async exists(p) {
    try { p = M.normalizeWorkspacePath(p); } catch (e) { return false; }
    return p in this.files || this._dirs().has(p);
  }
  async stat(p) {
    p = M.normalizeWorkspacePath(p);
    if (p in this.files) return { kind: 'file', size: this.files[p].byteLength, modified: 0 };
    if (this._dirs().has(p)) return { kind: 'directory', size: 0, modified: null };
    const e = new Error('No such path: ' + p); e.name = 'NotFoundError'; throw e;
  }
}

const dec = (b) => new TextDecoder().decode(b || new Uint8Array());

function fixture() {
  return new TreeWS({
    'a.txt': 'foo\nbar\nfoo again\n',
    'b.txt': 'second\n',
    'sub/c.txt': 'in sub\n',
    'sub/deep/d.txt': 'deep\n',
    'dir with space/note.txt': 'space ok\n',
  });
}

// Direct executor-level access: run one pipeline and inspect the SEPARATED
// stdout/stderr (the tool boundary merges them for presentation).
async function runPipelineOf(line, ws, opts) {
  const steps = M.parseShellLine(M.shellTokenize(line));
  const ctx = { workspace: ws, opts: opts || {}, cwd: '' };
  return M.runPipeline(steps[0].pipeline, ctx);
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  // ---------- IO. stdout/stderr separation inside the executor ----------
  {
    const ws = fixture();
    const io1 = await runPipelineOf('echo hello', ws);
    check('IO1 successful command: stdout only', io1.success && io1.stdout === 'hello' && io1.stderr === '',
      JSON.stringify(io1));
    const io2 = await runPipelineOf('cat missing.txt', ws);
    check('IO2 failing cat: stderr only', !io2.success && io2.stdout === '' && io2.stderr.includes('cat:'),
      JSON.stringify(io2));
    const io3 = await runPipelineOf('echo hello | wc -c', ws);
    check('IO3 pipeline forwards stdout', io3.success && io3.stdout === '5', JSON.stringify(io3));
    const io4 = await runPipelineOf('badcmd | wc -c', ws);
    check('IO4 pipeline never forwards stderr', io4.success && io4.stdout === '0' && io4.stderr.includes('badcmd'),
      JSON.stringify(io4));
    // presentation boundary still merges both streams
    const io5 = await M.executeTool('bash', 'cat missing.txt', ws);
    check('IO5 tool boundary merges stderr for presentation', !io5.success
      && io5.output.includes('cat:') && io5.output.includes('missing.txt'), io5.output);
  }

  // ---------- OR. || fallback ----------
  {
    const ws = fixture();
    const or1 = await M.executeTool('bash', 'cat missing.txt || echo fallback', ws);
    check('OR1 failure || runs fallback', or1.success && or1.output.includes('fallback')
      && or1.output.includes('cat:'), or1.output);
    const or2 = await M.executeTool('bash', 'echo ok || echo fallback', ws);
    check('OR2 success || skips fallback', or2.success && or2.output === 'ok', or2.output);
    const or3 = await M.executeTool('bash', 'bad-command && echo A || echo B', ws);
    check('OR3 && then || is left-associative', or3.success && !or3.output.includes('A') && or3.output.includes('B'),
      or3.output);
    const or4 = await M.executeTool('bash', 'echo A || echo B && echo C', ws);
    check('OR4 || then && is left-associative', or4.success && or4.output === 'A\nC', or4.output);
    const or5 = await M.executeTool('bash', 'cat missing || echo a || echo b', ws);
    check('OR5 chained || stops after first success', or5.success && or5.output.endsWith('\na')
      && !or5.output.endsWith('\nb') && !or5.output.split('\n').includes('b'), or5.output);
    const or6 = await M.executeTool('bash', 'echo A > or6.txt || echo B > or6b.txt', ws);
    check('OR6 || blocks later side effect on success', or6.success && ('or6.txt' in ws.files)
      && !('or6b.txt' in ws.files), JSON.stringify(Object.keys(ws.files)));
  }

  // ---------- MV. move/rename ----------
  {
    const ws = fixture();
    const mv1 = await M.executeTool('bash', 'mv a.txt renamed.txt', ws);
    check('MV1 file → new filename', mv1.success && dec(ws.files['renamed.txt']) === 'foo\nbar\nfoo again\n'
      && !('a.txt' in ws.files), mv1.output);

    const ws2 = fixture();
    const mv2 = await M.executeTool('bash', 'mv a.txt sub', ws2);
    check('MV2 file → directory', mv2.success && dec(ws2.files['sub/c.txt']) === 'in sub\n'
      && dec(ws2.files['sub/a.txt']) === 'foo\nbar\nfoo again\n' && !('a.txt' in ws2.files), mv2.output);

    const ws3 = fixture();
    const mv3 = await M.executeTool('bash', 'mv missing.txt x.txt', ws3);
    check('MV3 source missing fails', !mv3.success && mv3.output.includes('no such file or directory'), mv3.output);

    const ws4 = fixture();
    const mv4 = await M.executeTool('bash', 'mv a.txt b.txt', ws4);
    check('MV4 destination exists fails loudly, both intact', !mv4.success && mv4.output.includes('destination exists')
      && dec(ws4.files['a.txt']) === 'foo\nbar\nfoo again\n' && dec(ws4.files['b.txt']) === 'second\n', mv4.output);

    const ws5 = fixture();
    const mv5 = await M.executeTool('bash', 'mv "dir with space/note.txt" "renamed note.txt"', ws5);
    check('MV5 quoted paths with spaces', mv5.success && dec(ws5.files['renamed note.txt']) === 'space ok\n'
      && !('dir with space/note.txt' in ws5.files), mv5.output);

    const ws6 = fixture();
    const mv6 = await M.executeTool('bash', 'mv a.txt ../evil.txt', ws6);
    check('MV6 path escape rejected', !mv6.success && mv6.output.includes('escapes workspace')
      && ('a.txt' in ws6.files), mv6.output);
    const mv6b = await M.executeTool('bash', 'mv /a.txt /mv6b.txt', ws6);
    check('MV6b / is workspace-root absolute', mv6b.success && ('mv6b.txt' in ws6.files), mv6b.output);

    // cancellation AFTER the destination write but BEFORE the source delete:
    // source is preserved, partial state is honestly reported
    const ws7 = fixture();
    const ac7 = new AbortController();
    const origWrite7 = ws7.write.bind(ws7);
    ws7.write = async (p, d) => { await origWrite7(p, d); ac7.abort(); };
    const mv7 = await M.executeTool('bash', 'mv a.txt mv7.txt', ws7, { signal: ac7.signal });
    check('MV7 cancel before delete preserves source', !mv7.success && mv7.output.includes('cancelled')
      && ('a.txt' in ws7.files), mv7.output + ' | ' + JSON.stringify(Object.keys(ws7.files)));

    const ws8 = fixture();
    const mv8 = await M.executeTool('bash', 'mv sub sub2', ws8);
    check('MV8 directory rename/move (recursive)', mv8.success && dec(ws8.files['sub2/c.txt']) === 'in sub\n'
      && dec(ws8.files['sub2/deep/d.txt']) === 'deep\n' && !('sub/c.txt' in ws8.files)
      && !(await ws8.exists('sub')), mv8.output);

    const ws9 = fixture();
    const mv9 = await M.executeTool('bash', 'mv sub sub/inner', ws9);
    check('MV9 directory into itself rejected', !mv9.success && mv9.output.includes('into itself')
      && dec(ws9.files['sub/c.txt']) === 'in sub\n', mv9.output);

    const mv10 = await M.executeTool('bash', 'mv -f a.txt b.txt', fixture());
    check('MV10 -f fails loudly (unsupported)', !mv10.success && mv10.output.includes('-f is not supported'), mv10.output);

    const mv11 = await M.executeTool('bash', 'mv a.txt a.txt', fixture());
    check('MV11 same file rejected', !mv11.success && mv11.output.includes('same file'), mv11.output);

    const ws12 = fixture();
    const mv12 = await M.executeTool('bash', 'mv a.txt b.txt sub', ws12);
    check('MV12 multiple sources into directory', mv12.success && dec(ws12.files['sub/a.txt']).includes('foo')
      && dec(ws12.files['sub/b.txt']) === 'second\n' && !('a.txt' in ws12.files) && !('b.txt' in ws12.files), mv12.output);

    const mv13 = await M.executeTool('bash', 'mv a.txt missing-dir/x.txt', fixture());
    check('MV13 destination parent must exist', !mv13.success && mv13.output.includes('no such directory'), mv13.output);
  }

  // ---------- RM. remove ----------
  {
    const ws = fixture();
    const rm1 = await M.executeTool('bash', 'rm a.txt', ws);
    check('RM1 rm file', rm1.success && !('a.txt' in ws.files), rm1.output);

    const ws2 = fixture();
    const rm2 = await M.executeTool('bash', 'rm a.txt b.txt', ws2);
    check('RM2 rm multiple files', rm2.success && !('a.txt' in ws2.files) && !('b.txt' in ws2.files)
      && ('sub/c.txt' in ws2.files), rm2.output);

    const rm3 = await M.executeTool('bash', 'rm missing.txt', fixture());
    check('RM3 rm missing fails', !rm3.success && rm3.output.includes('no such file or directory'), rm3.output);

    const rm4 = await M.executeTool('bash', 'rm -f missing.txt', fixture());
    check('RM4 rm -f missing succeeds', rm4.success, rm4.output);

    const rm5 = await M.executeTool('bash', 'rm sub', fixture());
    check('RM5 rm directory without -r fails', !rm5.success && rm5.output.includes('is a directory'), rm5.output);

    const ws6 = fixture();
    const rm6 = await M.executeTool('bash', 'rm -r sub', ws6);
    check('RM6 rm -r recursive', rm6.success && !('sub/c.txt' in ws6.files) && !('sub/deep/d.txt' in ws6.files)
      && !(await ws6.exists('sub')) && ('a.txt' in ws6.files), rm6.output);

    const ws7 = fixture();
    const rm7 = await M.executeTool('bash', 'rm -rf sub', ws7);
    check('RM7 rm -rf combined flags', rm7.success && !(await ws7.exists('sub')), rm7.output);
    const ws7b = fixture();
    const rm7b = await M.executeTool('bash', 'rm -fr sub', ws7b);
    check('RM7b rm -fr combined flags', rm7b.success && !(await ws7b.exists('sub')), rm7b.output);

    const ws8 = fixture();
    const rm8 = await M.executeTool('bash', 'rm "dir with space/note.txt"', ws8);
    check('RM8 quoted path with spaces', rm8.success && !('dir with space/note.txt' in ws8.files), rm8.output);

    const ws9 = fixture();
    const rm9 = await M.executeTool('bash', 'rm ../evil.txt', ws9);
    check('RM9 path escape rejected', !rm9.success && rm9.output.includes('escapes workspace'), rm9.output);

    for (const spelled of ['/', '.', '/.', '/sub/..']) {
      const wsR = fixture();
      const rr = await M.executeTool('bash', 'rm -rf ' + spelled, wsR);
      check('RM10 rm -rf ' + spelled + ' refused, workspace intact', !rr.success
        && rr.output.includes('refusing to recursively remove workspace root')
        && ('a.txt' in wsR.files) && ('sub/deep/d.txt' in wsR.files), rr.output);
    }

    // recursive cancellation stops the traversal and reports what committed
    const ws11 = fixture();
    const ac11 = new AbortController();
    const origRemove11 = ws11.remove.bind(ws11);
    let removed = 0;
    ws11.remove = async (p) => { await origRemove11(p); if (++removed >= 2) ac11.abort(); };
    const rm11 = await M.executeTool('bash', 'rm -r sub', ws11, { signal: ac11.signal });
    check('RM11 recursive cancel stops deletion', !rm11.success && rm11.output.includes('cancelled')
      && removed === 2 && ('sub/c.txt' in ws11.files) && !('sub/deep/d.txt' in ws11.files),
      'removed=' + removed + ' | ' + rm11.output);
    check('RM11b cancel reports committed deletions, no fake rollback', rm11.output.includes('not rolled back')
      && rm11.output.includes('sub/deep'), rm11.output);

    const rm12 = await M.executeTool('bash', 'rm', fixture());
    check('RM12 rm without operands → usage error', !rm12.success && rm12.output.includes('usage: rm'), rm12.output);
    const rm12b = await M.executeTool('bash', 'rm -f', fixture());
    check('RM12b rm -f without operands succeeds', rm12b.success, rm12b.output);

    const ws13 = fixture();
    const rm13 = await M.executeTool('bash', 'rm *.txt', ws13);
    check('RM13 glob is NOT expanded (* stays literal)', !rm13.success && rm13.output.includes('*.txt')
      && ('a.txt' in ws13.files), rm13.output);
  }

  // ---------- RD. generalized redirection ----------
  {
    const ws = fixture();
    const rd1 = await M.executeTool('bash', 'echo hello > r1.txt', ws);
    check('RD1 > truncates/creates, stdout consumed', rd1.success && rd1.output === ''
      && dec(ws.files['r1.txt']) === 'hello\n', rd1.output + ' | ' + dec(ws.files['r1.txt']));

    const rd2 = await M.executeTool('bash', 'echo again >> r1.txt', ws);
    check('RD2 >> appends', rd2.success && dec(ws.files['r1.txt']) === 'hello\nagain\n', dec(ws.files['r1.txt']));

    const rd3 = await M.executeTool('bash', 'cat missing 2> err.txt', ws);
    check('RD3 2> captures stderr, stdout untouched', !rd3.success && rd3.output === ''
      && dec(ws.files['err.txt']).includes('cat:'), rd3.output + ' | ' + dec(ws.files['err.txt']));

    const rd4 = await M.executeTool('bash', 'cat missing 2>> err.txt', ws);
    check('RD4 2>> appends stderr', !rd4.success
      && dec(ws.files['err.txt']).split('\n').filter(Boolean).length === 2, dec(ws.files['err.txt']));

    // order matters: > all.txt 2>&1 vs 2>&1 > out.txt
    const ws5 = fixture();
    const rd5 = await M.executeTool('bash', 'cat missing > all.txt 2>&1', ws5);
    check('RD5 > all.txt 2>&1 merges BOTH into the file', !rd5.success && rd5.output === ''
      && dec(ws5.files['all.txt']).includes('cat:'), rd5.output + ' | ' + dec(ws5.files['all.txt']));

    const ws6 = fixture();
    const rd6 = await M.executeTool('bash', 'cat missing 2>&1 > out.txt', ws6);
    check('RD6 2>&1 > out.txt keeps stderr captured, stdout to file', !rd6.success
      && rd6.output.includes('cat:') && ('out.txt' in ws6.files) && dec(ws6.files['out.txt']) === '',
      rd6.output + ' | ' + dec(ws6.files['out.txt']));
    check('RD6b the two orders observably differ', rd5.output !== rd6.output
      && !('all.txt' in ws6.files), 'same result');

    const ws7 = fixture();
    const rd7 = await M.executeTool('bash', 'cat missing 2> err.txt || echo fallback', ws7);
    check('RD7 redirect never turns failure into success (|| still fires)', rd7.success
      && rd7.output.includes('fallback') && dec(ws7.files['err.txt']).includes('cat:'), rd7.output);

    const rd8 = await M.executeTool('bash', 'echo hi >', fixture());
    check('RD8 missing redirect target', !rd8.success && rd8.output.includes('missing redirect target'), rd8.output);

    const rd9 = await M.executeTool('bash', 'echo hi 1>&2', fixture());
    check('RD9 unsupported fd 1>&2 rejected', !rd9.success && rd9.output.includes("unsupported redirect: '1>'"), rd9.output);
    const rd9b = await M.executeTool('bash', 'echo hi 3> f.txt', fixture());
    check('RD9b unsupported fd 3> rejected', !rd9b.success && rd9b.output.includes("unsupported redirect: '3>'"), rd9b.output);
    const rd9c = await M.executeTool('bash', 'echo hi &> f.txt', fixture());
    check('RD9c &> rejected', !rd9c.success && rd9c.output.includes("unsupported operator: '&'"), rd9c.output);

    const rd10 = await M.executeTool('bash', '> lonely.txt', fixture());
    check('RD10 redirect without command is a syntax error', !rd10.success && rd10.output.includes('without a command'),
      rd10.output);

    const ws11 = fixture();
    const rd11 = await M.executeTool('bash', 'echo hi > "my file.txt"', ws11);
    check('RD11 quoted redirect target with spaces', rd11.success && dec(ws11.files['my file.txt']) === 'hi\n', rd11.output);

    const rd12 = await M.executeTool('bash', 'echo hi > nowhere.txt', null);
    check('RD12 redirect without workspace fails cleanly', !rd12.success && rd12.output.includes('no workspace selected'),
      rd12.output);

    const ws13 = fixture();
    const rd13 = await M.executeTool('bash', 'echo hi > /rd13.txt', ws13);
    check('RD13 redirect target: / is workspace-root absolute', rd13.success && ('rd13.txt' in ws13.files), rd13.output);
    const rd14 = await M.executeTool('bash', 'echo hi > ../evil.txt', fixture());
    check('RD14 redirect target escape rejected', !rd14.success && rd14.output.includes('escapes workspace'), rd14.output);

    // echo > file writes an empty file; a failing command still truncates stdout target
    const ws15 = fixture();
    const rd15 = await M.executeTool('bash', 'echo > empty.txt', ws15);
    check('RD15 empty stdout still creates the file', rd15.success && ('empty.txt' in ws15.files)
      && dec(ws15.files['empty.txt']) === '', rd15.output);
  }

  // ---------- PS. pipeline + stderr routing ----------
  {
    const ws = fixture();
    const ps1 = await M.executeTool('bash', 'cat missing 2>&1 | wc -l', ws);
    check('PS1 2>&1 merges stderr INTO the pipe', ps1.success && ps1.output === '1', ps1.output);

    const ws2 = fixture();
    const ps2 = await M.executeTool('bash', 'cat missing 2> err.txt | wc -l', ws2);
    check('PS2 2> file keeps stderr OUT of the pipe', ps2.success && ps2.output === '0'
      && dec(ws2.files['err.txt']).includes('cat:'), ps2.output + ' | ' + dec(ws2.files['err.txt']));

    const ps3 = await M.executeTool('bash', 'echo hi 2>&1 | cat', fixture());
    check('PS3 2>&1 with clean command pipes stdout', ps3.success && ps3.output === 'hi', ps3.output);

    const ps4 = await runPipelineOf('cat missing | wc -c', fixture());
    check('PS4 unmerged stderr stays out of the pipe but surfaces', ps4.success && ps4.stdout === '0'
      && ps4.stderr.includes('cat:'), JSON.stringify(ps4));

    const ws5 = fixture();
    const ps5 = await M.executeTool('bash', 'cat a.txt > ps5.txt | wc -l', ws5);
    check('PS5 stdout redirected to file → downstream gets empty stdin', ps5.success && ps5.output === '0'
      && dec(ws5.files['ps5.txt']).includes('foo'), ps5.output);
  }

  // ---------- TEL. filesystem operation telemetry ----------
  {
    const ws = fixture();
    M.Telemetry.records.length = 0;
    const t1 = await M.executeTool('bash', 'mv a.txt tel1.txt', ws);
    const rec1 = M.Telemetry.records[M.Telemetry.records.length - 1];
    check('TEL1 mv → operation filesystem / backend browser', t1.success && rec1.operation === 'filesystem'
      && rec1.backend === 'browser' && rec1.success === true, JSON.stringify(rec1));
    const t2 = await M.executeTool('bash', 'rm tel1.txt', ws);
    const rec2 = M.Telemetry.records[M.Telemetry.records.length - 1];
    check('TEL2 rm → operation filesystem', t2.success && rec2.operation === 'filesystem' && rec2.success === true,
      JSON.stringify(rec2));
    const t3 = await M.executeTool('bash', 'echo x > tel3.txt', ws);
    const rec3 = M.Telemetry.records[M.Telemetry.records.length - 1];
    check('TEL3 stdout redirect → operation filesystem', t3.success && rec3.operation === 'filesystem',
      JSON.stringify(rec3));
  }

  // ---------- HELP2. registry / prompt co-source for round 2 ----------
  {
    const h = await M.executeTool('bash', 'help', fixture());
    check('HELP6 help lists mv and rm', h.success && h.output.includes('mv <src>... <dest>')
      && h.output.includes('rm [-f] [-r|-R]'), h.output.slice(0, 300));
    check('HELP7 help lists || and all redirects', h.output.includes('||')
      && h.output.includes('2>&1') && h.output.includes('2>>'), '');
    const prompt = M.shellSystemPromptSection();
    check('HELP8 prompt documents round 2 contract', prompt.includes('cmd1 || cmd2')
      && prompt.includes('2>&1') && prompt.includes('rm -rf /') && prompt.includes('glob')
      && prompt.includes('mv') && prompt.includes('rm'), '');
    check('HELP9 unsupported note no longer bans || or 2>', !prompt.includes('Not supported: ||')
      && M.shellHelpText().includes('Redirects:'), '');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
