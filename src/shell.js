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
// Tokenize one command line, keeping quote/operator information.
// Returns [{text, quoted, op}] — quoted text is DATA, never syntax, so
// `echo ">" victim.txt` prints text instead of redirecting into a file.
// Throws on unclosed quotes.
function shellTokenize(line) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let has = false;
  const push = () => {
    if (has) tokens.push({ text: cur, quoted: quoted, op: false });
    cur = '';
    quoted = false;
    has = false;
  };
  let i = 0;
  const s = String(line || '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
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
    if (c === '>' || c === '|' || c === ';' || c === '&') {
      push();
      let op = c;
      if (s[i + 1] === c) { op = c + c; i++; }
      tokens.push({ text: op, quoted: false, op: true });
      i++;
      continue;
    }
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
  return 'bash: ' + cmd + ': command not available in local browser runtime';
}

// Execute one shell command line against the workspace.
// Returns { output: string, isError: boolean, io: {in, out} } — io in UTF-8 bytes.
async function runShellCommand(input, workspace, opts) {
  const line = String(input || '').trim();
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

  // Heredoc python is recognized before generic tokenizing.
  const heredoc = extractPythonHeredoc(line);
  if (heredoc) {
    return await runPythonCode(heredoc.code, workspace, opts);
  }

  let tokens;
  try {
    tokens = shellTokenize(line);
  } catch (e) {
    return err('bash: ' + e.message);
  }
  const cmd = tokens.length ? tokens[0].text : '';
  const args = tokens.slice(1);

  // Fail loudly on shell syntax this runtime does not implement instead of
  // silently treating operators as arguments. Redirects are handled by
  // echo below; everything else (pipes, sequencing, background) is out of
  // scope by design.
  for (const t of args) {
    if (t.op && t.text !== '>' && t.text !== '>>') {
      return err('bash: unsupported shell syntax: ' + t.text +
        ' (single commands only; quote special characters to pass them literally)');
    }
    if (t.op && cmd !== 'echo') {
      return err('bash: redirection is only supported for echo text > file / echo text >> file');
    }
  }

  try {
    switch (cmd) {
      case 'pwd':
        return ok(workspace ? '/' : '/ (no workspace selected)');

      case 'ls': {
        if (!workspace) return err('ls: no workspace selected');
        const path = args.length ? args[0].text : '';
        const entries = await workspace.list(path);
        if (!entries.length) return ok('');
        return ok(entries.map((e) => (e.kind === 'directory' ? e.name + '/' : e.name)).join('\n'));
      }

      case 'cat': {
        if (!workspace) return err('cat: no workspace selected');
        if (!args.length) return err('cat: missing file operand');
        const chunks = [];
        for (const a of args) {
          const st = await workspace.stat(a.text);
          if (st.kind !== 'file') return err('cat: ' + a.text + ': is a directory');
          if (st.size > 512 * 1024) return err('cat: ' + a.text + ': file too large for terminal output (use python)');
          chunks.push(await workspace.read(a.text));
        }
        return ok(chunks.join('\n'));
      }

      case 'echo': {
        // Supports: echo text | echo text > file | echo text >> file
        // Only UNQUOTED > / >> tokens redirect; quoted ones are text.
        let redirect = null, rIndex = -1;
        for (let i = 0; i < args.length; i++) {
          if (args[i].op && (args[i].text === '>' || args[i].text === '>>')) { redirect = args[i].text; rIndex = i; break; }
        }
        if (redirect) {
          if (!workspace) return err('echo: no workspace selected');
          const target = args[rIndex + 1];
          if (!target) return err('echo: missing redirect target');
          let text = args.slice(0, rIndex).map((t) => t.text).join(' ') + '\n';
          if (redirect === '>>' && (await workspace.exists(target.text))) {
            text = (await workspace.read(target.text)) + text;
          }
          // reads above awaited: re-check cancellation before writing
          throwIfCancelled(opts && opts.signal, 'echo');
          await workspace.write(target.text, text);
          return ok('');
        }
        return ok(args.map((t) => t.text).join(' '));
      }

      case 'python':
      case 'python3':
        return await runPython(args.map((t) => t.text), workspace, opts);

      case 'curl':
        return await runCurl(args.map((t) => t.text), workspace, line, opts);

      default:
        return err(shellError(cmd));
    }
  } catch (e) {
    if (isCancelledError(e)) return err('bash: cancelled');
    return err('bash: ' + (e && e.message ? e.message : String(e)));
  }

  function ok(output) {
    return { output, isError: false, io: { in: utf8ByteLength(line), out: utf8ByteLength(output) } };
  }
  function err(output) {
    return { output, isError: true, io: { in: utf8ByteLength(line), out: utf8ByteLength(output) } };
  }
}

async function runPython(args, workspace, opts) {
  let code = null;

  if (!args.length) {
    return { output: 'usage: python -c "<code>" | python <script.py> | python <<\'PY\' ... PY', isError: true, io: { in: utf8ByteLength('python'), out: 0 } };
  }
  if (args[0] === '--version' || args[0] === '-V') {
    return { output: 'Python (browser runtime)', isError: false, io: { in: utf8ByteLength('python'), out: 0 } };
  }
  if (args[0] === '-c') {
    code = args.slice(1).join(' ');
  } else {
    const script = args[0];
    if (!workspace) return { output: 'python: no workspace selected (cannot read ' + script + ')', isError: true, io: { in: utf8ByteLength(script), out: 0 } };
    try {
      code = await workspace.read(script);
    } catch (e) {
      return { output: 'python: can\'t open file \'' + script + '\': ' + e.message, isError: true, io: { in: utf8ByteLength(script), out: 0 } };
    }
  }

  return await runPythonCode(code, workspace, opts);
}

