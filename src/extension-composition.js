// ============================================================
//  CAPABILITY COMPOSITION CORE v1 (extension layer — Harness side)
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
//      guidance is read on demand from capability-private SkillInstance
//      files under /home/locus/.skills/<capability-id>/<skill-id>.skill).
//    - Skills are trusted harness content: a SkillDefinition is the
//      publisher's immutable metadata + default source template; an
//      ENABLED capability materializes its own private, durable
//      SkillInstance at /home/locus/.skills/<capability-id>/<skill-id>.skill.
//      Definitions may be shared; instances are NEVER shared.
//    - Skill bodies never enter the TaskEnvironment or the system prompt;
//      mutable SkillInstance contents DO persist as capability-private
//      durable files under /home/locus/.skills and become provider-visible
//      only through explicit on-demand reads. Skill READS are free, every
//      CREATE/WRITE/DELETE of an instance requires an explicit user
//      confirmation (behavior mutation) — enforced by
//      SkillInstanceWorkspace, never by shell command type.
// ============================================================
//  M2b SPLIT (repository split): THIS is the composition CORE — the
//  Harness-owned half. It depends on NO workspace.js/vfs.js (no VFS
//  provider class is constructed here — the introspection mounts leave as
//  pure spec data for the Product adapter) and no model/shell/DOM global.
//  The Product adapter half (StaticFileWorkspace / SkillInstanceStorage /
//  SkillInstanceWorkspace) stayed in src/extensions.js, which loads AFTER
//  this file; capability-package.js keeps reading the identity constants
//  through the classic lexical chain.
//  File ends with explicit globalThis publishes: the ESM self-assembly
//  mode (src/harness/core.js) needs cross-file names on globalThis;
//  classic loading is unaffected (same bindings).

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
    // Durable instance primitives arrive as the NARROW PORT the manager
    // actually calls (M2b): readBytes / writeBytes / removeDir / stat. The
    // durable Product storage implementation stays on the Product side;
    // null (or an incomplete port) means capabilities with skills fail
    // enable LOUDLY instead of pretending to materialize.
    const instances = o.instances || null;
    const portOk = !!instances && ['readBytes', 'writeBytes', 'removeDir', 'stat']
      .every((m) => typeof instances[m] === 'function');
    this.skillInstances = portOk ? instances : null;
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

  // ---- per-task mount SPECS (M2b: pure data, no VFS providers) ----
  // The introspection mounts for the task fork of the VirtualWorkspace:
  //   PLUGINS_VFS_ROOT/<plugin-id>/plugin.json   (safe introspection)
  //   CAPABILITIES_VFS_ROOT/<cap-id>/capability.json (safe introspection)
  // The composition core returns pure SPEC objects ({ path, name, files,
  // authority }) — constructing the read-only providers is the PRODUCT
  // adapter's job (productTaskVfsMounts in src/extensions.js over the
  // Runtime's StaticFileWorkspace), so this Harness-owned file depends on
  // no VFS class. Skill instances are NOT mounted here: they live as
  // durable, capability-private files under /home/locus/.skills, exposed
  // to the task through the approval-guarded SkillInstanceWorkspace
  // (store.js mounts it on the fork when the environment carries skills).
  // Introspection JSON carries safe metadata only — never payload bytes,
  // credentials or internal object references. An empty environment
  // yields NO specs (the production VFS stays exactly as before).
  taskVfsMountSpecs(env) {
    const source = env || this.buildTaskEnvironment();
    const specs = [];
    if (source.plugins.length) {
      const files = {};
      for (const p of source.plugins) {
        files[p.id + '/plugin.json'] = JSON.stringify({
          id: p.id, version: p.version, runtime: p.runtime,
          authority: p.authority, provides: p.provides,
        }, null, 2) + '\n';
      }
      specs.push({ path: PLUGINS_VFS_ROOT, name: 'locus-plugins', files: files, authority: 'system-read-only' });
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
      specs.push({ path: CAPABILITIES_VFS_ROOT, name: 'locus-capabilities', files: files, authority: 'system-read-only' });
    }
    return specs;
  }
}

// ============================================================
//  M2b: explicit publishes (ESM self-assembly mode). The harness entry
//  (src/harness/index.js) and src/harness/core.js resolve these names;
//  the declared __LOCUS_HARNESS_CORE__ table (agent.js) carries the
//  entry's surface. Classic loading is unaffected.
// ============================================================
globalThis.CapabilityManager = CapabilityManager;
globalThis.SkillSourceStore = SkillSourceStore;
globalThis.pythonExtensionKeyOf = pythonExtensionKeyOf;
globalThis.validatePluginPayload = validatePluginPayload;
globalThis.registerPluginRuntimeProvider = registerPluginRuntimeProvider;
globalThis.pluginRuntimeProvider = pluginRuntimeProvider;
globalThis.unregisterPluginRuntimeProvider = unregisterPluginRuntimeProvider;
globalThis.EXTENSION_ID_PATTERN = EXTENSION_ID_PATTERN;
globalThis.EXTENSION_PY_MODULE_PATTERN = EXTENSION_PY_MODULE_PATTERN;
// The four production catalogs travel with the publishes: the product
// page's store module reads them by bare name (globalThis), and a hosted
// page that loaded the composition core as a module must look exactly
// like the classic page.
globalThis.CAPABILITY_CATALOG = CAPABILITY_CATALOG;
globalThis.PLUGIN_CATALOG = PLUGIN_CATALOG;
globalThis.SKILL_CATALOG = SKILL_CATALOG;
globalThis.MCP_CATALOG = MCP_CATALOG;
