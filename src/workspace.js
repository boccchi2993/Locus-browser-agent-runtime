// ============================================================
//  WORKSPACE
//  WorkspaceAdapter abstraction + LocalDirectoryWorkspace backed by
//  the browser File System Access API. The agent and the model never
//  touch FileSystemDirectoryHandle directly.
//
//  Future adapters (not implemented in V0): OPFSWorkspace,
//  MemoryWorkspace, CloudWorkspace.
// ============================================================

// Normalize a user/agent-supplied path to a safe relative path and
// reject anything that would escape the workspace root.
function normalizeWorkspacePath(path) {
  let p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (/^[A-Za-z]:/.test(p) || /[\x00-\x1F]/.test(p)) {
    throw new Error('invalid path: ' + path);
  }
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error('path escapes workspace: ' + path);
      parts.pop();
      continue;
    }
    if (seg.includes(':')) throw new Error('invalid path segment: ' + seg);
    parts.push(seg);
  }
  return parts.join('/');
}

class WorkspaceAdapter {
  async list(path) { throw new Error('not implemented'); }
  async read(path) { throw new Error('not implemented'); }        // → string (utf-8)
  async readBytes(path) { throw new Error('not implemented'); }   // → Uint8Array
  async write(path, data) { throw new Error('not implemented'); } // string | Uint8Array
  async remove(path) { throw new Error('not implemented'); }      // delete a file
  async exists(path) { throw new Error('not implemented'); }
  async stat(path) { throw new Error('not implemented'); }        // → {kind, size, modified}
}

class LocalDirectoryWorkspace extends WorkspaceAdapter {
  constructor(dirHandle) {
    super();
    this.root = dirHandle;
    this.name = dirHandle.name || 'workspace';
  }

  async _dir(parts, create) {
    let dir = this.root;
    for (const name of parts) {
      dir = await dir.getDirectoryHandle(name, { create: !!create });
    }
    return dir;
  }

  _split(path) {
    const rel = normalizeWorkspacePath(path);
    const parts = rel ? rel.split('/') : [];
    return { rel, dirParts: parts.slice(0, -1), base: parts[parts.length - 1] || '' };
  }

  async list(path) {
    const rel = normalizeWorkspacePath(path);
    const dir = rel ? await this._dir(rel.split('/'), false) : this.root;
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      entries.push({ name, kind: handle.kind });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return entries;
  }

  async _fileHandle(path, create) {
    const { dirParts, base } = this._split(path);
    if (!base) throw new Error('not a file path: ' + path);
    const dir = await this._dir(dirParts, create);
    return dir.getFileHandle(base, { create: !!create });
  }

  async read(path) {
    const bytes = await this.readBytes(path);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async readBytes(path) {
    const fh = await this._fileHandle(path, false);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path, data) {
    const fh = await this._fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    await w.close();
  }

  async remove(path) {
    const { dirParts, base } = this._split(path);
    if (!base) throw new Error('cannot remove workspace root');
    const dir = await this._dir(dirParts, false);
    await dir.removeEntry(base);
  }

  async exists(path) {
    try {
      await this.stat(path);
      return true;
    } catch (e) {
      return false;
    }
  }

  async stat(path) {
    const { dirParts, base } = this._split(path);
    const dir = await this._dir(dirParts, false);
    if (!base) return { kind: 'directory', size: 0, modified: null };
    // Try file first, then directory.
    try {
      const fh = await dir.getFileHandle(base, false);
      const f = await fh.getFile();
      return { kind: 'file', size: f.size, modified: f.lastModified };
    } catch (e) {
      const dh = await dir.getDirectoryHandle(base, false);
      return { kind: 'directory', size: 0, modified: null };
    }
  }
}

// Request readwrite permission for a picked directory.
async function ensureWorkspacePermission(handle) {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
