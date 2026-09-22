// ============================================================
//  CAPABILITY COMPOSITION RUNTIME v1 (extension layer)
//
//  Four-layer model (docs/CAPABILITY-BOUNDARIES.md):
//    Capability = user-facing composition
//    Plugin     = code        (runtime authority: always "none" in v1)
//    Skill      = knowledge   (trusted content, read on demand)
//    MCP        = authority   (external; a requirement, never auto-granted)
//
//  "Plugin adds code. Skill adds knowledge. MCP adds authority.
//   Capability composes them for the user."
//
//  This module owns:
//    - strict descriptor validators (an invalid trusted catalog fails
//      LOUDLY at load — never "skip the bad entry and keep running"),
//    - the production catalogs (deliberately EMPTY; tests/e2e inject
//      synthetic catalogs through the CapabilityManager constructor),
//    - StaticFileWorkspace — a read-only VFS provider (system-read-only)
//      backing the plugin / capability introspection mounts,
//    - SkillSourceStore — the immutable default Markdown source of each
//      SkillDefinition (separate from its metadata descriptor),
//    - CapabilityManager — enable/disable with shared-component
//      reference semantics, durable capability-private skill instance
//      materialization (install marker + rollback), capability state,
//      TaskEnvironment builds,
//    - SkillInstanceWorkspace — the task-bound approval-guarded VFS
//      provider mounted at /home/locus/.skills on task forks,
//    - the PluginRuntimeProvider seam — a generic per-runtime binding
//      (python / javascript / wasm) so future verified loaders plug in
//      without touching the Capability / Skill / Agent model.
//
//  HARD invariants (pinned by tests/capability-composition.test.cjs):
//    - Plugin v1 descriptor authority === "none"; any other authority
//      is rejected at validation. Plugins never gain network, browser
//      credential, DOM, API-key, parent-RPC or MCP authority.
//    - The TaskEnvironment is deeply frozen. UI enable/disable mutates
//      only the MANAGER; a running task keeps the snapshot it started
//      with; mutations affect the NEXT buildTaskEnvironment() only.
//    - Shared components dedupe by id: a component stays active while
//      ANY enabled capability references it (never naive per-capability
//      add/remove).
//    - System prompt carries the capability INDEX (display names +
//      skill guide paths), never skill bodies (agent.js renders it;
//      bodies are read on demand from the read-only skill mount).
//    - Skills are trusted harness content: a SkillDefinition is the
//      publisher's immutable metadata + default source template; an
//      ENABLED capability materializes its own private, durable
//      SkillInstance at /home/locus/.skills/<capability-id>/<skill-id>.skill.
//      Definitions may be shared; instances are NEVER shared.
//    - Skill bodies never enter persistence or the system prompt; skill
//      READS are free, every CREATE/WRITE/DELETE of an instance requires
//      an explicit user confirmation (behavior mutation) — enforced by
//      SkillInstanceWorkspace, never by shell command type.
// ============================================================
//  Loaded after vfs.js (uses WorkspaceAdapter + normalizeWorkspacePath).
//  It must stay independent of model-adapters.js / model.js / shell.js:
//  the AgentSession consumes TaskEnvironments as plain frozen data via
//  dependency injection and never reads a manager global.

// ---------- identity / path rules ----------
// Component and capability ids are path-safe: lowercase, digits, dot,
// dash, underscore — no slashes, no traversal, no unicode surprises.
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
// Python module names for `provides.pythonImports` and smoke imports.
const EXTENSION_PY_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const CAPABILITIES_VFS_ROOT = '/usr/local/share/locus/capabilities';
const PLUGINS_VFS_ROOT = '/mnt/plugins';

// ---------- durable skill instances ----------
// A SkillInstance is a capability-private working copy of a shared
// SkillDefinition. The path IS the identity (capabilityId + skillId);
// every enabled capability owns an independent file under its own
// directory. Definitions may be shared; instances are never shared.
const SKILL_INSTANCE_ROOT = '/home/locus/.skills';
const SKILL_INSTANCE_MARKER = '.locus-installed.json';
const SKILL_INSTANCE_MAX_BYTES = 256 * 1024; // skills are Markdown text, never binary
const SKILL_DIFF_MAX_CHARS = 20000; // approval diffs above this fail closed

function skillCapabilityDir(capabilityId) {
  return SKILL_INSTANCE_ROOT + '/' + capabilityId;
}

function skillInstancePath(capabilityId, skillId) {
  return skillCapabilityDir(capabilityId) + '/' + skillId + '.skill';
}

// Capability-private install marker (Harness-owned metadata). Recorded
// AFTER every default instance materialized successfully; distinguishes
// "first install incomplete" from "user deliberately deleted a skill".
function skillInstanceMarkerPayload(capability, plans) {
  return JSON.stringify({
    markerVersion: 1,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    skills: plans.map((p) => ({ id: p.skillId, sourceVersion: p.version, sourceHash: p.hash })),
    installedAt: new Date().toISOString(),
  }, null, 2) + '\n';
}

