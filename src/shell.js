// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local `bash` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
// ============================================================

const PYTHON_TIMEOUT_MS = 30000;

function makeCancelledError(what) {
  const e = new Error((what || 'operation') + ' cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

function isCancelledError(e) {
  return !!e && (e.cancelled || e.name === 'AbortError');
}

// Uniform cancellation gate used by python commits, echo redirects, curl
// downloads and workspace collection: re-checked after every async
// pre-check, before every side effect.
function throwIfCancelled(signal, what) {
  if (signal && signal.aborted) throw makeCancelledError(what || 'operation');
}

// ---------- Python runtime bridge (Web Worker + lazy Pyodide) ----------
const PythonRuntime = {
  worker: null,
  status: 'cold', // cold | loading | ready
  _reqId: 0,
  _pending: new Map(),

  _ensureWorker() {
    if (this.worker) return;
    const src = document.getElementById('py-worker-src').textContent;
    const blob = new Blob([src], { type: 'text/javascript' });
    // The Blob URL is only needed to construct the Worker; revoke it
    // immediately so repeated worker timeout/recovery cycles do not
    // accumulate live Blob URLs.
    const workerUrl = URL.createObjectURL(blob);
    try {
      this.worker = new Worker(workerUrl);
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
    this.worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const pending = this._pending.get(msg.id);
      if (msg.type === 'status') {
        this._setStatus(msg.status);
        return;
      }
      if (msg.type === 'result' && pending) {
        this._pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
    };
    this.worker.onerror = (e) => {
      // A fatal worker error kills the interpreter: fail pending calls AND
      // destroy the worker so the next run boots a fresh one. (Ordinary
      // Python exceptions never reach here — they come back as result.error.)
      const message = 'worker error: ' + (e && e.message ? e.message : 'unknown');
      if (this.worker) {
        try { this.worker.terminate(); } catch (err) {}
        this.worker = null;
      }
      this._failAllPending(message);
      this._setStatus('cold');
    };
  },

  // Terminate the worker (timeout, cancellation, fatal error), fail every
  // pending request, and reset so the next call boots a fresh worker.
  _killWorker(reason) {
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }
    this._failAllPending(reason || ('python execution timed out after ' + PYTHON_TIMEOUT_MS + 'ms'));
    this._setStatus('cold');
  },

  // Session boundary: drop the entire interpreter (globals, imported
  // modules, /tmp files, pending state). Called on workspace switch and
  // on explicit session reset so no Python state leaks across sessions.
  reset() {
    if (this.worker || this._pending.size) {
      this._killWorker('python runtime reset (session boundary)');
    }
  },

  _failAllPending(errorMessage) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve({ stdout: '', stderr: '', error: errorMessage, files: [], deleted: [] });
    }
    this._pending.clear();
  },

  _setStatus(status) {
    this.status = status;
    const el = document.getElementById('sb-python');
    if (el) {
      el.textContent = 'Python: ' + status;
      el.className = status;
    }
  },

  // Run Python code with the workspace mirrored in.
  // opts.signal (optional AbortSignal) cancels the run: cancellation is
  // checked before starting, during workspace collection, after the worker
  // reply, after EVERY async pre-check and before EVERY commit side effect.
  // Commits already finished are not rolled back — the result reports
  // exactly what committed and what never ran.
  // Returns {
  //   stdout, stderr, error,            — compute outcome
  //   written, deleted,                 — paths actually committed
  //   conflicts: [{path, reason}],      — commits refused (external change / unsynced path)
  //   writeFailed: [description],       — commits attempted but failed
  //   notPersisted: [paths],            — generated files never written (no workspace / cancelled)
  //   skipped: [{path, reason}],        — workspace files NOT mirrored into Python
  //   uncollected: [paths],             — python outputs over the worker caps (changeset incomplete)
  //   stdoutTruncated, stderrTruncated, — output notice flags (NOT commit failures)
  // }
  async run(code, workspace, opts) {
    const signal = opts && opts.signal;
    this._ensureWorker();
    this._setStatus('loading');
    throwIfCancelled(signal, 'python execution');

    let files = [];
    let skipped = [];
    const snapshot = {}; // path → b64 at sync-in time (optimistic concurrency base)
    if (workspace) {
      const collected = await collectWorkspaceFiles(workspace, signal);
      files = collected.files;
      skipped = collected.skipped;
      for (const f of files) snapshot[f.path] = f.b64;
    }
    // The abort may have landed DURING collection (no listener was attached
    // yet) — never start the worker run on a cancelled task.
    throwIfCancelled(signal, 'python execution');

    const id = ++this._reqId;
    const onAbort = () => this._killWorker('python execution cancelled');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let result;
    try {
      result = await new Promise((resolve) => {
        const timer = setTimeout(
          () => this._killWorker('python execution timed out after ' + PYTHON_TIMEOUT_MS + 'ms'),
          PYTHON_TIMEOUT_MS);
        this._pending.set(id, { resolve, timer });
        this.worker.postMessage({ id, cmd: 'run', code, files });
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    throwIfCancelled(signal, 'python execution');

    const skippedSet = new Set(skipped.map((s) => s.path));
    const uncollected = result.uncollectedFiles || [];
    const written = [];
    const conflicts = [];
    const writeFailed = [];
    const notPersisted = [];
    const outFiles = result.files || [];

    for (const p of uncollected) {
      notPersisted.push(p + ' (over python output limit; changeset incomplete)');
    }

    if (!workspace && outFiles.length) {
      // Files were generated but there is nowhere to persist them — say so.
      for (const f of outFiles) notPersisted.push(f.path);
    }

    // ---- commit phase 1: create/modify ----
    if (workspace && outFiles.length) {
      for (const f of outFiles) {
        if (signal && signal.aborted) {
          notPersisted.push(f.path + ' (cancelled before write)');
          continue;
        }
        if (skippedSet.has(f.path)) {
          // The real file exists but was never mirrored in (over the size
          // or count limit). Python saw this path as absent; whatever it
          // created there must NOT clobber the real file.
          conflicts.push({
            path: f.path,
            reason: 'exists in workspace but was not synced into Python (over snapshot limits); refusing to overwrite',
          });
          continue;
        }
        const bytes = b64ToBytes(f.b64);
        let conflict = null;
        try {
          conflict = await detectExternalChange(workspace, f.path, snapshot, bytes);
        } catch (e) {
          conflict = { path: f.path, reason: 'could not verify current on-disk state (' + e.message + '); refusing to overwrite' };
        }
        if (conflict) {
          conflicts.push(conflict);
          continue;
        }
        // The pre-check awaited: cancellation may have landed meanwhile.
        // Re-check BEFORE the side effect, not just at the loop top.
        if (signal && signal.aborted) {
          notPersisted.push(f.path + ' (cancelled before write)');
          continue;
        }
        try {
          await workspace.write(f.path, bytes);
          written.push(f.path);
        } catch (e) {
          writeFailed.push(f.path + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    }

    // ---- commit phase 2: deletions (rename = delete + create) ----
    // If ANY write failed, was refused, or the worker could not collect the
    // full changeset, the run's new state is incomplete — deleting sources
    // could destroy the only good copy (e.g. a rename whose target never
    // landed). Stop the delete phase.
    const deleted = [];
    const deletesBlocked = writeFailed.length > 0 || conflicts.length > 0 || uncollected.length > 0;
    if (workspace && result.deleted && result.deleted.length && !deletesBlocked) {
      for (const p of result.deleted) {
        if (signal && signal.aborted) {
          notPersisted.push('delete ' + p + ' (cancelled before commit)');
          continue;
        }
        // Only delete the exact content we mirrored: re-read and compare
        // against the snapshot so an externally modified/replaced file is
        // never removed from under the user.
        if (snapshot[p] !== undefined) {
          let currentB64 = null;
          try {
            currentB64 = bytesToB64(await workspace.readBytes(p));
          } catch (e) {
            if (e && e.name === 'NotFoundError') continue; // already gone externally
            conflicts.push({ path: p, reason: 'could not verify current on-disk state (' + e.message + '); deletion skipped' });
            continue;
          }
          if (currentB64 !== snapshot[p]) {
            conflicts.push({ path: p, reason: 'modified externally during the run; deletion skipped' });
            continue;
          }
        }
        // Verification awaited: re-check cancellation BEFORE removing.
        if (signal && signal.aborted) {
          notPersisted.push('delete ' + p + ' (cancelled before commit)');
          continue;
        }
        try {
          await workspace.remove(p);
          deleted.push(p);
        } catch (e) {
          writeFailed.push('delete ' + p + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    } else if (workspace && result.deleted && result.deleted.length && deletesBlocked) {
      const why = uncollected.length > 0
        ? 'output changeset incomplete (' + uncollected.length + ' file(s) not collected), sources preserved'
        : 'earlier commits failed, sources preserved';
      notPersisted.push('deletions skipped (' + result.deleted.join(', ') + '): ' + why);
    }

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
      written,
      deleted,
      conflicts,
      writeFailed,
      notPersisted,
      skipped,
      uncollected,
      stdoutTruncated: !!result.stdoutTruncated,
      stderrTruncated: !!result.stderrTruncated,
      inputBytes: files.reduce((n, f) => n + b64ByteLength(f.b64), 0),
      outputBytes: outFiles.reduce((n, f) => n + b64ByteLength(f.b64), 0),
    };
  },
};

// Optimistic concurrency check before committing a create/modify.
// Returns null when the write is safe, or {path, reason} when the real
// file diverged from what Python saw (external edit/create/delete during
// the run). The user's newer on-disk content always wins.
async function detectExternalChange(workspace, path, snapshot, newBytes) {
  if (snapshot[path] !== undefined) {
    // File existed at sync-in: it must still exist with identical content.
    let current;
    try {
      current = await workspace.readBytes(path);
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        return { path, reason: 'deleted externally during the run; refusing to recreate' };
      }
      throw e;
    }
    if (bytesToB64(current) !== snapshot[path]) {
      return { path, reason: 'modified externally during the run; on-disk version kept' };
    }
    return null;
  }
  // New file from Python's point of view: safe unless someone else created
  // a different file at this path meanwhile.
  let exists = false;
  try {
    exists = await workspace.exists(path);
  } catch (e) {
    throw e;
  }
  if (!exists) return null;
  const current = await workspace.readBytes(path);
  if (current.byteLength !== newBytes.byteLength || bytesToB64(current) !== bytesToB64(newBytes)) {
    return { path, reason: 'created externally during the run; on-disk version kept' };
  }
  return null; // identical content — writing is a no-op
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Real byte count of a base64 payload, excluding padding (length*0.75
// would count a 1-byte payload as 3 bytes).
function b64ByteLength(b64) {
  const len = String(b64 || '').length;
  if (!len) return 0;
  let pad = 0;
  if (b64[len - 1] === '=') pad++;
  if (b64[len - 2] === '=') pad++;
  return Math.floor(len / 4) * 3 - pad;
}

// Snapshot workspace files for the Python mirror. Caps keep V0 sane.
// IMPORTANT: a capped snapshot is not the workspace. Every skipped path
// is recorded explicitly so (a) the model is told exactly what Python
// cannot see and (b) the write-back phase can refuse to overwrite those
// paths with files Python created in their absence.
const SYNC_MAX_FILES = 200;
const SYNC_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SYNC_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

async function collectWorkspaceFiles(workspace, signal) {
  const files = [];
  const skipped = [];
  let total = 0;

  async function walk(rel) {
    throwIfCancelled(signal, 'workspace collection');
    const entries = await workspace.list(rel);
    throwIfCancelled(signal, 'workspace collection');
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.kind === 'directory') {
        await walk(childRel);
        continue;
      }
      if (files.length >= SYNC_MAX_FILES) {
        skipped.push({ path: childRel, reason: 'over ' + SYNC_MAX_FILES + '-file snapshot limit' });
        continue;
      }
      const st = await workspace.stat(childRel);
      if (st.size > SYNC_MAX_FILE_BYTES) {
        skipped.push({ path: childRel, reason: st.size + ' bytes, over per-file limit of ' + SYNC_MAX_FILE_BYTES });
        continue;
      }
      if (total + st.size > SYNC_MAX_TOTAL_BYTES) {
        skipped.push({ path: childRel, reason: 'over total snapshot limit of ' + SYNC_MAX_TOTAL_BYTES + ' bytes' });
        continue;
      }
      const bytes = await workspace.readBytes(childRel);
      throwIfCancelled(signal, 'workspace collection');
      total += bytes.byteLength;
      files.push({ path: childRel, b64: bytesToB64(bytes) });
    }
  }

  await walk('');
  return { files, skipped };
}

// ---------- shell ----------
// Unix-like COMPATIBILITY shell — NOT full POSIX bash. Structure:
//   input → tokenizer → small parser (command list / pipelines) → executor
// No eval, no system shell: every simple command lands in an explicit,
// controlled handler from SHELL_COMMANDS. Quoted text is always DATA,
// never syntax: `echo "a;b"` prints text, it is never split.

// Bounds for command composition and recursive traversal.
const SHELL_PIPE_MAX_BYTES = 1024 * 1024; // intermediate stdout between pipeline stages
const CAT_MAX_FILE_BYTES = 512 * 1024;
const FIND_MAX_VISITED = 5000;            // entries visited per find run
const FIND_MAX_RESULTS = 1000;            // paths emitted per find run
const GREP_MAX_FILES = 500;               // files searched per recursive grep
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_MAX_MATCHES = 500;

// Tokenize one command line, keeping quote/operator information.
// Returns [{text, quoted, op, pos}] — quoted text is DATA, never syntax, so
// `echo ">" victim.txt` prints text instead of redirecting into a file.
// `pos` is the start offset in the line (used to detect glued `2>` redirects).
// Throws on unclosed quotes.
function shellTokenize(line) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let has = false;
  let start = 0;
  const push = () => {
    if (has) tokens.push({ text: cur, quoted: quoted, op: false, pos: start });
    cur = '';
    quoted = false;
    has = false;
  };
  let i = 0;
  const s = String(line || '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      if (!has) start = i;
      const close = s.indexOf(c, i + 1);
      if (close === -1) throw new Error('unclosed quote in command line');
      cur += s.slice(i + 1, close);
      quoted = true;
      has = true;
      i = close + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '>' && has && !quoted && cur === '2') {
      // Glued stderr redirects: 2> / 2>> / 2>&1 are single operators.
      cur = '';
      has = false;
      if (s[i + 1] === '&' && s[i + 2] === '1') {
        tokens.push({ text: '2>&1', quoted: false, op: true, pos: i - 1 });
        i += 3;
      } else if (s[i + 1] === '>') {
        tokens.push({ text: '2>>', quoted: false, op: true, pos: i - 1 });
        i += 2;
      } else {
        tokens.push({ text: '2>', quoted: false, op: true, pos: i - 1 });
        i += 1;
      }
      continue;
    }
    if (c === '>' || c === '<' || c === '|' || c === ';' || c === '&') {
      push();
      let op = c;
      if (s[i + 1] === c) { op = c + c; i++; }
      tokens.push({ text: op, quoted: false, op: true, pos: i - (op.length - 1) });
      i++;
      continue;
    }
    if (!has) start = i;
    cur += c;
    has = true;
    i++;
  }
  push();
  return tokens;
}

// Recognize the model-friendly heredoc form and extract the code verbatim:
//   python <<'PY'
//   <arbitrary multi-line code, any quotes>
//   PY
// Returns { code } or null. This is NOT a POSIX parser — just this one form.
function extractPythonHeredoc(line) {
  const m = String(line || '').match(/^python3?\s+<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\r?\n([\s\S]*)$/);
  if (!m) return null;
  const marker = m[1];
  const bodyLines = m[2].split(/\r?\n/);
  if (!bodyLines.length || bodyLines[bodyLines.length - 1].trim() !== marker) return null;
  bodyLines.pop();
  return { code: bodyLines.join('\n') };
}

function shellError(cmd) {
  return 'bash: ' + cmd + ': command not available in local browser runtime'
    + ' (run `help` for the supported command list)';
}

// ---------- capability registry (single source of truth) ----------
// The runtime dispatch, the `help` command and the system prompt all read
// from SHELL_COMMANDS / SHELL_OPERATORS so the advertised contract can never
// silently drift from what actually executes. `stdin` marks commands that
// may consume pipeline input; piping into a command with stdin:false fails
// loudly instead of silently dropping data.
const SHELL_COMMANDS = {
  pwd: {
    usage: 'pwd',
    summary: 'print the current virtual working directory',
    stdin: false, run: shPwd,
  },
  cd: {
    usage: 'cd <path>',
    summary: 'change the virtual cwd for THIS invocation only (bare cd → workspace root)',
    stdin: false, run: shCd,
  },
  ls: {
    usage: 'ls [-a] [-l] [-h] [path...]',
    summary: 'list directory entries (-a show dotfiles, -l long format, -h human-readable sizes)',
    stdin: false, run: shLs,
  },
  cat: {
    usage: 'cat [file...]',
    summary: 'print file contents; with no file, reads pipeline stdin',
    stdin: true, run: shCat,
  },
  echo: {
    usage: 'echo <text>',
    summary: 'print text (combine with > / >> to write files)',
    stdin: false, run: shEcho,
  },
  find: {
    usage: 'find [path...] [-name glob] [-type f|d] [-maxdepth N]',
    summary: 'bounded recursive listing (glob supports * and ? only)',
    stdin: false, run: shFind,
  },
  grep: {
    usage: 'grep [-n] [-i] [-r|-R] <pattern> [path...]',
    summary: 'print lines matching a JavaScript regex; reads stdin when no path is given',
    stdin: true, run: shGrep,
  },
  head: {
    usage: 'head [-n N] [file]',
    summary: 'first N lines (default 10); reads stdin when no file is given',
    stdin: true, run: shHead,
  },
  tail: {
    usage: 'tail [-n N] [file]',
    summary: 'last N lines (default 10); -n +N starts at line N; reads stdin when no file is given',
    stdin: true, run: shTail,
  },
  wc: {
    usage: 'wc [-l] [-w] [-c] [file...]',
    summary: 'count lines / words / UTF-8 bytes; reads stdin when no file is given',
    stdin: true, run: shWc,
  },
  mv: {
    usage: 'mv <src>... <dest>',
    summary: 'move/rename files or directories; fails if the destination exists (no -f)',
    stdin: false, run: shMv,
  },
  rm: {
    usage: 'rm [-f] [-r|-R] <path>...',
    summary: 'remove files; -r for recursive directory removal, -f to ignore missing paths',
    stdin: false, run: shRm,
  },
  python: {
    usage: 'python -c "<code>" | python <script.py> | python <<\'PY\' ... PY',
    summary: 'run Python (Pyodide); script paths resolve against the shell cwd, Python\'s own root stays the workspace root',
    stdin: false, run: shPython,
  },
  curl: {
    usage: 'curl <https-url> | curl -o <file> <https-url>',
    summary: 'anonymous HTTPS GET — text to stdout, or binary-safe download with -o',
    stdin: false, run: shCurl,
  },
  help: {
    usage: 'help',
    summary: 'show this shell contract',
    stdin: false, run: shHelp,
  },
};

const SHELL_OPERATORS = [
  { op: ';', summary: 'sequence — run the next command regardless of the previous result' },
  { op: '&&', summary: 'run the next command only if the previous one succeeded' },
  { op: '||', summary: 'run the next command only if the previous one failed' },
  { op: '|', summary: 'pipeline — stdout (only) of the left command becomes stdin of the right one' },
];

const SHELL_REDIRECTS = [
  { op: '> file', summary: 'write stdout to file (truncate/create)' },
  { op: '>> file', summary: 'append stdout to file' },
  { op: '2> file', summary: 'write stderr to file (truncate/create)' },
  { op: '2>> file', summary: 'append stderr to file' },
  { op: '2>&1', summary: 'send stderr to wherever stdout currently goes (order matters: > all.txt 2>&1 merges both into the file)' },
];

const SHELL_UNSUPPORTED_NOTE =
  'Not supported: &, $(...), backticks, subshells, variables/export, '
  + 'glob expansion (* stays literal — use find -name instead), input redirect (<), '
  + 'heredocs other than python, file descriptors other than 2>&1 (no 1>&2 / 3> / &>). '
  + 'rm -rf / (the workspace root) is always refused.';

function shellHelpText() {
  return [
    'Locus shell — a Unix-like compatibility shell, NOT full POSIX bash.',
    'Every bash invocation starts at the mounted workspace root (virtual cwd "/").',
    '`cd` changes the working directory only within the current invocation; the next bash call starts at the root again.',
    'Paths containing spaces must be quoted ("my file.txt").',
    '',
    'Commands:',
  ]
    .concat(Object.keys(SHELL_COMMANDS).map((n) => '  ' + SHELL_COMMANDS[n].usage))
    .concat([
      '',
      'Operators:',
    ])
    .concat(SHELL_OPERATORS.map((o) => '  ' + o.op + '  ' + o.summary))
    .concat([
      '',
      'Redirects:',
    ])
    .concat(SHELL_REDIRECTS.map((r) => '  ' + r.op + '  ' + r.summary))
    .concat(['', SHELL_UNSUPPORTED_NOTE])
    .join('\n');
}

// The bash section of the agent system prompt, generated from the same
// registry as the runtime and `help`.
function shellSystemPromptSection() {
  const head = [
    '  This is a Unix-like compatibility shell, NOT full POSIX bash.',
    '  Every bash invocation starts at the mounted workspace root (virtual cwd "/"); `cd` affects only the current invocation.',
    '  Paths containing spaces must be quoted ("my file.txt"). Unquoted paths must not contain spaces.',
    '  Supported commands:',
  ];
  const cmds = Object.keys(SHELL_COMMANDS).map((n) => '    ' + SHELL_COMMANDS[n].usage);
  const tail = [
    '  Supported operators:',
    '    cmd1 ; cmd2     run commands in sequence',
    '    cmd1 && cmd2    run cmd2 only if cmd1 succeeded',
    '    cmd1 || cmd2    run cmd2 only if cmd1 failed',
    '    cmd1 | cmd2     pipe stdout of cmd1 into stdin of cmd2 (stdin consumers: cat grep head tail wc);',
    '                    stderr is NOT piped unless merged with 2>&1',
    '  Supported redirects (applied left to right; order matters for 2>&1):',
    '    cmd > file      write stdout to file (truncate/create)',
    '    cmd >> file     append stdout to file',
    '    cmd 2> file     write stderr to file (truncate/create)',
    '    cmd 2>> file    append stderr to file',
    '    cmd 2>&1        merge stderr into stdout\'s current destination',
    '  Redirection never turns a failed command into a successful one.',
    '  rm -rf / (the workspace root) is always refused. Shell glob expansion is not supported:',
    '  * in command arguments stays literal — use find -name "*.tmp" to locate files.',
    '  ' + SHELL_UNSUPPORTED_NOTE,
    '  Run `help` at runtime to see this contract again.',
    '  curl usage (public HTTPS resources only):',
    '    curl <https-url>                  fetches a URL; text/JSON/XML responses are printed directly.',
    '    curl -o <file> <https-url>        downloads binary-safe into the workspace file (use this for images,',
    '                                    PDFs, archives, or any data you want to keep or process).',
    '  curl supports NO other flags (no -H/-X/-d/-u/cookies). URLs must be https://.',
    '  Network access may be served by a direct browser fetch or a transparent relay — you do not need to',
    '  know or care which. If curl fails, report the error; do NOT switch to cloud_bash for network access.',
    '  python usage: for short one-liners use python -c "<code>"; for anything multi-line or containing mixed quotes,',
    '  prefer the heredoc form — the code between the markers is passed to Python verbatim:',
    '    python <<\'PY\'',
    '    import pandas as pd',
    '    print(pd.DataFrame({"a": [1]}).to_json())',
    '    PY',
    '  python has the standard library and pandas available. Python\'s filesystem root is always the workspace',
    '  root; the shell cwd does not change Python\'s working directory (only the script path of `python script.py`',
    '  is resolved against the shell cwd). python and curl do not read pipeline stdin.',
  ];
  return head.concat(cmds, tail).join('\n');
}

// ---------- parser ----------
// Grammar:
//   command_list := pipeline ((';' | '&&' | '||') pipeline)*   (left-associative)
//   pipeline     := simple_command ('|' simple_command)*
// Redirect tokens (> >> 2> 2>> 2>&1) stay inside a simple command and are
// applied by the executor, left to right. Everything else that looks like
// shell syntax fails loudly with the supported alternative.
function parseShellLine(tokens) {
  const steps = [];
  let connector = null;
  let pipeline = [];
  let current = [];
  let pendingPipe = false;
  const fail = (m) => { throw new Error(m); };
  const flushPipeline = (allowEmpty) => {
    if (current.length) { pipeline.push({ argv: current }); current = []; }
    if (!pipeline.length) {
      if (!allowEmpty) fail("syntax error: empty command near '" + connector + "'");
      return;
    }
    steps.push({ connector: connector, pipeline: pipeline });
    pipeline = [];
  };
  for (const t of tokens) {
    if (!t.op) { current.push(t); pendingPipe = false; continue; }
    switch (t.text) {
      case '|':
        if (!current.length) fail("syntax error: empty command near '|'");
        pipeline.push({ argv: current });
        current = [];
        pendingPipe = true;
        break;
      case ';':
      case '&&':
      case '||':
        flushPipeline(t.text === ';'); // bare ';' tolerates empty neighbours
        connector = t.text;
        pendingPipe = false;
        break;
      case '&':
        fail("unsupported operator: '&' (supported operators: ; && || |)");
        break;
      case '<':
      case '<<':
        fail("unsupported operator: '<' (input redirection is not supported; pass the file as an argument instead)");
        break;
      case '>':
      case '>>':
      case '2>':
      case '2>>':
      case '2>&1':
        // A redirect with no command in front of it is a syntax error, not
        // an empty-command trick (`> file` alone is not supported).
        if (!current.length) fail("syntax error: redirect '" + t.text + "' without a command");
        // Other file descriptors (1>, 3>, ...) are out of scope: a digit word
        // glued to the operator must not silently become an argument.
        if (t.text === '>' || t.text === '>>') {
          const prev = current[current.length - 1];
          if (prev && !prev.op && !prev.quoted && /^[0-9]+$/.test(prev.text)
            && prev.pos + prev.text.length === t.pos) {
            fail("unsupported redirect: '" + prev.text + t.text + "' (supported redirects: > >> 2> 2>> 2>&1)");
          }
        }
        current.push(t);
        pendingPipe = false;
        break;
      default:
        fail("unsupported operator: '" + t.text + "' (supported operators: ; && || |; supported redirects: > >> 2> 2>> 2>&1)");
    }
  }
  if (pendingPipe) fail("syntax error: empty command after '|'");
  if (current.length) pipeline.push({ argv: current });
  if (pipeline.length) steps.push({ connector: connector, pipeline: pipeline });
  else if (connector === '&&' || connector === '||') fail("syntax error: empty command after '" + connector + "'");
  return steps;
}

// Resolve a (possibly relative) shell path against the invocation-local
// virtual cwd, reusing the workspace path normalization (workspace escape
// is rejected there). Absolute-looking paths (/x) are workspace-root relative.
function resolveShellPath(ctx, p) {
  const raw = String(p || '');
  const joined = raw.charAt(0) === '/' ? raw : (ctx.cwd ? ctx.cwd + '/' + raw : raw);
  return normalizeWorkspacePath(joined);
}

// Resolve for the filesystem, and report a uniform "no such file or
// directory" for plain missing entries (browser handle errors carry no
// useful message of their own). The workspace root ('') always exists once
// a workspace is selected.
async function statShellPath(ctx, display, rel) {
  if (!rel) return { kind: 'directory', size: 0, modified: null };
  try {
    return await ctx.workspace.stat(rel);
  } catch (e) {
    if (e && e.name === 'NotFoundError') throw new Error(display + ': no such file or directory');
    throw e;
  }
}

function splitLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline is a terminator, not an empty line
  return lines;
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + ' ' + units[u];
}

// Simple glob matching for find -name: * and ? only, everything else literal.
function globMatch(pattern, name) {
  const re = new RegExp('^' + String(pattern).split('').map((c) => {
    if (c === '*') return '.*';
    if (c === '?') return '.';
    return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$');
  return re.test(name);
}

function joinDisplay(base, name) {
  return base === '.' ? './' + name : base.replace(/\/+$/, '') + '/' + name;
}

// Internal per-command result: stdout and stderr stay SEPARATED inside the
// executor (pipelines forward stdout only; 2> / 2>&1 routing depends on the
// split). They are merged only at the outermost boundary for presentation.
function shOk(stdout) { return { success: true, stdout: stdout, stderr: '' }; }
function shErr(stderr) { return { success: false, stdout: '', stderr: stderr }; }
function shErrAt(stderr, stdout) { return { success: false, stdout: stdout || '', stderr: stderr }; }

// ---------- command handlers ----------

async function shPwd(ctx) {
  if (!ctx.workspace) return shOk('/ (no workspace selected)');
  return shOk(ctx.cwd ? '/' + ctx.cwd : '/');
}

async function shCd(ctx, args) {
  if (args.length > 1) return shErr('cd: too many arguments');
  if (!ctx.workspace) return shErr('cd: no workspace selected');
  const target = args.length ? args[0].text : '';
  if (!target) { ctx.cwd = ''; return shOk(''); }
  let rel;
  try {
    rel = resolveShellPath(ctx, target);
  } catch (e) {
    return shErr('cd: ' + target + ': ' + e.message);
  }
  if (rel) {
    let st;
    try {
      st = await ctx.workspace.stat(rel);
    } catch (e) {
      return shErr('cd: ' + target + ': ' + (e && e.name === 'NotFoundError' ? 'no such directory' : e.message));
    }
    if (st.kind !== 'directory') return shErr('cd: ' + target + ': not a directory');
  }
  ctx.cwd = rel;
  return shOk('');
}

async function shLs(ctx, args) {
  if (!ctx.workspace) return shErr('ls: no workspace selected');
  let flagA = false, flagL = false, flagH = false;
  const paths = [];
  for (const t of args) {
    if (!t.quoted && t.text.length > 1 && t.text.charAt(0) === '-') {
      for (const ch of t.text.slice(1)) {
        if (ch === 'a') flagA = true;
        else if (ch === 'l') flagL = true;
        else if (ch === 'h') flagH = true;
        else return shErr('ls: unsupported option: -' + ch + ' (supported options: -a -l -h)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!paths.length) paths.push('.');
  const showHeader = paths.length > 1;
  const sections = [];
  for (const p of paths) {
    let rel;
    try {
      rel = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('ls: ' + e.message);
    }
    const st = await statShellPath(ctx, p, rel);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    if (st.kind !== 'directory') {
      sections.push(lsFormatEntry(p, st, flagL, flagH));
      continue;
    }
    const entries = await ctx.workspace.list(rel);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    const lines = [];
    for (const e of entries) {
      if (!flagA && e.name.charAt(0) === '.') continue;
      let est = null;
      if (flagL) est = await ctx.workspace.stat(rel ? rel + '/' + e.name : e.name);
      lines.push(lsFormatEntry(e.name, est || { kind: e.kind, size: 0, modified: null }, flagL, flagH));
    }
    sections.push((showHeader ? p + ':\n' : '') + lines.join('\n'));
  }
  return shOk(sections.join('\n\n'));
}

function lsFormatEntry(name, st, flagL, flagH) {
  const isDir = st.kind === 'directory';
  if (!flagL) return isDir ? name + '/' : name;
  const parts = [isDir ? 'd' : '-', flagH ? humanBytes(st.size) : String(st.size)];
  if (st.modified) parts.push(new Date(st.modified).toISOString().slice(0, 16).replace('T', ' '));
  parts.push(isDir ? name + '/' : name);
  return parts.join(' ');
}

async function shCat(ctx, args, stdin) {
  if (!args.length) {
    if (stdin !== null && stdin !== undefined) return shOk(stdin);
    return shErr('cat: missing file operand (or pipe input into cat)');
  }
  if (!ctx.workspace) return shErr('cat: no workspace selected');
  const chunks = [];
  for (const a of args) {
    const rel = resolveShellPath(ctx, a.text);
    const st = await statShellPath(ctx, a.text, rel);
    if (st.kind !== 'file') return shErr('cat: ' + a.text + ': is a directory');
    if (st.size > CAT_MAX_FILE_BYTES) return shErr('cat: ' + a.text + ': file too large for terminal output (use python)');
    chunks.push(await ctx.workspace.read(rel));
  }
  return shOk(chunks.join('\n'));
}

async function shEcho(ctx, args) {
  // Redirection is generic (executor-level) — echo only prints its arguments.
  return shOk(args.map((t) => t.text).join(' '));
}

async function shFind(ctx, args) {
  if (!ctx.workspace) return shErr('find: no workspace selected');
  const paths = [];
  let name = null, type = null, maxdepth = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      if (t.text === '-name') {
        const v = args[++i];
        if (!v) return shErr('find: -name requires a pattern');
        name = v.text;
      } else if (t.text === '-type') {
        const v = args[++i];
        if (!v || (v.text !== 'f' && v.text !== 'd')) return shErr('find: -type must be f or d');
        type = v.text;
      } else if (t.text === '-maxdepth') {
        const v = args[++i];
        const n = v && /^[0-9]+$/.test(v.text) ? parseInt(v.text, 10) : NaN;
        if (!isFinite(n)) return shErr('find: -maxdepth requires a non-negative integer');
        maxdepth = n;
      } else {
        return shErr('find: unsupported predicate: ' + t.text + ' (supported: -name -type -maxdepth)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!paths.length) paths.push('.');

  const signal = ctx.opts && ctx.opts.signal;
  const results = [];
  const state = { visited: 0, truncated: false };

  async function walk(rel, disp, depth, kind) {
    if (state.truncated) return;
    throwIfCancelled(signal, 'find');
    if (state.visited >= FIND_MAX_VISITED || results.length >= FIND_MAX_RESULTS) {
      state.truncated = true;
      return;
    }
    state.visited++;
    const base = disp === '.' ? '.' : disp.slice(disp.lastIndexOf('/') + 1);
    const typeOk = !type || (type === 'f' ? kind === 'file' : kind === 'directory');
    if (typeOk && (!name || globMatch(name, base))) results.push(disp);
    if (kind !== 'directory') return;
    if (maxdepth !== null && depth >= maxdepth) return;
    const entries = await ctx.workspace.list(rel);
    for (const e of entries) {
      await walk(rel ? rel + '/' + e.name : e.name, joinDisplay(disp, e.name), depth + 1, e.kind);
      if (state.truncated) return;
    }
  }

  for (const p of paths) {
    let rel;
    try {
      rel = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('find: ' + e.message);
    }
    const st = await statShellPath(ctx, p, rel);
    await walk(rel, p.replace(/\/+$/, '') || '.', 0, st.kind);
  }

  let output = results.join('\n');
  if (state.truncated) {
    output += (output ? '\n' : '') + '[find: result truncated at traversal limits; narrow the path or predicates]';
  }
  return shOk(output);
}

async function shGrep(ctx, args, stdin) {
  let flagN = false, flagI = false, flagR = false;
  let pattern = null;
  const paths = [];
  for (const t of args) {
    if (pattern === null && !t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'n') flagN = true;
        else if (ch === 'i') flagI = true;
        else if (ch === 'r' || ch === 'R') flagR = true;
        else if (ch === 'E') { /* alias for the regex semantics already in use */ }
        else return shErr('grep: unsupported option: -' + ch + ' (supported options: -n -i -r -R -E)');
      }
    } else if (pattern === null) {
      pattern = t.text;
    } else {
      paths.push(t.text);
    }
  }
  if (pattern === null) return shErr('usage: grep [-n] [-i] [-r|-R] <pattern> [path...]');
  let re;
  try {
    re = new RegExp(pattern, flagI ? 'i' : '');
  } catch (e) {
    return shErr('grep: invalid pattern: ' + e.message + ' (patterns use JavaScript regex syntax)');
  }
  if (!paths.length && (stdin === null || stdin === undefined)) {
    return shErr('grep: missing file operand (or pipe input into grep)');
  }
  if (paths.length && !ctx.workspace) return shErr('grep: no workspace selected');

  const signal = ctx.opts && ctx.opts.signal;
  const matches = [];
  const skipped = [];
  const state = { truncated: false, filesSeen: 0 };
  const showPathDefault = paths.length > 1;

  function grepText(text, disp, showPath) {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= GREP_MAX_MATCHES) { state.truncated = true; return; }
      if (re.test(lines[i])) {
        matches.push((showPath ? disp + ':' : '') + (flagN ? (i + 1) + ':' : '') + lines[i]);
      }
    }
  }

  async function grepFile(rel, disp, showPath) {
    const st = await ctx.workspace.stat(rel);
    if (st.size > GREP_MAX_FILE_BYTES) {
      skipped.push(disp + ' (over ' + GREP_MAX_FILE_BYTES + '-byte grep limit)');
      return;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.workspace.readBytes(rel));
    } catch (e) {
      skipped.push(disp + ' (not UTF-8 text)');
      return;
    }
    grepText(text, disp, showPath);
  }

  async function grepDir(rel, disp) {
    if (state.truncated) return;
    throwIfCancelled(signal, 'grep');
    const entries = await ctx.workspace.list(rel);
    for (const e of entries) {
      if (state.truncated) return;
      throwIfCancelled(signal, 'grep');
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childDisp = joinDisplay(disp, e.name);
      if (e.kind === 'directory') {
        await grepDir(childRel, childDisp);
      } else {
        state.filesSeen++;
        if (state.filesSeen > GREP_MAX_FILES) { state.truncated = true; return; }
        await grepFile(childRel, childDisp, true);
      }
    }
  }

  if (!paths.length) {
    grepText(stdin, '', false);
  } else {
    for (const p of paths) {
      if (state.truncated) break;
      let rel;
      try {
        rel = resolveShellPath(ctx, p);
      } catch (e) {
        return shErr('grep: ' + e.message);
      }
      const st = await statShellPath(ctx, p, rel);
      if (st.kind === 'directory') {
        if (!flagR) return shErr('grep: ' + p + ': is a directory (use -r to search recursively)');
        await grepDir(rel, p.replace(/\/+$/, '') || '.');
      } else {
        await grepFile(rel, p, showPathDefault);
      }
    }
  }

  let output = matches.join('\n');
  if (skipped.length) {
    output += (output ? '\n' : '') + '[grep: skipped ' + skipped.length + ' file(s): '
      + skipped.slice(0, 5).join('; ') + (skipped.length > 5 ? '; …' : '') + ']';
  }
  if (state.truncated) {
    output += (output ? '\n' : '') + '[grep: results truncated at traversal limits; narrow the pattern or path]';
  }
  // A search with zero matches is a successful empty answer (diverges from
  // the GNU exit code) so pipelines like `grep x | wc -l` keep working.
  return shOk(output);
}

async function shHead(ctx, args, stdin) {
  const parsed = parseLineCountArgs('head', args);
  if (parsed.error) return shErr(parsed.error);
  const text = await readHeadTailInput(ctx, 'head', parsed.paths, stdin);
  if (text === null) return shErr('head: missing file operand (or pipe input into head)');
  if (text.error) return shErr(text.error);
  const lines = splitLines(text.text).slice(0, parsed.n);
  return shOk(lines.join('\n'));
}

async function shTail(ctx, args, stdin) {
  const parsed = parseLineCountArgs('tail', args);
  if (parsed.error) return shErr(parsed.error);
  const text = await readHeadTailInput(ctx, 'tail', parsed.paths, stdin);
  if (text === null) return shErr('tail: missing file operand (or pipe input into tail)');
  if (text.error) return shErr(text.error);
  const lines = splitLines(text.text);
  const out = parsed.from !== null ? lines.slice(parsed.from - 1) : lines.slice(Math.max(0, lines.length - parsed.n));
  return shOk(out.join('\n'));
}

function parseLineCountArgs(cmd, args) {
  let n = 10, from = null;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!t.quoted && t.text === '-n') {
      const v = args[++i];
      if (!v) return { error: cmd + ': -n requires a line count' };
      if (/^\+[0-9]+$/.test(v.text)) {
        if (cmd !== 'tail') return { error: cmd + ': -n +N is only supported by tail' };
        from = parseInt(v.text.slice(1), 10);
      } else if (/^[0-9]+$/.test(v.text)) {
        n = parseInt(v.text, 10);
      } else {
        return { error: cmd + ': invalid line count: ' + v.text };
      }
    } else if (!t.quoted && /^-n[0-9]+$/.test(t.text)) {
      n = parseInt(t.text.slice(2), 10);
    } else if (!t.quoted && cmd === 'tail' && /^-n\+[0-9]+$/.test(t.text)) {
      from = parseInt(t.text.slice(3), 10);
    } else if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      return { error: cmd + ': unsupported option: ' + t.text + ' (supported: -n N' + (cmd === 'tail' ? ', -n +N' : '') + ')' };
    } else {
      paths.push(t.text);
    }
  }
  return { n: n, from: from, paths: paths };
}

// head/tail read exactly one file or stdin (multiple files are rejected
// instead of inventing header semantics).
async function readHeadTailInput(ctx, cmd, paths, stdin) {
  if (!paths.length) {
    if (stdin !== null && stdin !== undefined) return { text: stdin };
    return null;
  }
  if (paths.length > 1) return { error: cmd + ': exactly one file operand is supported' };
  if (!ctx.workspace) return { error: cmd + ': no workspace selected' };
  const rel = resolveShellPath(ctx, paths[0]);
  const st = await statShellPath(ctx, paths[0], rel);
  if (st.kind !== 'file') return { error: cmd + ': ' + paths[0] + ': is a directory' };
  if (st.size > CAT_MAX_FILE_BYTES) return { error: cmd + ': ' + paths[0] + ': file too large for terminal output (use python)' };
  return { text: await ctx.workspace.read(rel) };
}

async function shWc(ctx, args, stdin) {
  let flagL = false, flagW = false, flagC = false;
  const paths = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'l') flagL = true;
        else if (ch === 'w') flagW = true;
        else if (ch === 'c') flagC = true;
        else return shErr('wc: unsupported option: -' + ch + ' (supported options: -l -w -c)');
      }
    } else {
      paths.push(t.text);
    }
  }
  if (!flagL && !flagW && !flagC) { flagL = flagW = flagC = true; }
  if (!paths.length && (stdin === null || stdin === undefined)) {
    return shErr('wc: missing file operand (or pipe input into wc)');
  }
  if (paths.length && !ctx.workspace) return shErr('wc: no workspace selected');

  // -l counts LINES (newline-terminated or not): our pipeline producers emit
  // unterminated final lines, and `grep x f | wc -l` must answer the number
  // of matched lines, not the number of \n bytes. For files ending in a
  // newline this is identical to GNU wc.
  const counts = (text, bytes) => ({
    l: text === '' ? 0 : (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1),
    w: text.split(/\s+/).filter(Boolean).length,
    c: bytes,
  });
  const format = (c, label) => {
    const nums = [];
    if (flagL) nums.push(c.l);
    if (flagW) nums.push(c.w);
    if (flagC) nums.push(c.c);
    return nums.join(' ') + (label ? ' ' + label : '');
  };

  if (!paths.length) return shOk(format(counts(stdin, utf8ByteLength(stdin)), null));

  const lines = [];
  const total = { l: 0, w: 0, c: 0 };
  for (const p of paths) {
    const rel = resolveShellPath(ctx, p);
    const st = await statShellPath(ctx, p, rel);
    if (st.kind !== 'file') return shErr('wc: ' + p + ': is a directory');
    const bytes = await ctx.workspace.readBytes(rel); // -c is real UTF-8 bytes, not JS string length
    const c = counts(new TextDecoder('utf-8').decode(bytes), bytes.byteLength);
    total.l += c.l; total.w += c.w; total.c += c.c;
    lines.push(format(c, p));
  }
  if (paths.length > 1) lines.push(format(total, 'total'));
  return shOk(lines.join('\n'));
}

// ---------- mv / rm ----------
// Bounded, workspace-confined file mutations implemented on WorkspaceAdapter
// primitives only. A move NEVER deletes its source before the destination
// write has landed and been verified; a recursive delete reports exactly
// what committed when cancelled (a cancel is not a rollback).

// Bounds for recursive directory moves/copies.
const MV_MAX_ENTRIES = 1000;
const MV_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function baseName(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

function parentRel(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

// Cancellation inside a mutating traversal: the thrown error carries exactly
// what already committed so the outer report never pretends a rollback.
function throwMutationCancelled(signal, what, done) {
  if (signal && signal.aborted) {
    const e = makeCancelledError(what);
    e.detail = what + ': cancelled after committing ' + done.length + ' entrie(s): '
      + done.slice(0, 10).join(', ') + (done.length > 10 ? ', …' : '') + ' (not rolled back)';
    throw e;
  }
}

async function shMv(ctx, args) {
  if (!ctx.workspace) return shErr('mv: no workspace selected');
  const signal = ctx.opts && ctx.opts.signal;
  const operands = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      if (t.text === '-f') return shErr('mv: -f is not supported (an existing destination is never overwritten)');
      return shErr('mv: unsupported option: ' + t.text + ' (no options are supported)');
    }
    operands.push(t.text);
  }
  if (operands.length < 2) return shErr('usage: mv <src>... <dest>');

  const destDisplay = operands[operands.length - 1];
  let destRel;
  try {
    destRel = resolveShellPath(ctx, destDisplay);
  } catch (e) {
    return shErr('mv: ' + destDisplay + ': ' + e.message);
  }
  const sources = operands.slice(0, -1);
  let destStat = null;
  try {
    destStat = await ctx.workspace.stat(destRel);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') return shErr('mv: ' + destDisplay + ': ' + e.message);
  }
  if (sources.length > 1 && (!destStat || destStat.kind !== 'directory')) {
    return shErr('mv: target ' + destDisplay + ': not a directory (required with multiple sources)');
  }

  const moved = [];
  for (const srcDisplay of sources) {
    throwIfCancelled(signal, 'mv');
    let srcRel;
    try {
      srcRel = resolveShellPath(ctx, srcDisplay);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + e.message);
    }
    if (!srcRel) return shErr('mv: ' + srcDisplay + ': refusing to move the workspace root');
    let srcStat;
    try {
      srcStat = await ctx.workspace.stat(srcRel);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + (e && e.name === 'NotFoundError' ? 'no such file or directory' : e.message));
    }

    // An existing destination directory means "move INTO it"; any other
    // existing destination is a loud failure (no implicit overwrite, no -f).
    let finalRel = destRel;
    if (destStat && destStat.kind === 'directory') {
      finalRel = destRel ? destRel + '/' + baseName(srcRel) : baseName(srcRel);
    }
    if (finalRel === srcRel) return shErr('mv: ' + srcDisplay + ' and ' + destDisplay + ' are the same file');
    if (destStat && destStat.kind !== 'directory') {
      return shErr('mv: ' + destDisplay + ': destination exists');
    }
    if (srcStat.kind === 'directory' && (finalRel === srcRel || finalRel.startsWith(srcRel + '/'))) {
      return shErr('mv: cannot move a directory into itself: ' + srcDisplay);
    }
    if (await ctx.workspace.exists(finalRel)) {
      return shErr('mv: destination exists: ' + (destStat && destStat.kind === 'directory' ? finalRel : destDisplay));
    }
    // The destination parent must be an existing directory.
    const parent = parentRel(finalRel);
    if (parent) {
      let pst;
      try {
        pst = await ctx.workspace.stat(parent);
      } catch (e) {
        return shErr('mv: ' + destDisplay + ': ' + (e && e.name === 'NotFoundError' ? 'no such directory' : e.message));
      }
      if (pst.kind !== 'directory') return shErr('mv: ' + destDisplay + ': parent is not a directory');
    }

    if (srcStat.kind === 'directory') {
      const err = await mvDirectory(ctx, srcRel, finalRel, signal);
      if (err) return shErr(err);
    } else {
      const err = await mvFile(ctx, srcRel, finalRel, signal);
      if (err) return shErr(err);
    }
    moved.push(srcRel + ' -> ' + finalRel);
  }
  const r = shOk('');
  r.fs = true;
  return r;
}

