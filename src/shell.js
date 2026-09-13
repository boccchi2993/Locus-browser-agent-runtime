// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local `bash` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
// ============================================================

const PYTHON_TIMEOUT_MS = 30000;

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
      this._failAllPending('worker error: ' + (e.message || 'unknown'));
    };
  },

  // Terminate the worker (e.g. after a timeout), fail every pending
  // request, and reset so the next call boots a fresh worker.
  _killWorker() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }
    this._failAllPending('python execution timed out after ' + PYTHON_TIMEOUT_MS + 'ms');
    this._setStatus('cold');
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

  // Run Python code with the workspace mirrored in. Returns
  // {stdout, stderr, error, written: [paths], deleted: [paths]}.
  async run(code, workspace) {
    this._ensureWorker();
    this._setStatus('loading');

    let files = [];
    let syncNote = '';
    if (workspace) {
      const collected = await collectWorkspaceFiles(workspace);
      files = collected.files;
      if (collected.skipped) syncNote = '[workspace sync: skipped ' + collected.skipped + ' file(s) over size limit]\n';
    }

    const id = ++this._reqId;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => this._killWorker(), PYTHON_TIMEOUT_MS);
      this._pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, cmd: 'run', code, files });
    });

    const written = [];
    if (workspace && result.files && result.files.length) {
      for (const f of result.files) {
        try {
          await workspace.write(f.path, b64ToBytes(f.b64));
          written.push(f.path);
        } catch (e) {
          result.stderr = (result.stderr || '') + '\n[write-back failed: ' + f.path + ': ' + e.message + ']';
        }
      }
    } else if (!workspace && result.files && result.files.length) {
      result.stderr = (result.stderr || '') + '\n[no workspace selected — generated files were not persisted]';
    }

    // Propagate deletions (and renames = delete + create) to the real workspace.
    const deleted = [];
    if (workspace && result.deleted && result.deleted.length) {
      for (const p of result.deleted) {
        try {
          await workspace.remove(p);
          deleted.push(p);
        } catch (e) {
          result.stderr = (result.stderr || '') + '\n[delete failed: ' + p + ': ' + e.message + ']';
        }
      }
    }

    return {
      stdout: result.stdout || '',
      stderr: syncNote + (result.stderr || ''),
      error: result.error || null,
      written,
      deleted,
      inputBytes: files.reduce((n, f) => n + Math.floor(f.b64.length * 0.75), 0),
      outputBytes: (result.files || []).reduce((n, f) => n + Math.floor(f.b64.length * 0.75), 0),
    };
  },
};

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

// Snapshot workspace files for the Python mirror. Caps keep V0 sane.
const SYNC_MAX_FILES = 200;
const SYNC_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SYNC_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

async function collectWorkspaceFiles(workspace) {
  const files = [];
  let skipped = 0;
  let total = 0;

  async function walk(rel) {
    if (files.length >= SYNC_MAX_FILES) return;
    const entries = await workspace.list(rel);
    for (const e of entries) {
      if (files.length >= SYNC_MAX_FILES) { skipped++; continue; }
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.kind === 'directory') {
        await walk(childRel);
      } else {
        const st = await workspace.stat(childRel);
        if (st.size > SYNC_MAX_FILE_BYTES || total + st.size > SYNC_MAX_TOTAL_BYTES) { skipped++; continue; }
        const bytes = await workspace.readBytes(childRel);
        total += bytes.byteLength;
        files.push({ path: childRel, b64: bytesToB64(bytes) });
      }
    }
  }

  await walk('');
  return { files, skipped };
}

// ---------- shell ----------
function shellTokenize(s) {
  const m = String(s || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return m.map((t) => {
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1);
    }
    return t;
  });
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
async function runShellCommand(input, workspace) {
  const line = String(input || '').trim();
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

  // Heredoc python is recognized before generic tokenizing.
  const heredoc = extractPythonHeredoc(line);
  if (heredoc) {
    return await runPythonCode(heredoc.code, workspace);
  }

  const tokens = shellTokenize(line);
  const cmd = tokens[0];
  const args = tokens.slice(1);

  try {
    switch (cmd) {
      case 'pwd':
        return ok(workspace ? '/' : '/ (no workspace selected)');

      case 'ls': {
        if (!workspace) return err('ls: no workspace selected');
        const path = args[0] || '';
        const entries = await workspace.list(path);
        if (!entries.length) return ok('');
        return ok(entries.map((e) => (e.kind === 'directory' ? e.name + '/' : e.name)).join('\n'));
      }

      case 'cat': {
        if (!workspace) return err('cat: no workspace selected');
        if (!args.length) return err('cat: missing file operand');
        const chunks = [];
        for (const p of args) {
          const st = await workspace.stat(p);
          if (st.kind !== 'file') return err('cat: ' + p + ': is a directory');
          if (st.size > 512 * 1024) return err('cat: ' + p + ': file too large for terminal output (use python)');
          chunks.push(await workspace.read(p));
        }
        return ok(chunks.join('\n'));
      }

      case 'echo': {
        // Supports: echo text | echo text > file | echo text >> file
        let redirect = null, rIndex = -1;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '>' || args[i] === '>>') { redirect = args[i]; rIndex = i; break; }
        }
        if (redirect) {
          if (!workspace) return err('echo: no workspace selected');
          const target = args[rIndex + 1];
          if (!target) return err('echo: missing redirect target');
          let text = args.slice(0, rIndex).join(' ') + '\n';
          if (redirect === '>>' && (await workspace.exists(target))) {
            text = (await workspace.read(target)) + text;
          }
          await workspace.write(target, text);
          return ok('');
        }
        return ok(args.join(' '));
      }

      case 'python':
      case 'python3':
        return await runPython(args, workspace);

      case 'curl':
        return await runCurl(args, workspace, line);

      default:
        return err(shellError(cmd));
    }
  } catch (e) {
    return err('bash: ' + (e && e.message ? e.message : String(e)));
  }

  function ok(output) {
    return { output, isError: false, io: { in: utf8ByteLength(line), out: utf8ByteLength(output) } };
  }
  function err(output) {
    return { output, isError: true, io: { in: utf8ByteLength(line), out: utf8ByteLength(output) } };
  }
}

async function runPython(args, workspace) {
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

  return await runPythonCode(code, workspace);
}

async function runPythonCode(code, workspace) {
  if (!code || !code.trim()) {
    return { output: 'python: empty code', isError: true, io: { in: 0, out: 0 } };
  }

  const res = await PythonRuntime.run(code, workspace);

  let output = '';
  if (res.stdout) output += res.stdout.replace(/\n$/, '');
  if (res.stderr) output += (output ? '\n' : '') + res.stderr.replace(/\n$/, '');
  if (res.error) output += (output ? '\n' : '') + res.error;
  if (res.written && res.written.length) {
    output += (output ? '\n' : '') + '[written to workspace: ' + res.written.join(', ') + ']';
  }
  if (res.deleted && res.deleted.length) {
    output += (output ? '\n' : '') + '[deleted from workspace: ' + res.deleted.join(', ') + ']';
  }

  return {
    output,
    isError: !!res.error,
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

async function runCurl(args, workspace, line) {
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

  let res;
  try {
    res = await NetworkRuntime.fetch(url);
  } catch (e) {
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
    if (!workspace) return netResult('curl: no workspace selected', true, res);
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