// SHA-256 hex of bytes via Web Crypto (async — materialization and the
// mutation guard are async anyway). Fails loudly when unavailable.
async function sha256Hex(bytes) {
  const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this context');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function extensionDescriptorError(message) {
  const e = new Error(message);
  e.name = 'ExtensionDescriptorError';
  e.code = 'extension_descriptor_invalid';
  return e;
}

function extensionResolutionError(message) {
  const e = new Error(message);
  e.name = 'ExtensionResolutionError';
  e.code = 'extension_resolution_failed';
  return e;
}

function extensionRequireString(value, field, descriptorId) {
  if (typeof value !== 'string' || !value.trim()) {
    throw extensionDescriptorError(descriptorId + ': "' + field + '" must be a non-empty string');
  }
  return value;
}

function extensionRequireId(value, kind) {
  if (typeof value !== 'string' || !EXTENSION_ID_PATTERN.test(value)) {
    throw extensionDescriptorError(kind + ' id must match ' + EXTENSION_ID_PATTERN + ': ' + String(value));
  }
  return value;
}

function extensionNormalizeStringList(value, field, descriptorId) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw extensionDescriptorError(descriptorId + ': "' + field + '" must be an array of ids');
  }
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !EXTENSION_ID_PATTERN.test(v)) {
      throw extensionDescriptorError(descriptorId + ': "' + field + '" entries must be valid ids, got ' + String(v));
    }
    if (!out.includes(v)) out.push(v); // duplicate refs normalize/dedupe
  }
  return out;
}

// ---------- Plugin descriptor ----------
// v1 runtime binding metadata: what the plugin provides to its runtime.
// provides values are arrays of strings; python plugins declare the
// module names their payload installs and that a smoke `import` will
// verify BEFORE the runtime reports READY (no lazy-install-on-import).
const PLUGIN_RUNTIMES = ['python', 'javascript', 'wasm'];

// Plugin v1 authority is ALWAYS "none". A plugin is local code running
// inside the existing execution substrate; network, browser credentials,
// DOM, API keys, arbitrary parent RPC and MCP authority stay outside the
// plugin model (MCP is the authority layer, and Capability enable never
// auto-authorizes anything).
const PLUGIN_V1_AUTHORITY = 'none';

function validatePluginDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionDescriptorError('plugin descriptor must be an object');
  }
  const id = extensionRequireId(raw.id, 'plugin');
  extensionRequireString(raw.version, 'version', 'plugin ' + id);
  if (!PLUGIN_RUNTIMES.includes(raw.runtime)) {
    throw extensionDescriptorError('plugin ' + id + ': unsupported runtime ' + String(raw.runtime)
      + ' (supported: ' + PLUGIN_RUNTIMES.join(', ') + ')');
  }
  // THE v1 authority constraint. Reject anything else outright.
  if (raw.authority !== PLUGIN_V1_AUTHORITY) {
    throw extensionDescriptorError('plugin ' + id + ': v1 plugin authority must be "none", got '
      + JSON.stringify(raw.authority === undefined ? null : raw.authority));
  }
  let provides = raw.provides;
  if (provides === undefined || provides === null) provides = {};
  if (typeof provides !== 'object' || Array.isArray(provides)) {
    throw extensionDescriptorError('plugin ' + id + ': "provides" must be an object of string arrays');
  }
  const providesOut = {};
  for (const key of Object.keys(provides)) {
    const list = provides[key];
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || !v)) {
      throw extensionDescriptorError('plugin ' + id + ': provides.' + key + ' must be an array of non-empty strings');
    }
    providesOut[key] = list.slice();
  }
  if (raw.runtime === 'python') {
    if (!Array.isArray(providesOut.pythonImports)) {
      throw extensionDescriptorError('plugin ' + id + ': python plugins must declare provides.pythonImports (array of module names)');
    }
    for (const name of providesOut.pythonImports) {
      if (!EXTENSION_PY_MODULE_PATTERN.test(name)) {
        throw extensionDescriptorError('plugin ' + id + ': invalid python module name in provides.pythonImports: ' + name);
      }
    }
  }
  return {
    kind: 'plugin',
    id: id,
    version: raw.version,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    runtime: raw.runtime,
    authority: PLUGIN_V1_AUTHORITY,
    provides: providesOut,
  };
}

// ---------- Skill descriptor (SkillDefinition) ----------
// A SkillDefinition is the publisher's immutable METADATA template — and
// nothing else. The default source Markdown lives in the SkillSourceStore
// (keyed by skillId + version), never inline on the descriptor, and the
// runtime instance path is DERIVED (capabilityId + skillId), never stored.
// Inline source fields are rejected LOUDLY: a definition that smuggles its
// body would blur the definition/instance boundary this module exists to
// keep exact.
const SKILL_DEFINITION_FORBIDDEN_FIELDS = ['body', 'content', 'markdown', 'inlineSource', 'path'];

function validateSkillDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionDescriptorError('skill descriptor must be an object');
  }
  const id = extensionRequireId(raw.id, 'skill');
  extensionRequireString(raw.version, 'version', 'skill ' + id);
  const description = extensionRequireString(raw.description, 'description', 'skill ' + id);
  for (const field of SKILL_DEFINITION_FORBIDDEN_FIELDS) {
    if (raw[field] !== undefined) {
      throw extensionDescriptorError('skill ' + id + ': "' + field + '" is not allowed on a SkillDefinition'
        + ' (definitions are metadata only; the default source belongs to the SkillSourceStore'
        + ' and instance paths are derived from capabilityId + skillId)');
    }
  }
  return {
    kind: 'skill',
    id: id,
    version: raw.version,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id,
    description: description,
  };
}

// ---------- SkillSourceStore ----------
// Trusted DEFAULT source of every SkillDefinition: (skillId, version) ->
// immutable UTF-8 Markdown. Deliberately separate from the descriptor
// registry (metadata) and from the durable instances (capability-private
// working copies). The production store stays EMPTY until real product
// skills exist; tests/e2e inject synthetic sources. A future production
// catalog feeds this store from build-time bundled sources — never from a
// runtime HTTP fetch.
class SkillSourceStore {
  constructor() {
    this._sources = new Map(); // skillId -> { version, bytes, text }
  }

  define(skillId, version, source) {
    extensionRequireId(skillId, 'skill');
    extensionRequireString(version, 'version', 'skill source ' + skillId);
    if (typeof source !== 'string') {
      throw extensionDescriptorError('skill source ' + skillId + ' must be UTF-8 text');
    }
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength > SKILL_INSTANCE_MAX_BYTES) {
      throw extensionDescriptorError('skill source ' + skillId + ' is ' + bytes.byteLength
        + ' bytes, over the ' + SKILL_INSTANCE_MAX_BYTES + '-byte skill source limit');
    }
    // bytes stay un-frozen (typed arrays cannot be frozen with elements);
    // sourceOf hands out a copy so callers can never alias the store.
    this._sources.set(skillId, { version: version, bytes: bytes, text: source });
  }

  has(skillId, version) {
    const s = this._sources.get(skillId);
    return !!s && s.version === version;
  }

  // Returns { version, bytes (a copy), text } or null.
  sourceOf(skillId, version) {
    const s = this._sources.get(skillId);
    if (!s || s.version !== version) return null;
    return { version: s.version, bytes: s.bytes.slice(), text: s.text };
  }
}

// ---------- MCP requirement descriptor ----------
// V1 carries the requirement REFERENCE only: id + display metadata. There
// is deliberately NO connector, no transport, no OAuth and no credential
// storage here. MCP adds authority, so an MCP requirement contributes
// "needs-connection" state until an explicit connection decision (never
// as a side effect of enabling a capability).
function validateMcpDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionDescriptorError('mcp descriptor must be an object');
  }
  const id = extensionRequireId(raw.id, 'mcp');
  return {
    kind: 'mcp',
    id: id,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

// ---------- Capability descriptor ----------
function validateCapabilityDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionDescriptorError('capability descriptor must be an object');
  }
  const id = extensionRequireId(raw.id, 'capability');
  extensionRequireString(raw.version, 'version', 'capability ' + id);
  const displayName = extensionRequireString(raw.displayName, 'displayName', 'capability ' + id);
  const description = extensionRequireString(raw.description, 'description', 'capability ' + id);
  return {
    kind: 'capability',
    id: id,
    version: raw.version,
    displayName: displayName,
    description: description,
    plugins: extensionNormalizeStringList(raw.plugins, 'plugins', 'capability ' + id),
    skills: extensionNormalizeStringList(raw.skills, 'skills', 'capability ' + id),
    mcps: extensionNormalizeStringList(raw.mcps, 'mcps', 'capability ' + id),
  };
}

// ---------- catalog-set validation (load time, fail loudly) ----------
// One manager owns ONE validated catalog set. Structural problems (dup
// ids, bad fields, capability -> missing local component) throw here so
// a broken trusted catalog can never half-load. MCP ids are free-form
// requirement references (valid strings only) — external authorities do
// not need to exist locally to be nameable.
function validateCatalogSet(catalogs) {
  const c = catalogs || {};
  const plugins = new Map();
  const skills = new Map();
  const mcps = new Map();
  const capabilities = new Map();
  const list = (v, kind) => (v === undefined || v === null ? [] : v);
  for (const raw of list(c.plugins, 'plugins')) {
    const p = validatePluginDescriptor(raw);
    if (plugins.has(p.id)) throw extensionDescriptorError('duplicate plugin id in catalog: ' + p.id);
    plugins.set(p.id, p);
  }
  for (const raw of list(c.skills, 'skills')) {
    const s = validateSkillDescriptor(raw);
    if (skills.has(s.id)) throw extensionDescriptorError('duplicate skill id in catalog: ' + s.id);
    skills.set(s.id, s);
  }
  for (const raw of list(c.mcps, 'mcps')) {
    const m = validateMcpDescriptor(raw);
    if (mcps.has(m.id)) throw extensionDescriptorError('duplicate mcp id in catalog: ' + m.id);
    mcps.set(m.id, m);
  }
  for (const raw of list(c.capabilities, 'capabilities')) {
    const cap = validateCapabilityDescriptor(raw);
    if (capabilities.has(cap.id)) throw extensionDescriptorError('duplicate capability id in catalog: ' + cap.id);
    for (const ref of cap.plugins) {
      if (!plugins.has(ref)) {
        throw extensionDescriptorError('capability ' + cap.id + ' references unknown plugin: ' + ref);
      }
    }
    for (const ref of cap.skills) {
      if (!skills.has(ref)) {
        throw extensionDescriptorError('capability ' + cap.id + ' references unknown skill: ' + ref);
      }
    }
    capabilities.set(cap.id, cap);
  }
  return { capabilities: capabilities, plugins: plugins, skills: skills, mcps: mcps };
}