// file → new path: copy, VERIFY the destination landed, only then remove
// the source. A failed/short destination write leaves the source untouched.
async function mvFile(ctx, srcRel, finalRel, signal) {
  throwIfCancelled(signal, 'mv');
  const bytes = await ctx.workspace.readBytes(srcRel);
  throwIfCancelled(signal, 'mv');
  await ctx.workspace.write(finalRel, bytes);
  throwIfCancelled(signal, 'mv');
  const check = await ctx.workspace.readBytes(finalRel);
  if (check.byteLength !== bytes.byteLength || bytesToB64(check) !== bytesToB64(bytes)) {
    return 'mv: write verification failed for ' + finalRel + '; source preserved';
  }
  throwIfCancelled(signal, 'mv');
  await ctx.workspace.remove(srcRel);
  return null;
}

// directory → new path: bounded pre-scan, full recursive copy, THEN a
// separate recursive delete of the source. The copy phase completing is the
// commit point — a cancel during copy leaves the source fully intact.
async function mvDirectory(ctx, srcRel, finalRel, signal) {
  const files = [];
  const dirs = [];
  let totalBytes = 0;
  async function scan(rel) {
    throwIfCancelled(signal, 'mv');
    if (files.length + dirs.length >= MV_MAX_ENTRIES) {
      throw new Error('mv: directory exceeds the ' + MV_MAX_ENTRIES + '-entry move limit');
    }
    const entries = await ctx.workspace.list(rel);
    for (const e of entries) {
      const child = rel + '/' + e.name;
      if (e.kind === 'directory') {
        dirs.push(child);
        await scan(child);
      } else {
        const st = await ctx.workspace.stat(child);
        totalBytes += st.size;
        if (totalBytes > MV_MAX_TOTAL_BYTES) {
          throw new Error('mv: directory exceeds the ' + MV_MAX_TOTAL_BYTES + '-byte move limit');
        }
        files.push(child);
      }
    }
  }
  try {
    await scan(srcRel);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return e.message;
  }

  // copy phase — source stays untouched until every file landed
  for (const f of files) {
    throwIfCancelled(signal, 'mv');
    const bytes = await ctx.workspace.readBytes(f);
    throwIfCancelled(signal, 'mv');
    try {
      await ctx.workspace.write(finalRel + '/' + f.slice(srcRel.length + 1), bytes);
    } catch (e) {
      return 'mv: copy failed at ' + f + ' (' + (e && e.message ? e.message : String(e))
        + '); source preserved, partial destination may exist';
    }
  }

  // delete phase — deepest first so directories are empty when removed
  const deleted = [];
  const all = files.concat(dirs.slice().reverse());
  try {
    for (const p of all) {
      throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
      await ctx.workspace.remove(p);
      deleted.push(p);
    }
    throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
    await ctx.workspace.remove(srcRel);
    deleted.push(srcRel);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return 'mv: delete failed at ' + (deleted.length ? 'entry after ' + deleted[deleted.length - 1] : srcRel)
      + ' (' + (e && e.message ? e.message : String(e)) + '); destination is complete, source may be partially removed';
  }
  return null;
}

