// ============================================================
//  EXTENSION PRODUCT ADAPTERS (extension layer — Product side, M2b split)
//
//  The composition CORE (validators, SkillSourceStore, CapabilityManager,
//  production catalogs) lives in src/extension-composition.js (Harness
//  side; loads BEFORE this file). This file keeps the PRODUCT adapter
//  half of the old extensions.js:
//    - StaticFileWorkspace   — read-only Runtime VFS provider class
//    - SkillInstanceStorage  — durable capability-private instance storage
//    - SkillInstanceWorkspace— the task-bound approval-guarded VFS view
//    - productTaskVfsMounts  — maps the manager's mount SPECS onto
//                              StaticFileWorkspace providers
//  It runs only inside the Locus product page: it extends WorkspaceAdapter
//  (workspace.js, loaded earlier) and reads the composition constants
//  through the classic lexical chain. It is NOT part of the Harness
//  public entry (see tests/harness-boundary.test.cjs).
// ============================================================

// ---------- StaticFileWorkspace ----------
// Read-only VFS provider over a fixed in-memory file tree (rel path ->
// UTF-8 text or Uint8Array). The mount authority stays system-read-only
// at the VirtualWorkspace layer AND the provider itself refuses every
// mutation — two independent layers for the same invariant. This backs
// /mnt/plugins/<id>/plugin.json and the capability introspection mounts;
// it is never agent-writable. (Skill guides used to be served here too —
// they now live as mutable, capability-private instances under
// /home/locus/.skills and there is deliberately NO second "skills" view.)
class StaticFileWorkspace extends WorkspaceAdapter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.name = opts.name || 'static-system';
    this.files = new Map(); // rel -> Uint8Array
    this.dirs = new Set();  // rel of explicit dirs; '' root implicit
    const tree = opts.files || {};
    for (const relRaw of Object.keys(tree)) {
      const rel = normalizeWorkspacePath(relRaw);
      if (!rel) throw new Error('StaticFileWorkspace: empty file path');
      const value = tree[relRaw];
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      this.files.set(rel, bytes);
      let cur = '';
      for (const part of rel.split('/').slice(0, -1)) {
        cur = cur ? cur + '/' + part : part;
        this.dirs.add(cur);
      }
    }
  }

  _rel(path) { return normalizeWorkspacePath(path); }

  _children(rel) {
    const prefix = rel ? rel + '/' : '';
    const names = new Map();
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest && !rest.includes('/')) names.set(rest, { name: rest, kind: 'directory' });
    }
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest && !rest.includes('/')) names.set(rest, { name: rest, kind: 'file' });
    }
    return [...names.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async list(path) {
    const rel = this._rel(path);
    if (this.files.has(rel)) throw vfsError('TypeMismatchError', 'not a directory: ' + rel);
    if (rel !== '' && !this.dirs.has(rel)) throw vfsNotFound(rel);
    return this._children(rel);
  }

  async read(path) {
    return new TextDecoder('utf-8').decode(await this.readBytes(path));
  }

  async readBytes(path) {
    const rel = this._rel(path);
    const data = this.files.get(rel);
    if (data) return data.slice(); // copy — byte-exact, no aliasing
    if (rel === '' || this.dirs.has(rel)) throw vfsError('TypeMismatchError', 'is a directory: ' + rel);
    throw vfsNotFound(rel);
  }

  // Mutations are refused BEFORE anything else (system-read-only).
  async write(path) { throw vfsReadOnly(this._rel(path)); }
  async remove(path) { throw vfsReadOnly(this._rel(path)); }
  async mkdir(path) { throw vfsReadOnly(this._rel(path)); }

  async exists(path) {
    const rel = this._rel(path);
    return rel === '' || this.dirs.has(rel) || this.files.has(rel);
  }

  async stat(path) {
    const rel = this._rel(path);
    const data = this.files.get(rel);
    if (data) return { kind: 'file', size: data.byteLength, modified: null };
    if (rel === '' || this.dirs.has(rel)) return { kind: 'directory', size: 0, modified: null };
    throw vfsNotFound(rel);
  }
}