// ---------- production catalogs ----------
// EMPTY by design: no capability ships without a real product decision.
// Tests and e2e inject synthetic catalogs via the manager constructor —
// never by mutating these (frozen) arrays.
const CAPABILITY_CATALOG = Object.freeze([]);
const PLUGIN_CATALOG = Object.freeze([]);
const SKILL_CATALOG = Object.freeze([]);
const MCP_CATALOG = Object.freeze([]);

// ---------- capability / MCP state vocabulary ----------
const CAPABILITY_STATES = Object.freeze(['disabled', 'needs-connection', 'ready', 'error']);
const MCP_STATES = Object.freeze(['connected', 'needs-connection', 'unavailable']);

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


// ---------- PluginRuntimeProvider seam ----------
// A runtime provider binds a plugin descriptor to its runtime. V1
// defines the GENERIC interface only — exactly one provider kind is ever
// exercised (python, by tests); javascript/wasm stay future seams. The
// interface is intentionally small and real-need-driven:
//
//   provider.prepare(plugin, context) -> Promise<{
//     files:   { relativePath: text, ... },   // installed into the runtime
//     imports: [moduleName, ...],             // smoke-imported before READY
//   }>
//
// A future verified wheel loader implements the same seam without any
// change to Capability / Skill / Agent code. Providers are registered
// per runtime; a plugin whose runtime has no provider fails capability
// RESOLUTION (state "error") — never a silent no-op and never a lazy
// download.
const PLUGIN_RUNTIME_PROVIDERS = new Map();

function registerPluginRuntimeProvider(runtime, provider) {
  if (!PLUGIN_RUNTIMES.includes(runtime)) {
    throw extensionDescriptorError('unknown plugin runtime: ' + String(runtime));
  }
  if (!provider || typeof provider.prepare !== 'function') {
    throw extensionDescriptorError('plugin runtime provider for ' + runtime + ' needs a prepare(plugin, context) function');
  }
  PLUGIN_RUNTIME_PROVIDERS.set(runtime, provider);
}

function pluginRuntimeProvider(runtime) {
  return PLUGIN_RUNTIME_PROVIDERS.get(runtime) || null;
}

function unregisterPluginRuntimeProvider(runtime) {
  PLUGIN_RUNTIME_PROVIDERS.delete(runtime);
}

// Structural validation of one prepared payload (trusted harness data,
// but relative paths are load-bearing for the runtime install step).
function validatePluginPayload(plugin, payload) {
  if (!payload || typeof payload !== 'object') {
    throw extensionResolutionError('plugin ' + plugin.id + ': runtime provider returned no payload');
  }
  const files = payload.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw extensionResolutionError('plugin ' + plugin.id + ': payload.files must be an object');
  }
  const outFiles = {};
  for (const relRaw of Object.keys(files)) {
    const rel = String(relRaw);
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..')) {
      throw extensionResolutionError('plugin ' + plugin.id + ': invalid payload file path: ' + rel);
    }
    if (typeof files[relRaw] !== 'string') {
      throw extensionResolutionError('plugin ' + plugin.id + ': payload file ' + rel + ' must be UTF-8 text');
    }
    outFiles[rel] = files[relRaw];
  }
  const imports = payload.imports;
  if (!Array.isArray(imports) || imports.some((n) => !EXTENSION_PY_MODULE_PATTERN.test(String(n)))) {
    throw extensionResolutionError('plugin ' + plugin.id + ': payload.imports must be an array of module names');
  }
  return { files: outFiles, imports: imports.map(String) };
}

// Stable identity of the python-side extension set (which plugin
// payloads a booted Python worker already contains). The harness uses it
// to decide whether the interpreter must be rebuilt for the NEXT task.
function pythonExtensionKeyOf(plugins) {
  const py = (plugins || []).filter((p) => p.runtime === 'python')
    .map((p) => p.id + '@' + p.version).sort();
  return py.length ? py.join('|') : null;
}

