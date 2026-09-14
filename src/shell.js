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
      p.resolve({ stdout: '', stderr: '', error: errorMessage, files: [], deleted: [], createdDirs: [], deletedDirs: [] });
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

  // Run Python code with every VFS data mount mirrored in.
  // `vfs` is always a VirtualWorkspace (asVfs guarantees it); opts carries
  // { signal, cwd } — cwd is the ABSOLUTE VFS path of the shell invocation
  // and becomes Python's working directory.
  // opts.signal (optional AbortSignal) cancels the run: cancellation is
  // checked before starting, during mount collection, after the worker
  // reply, after EVERY async pre-check and before EVERY commit side effect.
  // Commits already finished are not rolled back — the result reports
  // exactly what committed and what never ran.
  // Returns {
  //   stdout, stderr, error,            — compute outcome
  //   written, deleted,                 — ABS paths actually committed (deleted covers files AND directories)
  //   mkdirs,                           — ABS directory paths actually created
  //   conflicts: [{path, reason}],      — commits refused (read-only mount / external change / unsynced path / type change)
  //   writeFailed: [description],       — commits attempted but failed
  //   notPersisted: [paths],            — generated changes never written (cancelled / incomplete changeset)
  //   skipped: [{path, reason}],        — files NOT mirrored into Python (ABS paths)
  //   uncollected: [paths],             — python outputs over the worker caps (changeset incomplete)
  //   stdoutTruncated, stderrTruncated, — output notice flags (NOT commit failures)
  // }
  async run(code, vfs, opts) {
    const signal = opts && opts.signal;
    this._ensureWorker();
    this._setStatus('loading');
    throwIfCancelled(signal, 'python execution');

    // Mirror every data mount: files are collected from each provider with
    // RELATIVE paths and rebased onto the mount root, so the worker mirror,
    // the snapshot keys and every commit/conflict message all use absolute
    // VFS paths.
    const mounts = [];
    let skipped = [];
    let inputBytes = 0;
    const snapshot = {}; // ABS path → b64 at sync-in time (optimistic concurrency base)
    if (vfs && typeof vfs.dataMounts === 'function') {
      for (const dm of vfs.dataMounts()) {
        const collected = await collectWorkspaceFiles(dm.provider, signal);
        const files = collected.files.map((f) => ({ path: dm.root + '/' + f.path, b64: f.b64 }));
        // Every real VFS directory (empty ones included) is mirrored in, so
        // Python sees the same directory tree the shell does.
        const directories = collected.dirs.map((d) => dm.root + '/' + d);
        skipped = skipped.concat(collected.skipped.map((s) => ({ path: dm.root + '/' + s.path, reason: s.reason })));
        for (const f of files) snapshot[f.path] = f.b64;
        inputBytes += files.reduce((n, f) => n + b64ByteLength(f.b64), 0);
        mounts.push({
          root: dm.root,
          readOnly: dm.authority === 'read-only' || dm.authority === 'system-read-only',
          files: files,
          directories: directories,
        });
      }
    }
    // The shell cwd must exist in the Python mirror — but it is only ever
    // CREATED there when the VFS itself confirms it is a real directory.
    // A bogus cwd must still fail in Python, never be fabricated.
    const cwdAbs = (opts && opts.cwd) || (vfs && typeof vfs.defaultCwd === 'function' ? vfs.defaultCwd() : '/');
    for (const m of mounts) {
      if (cwdAbs === m.root || !cwdAbs.startsWith(m.root + '/')) continue;
      if (m.directories.indexOf(cwdAbs) === -1) {
        let st = null;
        try { st = await vfs.stat(cwdAbs); } catch (e) { st = null; }
        if (st && st.kind === 'directory') m.directories.push(cwdAbs);
      }
      break;
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
        this.worker.postMessage({
          id: id, cmd: 'run', code: code,
          cwd: cwdAbs,
          mounts: mounts,
        });
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    throwIfCancelled(signal, 'python execution');

    const skippedSet = new Set(skipped.map((s) => s.path));
    const uncollected = result.uncollectedFiles || [];
    const createdDirs = result.createdDirs || []; // worker emits parent-first
    const deletedDirs = result.deletedDirs || []; // worker emits child-first
    const written = [];
    const mkdirs = [];
    const conflicts = [];
    const writeFailed = [];
    const notPersisted = [];
    const outFiles = result.files || [];

    for (const p of uncollected) {
      notPersisted.push(p + ' (over python output limit; changeset incomplete)');
    }

    // ---- commit phase 0: created directories (parent before child) ----
    // Directory creations route through the same mount-authority checks as
    // file writes: read-only mounts reject with a conflict, and a path
    // already occupied by a FILE is a loud refusal — file↔directory type
    // changes are never half-applied.
    for (const d of createdDirs) {
      if (signal && signal.aborted) {
        notPersisted.push('mkdir ' + d + ' (cancelled before commit)');
        continue;
      }
      const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(d) : null;
      if (!mount) {
        conflicts.push({ path: d, reason: 'not under any writable mount; mkdir skipped' });
        continue;
      }
      if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
        conflicts.push({
          path: d,
          reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
        });
        continue;
      }
      let st = null;
      try {
        st = await vfs.stat(d);
      } catch (e) {
        if (!e || e.name !== 'NotFoundError') {
          conflicts.push({ path: d, reason: 'could not verify current on-disk state (' + e.message + '); mkdir skipped' });
          continue;
        }
      }
      if (st && st.kind === 'directory') continue; // appeared externally — already satisfied
      if (st) {
        conflicts.push({ path: d, reason: 'a file exists at this path; file→directory type changes are not committed' });
        continue;
      }
      // The stat above awaited: re-check cancellation BEFORE the side effect.
      if (signal && signal.aborted) {
        notPersisted.push('mkdir ' + d + ' (cancelled before commit)');
        continue;
      }
      try {
        await vfs.mkdir(d);
        mkdirs.push(d);
      } catch (e) {
        writeFailed.push('mkdir ' + d + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ---- commit phase 1: create/modify ----
    // EVERY changed ABS path is routed through the mount table: read-only
    // mounts reject with a conflict (the worker mirror is writable, so
    // authority is enforced HERE, at commit time — the provider bytes are
    // never touched), external mounts keep the optimistic-concurrency
    // check, internal mounts write straight through.
    for (const f of outFiles) {
      if (signal && signal.aborted) {
        notPersisted.push(f.path + ' (cancelled before write)');
        continue;
      }
      const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(f.path) : null;
      if (!mount) {
        conflicts.push({ path: f.path, reason: 'not under any writable mount; refusing to write' });
        continue;
      }
      if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
        conflicts.push({
          path: f.path,
          reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
        });
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
      if (mount.authority === 'external-read-write') {
        let conflict = null;
        try {
          conflict = await detectExternalChange(vfs, f.path, snapshot, bytes);
        } catch (e) {
          conflict = { path: f.path, reason: 'could not verify current on-disk state (' + e.message + '); refusing to overwrite' };
        }
        if (conflict) {
          conflicts.push(conflict);
          continue;
        }
      }
      // The pre-check awaited: cancellation may have landed meanwhile.
      // Re-check BEFORE the side effect, not just at the loop top.
      if (signal && signal.aborted) {
        notPersisted.push(f.path + ' (cancelled before write)');
        continue;
      }
      try {
        await vfs.write(f.path, bytes);
        written.push(f.path);
      } catch (e) {
        writeFailed.push(f.path + ': ' + (e && e.message ? e.message : String(e)));
      }
    }

    // ---- commit phase 2: deletions (rename = delete + create) ----
    // If ANY write failed, was refused, or the worker could not collect the
    // full changeset, the run's new state is incomplete — deleting sources
    // could destroy the only good copy (e.g. a rename whose target never
    // landed). Stop the delete phase.
    const deleted = [];
    const deletesBlocked = writeFailed.length > 0 || conflicts.length > 0 || uncollected.length > 0;
    if (result.deleted && result.deleted.length && !deletesBlocked) {
      for (const p of result.deleted) {
        if (signal && signal.aborted) {
          notPersisted.push('delete ' + p + ' (cancelled before commit)');
          continue;
        }
        const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(p) : null;
        if (!mount) {
          conflicts.push({ path: p, reason: 'not under any writable mount; deletion skipped' });
          continue;
        }
        if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
          conflicts.push({
            path: p,
            reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
          });
          continue;
        }
        if (mount.authority === 'external-read-write' && snapshot[p] !== undefined) {
          // Only delete the exact content we mirrored: re-read and compare
          // against the snapshot so an externally modified/replaced file is
          // never removed from under the user.
          let currentB64 = null;
          try {
            currentB64 = bytesToB64(await vfs.readBytes(p));
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
          await vfs.remove(p);
          deleted.push(p);
        } catch (e) {
          if (e && e.name === 'NotFoundError') continue; // already gone
          writeFailed.push('delete ' + p + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    } else if (result.deleted && result.deleted.length && deletesBlocked) {
      const why = uncollected.length > 0
        ? 'output changeset incomplete (' + uncollected.length + ' file(s) not collected), sources preserved'
        : 'earlier commits failed, sources preserved';
      notPersisted.push('deletions skipped (' + result.deleted.join(', ') + '): ' + why);
    }

    // ---- commit phase 3: deleted directories (child before parent) ----
    // Same honesty rule as file deletions, re-evaluated AFTER phase 2: any
    // failed/refused/incomplete commit so far means the run's new state is
    // incomplete — removing directories could destroy data, so stop.
    const dirDeletesBlocked = deletesBlocked || writeFailed.length > 0 || conflicts.length > 0;
    if (deletedDirs.length && !dirDeletesBlocked) {
      for (const p of deletedDirs) {
        if (signal && signal.aborted) {
          notPersisted.push('rmdir ' + p + ' (cancelled before commit)');
          continue;
        }
        if (vfs && typeof vfs.isProtectedRoot === 'function' && vfs.isProtectedRoot(p)) {
          conflicts.push({ path: p, reason: 'protected path; refusing to remove directory' });
          continue;
        }
        const mount = vfs && typeof vfs.resolveMount === 'function' ? vfs.resolveMount(p) : null;
        if (!mount) {
          conflicts.push({ path: p, reason: 'not under any writable mount; rmdir skipped' });
          continue;
        }
        if (mount.authority === 'read-only' || mount.authority === 'system-read-only') {
          conflicts.push({
            path: p,
            reason: 'read-only filesystem: changes under ' + mount.path + ' are never committed',
          });
          continue;
        }
        // A directory that still holds unsynced files is not empty — the
        // provider refuses the removal and the failure is reported below.
        try {
          await vfs.remove(p);
          deleted.push(p);
        } catch (e) {
          if (e && e.name === 'NotFoundError') continue; // already gone
          writeFailed.push('rmdir ' + p + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
    } else if (deletedDirs.length && dirDeletesBlocked) {
      const why = uncollected.length > 0
        ? 'output changeset incomplete (' + uncollected.length + ' file(s) not collected), sources preserved'
        : 'earlier commits failed, sources preserved';
      notPersisted.push('directory deletions skipped (' + deletedDirs.join(', ') + '): ' + why);
    }

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error || null,
      written,
      mkdirs,
      deleted,
      conflicts,
      writeFailed,
      notPersisted,
      skipped,
      uncollected,
      stdoutTruncated: !!result.stdoutTruncated,
      stderrTruncated: !!result.stderrTruncated,
      inputBytes: inputBytes,
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
  const dirs = []; // RELATIVE paths of every directory (empty ones included)
  const skipped = [];
  let total = 0;

  async function walk(rel) {
    throwIfCancelled(signal, 'workspace collection');
    const entries = await workspace.list(rel);
    throwIfCancelled(signal, 'workspace collection');
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.kind === 'directory') {
        // Directories are real filesystem state: an empty dir must exist in
        // the Python mirror (the shell cwd may point at it) and must survive
        // a round trip. Content caps below apply to files only.
        dirs.push(childRel);
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
  return { files, skipped, dirs };
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
// Append (`>>` / `2>>`) holds old+new bytes in memory, so the EXISTING
// content is bounded (16 MiB, matching the memory-provider per-file cap).
// A bigger target fails loudly — never a silent truncate, partial write
// or OOM.
const APPEND_MAX_EXISTING_BYTES = 16 * 1024 * 1024;
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
    summary: 'change the cwd for THIS invocation only (bare cd → the default cwd)',
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
    summary: 'run Python (Pyodide); script paths resolve against the shell cwd and Python runs in that same directory',
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
  + 'rm -rf / (and every protected mount root: /usr /home /home/locus /mnt /mnt/workspace '
  + '/mnt/upload /mnt/download /mnt/plugins) is always refused.';

function shellHelpText() {
  return [
    'Locus shell — a Unix-like compatibility shell, NOT full POSIX bash, on a small Linux-like browser machine.',
    'Every bash invocation starts at the default cwd: /mnt/workspace when a workspace folder is mounted, otherwise /home/locus (HOME).',
    '`cd` changes the working directory only within the current invocation; the next bash call starts at the default cwd again.',
    'Filesystem layout: /mnt/workspace (mounted working folder), /mnt/upload (read-only inputs),',
    '/mnt/download (downloadable artifacts), /tmp (scratch), /home/locus (home), /usr/bin + /bin (commands).',
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
    '  This is a Unix-like compatibility shell, NOT full POSIX bash, on a small Linux-like browser machine.',
    '  HOME=/home/locus. Every bash invocation starts at the default cwd: /mnt/workspace when a workspace',
    '  folder is mounted, otherwise /home/locus. `cd` affects only the current invocation.',
    '  Filesystem layout:',
    '    /mnt/workspace  user-authorized working folder (only present when mounted)',
    '    /mnt/upload     user-uploaded input files, READ-ONLY',
    '    /mnt/download   writable; files here are offered to the user as downloadable artifacts',
    '    /tmp            writable scratch space',
    '    /home/locus     your writable home',
    '    /usr/bin, /bin  available commands (virtual userland view)',
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
    '  rm -rf / (and every protected mount root) is always refused. Shell glob expansion is not supported:',
    '  * in command arguments stays literal — use find -name "*.tmp" to locate files.',
    '  ' + SHELL_UNSUPPORTED_NOTE,
    '  Run `help` at runtime to see this contract again.',
    '  curl usage (public HTTPS resources only):',
    '    curl <https-url>                  fetches a URL; text/JSON/XML responses are printed directly.',
    '    curl -o <file> <https-url>        downloads binary-safe into a writable file (use this for images,',
    '                                    PDFs, archives, or any data you want to keep or process, e.g. under /mnt/download).',
    '  curl supports NO other flags (no -H/-X/-d/-u/cookies). URLs must be https://.',
    '  Network access may be served by a direct browser fetch or a transparent relay — you do not need to',
    '  know or care which. If curl fails, report the error; do NOT switch to cloud_bash for network access.',
    '  python usage: for short one-liners use python -c "<code>"; for anything multi-line or containing mixed quotes,',
    '  prefer the heredoc form — the code between the markers is passed to Python verbatim:',
    '    python <<\'PY\'',
    '    import pandas as pd',
    '    print(pd.DataFrame({"a": [1]}).to_json())',
    '    PY',
    '  python has the standard library and pandas available. Python sees the SAME filesystem as the shell',
    '  (/mnt/workspace, /mnt/upload, /mnt/download, /tmp, /home/locus) and runs with the shell cwd as its',
    '  working directory. /mnt/upload is read-only, also from Python. python and curl do not read pipeline stdin.',
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

// ---------- VFS bridge ----------
// The shell ALWAYS runs against a VirtualWorkspace: a real VFS is used
// as-is, a legacy WorkspaceAdapter is mounted at /mnt/workspace
// (external-read-write), and a missing argument yields a fresh internal
// machine (test isolation). The filesystem therefore always exists — there
// is no "no workspace selected" state anywhere in the shell.
function asVfs(x) {
  if (x && x.isLocusVFS) return x;
  const vfs = new VirtualWorkspace({ listCommands: () => Object.keys(SHELL_COMMANDS) });
  if (x) vfs.mount('/mnt/workspace', x, 'external-read-write');
  return vfs;
}

// Resolve a (possibly relative) shell path against the invocation-local
// cwd to an ABSOLUTE VFS path. `..` above the filesystem root is rejected
// by normalizeVfsPath.
function resolveShellPath(ctx, p) {
  return normalizeVfsPath(String(p || ''), ctx.cwd);
}

// Join a child name onto an absolute directory path.
function joinAbs(abs, name) {
  return abs === '/' ? '/' + name : abs + '/' + name;
}

// Stat for the filesystem, and report a uniform "no such file or
// directory" for plain missing entries; NotMountedError passes its clear
// message through unchanged.
async function statShellPath(ctx, display, abs) {
  try {
    return await ctx.vfs.stat(abs);
  } catch (e) {
    if (e && e.name === 'NotFoundError') throw new Error(display + ': no such file or directory');
    if (e && e.name === 'NotMountedError') throw new Error(e.message);
    throw e;
  }
}

// Compact writability-failure wording shared by mv/curl/redirects.
function writableErrMsg(e) {
  if (e && e.name === 'NotMountedError') return 'not mounted';
  if (e && e.name === 'ReadOnlyError') return 'read-only filesystem';
  return e && e.message ? e.message : String(e);
}

// The parent of an absolute target must be an existing directory. Mount
// roots and structural directories always exist; only real intermediate
// directories are statted (legacy providers may not answer stat('') for
// their own root).
async function checkParentDir(vfs, abs) {
  const i = abs.lastIndexOf('/');
  const parent = i <= 0 ? '/' : abs.slice(0, i);
  const m = vfs.resolveMount(parent);
  if (m && m.rel === '') return null; // the parent IS a mount root
  let pst;
  try {
    pst = await vfs.stat(parent);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return 'no such directory';
    return writableErrMsg(e);
  }
  if (pst.kind !== 'directory') return 'parent is not a directory';
  return null;
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

// Byte-preserving append primitive shared by `>>` and `2>>`. The existing
// target is read as RAW BYTES — never decoded to text (a lossy UTF-8
// decode would silently replace non-UTF-8 bytes with U+FFFD and corrupt
// binary files on rewrite). Order: read/preflight → assemble the complete
// target bytes → re-check cancellation → ONE write, so a read, quota or
// cancellation failure leaves the original file untouched.
async function appendFileBytes(vfs, path, payload, signal, what) {
  let old = null;
  try {
    old = await vfs.readBytes(path);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') throw e; // missing target → plain create
  }
  let bytes = payload;
  if (old) {
    if (old.byteLength > APPEND_MAX_EXISTING_BYTES) {
      throw vfsError('QuotaExceededError', 'append target is ' + old.byteLength
        + ' bytes, over the ' + APPEND_MAX_EXISTING_BYTES + '-byte append limit: ' + path);
    }
    bytes = new Uint8Array(old.byteLength + payload.byteLength);
    bytes.set(old, 0);
    bytes.set(payload, old.byteLength);
  }
  throwIfCancelled(signal, what);
  await vfs.write(path, bytes);
}

async function shPwd(ctx) {
  return shOk(ctx.cwd);
}

async function shCd(ctx, args) {
  if (args.length > 1) return shErr('cd: too many arguments');
  const target = args.length ? args[0].text : '';
  if (!target) { ctx.cwd = ctx.vfs.defaultCwd(); return shOk(''); }
  let abs;
  try {
    abs = resolveShellPath(ctx, target);
  } catch (e) {
    return shErr('cd: ' + target + ': ' + e.message);
  }
  let st;
  try {
    st = await ctx.vfs.stat(abs);
  } catch (e) {
    return shErr('cd: ' + target + ': ' + (e && e.name === 'NotFoundError' ? 'no such directory' : writableErrMsg(e)));
  }
  if (st.kind !== 'directory') return shErr('cd: ' + target + ': not a directory');
  ctx.cwd = abs;
  return shOk('');
}

async function shLs(ctx, args) {
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
    let abs;
    try {
      abs = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('ls: ' + e.message);
    }
    const st = await statShellPath(ctx, p, abs);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    if (st.kind !== 'directory') {
      sections.push(lsFormatEntry(p, st, flagL, flagH));
      continue;
    }
    const entries = await ctx.vfs.list(abs);
    throwIfCancelled(ctx.opts && ctx.opts.signal, 'ls');
    const lines = [];
    for (const e of entries) {
      if (!flagA && e.name.charAt(0) === '.') continue;
      let est = null;
      if (flagL) est = await ctx.vfs.stat(joinAbs(abs, e.name));
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
  const chunks = [];
  for (const a of args) {
    const abs = resolveShellPath(ctx, a.text);
    const st = await statShellPath(ctx, a.text, abs);
    if (st.kind !== 'file') return shErr('cat: ' + a.text + ': is a directory');
    if (st.size > CAT_MAX_FILE_BYTES) return shErr('cat: ' + a.text + ': file too large for terminal output (use python)');
    chunks.push(await ctx.vfs.read(abs));
  }
  return shOk(chunks.join('\n'));
}

async function shEcho(ctx, args) {
  // Redirection is generic (executor-level) — echo only prints its arguments.
  return shOk(args.map((t) => t.text).join(' '));
}

async function shFind(ctx, args) {
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

  async function walk(abs, disp, depth, kind) {
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
    const entries = await ctx.vfs.list(abs);
    for (const e of entries) {
      await walk(joinAbs(abs, e.name), joinDisplay(disp, e.name), depth + 1, e.kind);
      if (state.truncated) return;
    }
  }

  for (const p of paths) {
    let abs;
    try {
      abs = resolveShellPath(ctx, p);
    } catch (e) {
      return shErr('find: ' + e.message);
    }
    const st = await statShellPath(ctx, p, abs);
    await walk(abs, p.replace(/\/+$/, '') || '.', 0, st.kind);
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

  async function grepFile(abs, disp, showPath) {
    const st = await ctx.vfs.stat(abs);
    if (st.size > GREP_MAX_FILE_BYTES) {
      skipped.push(disp + ' (over ' + GREP_MAX_FILE_BYTES + '-byte grep limit)');
      return;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await ctx.vfs.readBytes(abs));
    } catch (e) {
      skipped.push(disp + ' (not UTF-8 text)');
      return;
    }
    grepText(text, disp, showPath);
  }

  async function grepDir(abs, disp) {
    if (state.truncated) return;
    throwIfCancelled(signal, 'grep');
    const entries = await ctx.vfs.list(abs);
    for (const e of entries) {
      if (state.truncated) return;
      throwIfCancelled(signal, 'grep');
      const childAbs = joinAbs(abs, e.name);
      const childDisp = joinDisplay(disp, e.name);
      if (e.kind === 'directory') {
        await grepDir(childAbs, childDisp);
      } else {
        state.filesSeen++;
        if (state.filesSeen > GREP_MAX_FILES) { state.truncated = true; return; }
        await grepFile(childAbs, childDisp, true);
      }
    }
  }

  if (!paths.length) {
    grepText(stdin, '', false);
  } else {
    for (const p of paths) {
      if (state.truncated) break;
      let abs;
      try {
        abs = resolveShellPath(ctx, p);
      } catch (e) {
        return shErr('grep: ' + e.message);
      }
      const st = await statShellPath(ctx, p, abs);
      if (st.kind === 'directory') {
        if (!flagR) return shErr('grep: ' + p + ': is a directory (use -r to search recursively)');
        await grepDir(abs, p.replace(/\/+$/, '') || '.');
      } else {
        await grepFile(abs, p, showPathDefault);
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
  const abs = resolveShellPath(ctx, paths[0]);
  const st = await statShellPath(ctx, paths[0], abs);
  if (st.kind !== 'file') return { error: cmd + ': ' + paths[0] + ': is a directory' };
  if (st.size > CAT_MAX_FILE_BYTES) return { error: cmd + ': ' + paths[0] + ': file too large for terminal output (use python)' };
  return { text: await ctx.vfs.read(abs) };
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
    const abs = resolveShellPath(ctx, p);
    const st = await statShellPath(ctx, p, abs);
    if (st.kind !== 'file') return shErr('wc: ' + p + ': is a directory');
    const bytes = await ctx.vfs.readBytes(abs); // -c is real UTF-8 bytes, not JS string length
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
  let destAbs;
  try {
    destAbs = resolveShellPath(ctx, destDisplay);
  } catch (e) {
    return shErr('mv: ' + destDisplay + ': ' + e.message);
  }
  const sources = operands.slice(0, -1);
  let destStat = null;
  try {
    destStat = await ctx.vfs.stat(destAbs);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') return shErr('mv: ' + destDisplay + ': ' + writableErrMsg(e));
  }
  if (sources.length > 1 && (!destStat || destStat.kind !== 'directory')) {
    return shErr('mv: target ' + destDisplay + ': not a directory (required with multiple sources)');
  }

  // ---- preflight: validate EVERY source and BOTH mount authorities before
  // ANY mutation — a cross-mount move must never create a partial
  // destination only to discover the source is read-only afterwards. ----
  const plan = [];
  for (const srcDisplay of sources) {
    throwIfCancelled(signal, 'mv');
    let srcAbs;
    try {
      srcAbs = resolveShellPath(ctx, srcDisplay);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + e.message);
    }
    if (ctx.vfs.isProtectedRoot(srcAbs)) {
      return shErr('mv: ' + srcDisplay + ': refusing to move protected path: ' + srcAbs);
    }
    let srcStat;
    try {
      srcStat = await ctx.vfs.stat(srcAbs);
    } catch (e) {
      return shErr('mv: ' + srcDisplay + ': ' + (e && e.name === 'NotFoundError' ? 'no such file or directory' : writableErrMsg(e)));
    }
    const srcMount = ctx.vfs.resolveMount(srcAbs);
    if (!srcMount || srcMount.authority === 'read-only' || srcMount.authority === 'system-read-only') {
      return shErr('mv: ' + srcDisplay + ': source is on a read-only filesystem; move cannot remove source');
    }

    // An existing destination directory means "move INTO it"; any other
    // existing destination is a loud failure (no implicit overwrite, no -f).
    let finalAbs = destAbs;
    if (destStat && destStat.kind === 'directory') {
      finalAbs = joinAbs(destAbs, baseName(srcAbs));
    }
    if (finalAbs === srcAbs) return shErr('mv: ' + srcDisplay + ' and ' + destDisplay + ' are the same file');
    if (destStat && destStat.kind !== 'directory') {
      return shErr('mv: ' + destDisplay + ': destination exists');
    }
    if (srcStat.kind === 'directory' && finalAbs.startsWith(srcAbs + '/')) {
      return shErr('mv: cannot move a directory into itself: ' + srcDisplay);
    }
    if (await ctx.vfs.exists(finalAbs)) {
      return shErr('mv: destination exists: ' + (destStat && destStat.kind !== 'directory' ? finalAbs : destDisplay));
    }
    // The destination parent must be an existing directory.
    const parentErr = await checkParentDir(ctx.vfs, finalAbs);
    if (parentErr) return shErr('mv: ' + destDisplay + ': ' + parentErr);
    // The destination mount must be writable BEFORE anything is created.
    try {
      ctx.vfs.assertWritable(finalAbs);
    } catch (e) {
      return shErr('mv: ' + destDisplay + ': ' + writableErrMsg(e));
    }
    plan.push({ srcAbs: srcAbs, srcStat: srcStat, finalAbs: finalAbs });
  }

  const moved = [];
  for (const step of plan) {
    throwIfCancelled(signal, 'mv');
    const err = step.srcStat.kind === 'directory'
      ? await mvDirectory(ctx, step.srcAbs, step.finalAbs, signal)
      : await mvFile(ctx, step.srcAbs, step.finalAbs, signal);
    if (err) return shErr(err);
    moved.push(step.srcAbs + ' -> ' + step.finalAbs);
  }
  const r = shOk('');
  r.fs = true;
  return r;
}

// file → new path: copy, VERIFY the destination landed, only then remove
// the source. A failed/short destination write leaves the source untouched.
async function mvFile(ctx, srcAbs, finalAbs, signal) {
  throwIfCancelled(signal, 'mv');
  const bytes = await ctx.vfs.readBytes(srcAbs);
  throwIfCancelled(signal, 'mv');
  await ctx.vfs.write(finalAbs, bytes);
  throwIfCancelled(signal, 'mv');
  const check = await ctx.vfs.readBytes(finalAbs);
  if (check.byteLength !== bytes.byteLength || bytesToB64(check) !== bytesToB64(bytes)) {
    return 'mv: write verification failed for ' + finalAbs + '; source preserved';
  }
  throwIfCancelled(signal, 'mv');
  await ctx.vfs.remove(srcAbs);
  return null;
}

// directory → new path: bounded pre-scan, EXPLICIT destination tree
// creation (the tree itself is part of the data — empty directories must
// survive a move), per-file copy with read-back verification, and ONLY THEN
// a separate recursive delete of the source. Any failure or cancellation in
// the creation/copy/verify phase leaves the source tree fully intact; the
// partial destination is reported, never silently cleaned up.
async function mvDirectory(ctx, srcAbs, finalAbs, signal) {
  // ---- pre-scan: complete tree description; every bound is enforced BEFORE
  // the destination starts to exist ----
  const files = [];
  const dirs = []; // pre-order: parents always precede their children
  let totalBytes = 0;
  async function scan(abs) {
    throwIfCancelled(signal, 'mv');
    const entries = await ctx.vfs.list(abs);
    for (const e of entries) {
      // The entry bound is enforced per entry — a single flat directory can
      // exceed it without any nested scan() call ever re-checking.
      if (files.length + dirs.length >= MV_MAX_ENTRIES) {
        throw new Error('mv: directory exceeds the ' + MV_MAX_ENTRIES + '-entry move limit');
      }
      const child = joinAbs(abs, e.name);
      if (e.kind === 'directory') {
        dirs.push(child);
        await scan(child);
      } else {
        const st = await ctx.vfs.stat(child);
        totalBytes += st.size;
        if (totalBytes > MV_MAX_TOTAL_BYTES) {
          throw new Error('mv: directory exceeds the ' + MV_MAX_TOTAL_BYTES + '-byte move limit');
        }
        files.push(child);
      }
    }
  }
  try {
    await scan(srcAbs);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return e.message;
  }

  // ---- destination tree creation + copy + verify ----
  const createdDirs = [];
  const copiedFiles = [];
  const throwCopyCancelled = () => {
    if (signal && signal.aborted) {
      const e = makeCancelledError('mv');
      e.detail = 'mv: cancelled during copy; source preserved; partial destination may exist'
        + ' (created ' + createdDirs.length + ' director(y/ies), copied '
        + copiedFiles.length + '/' + files.length + ' file(s))';
      throw e;
    }
  };
  try {
    // The destination root itself is created explicitly — even a completely
    // empty source directory must materialize as an empty destination.
    throwCopyCancelled();
    await ctx.vfs.mkdir(finalAbs);
    createdDirs.push(finalAbs);
    // Child directories shallow-to-deep (pre-order scan already guarantees
    // parents first; mkdir itself is recursive as a second safety net).
    for (const d of dirs) {
      throwCopyCancelled();
      const target = finalAbs + '/' + d.slice(srcAbs.length + 1);
      await ctx.vfs.mkdir(target);
      createdDirs.push(target);
    }
    // Copy every file and verify the copy byte-for-byte before it counts.
    for (const f of files) {
      throwCopyCancelled();
      const bytes = await ctx.vfs.readBytes(f);
      throwCopyCancelled();
      const destPath = finalAbs + '/' + f.slice(srcAbs.length + 1);
      await ctx.vfs.write(destPath, bytes);
      throwCopyCancelled();
      const check = await ctx.vfs.readBytes(destPath);
      if (check.byteLength !== bytes.byteLength || bytesToB64(check) !== bytesToB64(bytes)) {
        return 'mv: write verification failed for ' + destPath
          + '; source preserved (partial destination may exist)';
      }
      copiedFiles.push(f);
    }
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return 'mv: destination creation/copy failed (' + (e && e.message ? e.message : String(e))
      + '); source preserved, partial destination may exist';
  }

  // ---- delete phase — deepest first so directories are empty when removed.
  // Only starts after the entire destination tree exists and every copied
  // file verified. A cancel here is a partial commit: reported, not rolled
  // back. ----
  const deleted = [];
  const all = files.concat(dirs.slice().reverse());
  try {
    for (const p of all) {
      throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
      await ctx.vfs.remove(p);
      deleted.push(p);
    }
    throwMutationCancelled(signal, 'mv', deleted.map((d) => 'delete ' + d));
    await ctx.vfs.remove(srcAbs);
    deleted.push(srcAbs);
  } catch (e) {
    if (isCancelledError(e)) throw e;
    return 'mv: delete failed at ' + (deleted.length ? 'entry after ' + deleted[deleted.length - 1] : srcAbs)
      + ' (' + (e && e.message ? e.message : String(e)) + '); destination is complete, source may be partially removed';
  }
  return null;
}

async function shRm(ctx, args) {
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
    let abs;
    try {
      abs = resolveShellPath(ctx, op);
    } catch (e) {
      errors.push('rm: ' + op + ': ' + e.message);
      continue;
    }
    // Hard stop: nothing may recursively remove a protected structural or
    // mount root, however spelled (/, /., /mnt/workspace, /x/.., ...).
    // This is disaster prevention, not a permission system.
    if (ctx.vfs.isProtectedRoot(abs)) {
      errors.push(recursive
        ? 'rm: refusing to recursively remove protected path: ' + abs
        : 'rm: ' + op + ': is a directory');
      continue;
    }
    let st;
    try {
      st = await ctx.vfs.stat(abs);
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        if (!force) errors.push('rm: ' + op + ': no such file or directory');
        continue;
      }
      errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      continue;
    }
    if (st.kind === 'directory') {
      if (!recursive) {
        errors.push('rm: ' + op + ': is a directory');
        continue;
      }
      try {
        await rmRecursive(ctx, abs, signal, deleted);
      } catch (e) {
        if (isCancelledError(e)) throw e;
        // A mid-recursion failure (e.g. a read-only mount) is reported
        // per operand; already-committed deletions stay in `deleted`.
        errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      }
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      try {
        await ctx.vfs.remove(abs);
        deleted.push(abs);
      } catch (e) {
        errors.push('rm: ' + op + ': ' + writableErrMsg(e));
      }
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
async function rmRecursive(ctx, abs, signal, deleted) {
  throwMutationCancelled(signal, 'rm', deleted);
  const entries = await ctx.vfs.list(abs);
  for (const e of entries) {
    const child = joinAbs(abs, e.name);
    if (e.kind === 'directory') {
      await rmRecursive(ctx, child, signal, deleted);
    } else {
      throwMutationCancelled(signal, 'rm', deleted);
      await ctx.vfs.remove(child);
      deleted.push(child);
    }
  }
  throwMutationCancelled(signal, 'rm', deleted);
  await ctx.vfs.remove(abs);
  deleted.push(abs);
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
// The cwd starts at the VFS default on EVERY invocation and never persists
// across tool calls.
async function runShellCommand(input, workspace, opts) {
  const line = String(input || '').trim();
  const ioOf = (output) => ({ in: utf8ByteLength(line), out: utf8ByteLength(output) });
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

  // The shell always has a filesystem: real VFS as-is, legacy adapter
  // mounted at /mnt/workspace, missing argument → fresh internal machine.
  const vfs = asVfs(workspace);
  // The cwd is VFS-ABSOLUTE and starts at the VFS default on EVERY
  // invocation: /mnt/workspace when mounted, otherwise /home/locus.
  // `cd` never leaks across bash calls.
  const ctx = { vfs: vfs, opts: opts, cwd: vfs.defaultCwd() };

  // Heredoc python is recognized before generic tokenizing.
  const heredoc = extractPythonHeredoc(line);
  if (heredoc) {
    const r = await runPythonCode(heredoc.code, ctx.vfs, pythonOpts(ctx));
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
    let abs;
    try {
      abs = resolveShellPath(ctx, target.text);
    } catch (e) {
      return shErr('bash: ' + e.message);
    }
    if (abs === '/') return shErr('bash: redirect target must be a file path, not the filesystem root');
    // Unwritable targets (read-only mounts, structural paths, unmounted
    // folders) are rejected BEFORE the command runs — before ANY side
    // effect, not just before the write itself.
    try {
      ctx.vfs.assertWritable(abs);
    } catch (e) {
      return shErr('bash: ' + name + ': cannot write ' + abs + ': ' + writableErrMsg(e));
    }
    const dest = { kind: 'file', path: abs, append: t.text === '>>' || t.text === '2>>' };
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
      if (append) {
        // `>>`/`2>>` are byte-preserving: the old content is read as raw
        // bytes and concatenated with the UTF-8 payload — binary targets
        // survive an append untouched.
        await appendFileBytes(ctx.vfs, w.dest.path, new TextEncoder().encode(text), signal, name);
      } else {
        // `>`/`2>` truncate + write (text payload, UTF-8).
        throwIfCancelled(signal, name);
        await ctx.vfs.write(w.dest.path, text);
      }
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
    let abs;
    try {
      abs = resolveShellPath(ctx, script);
    } catch (e) {
      return shErr('python: ' + e.message);
    }
    try {
      code = await ctx.vfs.read(abs);
    } catch (e) {
      return shErr('python: can\'t open file \'' + script + '\': ' + writableErrMsg(e));
    }
  }

  return await runPythonCode(code, ctx.vfs, pythonOpts(ctx));
}

// Options handed to PythonRuntime: the caller's opts plus the ABSOLUTE VFS
// cwd of this invocation (Python's os.chdir target).
function pythonOpts(ctx) {
  return Object.assign({}, ctx.opts, { cwd: ctx.cwd });
}

async function runPythonCode(code, vfs, opts) {
  if (!code || !code.trim()) {
    return { success: false, stdout: '', stderr: 'python: empty code', io: { in: 0, out: 0 } };
  }

  let res;
  try {
    res = await PythonRuntime.run(code, vfs, opts);
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
    outParts.push('[written: ' + res.written.join(', ') + ']');
  }
  if (res.mkdirs && res.mkdirs.length) {
    outParts.push('[mkdir: ' + res.mkdirs.join(', ') + ']');
  }
  if (res.deleted && res.deleted.length) {
    outParts.push('[deleted: ' + res.deleted.join(', ') + ']');
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
  const vfs = ctx.vfs;
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

  // A download with an unwritable target must fail BEFORE any network
  // request: resolve the absolute path, enforce mount authority, check the
  // parent directory and reject an existing DIRECTORY target — nothing here
  // may hit the network first.
  if (outFile) {
    const display = outFile;
    try {
      outFile = resolveShellPath(ctx, outFile);
    } catch (e) {
      return netResult('curl: ' + e.message, false);
    }
    try {
      vfs.assertWritable(outFile);
    } catch (e) {
      return netResult('curl: cannot write ' + display + ': ' + writableErrMsg(e), false);
    }
    const parentErr = await checkParentDir(vfs, outFile);
    if (parentErr) return netResult('curl: cannot write ' + display + ': ' + parentErr, false);
    let targetStat = null;
    try {
      targetStat = await vfs.stat(outFile);
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') {
        return netResult('curl: cannot write ' + display + ': ' + writableErrMsg(e), false);
      }
    }
    if (targetStat && targetStat.kind === 'directory') {
      return netResult('curl: cannot write ' + display + ': is a directory', false);
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
    // Binary-safe: raw bytes go straight into the VFS, no decoding.
    await vfs.write(outFile, res.bytes);
    // Telemetry stays `network`: the download IS the network operation.
    return netResult('[written to ' + outFile + ', ' + res.bytes.byteLength + ' bytes]', true, res);
  }

  if (isTextLikeMime(res.headers['content-type'])) {
    return netResult(new TextDecoder('utf-8').decode(res.bytes).replace(/\n$/, ''), true, res);
  }

  const mime = String(res.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return netResult(
    'curl: binary response (' + mime + ', ' + res.bytes.byteLength + ' bytes); use curl -o <file> <url>',
    true, res);
}
