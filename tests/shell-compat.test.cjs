// Shell compatibility baseline tests (node): command sequencing (; &&),
// pipelines (|), invocation-local cd / virtual cwd, ls flags, find, grep,
// head, tail, wc, help, quoted-operator safety, bounds and cancellation.
// Uses a hierarchical in-memory workspace (the flat MemWS in shell.test.cjs
// cannot represent directories). Run: node tests/shell-compat.test.cjs

const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

const src = ['telemetry.js', 'workspace.js', 'network.js', 'shell.js', 'tools.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n;\n');
const M = eval(src + '\n;({ WorkspaceAdapter, normalizeWorkspacePath, PythonRuntime, runShellCommand, executeTool,'
  + ' Telemetry, SHELL_COMMANDS, shellHelpText, shellSystemPromptSection, SHELL_PIPE_MAX_BYTES });');

// --- hierarchical in-memory workspace (byte-exact, deterministic order) ---
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
  async remove(p) { p = M.normalizeWorkspacePath(p); delete this.files[p]; }
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

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

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

const dec = (b) => new TextDecoder().decode(b || new Uint8Array());

function fixture() {
  return new TreeWS({
    'README.md': '# hello\nfoo line\nbar\n',
    'a.txt': 'foo\nbar\nfoo again\n',          // 18 bytes, 3 lines, 4 words
    'lines.txt': Array.from({ length: 20 }, (_, i) => 'L' + (i + 1)).join('\n') + '\n',
    'u.txt': '你好\n',                            // 7 UTF-8 bytes
    'k.bin': 'x'.repeat(1024),                   // exactly 1 KiB
    'sub/b.js': 'console.log(1)\n',
    'sub/deep/c.md': '# deep\n',
    'sub/.dotfile': 'x\n',
    '.hidden': 'secret\n',
    'dir with space/note.txt': 'space ok\n',
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function run() {
  // ---------- Q. quoted operators are DATA, never syntax ----------
  {
    const ws = fixture();
    const q1 = await M.executeTool('bash', 'echo "a;b"', ws);
    check('Q1 quoted semicolon is text', q1.success && q1.output === 'a;b', q1.output);
    const q2 = await M.executeTool('bash', "echo 'x|y'", ws);
    check('Q2 quoted pipe is text', q2.success && q2.output === 'x|y', q2.output);
    const q3 = await M.executeTool('bash', 'echo "x && y"', ws);
    check('Q3 quoted && is text', q3.success && q3.output === 'x && y', q3.output);
    const q4 = await M.executeTool('bash', 'echo "a && b"', ws);
    check('Q4 quoted && (2) is text', q4.success && q4.output === 'a && b', q4.output);
    const q5 = await M.executeTool('bash', 'echo ">" victim.txt', ws);
    check('Q5 quoted > writes nothing', q5.success && q5.output === '> victim.txt' && !('victim.txt' in ws.files));
  }

  // ---------- S. sequencing ----------
  {
    const ws = fixture();
    const s1 = await M.executeTool('bash', 'echo A; ls', ws);
    check('S1 ; sequence runs both', s1.success && s1.output.startsWith('A\n') && s1.output.includes('a.txt'), s1.output);
    const s2 = await M.executeTool('bash', 'echo one > s1.txt; echo two > s2.txt', ws);
    check('S2 both side effects commit', s2.success && dec(ws.files['s1.txt']) === 'one\n' && dec(ws.files['s2.txt']) === 'two\n');
    const s3 = await M.executeTool('bash', 'badcmd; echo after', ws);
    check('S3 ; continues after failure (status = last command)', s3.success
      && s3.output.includes('badcmd') && s3.output.includes('after'), s3.output);

    const a1 = await M.executeTool('bash', 'ls && cat a.txt', ws);
    check('A1 && runs second on success', a1.success && a1.output.includes('foo again'), a1.output);
    const a2 = await M.executeTool('bash', 'bad-command && echo should-not-run', ws);
    check('A2 && stops on failure', !a2.success && a2.output.includes('bad-command')
      && !a2.output.includes('should-not-run'), a2.output);
    const a3 = await M.executeTool('bash', 'cat missing.txt && echo nope > nope.txt', ws);
    check('A3 && blocks later side effect', !a3.success && !('nope.txt' in ws.files), a3.output);
  }

  // ---------- P. pipelines ----------
  {
    const ws = fixture();
    const p1 = await M.executeTool('bash', 'find . -type f | head -n 3', ws);
    check('P1 find | head works', p1.success && p1.output.split('\n').length === 3, p1.output);
    const p2 = await M.executeTool('bash', 'grep foo a.txt | wc -l', ws);
    check('P2 grep | wc -l', p2.success && p2.output === '2', p2.output);
    const p3 = await M.executeTool('bash', 'cat a.txt | grep bar', ws);
    check('P3 cat | grep', p3.success && p3.output === 'bar', p3.output);
    const p4 = await M.executeTool('bash', 'echo hi | cat', ws);
    check('P4 echo | cat', p4.success && p4.output === 'hi', p4.output);
    const p5 = await M.executeTool('bash', 'echo hi | ls', ws);
    check('P5 pipe into non-stdin command fails loudly', !p5.success && p5.output.includes('does not read stdin'), p5.output);
    const p6 = await M.executeTool('bash', 'find . -type f | grep "\\.md" | head -n 20', ws);
    check('P6 three-stage pipeline', p6.success && p6.output.includes('./README.md')
      && p6.output.includes('./sub/deep/c.md') && !p6.output.includes('a.txt'), p6.output);

    // intermediate stage output over SHELL_PIPE_MAX_BYTES fails loudly
    const wsBig = new TreeWS({ 'big.txt': 'x'.repeat(M.SHELL_PIPE_MAX_BYTES + 100) + '\n' }); // one huge matching line
    const p7 = await M.executeTool('bash', 'grep x big.txt | wc -l', wsBig);
    check('P7 oversized pipeline stage fails loudly', !p7.success && p7.output.includes('pipeline stage output exceeds'),
      p7.output.slice(0, 120));
  }

  // ---------- L. ls flags ----------
  {
    const ws = fixture();
    const l1 = await M.executeTool('bash', 'ls', ws);
    check('L1 ls hides dotfiles by default', l1.success && !l1.output.includes('.hidden')
      && l1.output.includes('a.txt') && l1.output.includes('sub/'), l1.output);
    const l2 = await M.executeTool('bash', 'ls -a', ws);
    check('L2 ls -a shows dotfiles', l2.success && l2.output.includes('.hidden'), l2.output);
    const l3 = await M.executeTool('bash', 'ls -l', ws);
    check('L3 ls -l long format', l3.success && /^- 18 a\.txt$/m.test(l3.output) && /^d 0 sub\/$/m.test(l3.output), l3.output);
    const l4 = await M.executeTool('bash', 'ls -lh', ws);
    check('L4 ls -lh human sizes', l4.success && l4.output.includes('18 B') && l4.output.includes('1.0 KiB'), l4.output);
    const l5 = await M.executeTool('bash', 'ls -l', ws);
    check('L5 raw bytes without -h', l5.success && l5.output.includes('1024') && !l5.output.includes('KiB'), l5.output);
    const l6 = await M.executeTool('bash', 'ls -la sub', ws);
    check('L6 ls -la path', l6.success && l6.output.includes('.dotfile') && l6.output.includes('deep/'), l6.output);
    const l7 = await M.executeTool('bash', 'ls -lah', ws);
    check('L7 combined -lah', l7.success && l7.output.includes('.hidden') && l7.output.includes('KiB'), l7.output);
    const l8 = await M.executeTool('bash', 'ls -al sub', ws);
    check('L8 combined -al path', l8.success && l8.output.includes('.dotfile'), l8.output);
    const l9 = await M.executeTool('bash', 'ls -R', ws);
    check('L9 unknown option error lists supported', !l9.success && l9.output.includes('ls: unsupported option: -R')
      && l9.output.includes('-a -l -h'), l9.output);
    const l10 = await M.executeTool('bash', 'ls missing', ws);
    check('L10 missing path error', !l10.success && l10.output.includes('no such file or directory'), l10.output);
    const l11 = await M.executeTool('bash', 'ls "dir with space"', ws);
    check('L11 quoted path with spaces', l11.success && l11.output === 'note.txt', l11.output);
    const l12 = await M.executeTool('bash', 'ls README.md a.txt', ws);
    check('L12 multiple file operands', l12.success && l12.output.includes('README.md') && l12.output.includes('a.txt'), l12.output);
  }

  // ---------- C. cd / virtual cwd ----------
  {
    const ws = fixture();
    const c1 = await M.executeTool('bash', 'pwd', ws);
    check('C1 pwd starts at /', c1.success && c1.output === '/', c1.output);
    const c2 = await M.executeTool('bash', 'cd sub && pwd', ws);
    check('C2 cd && pwd', c2.success && c2.output === '/sub', c2.output);
    const c3 = await M.executeTool('bash', 'cd sub && cat b.js', ws);
    check('C3 relative file resolves against cwd', c3.success && c3.output.includes('console.log(1)'), c3.output);
    const c4 = await M.executeTool('bash', 'cd sub; ls', ws);
    check('C4 cd ; ls', c4.success && c4.output.includes('b.js') && !c4.output.includes('a.txt'), c4.output);
    const c5 = await M.executeTool('bash', 'pwd', ws);
    check('C5 next invocation starts at root again', c5.success && c5.output === '/', c5.output);
    const c6 = await M.executeTool('bash', 'cd ../..', ws);
    check('C6 cd above root rejected (confinement)', !c6.success && c6.output.includes('escapes workspace'), c6.output);
    const c7 = await M.executeTool('bash', 'cd sub && cd ../../.. && pwd', ws);
    check('C7 nested escape rejected', !c7.success && c7.output.includes('escapes workspace'), c7.output);
    const c8 = await M.executeTool('bash', 'cd sub && cd .. && pwd', ws);
    check('C8 cd .. back to root', c8.success && c8.output === '/', c8.output);
    const c9 = await M.executeTool('bash', 'cd "dir with space" && pwd', ws);
    check('C9 quoted dir with spaces', c9.success && c9.output === '/dir with space', c9.output);
    const c10 = await M.executeTool('bash', 'cd missing', ws);
    check('C10 cd missing', !c10.success && c10.output.includes('no such directory'), c10.output);
    const c11 = await M.executeTool('bash', 'cd a.txt', ws);
    check('C11 cd onto file', !c11.success && c11.output.includes('not a directory'), c11.output);
    const c12 = await M.executeTool('bash', 'cd sub && echo hi > n.txt', ws);
    check('C12 redirect writes under cwd', c12.success && dec(ws.files['sub/n.txt']) === 'hi\n', JSON.stringify(Object.keys(ws.files)));
    const c13 = await M.executeTool('bash', 'cd sub && cat /a.txt', ws);
    check('C13 absolute path is workspace-root relative', c13.success && c13.output.includes('foo again'), c13.output);

    // python script path resolves against the shell cwd (Python root unchanged)
    const wsP = new TreeWS({ 'sub/script.py': 'print(1)\n' });
    mockWorkerResult({ stdout: 'ok', stderr: '', error: null, files: [], deleted: [] });
    const c14 = await M.executeTool('bash', 'cd sub && python script.py', wsP);
    check('C14 cd && python script.py resolves script under cwd', c14.success && c14.output.includes('ok'), c14.output);
    const c15 = await M.executeTool('bash', 'cd sub && python missing.py', wsP);
    check('C15 missing script error', !c15.success && c15.output.includes("can't open file"), c15.output);
  }

  // ---------- F. find ----------
  {
    const ws = fixture();
    const f1 = await M.executeTool('bash', 'find . -type f', ws);
    const f1again = await M.executeTool('bash', 'find . -type f', ws);
    check('F1 find lists files', f1.success && f1.output.includes('./a.txt') && f1.output.includes('./sub/deep/c.md')
      && f1.output.includes('./.hidden') && !f1.output.includes('./sub\n'), f1.output);
    check('F1b find is deterministic', f1.output === f1again.output);
    const f2 = await M.executeTool('bash', 'find . -name "*.js"', ws);
    check('F2 find -name glob', f2.success && f2.output === './sub/b.js', f2.output);
    const f3 = await M.executeTool('bash', 'find . -type d', ws);
    check('F3 find -type d', f3.success && f3.output.includes('./sub') && f3.output.includes('./sub/deep')
      && !f3.output.includes('a.txt'), f3.output);
    const f4 = await M.executeTool('bash', 'find . -maxdepth 1', ws);
    check('F4 find -maxdepth 1', f4.success && f4.output.includes('./sub') && f4.output.includes('./a.txt')
      && !f4.output.includes('deep'), f4.output);
    const f5 = await M.executeTool('bash', 'find . -maxdepth 0', ws);
    check('F5 find -maxdepth 0 prints start only', f5.success && f5.output === '.', f5.output);
    const f6 = await M.executeTool('bash', 'find sub -name "?.js"', ws);
    check('F6 find -name ? glob', f6.success && f6.output === 'sub/b.js', f6.output);
    const f7 = await M.executeTool('bash', 'find missing', ws);
    check('F7 find missing path', !f7.success && f7.output.includes('no such file or directory'), f7.output);
    const f8 = await M.executeTool('bash', 'find . -exec rm', ws);
    check('F8 unsupported predicate fails with guidance', !f8.success && f8.output.includes('find: unsupported predicate: -exec'), f8.output);
    const f9 = await M.executeTool('bash', 'find src -name "*.java" -type f', ws);
    check('F9 combined predicates on missing dir fail cleanly', !f9.success && f9.output.includes('no such'), f9.output);
    const f10 = await M.executeTool('bash', 'find sub -maxdepth 1 -type f', ws);
    check('F10 combined -maxdepth -type', f10.success && f10.output === 'sub/.dotfile\nsub/b.js', f10.output);

    // cancellation stops traversal
    const wsC = fixture();
    const ac = new AbortController();
    let lists = 0;
    const origList = wsC.list.bind(wsC);
    wsC.list = async (p) => { lists++; if (lists >= 2) ac.abort(); return origList(p); };
    const f11 = await M.runShellCommand('find .', wsC, { signal: ac.signal });
    check('F11 find honours cancellation mid-traversal', f11.isError && f11.output.includes('cancelled'), f11.output);
  }

  // ---------- G. grep ----------
  {
    const ws = fixture();
    const g1 = await M.executeTool('bash', 'grep foo a.txt', ws);
    check('G1 grep file', g1.success && g1.output === 'foo\nfoo again', g1.output);
    const g2 = await M.executeTool('bash', 'grep -n foo a.txt', ws);
    check('G2 grep -n', g2.success && g2.output === '1:foo\n3:foo again', g2.output);
    const g3 = await M.executeTool('bash', 'grep -i FOO a.txt', ws);
    check('G3 grep -i', g3.success && g3.output === 'foo\nfoo again', g3.output);
    const g4 = await M.executeTool('bash', 'grep -r foo .', ws);
    check('G4 grep -r prefixes paths', g4.success && g4.output.includes('./a.txt:foo') && g4.output.includes('./README.md:foo line'), g4.output);
    const g5 = await M.executeTool('bash', 'grep -Rn foo .', ws);
    check('G5 combined -Rn', g5.success && g5.output.includes('./README.md:2:foo line'), g5.output);
    const g6 = await M.executeTool('bash', 'grep [ a.txt', ws);
    check('G6 invalid regex fails clearly', !g6.success && g6.output.includes('grep: invalid pattern'), g6.output);
    const g7 = await M.executeTool('bash', 'grep foo sub', ws);
    check('G7 directory without -r', !g7.success && g7.output.includes('is a directory'), g7.output);
    const g8 = await M.executeTool('bash', 'echo "hello world" | grep "o.w"', ws);
    check('G8 regex semantics on stdin', g8.success && g8.output === 'hello world', g8.output);
    const g9 = await M.executeTool('bash', 'grep zzz a.txt', ws);
    check('G9 no match = successful empty answer', g9.success && g9.output === '', JSON.stringify(g9));
    const g10 = await M.executeTool('bash', 'grep foo', ws);
    check('G10 no file and no stdin fails', !g10.success && g10.output.includes('missing file operand'), g10.output);
    const g11 = await M.executeTool('bash', 'grep -P foo a.txt', ws);
    check('G11 unsupported option lists supported', !g11.success && g11.output.includes('grep: unsupported option: -P'), g11.output);

    // binary / non-UTF-8 files are skipped safely, with a note
    const wsB = fixture();
    wsB.files['bin.dat'] = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    const g12 = await M.executeTool('bash', 'grep -r foo .', wsB);
    check('G12 non-UTF-8 file skipped with note', g12.success && g12.output.includes('skipped') && g12.output.includes('bin.dat'), g12.output.slice(-200));

    // match cap truncates with an explicit note
    const wsM = new TreeWS({ 'm.txt': Array(600).fill('hit').join('\n') + '\n' });
    const g13 = await M.executeTool('bash', 'grep hit m.txt', wsM);
    check('G13 match cap truncates with note', g13.success && g13.output.split('\n').length === 501
      && g13.output.includes('truncated'), 'lines=' + g13.output.split('\n').length);

    // cancellation stops recursive grep
    const wsC = fixture();
    const ac = new AbortController();
    let lists = 0;
    const origList = wsC.list.bind(wsC);
    wsC.list = async (p) => { lists++; if (lists >= 2) ac.abort(); return origList(p); };
    const g14 = await M.runShellCommand('grep -r foo .', wsC, { signal: ac.signal });
    check('G14 recursive grep honours cancellation', g14.isError && g14.output.includes('cancelled'), g14.output);
  }

  // ---------- H/T. head / tail ----------
  {
    const ws = fixture();
    const h1 = await M.executeTool('bash', 'head lines.txt', ws);
    check('H1 head default 10', h1.success && h1.output.split('\n').length === 10 && h1.output.startsWith('L1\n'), h1.output);
    const h2 = await M.executeTool('bash', 'head -n 3 lines.txt', ws);
    check('H2 head -n 3', h2.success && h2.output === 'L1\nL2\nL3', h2.output);
    const h3 = await M.executeTool('bash', 'cat lines.txt | head -n 2', ws);
    check('H3 head from stdin', h3.success && h3.output === 'L1\nL2', h3.output);
    const h4 = await M.executeTool('bash', 'head -x lines.txt', ws);
    check('H4 head unsupported option', !h4.success && h4.output.includes('head: unsupported option'), h4.output);
    const t1 = await M.executeTool('bash', 'tail -n 2 lines.txt', ws);
    check('HT1 tail -n 2', t1.success && t1.output === 'L19\nL20', t1.output);
    const t2 = await M.executeTool('bash', 'tail -n +19 lines.txt', ws);
    check('HT2 tail -n +N', t2.success && t2.output === 'L19\nL20', t2.output);
    const t3 = await M.executeTool('bash', 'tail -n 30 lines.txt', ws);
    check('HT3 tail larger than file', t3.success && t3.output.split('\n').length === 20, t3.output);
    const t4 = await M.executeTool('bash', 'cat lines.txt | tail -n 1', ws);
    check('HT4 tail from stdin', t4.success && t4.output === 'L20', t4.output);
    const t5 = await M.executeTool('bash', 'tail -n -3 lines.txt', ws);
    check('HT5 tail rejects invalid count', !t5.success && t5.output.includes('invalid line count'), t5.output);
  }

  // ---------- W. wc ----------
  {
    const ws = fixture();
    const w1 = await M.executeTool('bash', 'wc a.txt', ws);
    check('W1 wc default l/w/c', w1.success && w1.output === '3 4 18 a.txt', w1.output);
    const w2 = await M.executeTool('bash', 'wc -l a.txt', ws);
    check('W2 wc -l', w2.success && w2.output === '3 a.txt', w2.output);
    const w3 = await M.executeTool('bash', 'wc -w a.txt', ws);
    check('W3 wc -w', w3.success && w3.output === '4 a.txt', w3.output);
    const w4 = await M.executeTool('bash', 'wc -c u.txt', ws);
    check('W4 wc -c counts UTF-8 bytes', w4.success && w4.output === '7 u.txt', w4.output);
    const w5 = await M.executeTool('bash', 'echo 你好 | wc -c', ws);
    check('W5 wc -c stdin UTF-8 bytes', w5.success && w5.output === '6', w5.output);
    const w6 = await M.executeTool('bash', 'cat a.txt | wc -l', ws);
    check('W6 wc -l stdin', w6.success && w6.output === '3', w6.output);
    const w7 = await M.executeTool('bash', 'wc -l a.txt u.txt', ws);
    check('W7 wc multiple files + total', w7.success && w7.output.includes('3 a.txt') && w7.output.includes('1 u.txt')
      && w7.output.includes('4 total'), w7.output);
    const w8 = await M.executeTool('bash', 'wc -x a.txt', ws);
    check('W8 wc unsupported option', !w8.success && w8.output.includes('wc: unsupported option: -x'), w8.output);
  }

  // ---------- X. unsupported syntax / operator errors ----------
  {
    const ws = fixture();
    const x1 = await M.executeTool('bash', 'ls || pwd', ws);
    check('X1 || unsupported', !x1.success && x1.output.includes("unsupported operator: '||'"), x1.output);
    const x2 = await M.executeTool('bash', 'ls & pwd', ws);
    check('X2 background & unsupported', !x2.success && x2.output.includes("unsupported operator: '&'"), x2.output);
    const x3 = await M.executeTool('bash', 'cat < a.txt', ws);
    check('X3 input redirect unsupported', !x3.success && x3.output.includes("unsupported operator: '<'"), x3.output);
    const x4 = await M.executeTool('bash', 'echo hi 2> err.txt', ws);
    check('X4 2> unsupported', !x4.success && x4.output.includes("unsupported redirect: '2>'") && !('err.txt' in ws.files), x4.output);
    const x5 = await M.executeTool('bash', 'ls |', ws);
    check('X5 trailing pipe syntax error', !x5.success && x5.output.includes("empty command after '|'"), x5.output);
    const x6 = await M.executeTool('bash', 'ls &&', ws);
    check('X6 trailing && syntax error', !x6.success && x6.output.includes("empty command after '&&'"), x6.output);
    const x7 = await M.executeTool('bash', 'sudo rm x', ws);
    check('X7 unknown command suggests help', !x7.success && x7.output.includes('sudo') && x7.output.includes('help'), x7.output);
    const x8 = await M.executeTool('bash', 'echo $(pwd)', ws);
    check('X8 $() is literal text, not executed', x8.success && x8.output === '$(pwd)', x8.output);
  }

  // ---------- HELP. help + registry/prompt co-source ----------
  {
    const ws = fixture();
    const h = await M.executeTool('bash', 'help', ws);
    check('HELP1 help succeeds and lists commands', h.success && h.output.includes('Unix-like compatibility shell'), h.output.slice(0, 120));
    const names = Object.keys(M.SHELL_COMMANDS);
    check('HELP2 help text contains every command', names.every((n) => h.output.includes(n)), names.join(','));
    const prompt = M.shellSystemPromptSection();
    check('HELP3 prompt section contains every command usage',
      names.every((n) => prompt.includes(M.SHELL_COMMANDS[n].usage)), names.join(','));
    check('HELP4 prompt states the contract', prompt.includes('NOT full POSIX bash')
      && prompt.includes('Paths containing spaces must be quoted')
      && prompt.includes('starts at the mounted workspace root'));
    check('HELP5 help and prompt come from one registry',
      h.output === M.shellHelpText() && h.output.includes(';') && h.output.includes('&&') && h.output.includes('|'));
  }

  // ---------- K. cancellation between sequence commands ----------
  {
    const ws = fixture();
    const ac = new AbortController();
    const origWrite = ws.write.bind(ws);
    let writes = 0;
    ws.write = async (p, d) => { writes++; await origWrite(p, d); ac.abort(); };
    const k1 = await M.executeTool('bash', 'echo A > ka.txt; echo B > kb.txt', ws, { signal: ac.signal });
    check('K1 cancel between commands stops side effects', !k1.success && ('ka.txt' in ws.files) && !('kb.txt' in ws.files),
      JSON.stringify(Object.keys(ws.files).filter((f) => f.startsWith('k'))) + ' | ' + k1.output);
    check('K1b output reports cancellation', k1.output.includes('cancelled'), k1.output);
  }

  // ---------- N. network metadata through compound commands ----------
  {
    const ws = fixture();
    const origFetch = global.fetch;
    global.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const n1 = await M.executeTool('bash', 'echo start; curl https://example.test/x', ws);
      check('N1 single network op keeps real backend', n1.success && n1.backend === 'browser-direct'
        && n1.operation === 'network', n1.backend + '/' + n1.operation);
      const rec = M.Telemetry.records[M.Telemetry.records.length - 1];
      check('N1b telemetry carries network operation', rec.operation === 'network' && rec.backend === 'browser-direct'
        && rec.success === true, JSON.stringify(rec));
      const n2 = await M.executeTool('bash', 'curl https://example.test/a; curl https://example.test/b', ws);
      check('N2 multiple network ops marked compound', n2.success && n2.operation === 'compound' && n2.backend === 'browser',
        n2.backend + '/' + n2.operation);
      const n3 = await M.executeTool('bash', 'curl https://example.test/x | head -n 1', ws);
      check('N3 network op inside pipeline propagates', n3.success && n3.backend === 'browser-direct'
        && n3.operation === 'network' && n3.output === '{"ok":true}', n3.backend + '/' + n3.operation + ' | ' + n3.output);
    } finally {
      global.fetch = origFetch;
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