// ---------- SkillInstanceStorage ----------
// Durable primitives for the capability-private skill instance tree,
// addressed RELATIVE to /home/locus/.skills. Wraps whatever provider is
// CURRENTLY mounted at /home/locus (memory before boot, OPFS after) via
// the injected resolveHome() callback, so it never captures a stale home
// provider. This is the Harness side of the lifecycle (materialize /
// marker / cleanup); agent-facing mutations go through the guarded
// SkillInstanceWorkspace below, never through this class directly.
class SkillInstanceStorage {
  constructor(opts) {
    this._resolveHome = typeof (opts && opts.resolveHome) === 'function' ? opts.resolveHome : null;
  }

  _home() {
    const provider = this._resolveHome ? this._resolveHome() : null;
    if (!provider) {
      throw vfsError('NotMountedError', '/home/locus is not mounted; skill instance storage is unavailable');
    }
    return provider;
  }

  _abs(rel) {
    // normalizeWorkspacePath rejects traversal, control chars and ':' —
    // the rel path can never escape the .skills root.
    return '.skills/' + normalizeWorkspacePath('/' + rel);
  }

  async readBytes(rel) { return this._home().readBytes(this._abs(rel)); }
  async read(rel) { return this._home().read(this._abs(rel)); }
  async writeBytes(rel, bytes) { return this._home().write(this._abs(rel), bytes); }
  async exists(rel) { return this._home().exists(this._abs(rel)); }
  async stat(rel) { return this._home().stat(this._abs(rel)); }

  async removeFile(rel) { return this._home().remove(this._abs(rel)); }

  // Recursive directory removal that works over every provider: walk
  // depth-first, remove files, then try the directory itself. A missing
  // directory is a successful no-op (cleanup idempotence).
  async removeDir(rel) {
    const clean = rel ? normalizeWorkspacePath('/' + rel) : '';
    let entries = [];
    try {
      entries = await this._home().list(clean ? this._abs(clean) : '.skills');
    } catch (e) {
      if (e && e.name === 'NotFoundError') return;
      throw e;
    }
    for (const entry of entries) {
      const child = clean ? clean + '/' + entry.name : entry.name;
      if (entry.kind === 'directory') await this.removeDir(child);
      else await this.removeFile(child);
    }
    if (!clean) return; // never remove the .skills root itself
    try {
      await this._home().remove(this._abs(clean));
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || /not empty/i.test(String(e.message)))) {
        // Already gone, or the provider refused a non-empty removal
        // (rollback best-effort): report via a loud failure ONLY if the
        // directory is still there.
        if (await this._home().exists(this._abs(clean))) {
          throw vfsError('ResourceBusyError', 'could not remove skill directory: ' + clean);
        }
        return;
      }
      throw e;
    }
  }

  // list() relative to the .skills root ('' = the root itself).
  async list(rel) {
    return this._home().list(rel ? this._abs(rel) : '.skills');
  }
}

// ---------- SkillInstanceWorkspace ----------
// The TASK-BOUND, approval-guarded view of /home/locus/.skills. Mounted
// read-write on every task fork whose TaskEnvironment carries skills, so
// EVERY mutation route (echo redirects, >>, curl -o, rm, python write-back
// commits) funnels through the SAME guard — never through per-command
// checks. Reads are free. Marker files are Harness metadata: hidden from
// list() and refused for every mutation.
//
// Mutation contract (docs/APPROVALS.md consumer contract + TOCTOU):
//   1. fail closed without a live task signal,
//   2. validate the path is a DECLARED skill of a capability in THIS
//      task's TaskEnvironment (exact path match; old tasks cannot touch
//      capabilities enabled later, nobody touches undeclared ids),
//   3. validate UTF-8 + size bound,
//   4. hash the before-state, no-op when bytes are identical,
//   5. build a bounded human-readable diff and ask via the Approval
//      Framework kind 'confirmation' (confirm | cancel, NO session grant),
//   6. re-check the AbortSignal, re-read the current bytes and verify the
//      before-hash still matches — a changed file is a conflict, never a
//      silently applied stale diff,
//   7. only then perform the write/remove through SkillInstanceStorage.
class SkillInstanceWorkspace extends WorkspaceAdapter {
  constructor(opts) {
    super();
    this.name = (opts && opts.name) || 'skill-instances';
    this._storage = opts && opts.storage;
    this._context = (opts && opts.context) || null;
    if (!this._storage) throw new Error('SkillInstanceWorkspace requires a SkillInstanceStorage');
  }