async function shRm(ctx, args) {
  if (!ctx.workspace) return shErr('rm: no workspace selected');
  const signal = ctx.opts && ctx.opts.signal;
  let force = false, recursive = false;
  const operands = [];
  for (const t of args) {
    if (!t.quoted && t.text.charAt(0) === '-' && t.text.length > 1) {
      for (const ch of t.text.slice(1)) {
        if (ch === 'f') force = true;
        else if (ch === 'r' || ch === 'R') recursive = true;
        else return shErr('rm: unsupported option: -' + ch + ' (supported options: -f -r -R)');
      }
    } else {
      operands.push(t.text);
    }
  }
  if (!operands.length) return force ? shOk('') : shErr('usage: rm [-f] [-r|-R] <path>...');

  const errors = [];
  const deleted = [];
  for (const op of operands) {
    throwMutationCancelled(signal, 'rm', deleted);
    let rel;
    try {
      rel = resolveShellPath(ctx, op);
    } catch (e) {
      errors.push('rm: ' + op + ': ' + e.message);
      continue;
    }
    // Hard stop: nothing may recursively remove the workspace root, however
    // spelled (/, /., /x/.., ...). This is disaster prevention, not a
    // permission system.
    if (!rel) {
      errors.push(recursive
        ? 'rm: refusing to recursively remove workspace root'
        : 'rm: ' + op + ': is a directory');
      continue;
    }
    let st;
    try {
      st = await ctx.workspace.stat(rel);
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        if (!force) errors.push('rm: ' + op + ': no such file or directory');
        continue;
      }
      errors.push('rm: ' + op + ': ' + e.message);
      continue;
    }
    if (st.kind === 'directory') {
      if (!recursive) {
        errors.push('rm: ' + op + ': is a directory');
        continue;
      }
      await rmRecursive(ctx, rel, signal, deleted);
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      await ctx.workspace.remove(rel);
      deleted.push(rel);
    }
  }
  if (errors.length) {
    const r = shErr(errors.join('\n'));
    if (deleted.length) r.fs = true;
    return r;
  }
  const r = shOk('');
  if (deleted.length) r.fs = true;
  return r;
}