async function runPythonCode(code, workspace, opts) {
  if (!code || !code.trim()) {
    return { output: 'python: empty code', isError: true, io: { in: 0, out: 0 } };
  }

  let res;
  try {
    res = await PythonRuntime.run(code, workspace, opts);
  } catch (e) {
    if (isCancelledError(e)) {
      return { output: 'python: execution cancelled', isError: true, cancelled: true, io: { in: utf8ByteLength(code), out: 0 } };
    }
    throw e;
  }

  let output = '';
  if (res.stdout) output += res.stdout.replace(/\n$/, '');
  if (res.stderr) output += (output ? '\n' : '') + res.stderr.replace(/\n$/, '');
  if (res.error) output += (output ? '\n' : '') + res.error;
  if (res.stdoutTruncated) {
    output += (output ? '\n' : '') + '[python output limit: stdout truncated]';
  }
  if (res.stderrTruncated) {
    output += (output ? '\n' : '') + '[python output limit: stderr truncated]';
  }
  if (res.skipped && res.skipped.length) {
    const shown = res.skipped.slice(0, 10).map((s) => s.path + ' (' + s.reason + ')');
    output += (output ? '\n' : '') +
      '[workspace sync: ' + res.skipped.length + ' file(s) NOT visible to Python: ' + shown.join('; ') +
      (res.skipped.length > shown.length ? '; …' : '') + ']';
  }
  if (res.written && res.written.length) {
    output += (output ? '\n' : '') + '[written to workspace: ' + res.written.join(', ') + ']';
  }
  if (res.deleted && res.deleted.length) {
    output += (output ? '\n' : '') + '[deleted from workspace: ' + res.deleted.join(', ') + ']';
  }
  for (const c of res.conflicts || []) {
    output += (output ? '\n' : '') + '[conflict: ' + c.path + ': ' + c.reason + ']';
  }
  for (const f of res.writeFailed || []) {
    output += (output ? '\n' : '') + '[write-back failed: ' + f + ']';
  }
  for (const p of res.notPersisted || []) {
    output += (output ? '\n' : '') + '[not persisted: ' + p + ']';
  }

  // Compute success and commit success are reported separately: a run that
  // computed fine but could not fully persist is a FAILURE state (partial
  // commit), never a silent success. Multi-file commits are staged, NOT
  // atomic — partial results are always spelled out above.
  const commitFailed = (res.writeFailed && res.writeFailed.length > 0)
    || (res.conflicts && res.conflicts.length > 0)
    || (res.notPersisted && res.notPersisted.length > 0);

  return {
    output,
    isError: !!res.error || commitFailed,
    io: { in: utf8ByteLength(code) + res.inputBytes, out: utf8ByteLength(output) + res.outputBytes },
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

async function runCurl(args, workspace, line, opts) {
  const io = { in: utf8ByteLength(line), out: 0 };
  const netResult = (output, isError, net) => ({
    output,
    isError,
    io: { in: io.in, out: io.out || utf8ByteLength(output) },
    // network metadata flows up to telemetry via executeTool
    backend: net && net.backend,
    operation: 'network',
  });

  // Parse: exactly one URL positional; only -o/--output takes a value.
  let outFile = null;
  let url = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      outFile = args[++i];
      if (!outFile) return netResult('curl: -o requires a file path', true);
    } else if (a.startsWith('-')) {
      return netResult('curl: option not supported in local browser runtime: ' + a, true);
    } else if (url) {
      return netResult('curl: only one URL is supported', true);
    } else {
      url = a;
    }
  }
  if (!url) return netResult('usage: curl <https-url> | curl -o <file> <https-url>', true);

  // A download with nowhere to write must fail BEFORE any network request.
  if (outFile && !workspace) return netResult('curl: no workspace selected', true);

  let res;
  try {
    res = await NetworkRuntime.fetch(url, { signal: opts && opts.signal });
  } catch (e) {
    if (isCancelledError(e)) return netResult('curl: cancelled', true);
    return netResult('curl: ' + (e && e.message ? e.message : String(e)), true);
  }
  io.out = res.bytes.byteLength;

  // An HTTP error status is an authoritative response, not a transport
  // failure — report the status (with a text body preview when sensible).
  if (res.status >= 400) {
    let output = 'curl: HTTP ' + res.status + ' from ' + res.finalUrl;
    if (isTextLikeMime(res.headers['content-type']) && res.bytes.byteLength) {
      const preview = new TextDecoder().decode(res.bytes.slice(0, 500)).replace(/\n$/, '');
      if (preview.trim()) output += '\n' + preview;
    }
    return netResult(output, true, res);
  }

  if (outFile) {
    // The fetch awaited: re-check cancellation before writing the file.
    throwIfCancelled(opts && opts.signal, 'curl');
    // Binary-safe: raw bytes go straight into the workspace, no decoding.
    await workspace.write(outFile, res.bytes);
    return netResult('[written to workspace: ' + outFile + ', ' + res.bytes.byteLength + ' bytes]', false, res);
  }

  if (isTextLikeMime(res.headers['content-type'])) {
    return netResult(new TextDecoder('utf-8').decode(res.bytes).replace(/\n$/, ''), false, res);
  }

  const mime = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return netResult(
    'curl: binary response (' + mime + ', ' + res.bytes.byteLength + ' bytes); use curl -o <file> <url>',
    false, res);
}