// ------------------------------------------------------------
//  CapabilityManager
//
//  new CapabilityManager({ catalogs, sources, instances })
//
//  Catalogs are validated LOUDLY at construction. Production passes the
//  (empty) frozen catalogs, an EMPTY SkillSourceStore and the durable
//  SkillInstanceStorage; tests inject synthetic sets. Enabled-state is
//  page-session only (no persistence — reload resets to default), but a
//  capability's materialized skill INSTANCES are durable: re-enabling
//  finds the install marker and reuses the user's customized copies.
//  ------------------------------------------------------------
class CapabilityManager {
  constructor(opts) {
    const o = opts || {};
    const catalogs = validateCatalogSet(o.catalogs ? o.catalogs : {});
    this._capabilities = catalogs.capabilities;
    this._plugins = catalogs.plugins;
    this._skills = catalogs.skills;
    this._mcps = catalogs.mcps;
    // capabilityId -> { state, error, plugins: Map(id -> {descriptor,payload}),
    //                   skills: Map(id -> descriptor),
    //                   skillPresence: Map(skillId -> bool),
    //                   mcps: Set(id) }
    this._enabled = new Map();
    // mcpId -> 'connected' | 'needs-connection' | 'unavailable'
    // Default for a referenced requirement is needs-connection: a
    // capability may be installed locally while its external authority
    // is not connected. Only an EXPLICIT connection decision flips it.
    this._mcpStates = new Map();
    // Immutable default sources for the catalog's SkillDefinitions.
    // Metadata (this._skills) and source bytes are separate concepts.
    this.skillSources = o.sources instanceof SkillSourceStore ? o.sources : new SkillSourceStore();
    // Durable instance primitives; null storage means capabilities with
    // skills fail enable LOUDLY instead of pretending to materialize.
    this.skillInstances = o.instances instanceof SkillInstanceStorage ? o.instances : null;
  }

  // ---- catalog view (UI / introspection) ----
  listCapabilities() {
    const out = [];
    for (const cap of this._capabilities.values()) {
      const entry = this._enabled.get(cap.id);
      const state = entry ? entry.state : 'disabled';
      out.push({
        id: cap.id,
        version: cap.version,
        displayName: cap.displayName,
        description: cap.description,
        state: state,
        error: entry && entry.error ? entry.error : null,
        enabled: !!entry,
        includes: {
          plugins: cap.plugins.length,
          skills: cap.skills.length,
          mcps: cap.mcps.length,
        },
        plugins: cap.plugins.map((id) => this._pluginSummary(id)),
        skills: cap.skills.map((id) => this._skillSummary(id)),
        mcps: cap.mcps.map((id) => ({
          id: id,
          displayName: this._mcpDisplayName(id),
          state: this._mcpState(id),
        })),
      });
    }
    return out;
  }

  isEnabled(capabilityId) { return this._enabled.has(capabilityId); }

  // TEST/E2E-ONLY catalog injection: validate the replacement set LOUDLY
  // first (a broken set leaves the current state untouched), then swap
  // catalogs — and, when provided, the synthetic source store — and reset
  // enabled-state — page-session semantics, so a reload resets to the
  // default anyway. Production code never calls this; the production
  // catalogs stay the frozen, empty arrays. sources: { [skillId]:
  // { version, source } }.
  replaceCatalogs(catalogs, sources) {
    const next = validateCatalogSet(catalogs || {});
    const store = new SkillSourceStore();
    if (sources && typeof sources === 'object') {
      for (const skillId of Object.keys(sources)) {
        const s = sources[skillId];
        if (!s || typeof s !== 'object') {
          throw extensionDescriptorError('synthetic skill source ' + skillId + ' must be { version, source }');
        }
        store.define(skillId, s.version, s.source);
      }
    }
    this._capabilities = next.capabilities;
    this._plugins = next.plugins;
    this._skills = next.skills;
    this._mcps = next.mcps;
    if (sources !== undefined) this.skillSources = store;
    this._enabled = new Map();
    this._mcpStates = new Map();
  }

  capabilityState(capabilityId) {
    const entry = this._enabled.get(capabilityId);
    return entry ? entry.state : 'disabled';
  }

  _pluginSummary(id) {
    const p = this._plugins.get(id);
    return p ? { id: p.id, displayName: p.displayName, runtime: p.runtime, authority: p.authority } : { id: id, displayName: id, missing: true };
  }

  _skillSummary(id) {
    const s = this._skills.get(id);
    return s ? { id: s.id, displayName: s.displayName, version: s.version } : { id: id, displayName: id, missing: true };
  }

  _mcpDisplayName(id) {
    const m = this._mcps.get(id);
    return m ? m.displayName : id;
  }

  _mcpState(id) {
    return this._mcpStates.get(id) || 'needs-connection';
  }

  // ---- MCP connection state (the future connector's only write path) ----
  setMcpState(mcpId, state) {
    if (!MCP_STATES.includes(state)) {
      throw extensionResolutionError('invalid MCP state: ' + String(state));
    }
    this._mcpStates.set(mcpId, state);
    // Capabilities referencing this authority recompute immediately —
    // but any TaskEnvironment already built stays frozen at its old
    // state by construction.
    for (const [capId, entry] of this._enabled) {
      if (entry.state !== 'error' && this._capabilities.get(capId).mcps.includes(mcpId)) {
        entry.state = this._computeState(entry);
      }
    }
    return this._mcpState(mcpId);
  }