// Depth-first recursive delete: children (deepest first) before the
// directory itself, with a cancellation check before EVERY removal. Already
// committed deletions are reported on the cancellation error, never hidden.
async function rmRecursive(ctx, rel, signal, deleted) {
  throwMutationCancelled(signal, 'rm', deleted);
  const entries = await ctx.workspace.list(rel);
  for (const e of entries) {
    const child = rel + '/' + e.name;
    if (e.kind === 'directory') {
      await rmRecursive(ctx, child, signal, deleted);
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      await ctx.workspace.remove(child);
      deleted.push(child);
    }
  }
  throwMutationCancelled(signal, 'rm', deleted);
  await ctx.workspace.remove(rel);
  deleted.push(rel);
}

async function shPython(ctx, args) {
  return await runPython(args.map((t) => t.text), ctx, ctx.opts);
}

async function shCurl(ctx, args) {
  return await runCurl(args.map((t) => t.text), ctx, ctx.opts);
}

async function shHelp() {
  return shOk(shellHelpText());
}

// ---------- executor ----------

// Execute one shell command line against the workspace.
// Returns { output: string, isError: boolean, io: {in, out} } for the tool
// layer — stdout/stderr are separated INSIDE the executor and merged only
// here, for presentation. io in UTF-8 bytes.
// The virtual cwd starts at the workspace root on EVERY invocation and never
// persists across tool calls.
async function runShellCommand(input, workspace, opts) {
  const line = String(input || '').trim();
  const ioOf = (output) => ({ in: utf8ByteLength(line), out: utf8ByteLength(output) });
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

  // Heredoc python is recognized before generic tokenizing.
  const heredoc = extractPythonHeredoc(line);
  if (heredoc) {
    const r = await runPythonCode(heredoc.code, workspace, opts);
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return { output: output, isError: !r.success, io: r.io };
  }

  let steps;
  try {
    steps = parseShellLine(shellTokenize(line));
  } catch (e) {
    return { output: 'bash: ' + e.message, isError: true, io: ioOf('bash: ' + e.message) };
  }
  if (!steps.length) return { output: '', isError: false, io: ioOf('') };

  const ctx = { workspace: workspace, opts: opts, cwd: '' };
  const outParts = [];
  const networkOps = [];
  let fsOps = 0;
  let prevSuccess = true;
  let lastRes = null;

  try {
    for (const step of steps) {
      // Cancellation is re-checked between commands: a task cancelled after
      // `echo A > a.txt` must never run the next command's side effects.
      throwIfCancelled(opts && opts.signal, 'bash');
      // and_or_list is left-associative: && skips on failure, || on success.
      if (step.connector === '&&' && !prevSuccess) continue;
      if (step.connector === '||' && prevSuccess) continue;
      const res = await runPipeline(step.pipeline, ctx);
      prevSuccess = res.success;
      if (res.stdout) outParts.push(res.stdout);
      if (res.stderr) outParts.push(res.stderr);
      if (res.network) networkOps.push(res.network);
      if (res.fs) fsOps++;
      lastRes = res;
    }
  } catch (e) {
    if (isCancelledError(e)) {
      // Mutating commands (rm/mv) attach exactly what already committed —
      // a cancel is never a rollback and the report must say so.
      if (e.detail) outParts.push(e.detail);
      outParts.push('bash: cancelled');
    } else {
      outParts.push('bash: ' + (e && e.message ? e.message : String(e)));
    }
    const output = outParts.join('\n');
    return { output: output, isError: true, io: ioOf(output) };
  }

  const output = outParts.join('\n');
  const result = { output: output, isError: lastRes ? !lastRes.success : false, io: ioOf(output) };
  // Operation metadata: a single network command keeps its real backend; a
  // compound command mixing several operations reports honestly instead of
  // attributing one backend to all of them.
  if (networkOps.length === 1 && !fsOps) {
    result.backend = networkOps[0].backend;
    result.operation = 'network';
  } else if (networkOps.length > 1 || (networkOps.length && fsOps)) {
    result.backend = 'browser';
    result.operation = 'compound';
  } else if (fsOps) {
    result.backend = 'browser';
    result.operation = 'filesystem';
  }
  return result;
}