  // Parse a mount-relative path. Returns { capabilityId, skillId } for a
  // declared-shaped `<capabilityId>/<skillId>.skill`, or null for
  // everything else (marker files, wrong depth, foreign names, dirs).
  _parseSkillRel(rel) {
    const clean = normalizeWorkspacePath('/' + rel);
    const parts = clean.split('/');
    if (parts.length !== 2 || !parts[1].endsWith('.skill')) return null;
    if (parts[1] === SKILL_INSTANCE_MARKER) return null;
    const capabilityId = parts[0];
    const skillId = parts[1].slice(0, -'.skill'.length);
    if (!EXTENSION_ID_PATTERN.test(capabilityId) || !EXTENSION_ID_PATTERN.test(skillId)) return null;
    if (skillInstancePath(capabilityId, skillId) !== SKILL_INSTANCE_ROOT + '/' + clean) return null;
    return { capabilityId: capabilityId, skillId: skillId, rel: clean, abs: SKILL_INSTANCE_ROOT + '/' + clean };
  }

  _boundaryError(message) {
    const e = vfsError('ReadOnlyError', message);
    e.code = 'skill_mutation_boundary';
    return e;
  }

  _mutationError(message, code) {
    const e = new Error(message);
    e.name = 'SkillMutationError';
    e.code = code;
    return e;
  }

  // The identity check against THIS task's frozen TaskEnvironment (spec:
  // a task may only touch skills its own environment declares).
  _declaredSkill(capabilityId, skillId, abs) {
    const env = this._context && this._context.taskEnvironment;
    if (!env || !Array.isArray(env.capabilities)) return null;
    const cap = env.capabilities.find((c) => c && c.id === capabilityId);
    if (!cap || cap.state === 'error') return null;
    if (!Array.isArray(cap.skillIds) || cap.skillIds.indexOf(skillId) === -1) return null;
    if (skillInstancePath(capabilityId, skillId) !== abs) return null;
    return cap;
  }

  _skillLabel(skill, ref) {
    return 'Capability: ' + (skill.capabilityDisplayName || ref.capabilityId) + '\n'
      + 'Skill: ' + (skill.displayName || ref.skillId) + '\n'
      + 'Path: ' + ref.abs;
  }

  _liveSignal() {
    const getSignal = this._context && this._context.getSignal;
    const signal = typeof getSignal === 'function' ? getSignal() : null;
    if (!signal) {
      throw this._mutationError(
        'skill changes require the live task that proposed them; no task signal is bound',
        'skill_mutation_no_task');
    }
    return signal;
  }

