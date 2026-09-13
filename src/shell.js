// ============================================================
//  BROWSER SHELL COMPATIBILITY LAYER
//  Implements the local `bash` tool: pwd / ls / cat / echo / python.
//  Everything runs against the WorkspaceAdapter and the Pyodide
//  worker — no native shell, no server, no cloud execution.
// ============================================================

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
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const pending = this._pending.get(msg.id);
      if (msg.type === 'status') {
        this._setStatus(msg.status);
        return;
      }
      if (msg.type === 'result' && pending) {
        this._pending.delete(msg.id);
        pending.resolve(msg);
      }
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this._pending) p.resolve({ stdout: '', stderr: '', error: 'worker error: ' + (e.message || 'unknown'), files: [] });
      this._pending.clear();
    };
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
  // {stdout, stderr, error, written: [paths]}.
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
      this._pending.set(id, { resolve });
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

    return {
      stdout: result.stdout || '',
      stderr: syncNote + (result.stderr || ''),
      error: result.error || null,
      written,
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

function shellError(cmd) {
  return 'bash: ' + cmd + ': command not available in local browser runtime';
}

// Execute one shell command line against the workspace.
// Returns { output: string, isError: boolean, io: {in, out} }.
async function runShellCommand(input, workspace) {
  const line = String(input || '').trim();
  if (!line) return { output: '', isError: false, io: { in: 0, out: 0 } };

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

      default:
        return err(shellError(cmd));
    }
  } catch (e) {
    return err('bash: ' + (e && e.message ? e.message : String(e)));
  }

  function ok(output) {
    return { output, isError: false, io: { in: line.length, out: output.length } };
  }
  function err(output) {
    return { output, isError: true, io: { in: line.length, out: output.length } };
  }
}

async function runPython(args, workspace) {
  let code = null;

  if (!args.length) {
    return { output: 'usage: python -c "<code>" | python <script.py>', isError: true, io: { in: 6, out: 0 } };
  }
  if (args[0] === '--version' || args[0] === '-V') {
    return { output: 'Python (browser runtime)', isError: false, io: { in: 6, out: 0 } };
  }
  if (args[0] === '-c') {
    code = args.slice(1).join(' ');
  } else {
    const script = args[0];
    if (!workspace) return { output: 'python: no workspace selected (cannot read ' + script + ')', isError: true, io: { in: 6, out: 0 } };
    try {
      code = await workspace.read(script);
    } catch (e) {
      return { output: 'python: can\'t open file \'' + script + '\': ' + e.message, isError: true, io: { in: 6, out: 0 } };
    }
  }
  if (!code || !code.trim()) {
    return { output: 'python: empty code', isError: true, io: { in: 6, out: 0 } };
  }

  const res = await PythonRuntime.run(code, workspace);

  let output = '';
  if (res.stdout) output += res.stdout.replace(/\n$/, '');
  if (res.stderr) output += (output ? '\n' : '') + res.stderr.replace(/\n$/, '');
  if (res.error) output += (output ? '\n' : '') + res.error;
  if (res.written && res.written.length) {
    output += (output ? '\n' : '') + '[written to workspace: ' + res.written.join(', ') + ']';
  }

  return {
    output,
    isError: !!res.error,
    io: { in: code.length + res.inputBytes, out: output.length + res.outputBytes },
  };
}
