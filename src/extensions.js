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
//      backing the skill / plugin / capability introspection mounts,
//    - CapabilityManager — enable/disable with shared-component
//      reference semantics, capability state, TaskEnvironment builds,
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
//    - Skills are trusted harness content: mounted ONLY from the built
//      catalog at a fixed system path — workspace files, uploads and
//      URLs can never shadow or supply a skill.
//    - Skill bodies never enter persistence or the system prompt; after
//      the model cats one, it is ordinary tool output (already inside
//      the existing HISTORY_BUDGET_BYTES accounting).
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

const SKILLS_VFS_ROOT = '/usr/local/share/locus/skills';
const CAPABILITIES_VFS_ROOT = '/usr/local/share/locus/capabilities';
const PLUGINS_VFS_ROOT = '/mnt/plugins';

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

// ---------- Skill descriptor ----------
// A skill is trusted knowledge. The descriptor carries the FIXED VFS path
// of its guide and the guide body itself (supplied by the trusted catalog
// — never loaded from the workspace, an upload or a URL). The body is
// served read-only from SKILLS_VFS_ROOT and is read by the model ON
// DEMAND; it must never be inlined into the system prompt.
function validateSkillDescriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw extensionDescriptorError('skill descriptor must be an object');
  }
  const id = extensionRequireId(raw.id, 'skill');
  extensionRequireString(raw.version, 'version', 'skill ' + id);
  const description = extensionRequireString(raw.description, 'description', 'skill ' + id);
  const expectedPath = SKILLS_VFS_ROOT + '/' + id + '/SKILL.md';
  const path = extensionRequireString(raw.path, 'path', 'skill ' + id);
  if (path !== expectedPath) {
    throw extensionDescriptorError('skill ' + id + ': path must be exactly ' + expectedPath
      + ' (got ' + path + ')');
  }
  const body = extensionRequireString(raw.body, 'body', 'skill ' + id);
  return {
    kind: 'skill',
    id: id,
    version: raw.version,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id,
    description: description,
    path: path,
    body: body,
  };
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
// the skill guides, /mnt/plugins/<id>/plugin.json and the capability
// introspection mounts; it is never agent-writable.
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
//  new CapabilityManager({ catalogs: { capabilities, plugins, skills, mcps } })
//
//  Catalogs are validated LOUDLY at construction. Production passes the
//  (empty) frozen catalogs; tests inject synthetic sets. Enabled-state
//  is page-session only (no persistence — reload resets to default).
//  ------------------------------------------------------------
class CapabilityManager {
  constructor(opts) {
    const catalogs = validateCatalogSet(opts && opts.catalogs ? opts.catalogs : {});
    this._capabilities = catalogs.capabilities;
    this._plugins = catalogs.plugins;
    this._skills = catalogs.skills;
    this._mcps = catalogs.mcps;
    // capabilityId -> { state, error, plugins: Map(id -> {descriptor,payload}),
    //                   skills: Map(id -> descriptor), mcps: Set(id) }
    this._enabled = new Map();
    // mcpId -> 'connected' | 'needs-connection' | 'unavailable'
    // Default for a referenced requirement is needs-connection: a
    // capability may be installed locally while its external authority
    // is not connected. Only an EXPLICIT connection decision flips it.
    this._mcpStates = new Map();
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
  // catalogs and reset enabled-state — page-session semantics, so a
  // reload resets to the default anyway. Production code never calls
  // this; the production catalogs stay the frozen, empty arrays.
  replaceCatalogs(catalogs) {
    const next = validateCatalogSet(catalogs || {});
    this._capabilities = next.capabilities;
    this._plugins = next.plugins;
    this._skills = next.skills;
    this._mcps = next.mcps;
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
    return s ? { id: s.id, displayName: s.displayName, path: s.path } : { id: id, displayName: id, missing: true };
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
  // 2. resolve skills
  // 3. collect MCP requirements
  // 4. dedupe by id (Map semantics — shared components stay shared)
  // 5. compute state (error > needs-connection > ready)
  // Local resolution failure (e.g. no runtime provider for a python
  // plugin, or a provider that fails) does NOT throw: the capability is
  // recorded with state "error" and contributes nothing to task
  // environments. Unknown ids and invalid state transitions throw.
  async enable(capabilityId) {
    const cap = this._capabilities.get(capabilityId);
    if (!cap) throw extensionResolutionError('unknown capability: ' + String(capabilityId));
    if (this._enabled.has(capabilityId)) return this._enabled.get(capabilityId).state;

    const entry = { state: 'error', error: null, plugins: new Map(), skills: new Map(), mcps: new Set(cap.mcps) };
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
    }

    if (failure) {
      entry.state = 'error';
      entry.error = failure;
    } else {
      entry.state = this._computeState(entry);
    }
    return entry.state;
  }

  // ---- disable ----
  // Idempotent for unknown/disabled ids (a UI toggle can race a reload).
  // Shared components are removed automatically: they simply stop being
  // part of the UNION while any other enabled capability still
  // references them.
  disable(capabilityId) {
    if (!this._capabilities.has(capabilityId)) {
      throw extensionResolutionError('unknown capability: ' + String(capabilityId));
    }
    this._enabled.delete(capabilityId);
  }

  // ------------------------------------------------------------
  //  TaskEnvironment — THE immutable per-task snapshot.
  //
  //  Deeply frozen plain data: capabilities (with resolved state),
  //  plugins (safe descriptors + prepared payloads), skills (safe
  //  descriptors, paths only at prompt time), mcps (requirement states).
  //  Built ONCE per task start by the harness; mutations afterwards are
  //  invisible to it. pythonExtensionKey identifies the python plugin
  //  payload set so the harness can rebuild the interpreter when the
  //  NEXT task needs a different set.
  //  ------------------------------------------------------------
  buildTaskEnvironment() {
    const capabilities = [];
    const plugins = new Map();
    const skills = new Map();
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
        if (!skills.has(skillId)) skills.set(skillId, descriptor);
        skillIds.push(skillId);
        skillPaths.push(descriptor.path);
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
    const skillList = [];
    for (const [skillId, d] of skills) {
      skillList.push(this._freeze({
        id: skillId, version: d.version, displayName: d.displayName,
        description: d.description, path: d.path, body: d.body,
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
      skills: skillList,
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
  //   SKILLS_VFS_ROOT/<skill-id>/SKILL.md        (read-only guides)
  //   PLUGINS_VFS_ROOT/<plugin-id>/plugin.json   (safe introspection)
  //   CAPABILITIES_VFS_ROOT/<cap-id>/capability.json (safe introspection)
  // Introspection JSON carries safe metadata only — never payload bytes,
  // credentials or internal object references. An empty environment
  // yields NO mounts (the production VFS stays exactly as before).
  taskVfsMounts(env) {
    const source = env || this.buildTaskEnvironment();
    const mounts = [];
    if (source.skills.length) {
      const files = {};
      for (const s of source.skills) files[s.id + '/SKILL.md'] = s.body;
      mounts.push({
        path: SKILLS_VFS_ROOT,
        provider: new StaticFileWorkspace({ name: 'locus-skills', files: files }),
        authority: 'system-read-only',
      });
    }
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