  _computeState(entry) {
    for (const mcpId of entry.mcps) {
      if (this._mcpState(mcpId) !== 'connected') return 'needs-connection';
    }
    return 'ready';
  }

  // ---- enable ----
  // 1. validate + resolve plugins (runtime provider prepares payloads)
  // 2. resolve skills (definitions) + materialize capability-private
  //    durable instances (reuse a compatible install, else build one)
  // 3. collect MCP requirements
  // 4. dedupe by id (Map semantics — shared components stay shared;
  //    skill INSTANCES are per-capability and never deduped)
  // 5. compute state (error > needs-connection > ready)
  // Local resolution failure (e.g. no runtime provider for a python
  // plugin, a provider that fails, or a skill materialization fault)
  // does NOT throw: the capability is recorded with state "error" and
  // contributes nothing to task environments. Unknown ids and invalid
  // state transitions throw.
  async enable(capabilityId) {
    const cap = this._capabilities.get(capabilityId);
    if (!cap) throw extensionResolutionError('unknown capability: ' + String(capabilityId));
    if (this._enabled.has(capabilityId)) return this._enabled.get(capabilityId).state;

    const entry = {
      state: 'error', error: null, plugins: new Map(), skills: new Map(),
      skillPresence: new Map(), mcps: new Set(cap.mcps),
    };
    this._enabled.set(capabilityId, entry); // reserve first: recompute paths see it

    let failure = null;
    for (const pluginId of cap.plugins) {
      const descriptor = this._plugins.get(pluginId);
      const provider = pluginRuntimeProvider(descriptor.runtime);
      if (!provider) {
        failure = 'plugin ' + pluginId + ': no runtime provider registered for "' + descriptor.runtime + '"';
        break;
      }
      try {
        const payload = validatePluginPayload(descriptor, await provider.prepare(descriptor, { capabilityId: cap.id }));
        entry.plugins.set(pluginId, { descriptor: descriptor, payload: payload });
      } catch (e) {
        failure = 'plugin ' + pluginId + ' failed to prepare: ' + (e && e.message ? e.message : String(e));
        break;
      }
    }
    if (!failure) {
      for (const skillId of cap.skills) {
        entry.skills.set(skillId, this._skills.get(skillId));
      }
      if (cap.skills.length) {
        failure = await this._materializeSkills(cap, entry);
      }
    }

    if (failure) {
      entry.state = 'error';
      entry.error = failure;
    } else {
      await this._refreshPresence(cap.id);
      entry.state = this._computeState(entry);
    }
    return entry.state;
  }