async function runPipeline(pipeline, ctx) {
  let stdin = null;
  let network = null;
  let fs = false;
  const stderrParts = [];
  let res = { success: true, stdout: '', stderr: '' };
  for (let i = 0; i < pipeline.length; i++) {
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'bash');
    res = await runSimpleCommand(pipeline[i], ctx, stdin);
    if (res.network) network = res.network;
    if (res.fs) fs = true;
    if (res.stderr) stderrParts.push(res.stderr);
    if (i < pipeline.length - 1) {
      // A pipeline forwards STDOUT ONLY — stderr is never fed downstream
      // (that is exactly what an explicit `2>&1` is for). Like a real shell,
      // a failed left stage does not stop the right stages from running.
      if (utf8ByteLength(res.stdout) > SHELL_PIPE_MAX_BYTES) {
        // Fail loudly: downstream stages must never receive silently
        // truncated input and mistake it for a complete answer.
        const err = shErr('bash: pipeline stage output exceeds the ' + SHELL_PIPE_MAX_BYTES
          + '-byte limit; refusing to forward truncated data (narrow the command, e.g. with head -n)');
        err.network = network;
        err.fs = fs;
        return err;
      }
      stdin = res.stdout;
    }
  }
  // Pipeline status is the LAST stage's status (shell semantics); stderr is
  // the concatenation of every stage's diagnostics.
  return {
    success: res.success,
    stdout: res.stdout,
    stderr: stderrParts.join('\n'),
    network: network,
    fs: fs,
  };
}