  // Bounded line diff (common prefix/suffix trim) for the approval card.
  _diffText(beforeText, afterText) {
    const a = beforeText.length ? beforeText.split('\n') : [];
    const b = afterText.length ? afterText.split('\n') : [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const ctx = 2;
    const lines = [];
    for (let i = Math.max(0, start - ctx); i < start; i++) lines.push('  ' + a[i]);
    for (let i = start; i < endA; i++) lines.push('- ' + a[i]);
    for (let i = start; i < endB; i++) lines.push('+ ' + b[i]);
    for (let i = endA; i < Math.min(a.length, endA + ctx); i++) lines.push('  ' + a[i]);
    const text = lines.join('\n');
    if (text.length > SKILL_DIFF_MAX_CHARS) {
      throw this._mutationError(
        'Skill change is too large to review safely in one approval. Make a smaller edit.',
        'skill_mutation_too_large');
    }
    return text;
  }

  async _decodeBytes(data, abs) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (bytes.byteLength > SKILL_INSTANCE_MAX_BYTES) {
      throw this._mutationError('skill file size ' + bytes.byteLength + ' bytes exceeds the '
        + SKILL_INSTANCE_MAX_BYTES + '-byte skill limit: ' + abs, 'skill_mutation_too_large');
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes); // binary skills are never accepted
    } catch (e) {
      throw this._mutationError('skill files must be UTF-8 text: ' + abs, 'skill_mutation_boundary');
    }
    return bytes;
  }

  async _requestConfirmation(type, cap, skillRef, summary, detail) {
    const approvals = this._context && this._context.approvals;
    if (!approvals || typeof approvals.request !== 'function') {
      throw this._mutationError('approval framework unavailable; skill change refused',
        'skill_mutation_no_task');
    }
    return approvals.request({
      kind: 'confirmation',
      action: { type: type, summary: summary, detail: detail },
      resource: {
        type: 'skill',
        key: cap.id + ':' + skillRef.skillId,
        label: skillInstancePath(cap.id, skillRef.skillId),
      },
      conversationId: this._context.conversationId || null,
      taskGeneration: Number.isFinite(this._context.taskGeneration) ? this._context.taskGeneration : null,
    }, { signal: this._liveSignal() });
  }

  // ---- reads: free, marker hidden ----
  async list(path) {
    const entries = await this._storage.list(path);
    return entries.filter((e) => e.name !== SKILL_INSTANCE_MARKER);
  }

  async read(path) { return this._storage.read(path); }
  async readBytes(path) { return this._storage.readBytes(path); }
  async exists(path) { return this._storage.exists(path); }
  async stat(path) { return this._storage.stat(path); }

  // ---- guarded mutations ----
  async mkdir(path) {
    throw this._boundaryError('skill instance directories are harness-owned; capabilities are added in Settings, not created from the shell');
  }

  async remove(path) {
    const ref = this._parseSkillRel(path);
    if (!ref) {
      throw this._boundaryError(
        'only a declared <capability>/<skill>.skill file can be deleted under ' + SKILL_INSTANCE_ROOT
        + ' (install markers and directory layout are harness-owned; remove/re-add the capability in Settings to reset its guidance)');
    }
    let stat = null;
    try { stat = await this._storage.stat(ref.rel); } catch (e) { throw e; }
    if (stat.kind !== 'file') {
      throw this._boundaryError('not a skill instance file: ' + ref.abs);
    }
    const cap = this._declaredSkill(ref.capabilityId, ref.skillId, ref.abs);
    if (!cap) {
      throw this._mutationError(ref.abs + ' is not a skill of any capability in this task',
        'skill_mutation_boundary');
    }
    const skillDef = this._skillMetadata(cap, ref.skillId);
    const before = await this._storage.readBytes(ref.rel);
    const beforeHash = await sha256Hex(before);
    const signal = this._liveSignal();
    const decision = await this._requestConfirmation('skill-delete', cap, ref,
      'Delete capability guidance: ' + (skillDef.displayName || ref.skillId),
      this._skillLabel(skillDef, ref)
        + '\n\nThis removes this guidance file from the capability.'
        + ' It will stay absent until recreated, or until the capability is removed and added again.');
    if (!decision || decision.outcome !== 'confirm') {
      throw this._mutationError('skill deletion cancelled — ' + ref.abs + ' was not changed',
        'skill_mutation_declined');
    }
    if (signal.aborted) {
      throw this._mutationError('task cancelled before the skill deletion was applied',
        'skill_mutation_cancelled');
    }
    const current = await this._storage.readBytes(ref.rel);
    if ((await sha256Hex(current)) !== beforeHash) {
      throw this._mutationError('skill changed while the deletion was awaiting approval; nothing was deleted',
        'skill_mutation_conflict');
    }
    if (signal.aborted) {
      throw this._mutationError('task cancelled before the skill deletion was applied',
        'skill_mutation_cancelled');
    }
    await this._storage.removeFile(ref.rel);
  }

  async write(path, data) {
    const ref = this._parseSkillRel(path);
    if (!ref) {
      throw this._boundaryError(
        'only a declared <capability>/<skill>.skill file can be written under ' + SKILL_INSTANCE_ROOT
        + ' (install markers and directory layout are harness-owned)');
    }
    const cap = this._declaredSkill(ref.capabilityId, ref.skillId, ref.abs);
    if (!cap) {
      throw this._mutationError(ref.abs + ' is not a skill of any capability in this task',
        'skill_mutation_boundary');
    }
    const skillDef = this._skillMetadata(cap, ref.skillId);
    const bytes = await this._decodeBytes(data, ref.abs);
    const afterText = new TextDecoder('utf-8').decode(bytes);

    // Before-state: present bytes or null (create).
    let before = null;
    try { before = await this._storage.readBytes(ref.rel); } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
    }
    const beforeHash = before ? await sha256Hex(before) : null;
    if (before && (await sha256Hex(bytes)) === beforeHash) return; // no-op write: no mutation, no approval

    const creating = !before;
    const beforeText = before ? new TextDecoder('utf-8').decode(before) : '';
    const diff = creating
      ? '(new file)\n' + this._diffText('', afterText)
      : this._diffText(beforeText, afterText);
    const header = this._skillLabel(skillDef, ref) + '\n\nChanges:\n';
    const detail = header + diff;
    if (detail.length > SKILL_DIFF_MAX_CHARS) {
      throw this._mutationError(
        'Skill change is too large to review safely in one approval. Make a smaller edit.',
        'skill_mutation_too_large');
    }

    const signal = this._liveSignal();
    const verb = creating ? 'Recreate capability guidance: ' : 'Modify capability guidance: ';
    const decision = await this._requestConfirmation(creating ? 'skill-create' : 'skill-write', cap, ref,
      verb + (skillDef.displayName || ref.skillId), detail);
    if (!decision || decision.outcome !== 'confirm') {
      throw this._mutationError('skill change cancelled — ' + ref.abs + ' was not modified',
        'skill_mutation_declined');
    }
    if (signal.aborted) {
      throw this._mutationError('task cancelled before the skill change was applied',
        'skill_mutation_cancelled');
    }

    // TOCTOU: the approved diff may only land on the exact approved
    // before-state. (For a create, the file must still be absent.)
    let current = null;
    try { current = await this._storage.readBytes(ref.rel); } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
    }
    const currentHash = current ? await sha256Hex(current) : null;
    if (currentHash !== beforeHash) {
      throw this._mutationError('skill changed while the change was awaiting approval; the edit was not applied',
        'skill_mutation_conflict');
    }
    if (signal.aborted) {
      throw this._mutationError('task cancelled before the skill change was applied',
        'skill_mutation_cancelled');
    }
    await this._storage.writeBytes(ref.rel, bytes);
  }

  // Skill metadata for the card, resolved from THIS task's frozen
  // environment (TaskEnvironment.skills entries carry displayName etc.).
  _skillMetadata(cap, skillId) {
    const env = this._context && this._context.taskEnvironment;
    const list = env && Array.isArray(env.skills) ? env.skills : [];
    const found = list.find((s) => s && s.capabilityId === cap.id && s.skillId === skillId);
    const base = found || { displayName: skillId, skillId: skillId };
    return Object.assign({}, base, { capabilityDisplayName: cap.displayName || cap.id });
  }
}

// ---------- product task mounts (M2b) ----------
// The Product side of the split: the CapabilityManager returns pure mount
// SPECS (no VFS class); this adapter constructs the read-only
// StaticFileWorkspace providers the Runtime mounts. Mount paths,
// authorities and file contents are exactly what taskVfsMounts used to
// produce — only the construction site moved (composition core stays
// VFS-class-free).
function productTaskVfsMounts(manager, env) {
  return manager.taskVfsMountSpecs(env).map((spec) => ({
    path: spec.path,
    provider: new StaticFileWorkspace({ name: spec.name, files: spec.files }),
    authority: spec.authority,
  }));
}