  // ---- durable skill instance materialization ----
  // A capability owns /home/locus/.skills/<capabilityId>/ exclusively.
  //   marker present + compatible (capabilityVersion + per-skill source
  //   version/hash) -> REUSE the existing instances untouched (user edits
  //   and deliberate deletions survive re-enables and page reloads);
  //   marker present + INCOMPATIBLE -> state error, never auto-overwrite;
  //   marker absent -> incomplete/first install: clean any leftovers,
  //   write every default, verify, write the marker LAST; any failure
  //   rolls the whole first install back so no half-installed state
  //   can ever "look enabled".
  async _materializeSkills(cap, entry) {
    if (!this.skillInstances) {
      return 'capability ' + cap.id + ': skill instance storage is unavailable';
    }
    const storage = this.skillInstances;
    const plans = [];
    for (const skillId of cap.skills) {
      const def = entry.skills.get(skillId);
      const source = this.skillSources.sourceOf(skillId, def.version);
      if (!source) {
        return 'skill ' + skillId + ': no default source in the skill source store for version ' + def.version;
      }
      const hash = await sha256Hex(source.bytes);
      plans.push({ skillId: skillId, version: def.version, bytes: source.bytes, hash: hash });
    }
    const markerRel = cap.id + '/' + SKILL_INSTANCE_MARKER;

    let marker = null;
    try {
      marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await storage.readBytes(markerRel)));
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') marker = null; // corrupt/unreadable marker = incomplete install
    }
    if (marker && typeof marker === 'object') {
      const compatible = marker.capabilityId === cap.id
        && marker.capabilityVersion === cap.version
        && Array.isArray(marker.skills)
        && marker.skills.length === plans.length
        && plans.every((p) => marker.skills.some((m) => m
          && m.id === p.skillId && m.sourceVersion === p.version && m.sourceHash === p.hash));
      if (compatible) return null; // REUSE: the user's instances stay exactly as they are
      return 'capability ' + cap.id + ': installed skill instances do not match the current catalog'
        + ' (installed capability version ' + JSON.stringify(marker.capabilityVersion || null) + ')'
        + '; remove and re-add the capability to reset its guidance';
    }

    // FIRST INSTALL (or recovery from an incomplete one): rollback on any
    // failure — nothing partially written survives as "installed".
    try {
      await storage.removeDir(cap.id); // clear incomplete leftovers (no-op when absent)
      for (const p of plans) {
        await storage.writeBytes(cap.id + '/' + p.skillId + '.skill', p.bytes);
      }
      for (const p of plans) {
        const back = await storage.readBytes(cap.id + '/' + p.skillId + '.skill');
        if ((await sha256Hex(back)) !== p.hash) {
          throw new Error('verification failed for ' + skillInstancePath(cap.id, p.skillId));
        }
      }
      await storage.writeBytes(markerRel, new TextEncoder().encode(skillInstanceMarkerPayload(cap, plans)));
    } catch (e) {
      try { await storage.removeDir(cap.id); } catch (ignored) { /* best-effort rollback */ }
      return 'capability ' + cap.id + ': skill materialization failed: ' + (e && e.message ? e.message : String(e));
    }
    return null;
  }

  // Re-observe which skill instances currently exist (user deletions and
  // recreations change durability behind the manager's back). Called at
  // enable and before every TaskEnvironment build; presence affects the
  // system-prompt index only — never the frozen instance identity.
  async refreshSkillPresence() {
    for (const capId of this._enabled.keys()) {
      await this._refreshPresence(capId);
    }
  }

  async _refreshPresence(capId) {
    const entry = this._enabled.get(capId);
    if (!entry || !entry.skills.size) return;
    const storage = this.skillInstances;
    for (const skillId of entry.skills.keys()) {
      let present = false;
      if (storage) {
        try { present = (await storage.stat(capId + '/' + skillId + '.skill')).kind === 'file'; } catch (e) { present = false; }
      }
      entry.skillPresence.set(skillId, present);
    }
  }

  // ---- disable (= REMOVE, the reset boundary) ----
  // The user explicitly removing a capability deletes its ENTIRE private
  // skill instance directory — customizations included — then releases
  // the component references. Re-adding rematerializes from the immutable
  // definitions: this IS the v1 "restore defaults" path. Idempotent for
  // unknown/disabled ids. A failed cleanup leaves the capability ENABLED
  // and throws: the UI must never claim "Removed" when the destructive
  // deletion did not happen.
  async disable(capabilityId) {
    if (!this._capabilities.has(capabilityId)) {
      throw extensionResolutionError('unknown capability: ' + String(capabilityId));
    }
    const entry = this._enabled.get(capabilityId);
    if (!entry) return; // a UI toggle can race a reload
    if (entry.skills.size && this.skillInstances) {
      try {
        await this.skillInstances.removeDir(capabilityId);
      } catch (e) {
        throw extensionResolutionError('capability ' + capabilityId
          + ' was NOT removed: deleting its skill instances failed: '
          + (e && e.message ? e.message : String(e)));
      }
    }
    this._enabled.delete(capabilityId);
  }

  // ------------------------------------------------------------
  //  TaskEnvironment — THE immutable per-task snapshot.
  //
  //  Deeply frozen plain data: capabilities (with resolved state),
  //  plugins (safe descriptors + prepared payloads), skill INSTANCES
  //  (one entry per enabled capability × declared skill — the SAME
  //  SkillDefinition referenced by two capabilities yields TWO entries
  //  with two independent paths; never deduped, never a body), mcps
  //  (requirement states). Built ONCE per task start by the harness;
  //  mutations afterwards are invisible to it. pythonExtensionKey
  //  identifies the python plugin payload set so the harness can rebuild
  //  the interpreter when the NEXT task needs a different set.
  //
  //  The snapshot freezes instance IDENTITY (capabilityId + skillId +
  //  path), not file content: an approved in-task mutation changes the
  //  file, never this object; the NEXT build re-observes `present`.
  //  ------------------------------------------------------------
  buildTaskEnvironment() {
    const capabilities = [];
    const plugins = new Map();
    const skills = [];
    const mcps = new Map();
    for (const [capId, entry] of this._enabled) {
      const cap = this._capabilities.get(capId);
      if (entry.state === 'error') {
        // A capability whose local resolution failed contributes nothing
        // but its (honest) error record.
        capabilities.push(this._freeze({
          id: cap.id, version: cap.version, displayName: cap.displayName,
          description: cap.description, state: entry.state, error: entry.error,
          pluginIds: [], skillIds: [], mcpIds: [], skillPaths: [],
          includes: { plugins: 0, skills: 0, mcps: 0 },
        }));
        continue;
      }
      const pluginIds = [];
      for (const [pluginId, resolved] of entry.plugins) {
        if (!plugins.has(pluginId)) plugins.set(pluginId, resolved);
        pluginIds.push(pluginId);
      }
      const skillIds = [];
      const skillPaths = [];
      for (const [skillId, descriptor] of entry.skills) {
        // One instance entry per capability × skill — paths are
        // capability-private, so shared definitions stay separate rows.
        const path = skillInstancePath(capId, skillId);
        const present = entry.skillPresence.get(skillId) === true;
        skills.push(this._freeze({
          capabilityId: capId,
          skillId: skillId,
          version: descriptor.version,
          displayName: descriptor.displayName,
          description: descriptor.description,
          path: path,
          present: present,
        }));
        skillIds.push(skillId);
        if (present) skillPaths.push(path);
      }
      const mcpIds = [];
      for (const mcpId of entry.mcps) {
        if (!mcps.has(mcpId)) mcps.set(mcpId, this._mcpState(mcpId));
        mcpIds.push(mcpId);
      }
      capabilities.push(this._freeze({
        id: cap.id, version: cap.version, displayName: cap.displayName,
        description: cap.description, state: entry.state, error: null,
        pluginIds: pluginIds, skillIds: skillIds, mcpIds: mcpIds,
        skillPaths: skillPaths,
        includes: { plugins: pluginIds.length, skills: skillIds.length, mcps: mcpIds.length },
      }));
    }
    const pluginList = [];
    for (const [pluginId, resolved] of plugins) {
      pluginList.push(this._freeze({
        id: pluginId,
        version: resolved.descriptor.version,
        displayName: resolved.descriptor.displayName,
        runtime: resolved.descriptor.runtime,
        authority: resolved.descriptor.authority,
        provides: this._freeze(Object.assign({}, resolved.descriptor.provides)),
        payload: this._freeze({ files: this._freeze(Object.assign({}, resolved.payload.files)), imports: resolved.payload.imports.slice() }),
      }));
    }
    const mcpList = [];
    for (const [mcpId, state] of mcps) {
      mcpList.push(this._freeze({ id: mcpId, displayName: this._mcpDisplayName(mcpId), state: state }));
    }
    const pythonPlugins = pluginList.filter((p) => p.runtime === 'python');
    return this._freeze({
      generatedAt: new Date().toISOString(),
      capabilities: capabilities,
      plugins: pluginList,
      skills: skills,
      mcps: mcpList,
      pythonExtensionKey: pythonExtensionKeyOf(pluginList),
    });
  }

  // Deep-freeze helper: every nested array/object of the snapshot is
  // frozen; mutation attempts from any consumer are silent no-ops
  // (strict mode throws) — the snapshot stays exactly what the task
  // started with.
  _freeze(value) {
    if (Array.isArray(value)) {
      value.forEach((v) => this._freeze(v));
      return Object.freeze(value);
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) this._freeze(value[k]);
      return Object.freeze(value);
    }
    return value;
  }

  // ---- python extension payload for the worker bootstrap ----
  // Modules from ALL enabled python plugins, deduped by plugin id —
  // the exact set a freshly booted Python worker installs BEFORE READY
  // (no lazy-install-on-import, ever).
  pythonExtensionPayload(env) {
    const source = env || this.buildTaskEnvironment();
    const modules = [];
    for (const p of source.plugins) {
      if (p.runtime !== 'python') continue;
      modules.push(this._freeze({
        pluginId: p.id,
        files: Object.assign({}, p.payload.files),
        imports: p.payload.imports.slice(),
      }));
    }
    return this._freeze({ key: source.pythonExtensionKey, modules: modules });
  }

  // ---- per-task VFS mounts ----
  // Providers for the task's fork of the VirtualWorkspace:
  //   PLUGINS_VFS_ROOT/<plugin-id>/plugin.json   (safe introspection)
  //   CAPABILITIES_VFS_ROOT/<cap-id>/capability.json (safe introspection)
  // Skill instances are NOT mounted here: they live as durable,
  // capability-private files under /home/locus/.skills, exposed to the
  // task through the approval-guarded SkillInstanceWorkspace (store.js
  // mounts it on the fork when the environment carries skills). The old
  // read-only /usr/local/share/locus/skills body mount is gone — there is
  // exactly ONE working view of each skill.
  // Introspection JSON carries safe metadata only — never payload bytes,
  // credentials or internal object references. An empty environment
  // yields NO mounts (the production VFS stays exactly as before).
  taskVfsMounts(env) {
    const source = env || this.buildTaskEnvironment();
    const mounts = [];
    if (source.plugins.length) {
      const files = {};
      for (const p of source.plugins) {
        files[p.id + '/plugin.json'] = JSON.stringify({
          id: p.id, version: p.version, runtime: p.runtime,
          authority: p.authority, provides: p.provides,
        }, null, 2) + '\n';
      }
      mounts.push({
        path: PLUGINS_VFS_ROOT,
        provider: new StaticFileWorkspace({ name: 'locus-plugins', files: files }),
        authority: 'system-read-only',
      });
    }
    if (source.capabilities.length) {
      const files = {};
      for (const c of source.capabilities) {
        files[c.id + '/capability.json'] = JSON.stringify({
          id: c.id, version: c.version, displayName: c.displayName,
          description: c.description, plugins: c.pluginIds,
          skills: c.skillPaths, mcps: c.mcpIds, state: c.state,
        }, null, 2) + '\n';
      }
      mounts.push({
        path: CAPABILITIES_VFS_ROOT,
        provider: new StaticFileWorkspace({ name: 'locus-capabilities', files: files }),
        authority: 'system-read-only',
      });
    }
    return mounts;
  }
}