// Execute one simple command: resolve the handler, extract redirections
// (applied LEFT TO RIGHT — `> all.txt 2>&1` and `2>&1 > out.txt` differ),
// run the command, then deliver its stdout/stderr through the routing state.
async function runSimpleCommand(cmd, ctx, stdin) {
  const argv = cmd.argv;
  let name = argv[0].text;
  if (name === 'python3') name = 'python'; // alias
  const spec = SHELL_COMMANDS[name];

  // ---- redirection routing state ----
  // stdout: {kind:'capture'} | {kind:'file', path, append}
  // stderr: same, plus {kind:'merge-stdout'} (2>&1 while stdout was captured)
  const args = [];
  const route = { stdout: { kind: 'capture' }, stderr: { kind: 'capture' } };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (!t.op) { args.push(t); continue; }
    if (t.text === '2>&1') {
      // stderr inherits stdout's CURRENT destination — a snapshot, so a later
      // `> file` does not retroactively move stderr.
      route.stderr = route.stdout.kind === 'file'
        ? { kind: 'file', path: route.stdout.path, append: route.stdout.append }
        : { kind: 'merge-stdout' };
      continue;
    }
    const target = argv[++i];
    if (!target || target.op) return shErr('bash: missing redirect target after "' + t.text + '"');
    if (!ctx.workspace) return shErr('bash: no workspace selected (cannot redirect to a file)');
    let rel;
    try {
      rel = resolveShellPath(ctx, target.text);
    } catch (e) {
      return shErr('bash: ' + e.message);
    }
    if (!rel) return shErr('bash: redirect target must be a file path, not the workspace root');
    const dest = { kind: 'file', path: rel, append: t.text === '>>' || t.text === '2>>' };
    if (t.text.charAt(0) === '2') route.stderr = dest;
    else route.stdout = dest;
  }

  let res;
  if (!spec) {
    // Even an unknown command's error is stderr and routes like stderr.
    res = shErr(shellError(name));
  } else if (stdin !== null && stdin !== undefined && !spec.stdin) {
    res = shErr('bash: ' + name + ': does not read stdin (pipeline input has nowhere to go)');
  } else {
    try {
      res = await spec.run(ctx, args, stdin);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      // Handler failures are the command's stderr — redirection applies to
      // them exactly like to normally-produced stderr.
      res = shErr('bash: ' + name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }

  // ---- deliver streams through the routing state ----
  // Redirection changes WHERE output goes, never the command's success.
  const out = {
    success: res.success,
    stdout: '',
    stderr: route.stderr.kind === 'capture' ? (res.stderr || '') : '',
    network: res.network || null,
    fs: !!res.fs,
  };
  const writes = [];
  if (route.stdout.kind === 'file') writes.push({ dest: route.stdout, text: res.stdout || '' });
  else out.stdout = res.stdout || '';
  if (route.stderr.kind === 'file') writes.push({ dest: route.stderr, text: res.stderr || '' });
  else if (route.stderr.kind === 'merge-stdout') {
    out.stdout = [out.stdout, res.stderr].filter(Boolean).join('\n');
  }

  const signal = ctx.opts && ctx.opts.signal;
  const writtenPaths = new Set();
  for (const w of writes) {
    let text = w.text;
    // Captured streams carry no trailing newline; a redirected stream
    // terminates like a real one would (echo hi > f → "hi\n").
    if (text && !text.endsWith('\n')) text += '\n';
    // A second stream aimed at the same file in the same command appends to
    // what the first write just landed (stdout first, then stderr).
    const append = w.dest.append || writtenPaths.has(w.dest.path);
    try {
      if (append && (await ctx.workspace.exists(w.dest.path))) {
        text = (await ctx.workspace.read(w.dest.path)) + text;
      }
      // reads above awaited: re-check cancellation before writing
      throwIfCancelled(signal, name);
      await ctx.workspace.write(w.dest.path, text);
      writtenPaths.add(w.dest.path);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      out.success = false;
      out.stderr = [out.stderr, 'bash: ' + name + ': cannot write ' + w.dest.path + ': '
        + (e && e.message ? e.message : String(e))].filter(Boolean).join('\n');
      return out;
    }
  }
  if (writes.length) out.fs = true;
  return out;
}

async function runPython(args, ctx, opts) {
  let code = null;

  if (!args.length) {
    return shErr('usage: python -c "<code>" | python <script.py> | python <<\'PY\' ... PY');
  }
  if (args[0] === '--version' || args[0] === '-V') {
    return shOk('Python (browser runtime)');
  }
  if (args[0] === '-c') {
    code = args.slice(1).join(' ');
  } else {
    const script = args[0];
    if (!ctx.workspace) return shErr('python: no workspace selected (cannot read ' + script + ')');
    // The script path resolves against the shell's virtual cwd; Python's own
    // filesystem root remains the workspace root (documented divergence).
    let rel;
    try {
      rel = resolveShellPath(ctx, script);
    } catch (e) {
      return shErr('python: ' + e.message);
    }
    try {
      code = await ctx.workspace.read(rel);
    } catch (e) {
      return shErr('python: can\'t open file \'' + script + '\': ' + e.message);
    }
  }

  return await runPythonCode(code, ctx.workspace, opts);
}

async function runPythonCode(code, workspace, opts) {
  if (!code || !code.trim()) {
    return { success: false, stdout: '', stderr: 'python: empty code', io: { in: 0, out: 0 } };
  }

  let res;
  try {
    res = await PythonRuntime.run(code, workspace, opts);
  } catch (e) {
    if (isCancelledError(e)) {
      return { success: false, stdout: '', stderr: 'python: execution cancelled', cancelled: true, io: { in: utf8ByteLength(code), out: 0 } };
    }
    throw e;
  }

  // stdout carries normal output + commit reports; stderr carries Python's
  // own stderr, execution errors and every commit-failure note.
  const outParts = [];
  const errParts = [];
  if (res.stdout) outParts.push(res.stdout.replace(/\n$/, ''));
  if (res.stderr) errParts.push(res.stderr.replace(/\n$/, ''));
  if (res.error) errParts.push(res.error);
  if (res.stdoutTruncated) {
    outParts.push('[python output limit: stdout truncated]');
  }
  if (res.stderrTruncated) {
    errParts.push('[python output limit: stderr truncated]');
  }
  if (res.skipped && res.skipped.length) {
    const shown = res.skipped.slice(0, 10).map((s) => s.path + ' (' + s.reason + ')');
    outParts.push('[workspace sync: ' + res.skipped.length + ' file(s) NOT visible to Python: ' + shown.join('; ')
      + (res.skipped.length > shown.length ? '; …' : '') + ']');
  }
  if (res.written && res.written.length) {
    outParts.push('[written to workspace: ' + res.written.join(', ') + ']');
  }
  if (res.deleted && res.deleted.length) {
    outParts.push('[deleted from workspace: ' + res.deleted.join(', ') + ']');
  }
  for (const c of res.conflicts || []) {
    errParts.push('[conflict: ' + c.path + ': ' + c.reason + ']');
  }
  for (const f of res.writeFailed || []) {
    errParts.push('[write-back failed: ' + f + ']');
  }
  for (const p of res.notPersisted || []) {
    errParts.push('[not persisted: ' + p + ']');
  }

  const stdout = outParts.join('\n');
  const stderr = errParts.join('\n');

  // Compute success and commit success are reported separately: a run that
  // computed fine but could not fully persist is a FAILURE state (partial
  // commit), never a silent success. Multi-file commits are staged, NOT
  // atomic — partial results are always spelled out above.
  const commitFailed = (res.writeFailed && res.writeFailed.length > 0)
    || (res.conflicts && res.conflicts.length > 0)
    || (res.notPersisted && res.notPersisted.length > 0);

  return {
    success: !res.error && !commitFailed,
    stdout,
    stderr,
    io: {
      in: utf8ByteLength(code) + res.inputBytes,
      out: utf8ByteLength(stdout) + utf8ByteLength(stderr) + res.outputBytes,
    },
  };
}

// ---------- curl (NetworkRuntime) ----------
// Deliberately NOT full curl. Supported forms only:
//   curl <https-url>                 → text responses printed to stdout
//   curl -o <file> <https-url>       → binary-safe download into workspace
//   curl --output <file> <https-url> → same as -o
// Everything else (headers, methods, POST bodies, cookies, auth) is out of
// scope for the browser runtime and fails with a clear message.

const TEXT_LIKE_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/x-www-form-urlencoded',
  'image/svg+xml',
]);

function isTextLikeMime(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'text/plain') return true; // unknown → assume text
  return mime.startsWith('text/') || TEXT_LIKE_MIMES.has(mime)
    || mime.endsWith('+json') || mime.endsWith('+xml');
}

async function runCurl(args, ctx, opts) {
  const workspace = ctx.workspace;
  const netResult = (text, success, net) => ({
    success,
    stdout: success ? text : '',
    stderr: success ? '' : text,
    // network metadata flows up to telemetry via the compound executor
    network: net ? { backend: net.backend } : null,
  });

  // Parse: exactly one URL positional; only -o/--output takes a value.
  let outFile = null;
  let url = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      outFile = args[++i];
      if (!outFile) return netResult('curl: -o requires a file path', false);
    } else if (a.startsWith('-')) {
      return netResult('curl: option not supported in local browser runtime: ' + a, false);
    } else if (url) {
      return netResult('curl: only one URL is supported', false);
    } else {
      url = a;
    }
  }
  if (!url) return netResult('usage: curl <https-url> | curl -o <file> <https-url>', false);

  // A download with nowhere to write must fail BEFORE any network request.
  if (outFile && !workspace) return netResult('curl: no workspace selected', false);
  if (outFile) {
    try {
      outFile = resolveShellPath(ctx, outFile);
    } catch (e) {
      return netResult('curl: ' + e.message, false);
    }
  }

  let res;
  try {
    res = await NetworkRuntime.fetch(url, { signal: opts && opts.signal });
  } catch (e) {
    if (isCancelledError(e)) return netResult('curl: cancelled', false);
    return netResult('curl: ' + (e && e.message ? e.message : String(e)), false);
  }

  // An HTTP error status is an authoritative response, not a transport
  // failure — report the status (with a text body preview when sensible).
  if (res.status >= 400) {
    let output = 'curl: HTTP ' + res.status + ' from ' + res.finalUrl;
    if (isTextLikeMime(res.headers['content-type']) && res.bytes.byteLength) {
      const preview = new TextDecoder().decode(res.bytes.slice(0, 500)).replace(/\n$/, '');
      if (preview.trim()) output += '\n' + preview;
    }
    return netResult(output, false, res);
  }

  if (outFile) {
    // The fetch awaited: re-check cancellation before writing the file.
    throwIfCancelled(opts && opts.signal, 'curl');
    // Binary-safe: raw bytes go straight into the workspace, no decoding.
    await workspace.write(outFile, res.bytes);
    // Telemetry stays `network`: the download IS the network operation.
    return netResult('[written to workspace: ' + outFile + ', ' + res.bytes.byteLength + ' bytes]', true, res);
  }

  if (isTextLikeMime(res.headers['content-type'])) {
    return netResult(new TextDecoder('utf-8').decode(res.bytes).replace(/\n$/, ''), true, res);
  }

  const mime = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return netResult(
    'curl: binary response (' + mime + ', ' + res.bytes.byteLength + ' bytes); use curl -o <file> <url>',
    true, res);
}
