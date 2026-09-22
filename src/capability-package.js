// ============================================================
//  CAPABILITY PACKAGE CORE V1 (authoring/package boundary)
//
//  Pure core layer between an editable Capability PROJECT (source
//  tree) and an immutable logical CAPABILITY BUNDLE:
//
//    Capability Project -> validate -> build -> inspect -> Bundle
//
//  This module is the package boundary the future Trusted Plugin
//  Runtime, Reference Capability and self-hosting flows will share.
//  It deliberately does NOT install, register, enable or trust
//  anything: validation/build are read-only observations of a
//  project directory and never touch runtime catalogs, plugin
//  installs or skill materialization (docs/CAPABILITY-PACKAGE.md
//  §7 — "building a package is not installing it").
//
//  Layering:
//    - depends only on workspace.js (WorkspaceAdapter,
//      normalizeWorkspacePath) and extensions.js (the canonical
//      runtime descriptor validators, sha256Hex, id pattern, the
//      256 KiB skill contract). Input is an existing
//      WorkspaceAdapter-compatible reader + a project root path;
//      there is NO second filesystem abstraction, no File System
//      Access API / OPFS / Node fs / fetch here.
//    - source manifests are validated against a STRICT package
//      schema (exact whitelist, unknown fields fail loudly), then
//      the nested descriptor is normalized by the EXISTING runtime
//      validators — this module never re-implements runtime
//      descriptor semantics.
//    - v1 package policy is deliberately narrower than the runtime
//      descriptor support surface: plugins are python-only with
//      exactly one python-wheel artifact and authority "none"
//      (authority itself is enforced by the runtime validator).
//
//  Error discipline:
//    - author/package faults  -> structured diagnostics
//      { severity, code, path, message } (never a raw SyntaxError);
//    - programmer invariants  -> thrown Errors (bad workspace, bad
//      root, inspectBundle on a non-bundle).
//
//  Determinism:
//    - diagnostics sort by (path, code, message);
//    - bundle lock ordering is derived from ids/paths, never from
//      provider list() order or timestamps;
//    - serializeLock() is canonical JSON (sorted keys, LF).
//
//  ZERO side effects: no writes, no network, no globals beyond the
//  single frozen namespace below.
// ============================================================
//  Loaded after vfs.js and extensions.js (index.html order:
//  workspace.js -> vfs.js -> extensions.js -> capability-package.js).
//  Must stay independent of Vue / store / AgentSession /
//  ProviderAdapter / shell dispatch / persistence / DOM UI.
// ============================================================

// ---------- package constants (the only magic numbers) ----------
// v1 bounds exist so an authoring project cannot become a memory
// bomb. They are policy for the PACKAGE layer; runtime-side limits
// (skill bytes) reuse the existing extensions.js contract.
const PACKAGE_SCHEMA_VERSION = 1;

const PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024;           // each source manifest
const PACKAGE_SKILL_MAX_BYTES = SKILL_INSTANCE_MAX_BYTES; // existing 256 KiB contract
const PACKAGE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;      // per plugin artifact
const PACKAGE_TOTAL_MAX_BYTES = 128 * 1024 * 1024;        // shipped runtime bytes
const PACKAGE_MAX_COMPONENTS = 128;                       // plugin+skill+mcp dirs
const PACKAGE_MAX_SHIPPED_FILES = 256;                    // artifacts + skill sources

// v1 package policy (narrower than the runtime descriptor surface).
const PACKAGE_PLUGIN_RUNTIME = 'python';
const PACKAGE_ARTIFACT_FORMAT = 'python-wheel';
const PACKAGE_SKILL_SOURCE_NAME = 'SKILL.md';
const PACKAGE_ARTIFACTS_DIR = 'artifacts';

// ---------- diagnostics ----------
// Author-facing failures are data, never thrown browser errors.
function packageDiagnostic(code, path, message) {
  return { severity: 'error', code: code, path: path, message: message };
}

function compareDiagnostics(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

// Deterministic, provider-order-independent diagnostics ordering +
// de-duplication (same fault discovered twice is reported once).
function sortDiagnostics(diagnostics) {
  const seen = new Set();
  const out = [];
  for (const d of diagnostics) {
    const key = d.path + '\u0000' + d.code + '\u0000' + d.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  out.sort(compareDiagnostics);
  return out;
}

// ---------- small helpers ----------
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Provider-relative project root. Programmer faults throw; the
// manifest-level path rules (strict POSIX, no traversal) apply to
// AUTHOR data below, not to this caller-supplied path.
function normalizeProjectRoot(root) {
  if (root === undefined || root === null) return '';
  if (typeof root !== 'string') {
    throw new Error('capability package: root must be a string workspace path');
  }
  if (root.includes('\\')) {
    throw new Error('capability package: root must use POSIX "/" separators');
  }
  return normalizeWorkspacePath(root); // throws on traversal/control/drive letters
}

function assertWorkspace(workspace) {
  if (!(workspace instanceof WorkspaceAdapter)) {
    throw new Error('capability package: workspace must be a WorkspaceAdapter');
  }
}

// Join the normalized root with a validated relative segment path.
function joinProjectPath(root, rel) {
  return root ? root + '/' + rel : rel;
}

// The builder only ever reads paths it constructed from the
// normalized root plus validated segments — this assertion is the
// explicit proof that no read leaves the project root.
function assertUnderRoot(providerPath, root) {
  if (providerPath !== root && !providerPath.startsWith(root ? root + '/' : '')) {
    throw new Error('capability package: internal read escaped the project root: ' + providerPath);
  }
}

// Strict relative-path rule for AUTHOR-supplied paths (artifacts).
// Reject loudly; never "normalize" traversal into a safe path.
// Returns null when valid, or a rejection reason string.
function sourceRelPathRejectReason(raw, opts) {
  const o = opts || {};
  if (typeof raw !== 'string' || !raw.length) return 'path must be a non-empty string';
  if (raw.includes('\\')) return 'backslash path separators are not allowed: ' + JSON.stringify(raw);
  if (/[\x00-\x1F\x7F]/.test(raw)) return 'control characters are not allowed in paths';
  if (raw.startsWith('/')) return 'absolute paths are not allowed: ' + JSON.stringify(raw);
  if (/^[A-Za-z]:/.test(raw)) return 'drive letters are not allowed: ' + JSON.stringify(raw);
  const segments = raw.split('/');
  for (const seg of segments) {
    if (!seg.length) return 'empty path segment: ' + JSON.stringify(raw);
    if (seg === '.' || seg === '..') return 'path traversal is not allowed: ' + JSON.stringify(raw);
  }
  if (o.under && segments[0] !== o.under) {
    return 'path must stay under "' + o.under + '/": ' + JSON.stringify(raw);
  }
  return null;
}

// Canonical JSON for the lock serialization ONLY: sorted object keys,
// stable arrays, no whitespace decisions left to the ambient runtime.
// This is not a general-purpose repo serializer.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Deep freeze for the lock (plain data only — never bytes).
function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    return Object.freeze(value);
  }
  return value;
}

// ---------- strict manifest reading ----------
// Read one source manifest with the size bound enforced BEFORE the
// full read (where the provider exposes stat), and parse it as a
// JSON object. Author faults become diagnostics; provider faults
// other than clear "missing/wrong kind" answers propagate.
async function readManifestObject(workspace, providerPath, logicalPath, diagnostics) {
  let size = null;
  try {
    const st = await workspace.stat(providerPath);
    if (st.kind !== 'file') {
      diagnostics.push(packageDiagnostic('package_manifest_unreadable', logicalPath,
        logicalPath + ' is not a regular file'));
      return null;
    }
    size = st.size;
  } catch (e) {
    if (e && e.name === 'NotFoundError') {
      diagnostics.push(packageDiagnostic('package_manifest_missing', logicalPath,
        'required manifest is missing: ' + logicalPath));
      return null;
    }
    if (e && e.name === 'TypeMismatchError') {
      diagnostics.push(packageDiagnostic('package_manifest_unreadable', logicalPath,
        logicalPath + ' is not a regular file'));
      return null;
    }
    throw e;
  }
  if (size !== null && size > PACKAGE_MANIFEST_MAX_BYTES) {
    diagnostics.push(packageDiagnostic('package_manifest_too_large', logicalPath,
      logicalPath + ' is ' + size + ' bytes, over the ' + PACKAGE_MANIFEST_MAX_BYTES
      + '-byte manifest limit'));
    return null;
  }
  let bytes;
  try {
    bytes = await workspace.readBytes(providerPath);
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
      diagnostics.push(packageDiagnostic('package_manifest_missing', logicalPath,
        'required manifest is missing: ' + logicalPath));
      return null;
    }
    throw e;
  }
  if (bytes.byteLength > PACKAGE_MANIFEST_MAX_BYTES) {
    diagnostics.push(packageDiagnostic('package_manifest_too_large', logicalPath,
      logicalPath + ' is ' + bytes.byteLength + ' bytes, over the ' + PACKAGE_MANIFEST_MAX_BYTES
      + '-byte manifest limit'));
    return null;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    diagnostics.push(packageDiagnostic('package_json_invalid', logicalPath,
      logicalPath + ' is not valid UTF-8 text'));
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    diagnostics.push(packageDiagnostic('package_json_invalid', logicalPath,
      logicalPath + ' is not valid JSON: ' + (e && e.message ? e.message : String(e))));
    return null;
  }
  if (!isPlainObject(parsed)) {
    diagnostics.push(packageDiagnostic('package_json_invalid', logicalPath,
      logicalPath + ' must contain a JSON object'));
    return null;
  }
  return parsed;
}

// Exact schemaVersion check for every source manifest.
function checkSchemaVersion(parsed, logicalPath, diagnostics) {
  if (parsed.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    diagnostics.push(packageDiagnostic('package_schema_version', logicalPath,
      'unsupported package schemaVersion: ' + JSON.stringify(parsed.schemaVersion)
      + ' (this build implements exactly ' + PACKAGE_SCHEMA_VERSION + ')'));
    return false;
  }
  return true;
}

// Strict field whitelist. Unknown fields FAIL — the package source
// schema never silently ignores author data, even where the runtime
// descriptor validators would tolerate extras.
function rejectUnknownFields(obj, allowed, logicalPath, what, diagnostics) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      diagnostics.push(packageDiagnostic('package_field_unknown', logicalPath,
        what + ' has unknown field "' + key + '" (allowed: ' + allowed.join(', ') + ')'));
    }
  }
}

// Run one EXISTING runtime descriptor validator and turn its
// ExtensionDescriptorError into a structured diagnostic. The runtime
// validators remain the canonical descriptor schema.
function normalizeDescriptor(kind, raw, logicalPath, diagnostics) {
  const validator = kind === 'capability' ? validateCapabilityDescriptor
    : kind === 'plugin' ? validatePluginDescriptor
      : kind === 'skill' ? validateSkillDescriptor
        : validateMcpDescriptor;
  try {
    return validator(raw);
  } catch (e) {
    diagnostics.push(packageDiagnostic('package_descriptor_invalid', logicalPath,
      (e && e.message ? e.message : String(e))));
    return null;
  }
}

// ---------- per-kind source manifest validation ----------
// capability.json: { schemaVersion, capability }
function validateCapabilityManifest(parsed, logicalPath, diagnostics) {
  if (!checkSchemaVersion(parsed, logicalPath, diagnostics)) return null;
  rejectUnknownFields(parsed, ['schemaVersion', 'capability'], logicalPath,
    logicalPath, diagnostics);
  if (!isPlainObject(parsed.capability)) {
    diagnostics.push(packageDiagnostic('package_field_missing', logicalPath,
      logicalPath + ' requires a "capability" object'));
    return null;
  }
  rejectUnknownFields(parsed.capability,
    ['id', 'version', 'displayName', 'description', 'plugins', 'skills', 'mcps'],
    logicalPath, 'capability descriptor', diagnostics);
  return normalizeDescriptor('capability', parsed.capability, logicalPath, diagnostics);
}

// plugins/<id>/plugin.json: { schemaVersion, plugin, artifacts }
// v1 package policy: runtime python, authority none (runtime
// validator), exactly ONE python-wheel artifact under artifacts/.
function validatePluginManifest(parsed, dirId, logicalPath, diagnostics) {
  if (!checkSchemaVersion(parsed, logicalPath, diagnostics)) return null;
  rejectUnknownFields(parsed, ['schemaVersion', 'plugin', 'artifacts'], logicalPath,
    logicalPath, diagnostics);
  if (!isPlainObject(parsed.plugin)) {
    diagnostics.push(packageDiagnostic('package_field_missing', logicalPath,
      logicalPath + ' requires a "plugin" object'));
    return null;
  }
  rejectUnknownFields(parsed.plugin,
    ['id', 'version', 'displayName', 'description', 'runtime', 'authority', 'provides'],
    logicalPath, 'plugin descriptor', diagnostics);

  // Package-layer runtime policy: narrower than the runtime surface
  // by design. javascript/wasm package delivery is NOT claimed.
  if (parsed.plugin.runtime !== PACKAGE_PLUGIN_RUNTIME) {
    diagnostics.push(packageDiagnostic('package_runtime_unsupported', logicalPath,
      'package v1 supports runtime "' + PACKAGE_PLUGIN_RUNTIME + '" only, got '
      + JSON.stringify(parsed.plugin.runtime === undefined ? null : parsed.plugin.runtime)));
  }

  const artifacts = parsed.artifacts;
  if (!Array.isArray(artifacts)) {
    diagnostics.push(packageDiagnostic('package_field_missing', logicalPath,
      logicalPath + ' requires an "artifacts" array'));
    return null;
  }
  // v1 carries exactly one python-wheel: there is no dependency
  // closure format yet, and multiple artifacts would imply an
  // ordering/install contract the runtime does not have.
  if (artifacts.length !== 1) {
    diagnostics.push(packageDiagnostic('package_artifact_policy', logicalPath,
      logicalPath + ' must declare exactly one ' + PACKAGE_ARTIFACT_FORMAT
      + ' artifact, got ' + artifacts.length));
  }
  const outArtifacts = [];
  for (let i = 0; i < artifacts.length; i++) {
    const entry = artifacts[i];
    const entryPath = logicalPath + '#artifacts[' + i + ']';
    if (!isPlainObject(entry)) {
      diagnostics.push(packageDiagnostic('package_field_unknown', entryPath,
        'artifact entries must be objects'));
      continue;
    }
    rejectUnknownFields(entry, ['path', 'format'], entryPath, 'artifact entry', diagnostics);
    const reason = sourceRelPathRejectReason(entry.path, { under: PACKAGE_ARTIFACTS_DIR });
    if (reason) {
      diagnostics.push(packageDiagnostic('package_path_invalid', entryPath, reason));
      continue;
    }
    if (entry.format !== PACKAGE_ARTIFACT_FORMAT) {
      diagnostics.push(packageDiagnostic('package_artifact_policy', entryPath,
        'unsupported artifact format: ' + JSON.stringify(entry.format === undefined
          ? null : entry.format)
        + ' (package v1 supports exactly "' + PACKAGE_ARTIFACT_FORMAT + '")'));
      continue;
    }
    outArtifacts.push({ sourcePath: entry.path, logicalPath: null, format: entry.format });
  }

  const descriptor = normalizeDescriptor('plugin', parsed.plugin, logicalPath, diagnostics);
  if (!descriptor) return null;
  // Directory name MUST equal descriptor id.
  if (descriptor.id !== dirId) {
    diagnostics.push(packageDiagnostic('package_id_mismatch', logicalPath,
      'plugin directory name "' + dirId + '" does not match descriptor id "'
      + descriptor.id + '"'));
    return null;
  }
  for (const a of outArtifacts) {
    a.logicalPath = 'plugins/' + descriptor.id + '/' + a.sourcePath;
  }
  return { descriptor: descriptor, artifacts: outArtifacts };
}

// skills/<id>/skill.json: { schemaVersion, skill, source }
// The source FIELD is authoring metadata; v1 accepts exactly
// "SKILL.md" — no arbitrary runtime paths.
function validateSkillManifest(parsed, dirId, logicalPath, diagnostics) {
  if (!checkSchemaVersion(parsed, logicalPath, diagnostics)) return null;
  rejectUnknownFields(parsed, ['schemaVersion', 'skill', 'source'], logicalPath,
    logicalPath, diagnostics);
  if (!isPlainObject(parsed.skill)) {
    diagnostics.push(packageDiagnostic('package_field_missing', logicalPath,
      logicalPath + ' requires a "skill" object'));
    return null;
  }
  rejectUnknownFields(parsed.skill,
    ['id', 'version', 'displayName', 'description'],
    logicalPath, 'skill descriptor', diagnostics);
  if (parsed.source !== PACKAGE_SKILL_SOURCE_NAME) {
    diagnostics.push(packageDiagnostic('package_source_invalid', logicalPath,
      'skill "source" must be exactly "' + PACKAGE_SKILL_SOURCE_NAME + '", got '
      + JSON.stringify(parsed.source === undefined ? null : parsed.source)));
  }
  const descriptor = normalizeDescriptor('skill', parsed.skill, logicalPath, diagnostics);
  if (!descriptor) return null;
  if (descriptor.id !== dirId) {
    diagnostics.push(packageDiagnostic('package_id_mismatch', logicalPath,
      'skill directory name "' + dirId + '" does not match descriptor id "'
      + descriptor.id + '"'));
    return null;
  }
  const sourceLogical = 'skills/' + descriptor.id + '/' + PACKAGE_SKILL_SOURCE_NAME;
  return { descriptor: descriptor, sourceLogical: sourceLogical };
}

// mcp/<id>/mcp.json: { schemaVersion, mcp }. Credential-ish fields
// are rejected by the strict whitelist above — no secret blacklist
// is maintained here.
function validateMcpManifest(parsed, dirId, logicalPath, diagnostics) {
  if (!checkSchemaVersion(parsed, logicalPath, diagnostics)) return null;
  rejectUnknownFields(parsed, ['schemaVersion', 'mcp'], logicalPath, logicalPath, diagnostics);
  if (!isPlainObject(parsed.mcp)) {
    diagnostics.push(packageDiagnostic('package_field_missing', logicalPath,
      logicalPath + ' requires an "mcp" object'));
    return null;
  }
  rejectUnknownFields(parsed.mcp, ['id', 'displayName', 'description'],
    logicalPath, 'mcp descriptor', diagnostics);
  const descriptor = normalizeDescriptor('mcp', parsed.mcp, logicalPath, diagnostics);
  if (!descriptor) return null;
  if (descriptor.id !== dirId) {
    diagnostics.push(packageDiagnostic('package_id_mismatch', logicalPath,
      'mcp directory name "' + dirId + '" does not match descriptor id "'
      + descriptor.id + '"'));
    return null;
  }
  return { descriptor: descriptor };
}

// ---------- discovery ----------
// Scan ONE component directory level: <root>/<dirName>/<id>/...
// Returns Map<id, dirName>. Anything that is not a valid component
// directory name produces a diagnostic (a package project is never a
// component warehouse with surprise nested descriptors).
async function scanComponentDir(workspace, root, dirName, diagnostics) {
  const found = new Map();
  const providerPath = joinProjectPath(root, dirName);
  let entries;
  try {
    entries = await workspace.list(providerPath);
  } catch (e) {
    if (e && e.name === 'NotFoundError') return found; // absent dir = no components
    if (e && e.name === 'TypeMismatchError') {
      diagnostics.push(packageDiagnostic('package_component_dir_invalid', dirName,
        dirName + '/ must be a directory'));
      return found;
    }
    throw e;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== 'string' || !name.length || name.includes('/')
      || name.includes('\\') || /[\x00-\x1F\x7F]/.test(name)
      || name === '.' || name === '..') {
      diagnostics.push(packageDiagnostic('package_component_dir_invalid', dirName,
        dirName + '/ contains an invalid entry name: ' + JSON.stringify(String(name))));
      continue;
    }
    if (entry.kind !== 'directory') {
      diagnostics.push(packageDiagnostic('package_component_dir_invalid', dirName + '/' + name,
        dirName + '/ entries must be component directories, got a file: ' + name));
      continue;
    }
    if (!EXTENSION_ID_PATTERN.test(name)) {
      diagnostics.push(packageDiagnostic('package_id_invalid', dirName + '/' + name,
        dirName + '/ directory name must match ' + EXTENSION_ID_PATTERN + ': ' + name));
      continue;
    }
    if (found.has(name)) {
      diagnostics.push(packageDiagnostic('package_duplicate', dirName + '/' + name,
        'duplicate ' + dirName + ' component id: ' + name));
      continue;
    }
    found.set(name, dirName + '/' + name);
  }
  return found;
}

// ---------- project validation ----------
// validateProject({ workspace, root }) -> {
//   ok, diagnostics, normalized?: { capability, plugins, skills, mcps, sourcePlan }
// }
//
// READ ONLY: list / stat / readBytes only. ZERO writes, no
// installation, no catalog mutation, no trust decision.
async function validateProject(opts) {
  const o = opts || {};
  assertWorkspace(o.workspace);
  const root = normalizeProjectRoot(o.root);
  const ws = o.workspace;
  const diagnostics = [];

  // Root must exist and be a directory.
  try {
    const st = await ws.stat(root || '.');
    if (st.kind !== 'directory') {
      diagnostics.push(packageDiagnostic('package_root_missing', root || '.',
        'project root is not a directory: ' + (root || '.')));
    }
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
      diagnostics.push(packageDiagnostic('package_root_missing', root || '.',
        'project root does not exist: ' + (root || '.')));
    } else {
      throw e;
    }
  }

  // EXACTLY ONE capability root manifest.
  const capParsed = await readManifestObject(ws, joinProjectPath(root, 'capability.json'),
    'capability.json', diagnostics);
  let capability = null;
  if (capParsed) {
    capability = validateCapabilityManifest(capParsed, 'capability.json', diagnostics);
  }

  // One-level component discovery.
  const pluginDirs = await scanComponentDir(ws, root, 'plugins', diagnostics);
  const skillDirs = await scanComponentDir(ws, root, 'skills', diagnostics);
  const mcpDirs = await scanComponentDir(ws, root, 'mcp', diagnostics);
  const componentCount = pluginDirs.size + skillDirs.size + mcpDirs.size;
  if (componentCount > PACKAGE_MAX_COMPONENTS) {
    diagnostics.push(packageDiagnostic('package_too_many_components', root || '.',
      'project declares ' + componentCount + ' components, over the '
      + PACKAGE_MAX_COMPONENTS + '-component limit'));
  }

  // Read each component manifest (sorted by id — provider order must
  // never influence results).
  const plugins = [];
  for (const id of [...pluginDirs.keys()].sort(compareStrings)) {
    const logicalPath = 'plugins/' + id + '/plugin.json';
    const parsed = await readManifestObject(ws, joinProjectPath(root, logicalPath),
      logicalPath, diagnostics);
    if (!parsed) continue;
    const validated = validatePluginManifest(parsed, id, logicalPath, diagnostics);
    if (!validated) continue;
    // Artifact existence + per-artifact bound, checked with stat during
    // validation so an oversized/absent artifact fails BEFORE build
    // materializes any bytes. Exact bytes are read and hashed at BUILD.
    for (const a of validated.artifacts) {
      const artifactProvider = joinProjectPath(root, 'plugins/' + id + '/' + a.sourcePath);
      assertUnderRoot(artifactProvider, root);
      try {
        const st = await ws.stat(artifactProvider);
        if (st.kind !== 'file') {
          diagnostics.push(packageDiagnostic('package_artifact_unreadable', a.logicalPath,
            a.logicalPath + ' is not a regular file'));
        } else if (st.size > PACKAGE_ARTIFACT_MAX_BYTES) {
          diagnostics.push(packageDiagnostic('package_artifact_too_large', a.logicalPath,
            a.logicalPath + ' is ' + st.size + ' bytes, over the '
            + PACKAGE_ARTIFACT_MAX_BYTES + '-byte artifact limit'));
        }
      } catch (e) {
        if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
          diagnostics.push(packageDiagnostic('package_artifact_missing', a.logicalPath,
            'declared plugin artifact is missing: ' + a.logicalPath));
        } else {
          throw e;
        }
      }
    }
    plugins.push(validated);
  }
  const skills = [];
  for (const id of [...skillDirs.keys()].sort(compareStrings)) {
    const logicalPath = 'skills/' + id + '/skill.json';
    const parsed = await readManifestObject(ws, joinProjectPath(root, logicalPath),
      logicalPath, diagnostics);
    if (!parsed) continue;
    const validated = validateSkillManifest(parsed, id, logicalPath, diagnostics);
    if (!validated) continue;
    // Skill default source: UTF-8 text within the existing 256 KiB
    // skill contract. Exact bytes are hashed at BUILD time.
    const sourceProvider = joinProjectPath(root, validated.sourceLogical);
    assertUnderRoot(sourceProvider, root);
    try {
      const st = await ws.stat(sourceProvider);
      if (st.kind !== 'file') {
        diagnostics.push(packageDiagnostic('package_skill_source_missing',
          validated.sourceLogical, validated.sourceLogical + ' is not a regular file'));
      } else if (st.size > PACKAGE_SKILL_MAX_BYTES) {
        diagnostics.push(packageDiagnostic('package_skill_too_large', validated.sourceLogical,
          validated.sourceLogical + ' is ' + st.size + ' bytes, over the '
          + PACKAGE_SKILL_MAX_BYTES + '-byte skill source limit'));
      } else {
        const bytes = await ws.readBytes(sourceProvider);
        if (bytes.byteLength > PACKAGE_SKILL_MAX_BYTES) {
          diagnostics.push(packageDiagnostic('package_skill_too_large', validated.sourceLogical,
            validated.sourceLogical + ' is ' + bytes.byteLength + ' bytes, over the '
            + PACKAGE_SKILL_MAX_BYTES + '-byte skill source limit'));
        } else {
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch (e) {
            diagnostics.push(packageDiagnostic('package_skill_source_invalid',
              validated.sourceLogical,
              validated.sourceLogical + ' must be UTF-8 text (binary skill sources are refused)'));
          }
        }
      }
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
        diagnostics.push(packageDiagnostic('package_skill_source_missing', validated.sourceLogical,
          'declared skill source is missing: ' + validated.sourceLogical));
      } else {
        throw e;
      }
    }
    skills.push(validated);
  }
  const mcps = [];
  for (const id of [...mcpDirs.keys()].sort(compareStrings)) {
    const logicalPath = 'mcp/' + id + '/mcp.json';
    const parsed = await readManifestObject(ws, joinProjectPath(root, logicalPath),
      logicalPath, diagnostics);
    if (!parsed) continue;
    const validated = validateMcpManifest(parsed, id, logicalPath, diagnostics);
    if (validated) mcps.push(validated);
  }

  if (capability) {
    // Graph: every reference resolves to exactly one LOCAL component,
    // and every discovered component is referenced (a package project
    // is exactly one capability, not a warehouse).
    const pluginIds = new Set(plugins.map((p) => p.descriptor.id));
    const skillIds = new Set(skills.map((s) => s.descriptor.id));
    const mcpIds = new Set(mcps.map((m) => m.descriptor.id));
    for (const ref of capability.plugins) {
      if (!pluginIds.has(ref)) {
        diagnostics.push(packageDiagnostic('package_ref_missing', 'capability.json',
          'capability ' + capability.id + ' references missing local plugin: ' + ref));
      }
    }
    for (const ref of capability.skills) {
      if (!skillIds.has(ref)) {
        diagnostics.push(packageDiagnostic('package_ref_missing', 'capability.json',
          'capability ' + capability.id + ' references missing local skill: ' + ref));
      }
    }
    for (const ref of capability.mcps) {
      if (!mcpIds.has(ref)) {
        diagnostics.push(packageDiagnostic('package_ref_missing', 'capability.json',
          'capability ' + capability.id + ' references missing local mcp: ' + ref
          + ' (a package must describe the MCP requirements it names)'));
      }
    }
    for (const p of plugins) {
      if (!capability.plugins.includes(p.descriptor.id)) {
        diagnostics.push(packageDiagnostic('package_component_unreferenced',
          'plugins/' + p.descriptor.id,
          'plugin ' + p.descriptor.id + ' is not referenced by capability '
          + capability.id));
      }
    }
    for (const s of skills) {
      if (!capability.skills.includes(s.descriptor.id)) {
        diagnostics.push(packageDiagnostic('package_component_unreferenced',
          'skills/' + s.descriptor.id,
          'skill ' + s.descriptor.id + ' is not referenced by capability '
          + capability.id));
      }
    }
    for (const m of mcps) {
      if (!capability.mcps.includes(m.descriptor.id)) {
        diagnostics.push(packageDiagnostic('package_component_unreferenced',
          'mcp/' + m.descriptor.id,
          'mcp ' + m.descriptor.id + ' is not referenced by capability '
          + capability.id));
      }
    }
  }

  const sorted = sortDiagnostics(diagnostics);
  if (sorted.length || !capability) {
    return { ok: false, diagnostics: sorted };
  }

  // Normalized project view + deterministic source plan. The plan is
  // the ONLY thing build reads, and every entry was validated above.
  const sourcePlan = [];
  const normalizedPlugins = plugins
    .slice()
    .sort((a, b) => compareStrings(a.descriptor.id, b.descriptor.id))
    .map((p) => ({
      descriptor: p.descriptor,
      artifacts: p.artifacts.map((a) => ({
        sourcePath: a.sourcePath,
        logicalPath: a.logicalPath,
        format: a.format,
      })),
    }));
  for (const p of normalizedPlugins) {
    for (const a of p.artifacts) {
      sourcePlan.push({
        kind: 'artifact',
        pluginId: p.descriptor.id,
        logicalPath: a.logicalPath,
        providerPath: joinProjectPath(root, 'plugins/' + p.descriptor.id + '/' + a.sourcePath),
        format: a.format,
      });
    }
  }
  const normalizedSkills = skills
    .slice()
    .sort((a, b) => compareStrings(a.descriptor.id, b.descriptor.id))
    .map((s) => ({
      descriptor: s.descriptor,
      sourceLogical: s.sourceLogical,
    }));
  for (const s of normalizedSkills) {
    sourcePlan.push({
      kind: 'skill-source',
      skillId: s.descriptor.id,
      logicalPath: s.sourceLogical,
      providerPath: joinProjectPath(root, s.sourceLogical),
    });
  }
  const normalizedMcps = mcps
    .slice()
    .sort((a, b) => compareStrings(a.descriptor.id, b.descriptor.id))
    .map((m) => ({ descriptor: m.descriptor }));
  sourcePlan.sort((a, b) => compareStrings(a.logicalPath, b.logicalPath));
  for (const entry of sourcePlan) assertUnderRoot(entry.providerPath, root);

  if (sourcePlan.length > PACKAGE_MAX_SHIPPED_FILES) {
    return {
      ok: false,
      diagnostics: sortDiagnostics(diagnostics.concat([packageDiagnostic(
        'package_too_many_files', root || '.',
        'project ships ' + sourcePlan.length + ' runtime files, over the '
        + PACKAGE_MAX_SHIPPED_FILES + '-file limit')])),
    };
  }

  return {
    ok: true,
    diagnostics: [],
    normalized: {
      capability: capability,
      plugins: normalizedPlugins,
      skills: normalizedSkills,
      mcps: normalizedMcps,
      sourcePlan: sourcePlan,
    },
  };
}

// ---------- CapabilityBundle ----------
// The immutable logical build output. Bytes live in a private map;
// every external read hands out a COPY. The lock is deeply frozen
// plain metadata: descriptors, sizes, hashes — never skill bodies,
// never artifact bytes, never credentials, never timestamps.
class CapabilityBundle {
  constructor(lock, files) {
    if (!isPlainObject(lock)) {
      throw new Error('CapabilityBundle requires a lock object');
    }
    if (!(files instanceof Map)) {
      throw new Error('CapabilityBundle requires a Map of logicalPath -> Uint8Array');
    }
    for (const [path, bytes] of files) {
      if (typeof path !== 'string' || !path.length) {
        throw new Error('CapabilityBundle: invalid logical path');
      }
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('CapabilityBundle: file ' + path + ' must be Uint8Array');
      }
    }
    this._lock = deepFreeze(JSON.parse(JSON.stringify(lock))); // own plain copy
    this._files = new Map();
    for (const [path, bytes] of files) this._files.set(path, new Uint8Array(bytes));
    this._listCache = null;
  }

  // Deeply frozen lock metadata (no bytes).
  get lock() { return this._lock; }

  // Copy-out read: mutating the result can never alias bundle bytes.
  readBytes(path) {
    if (typeof path !== 'string' || !path.length || path.includes('\\')
      || path.startsWith('/') || /[\x00-\x1F\x7F]/.test(path)) {
      throw new Error('CapabilityBundle.readBytes: invalid logical path: ' + String(path));
    }
    const segs = path.split('/');
    for (const s of segs) {
      if (!s.length || s === '.' || s === '..') {
        throw new Error('CapabilityBundle.readBytes: invalid logical path: ' + path);
      }
    }
    const bytes = this._files.get(path);
    if (!bytes) {
      const e = new Error('no such bundle file: ' + path);
      e.name = 'NotFoundError';
      throw e;
    }
    return bytes.slice();
  }

  // Deterministic sorted logical paths.
  listFiles() {
    if (!this._listCache) {
      this._listCache = Object.freeze([...this._files.keys()].sort(compareStrings));
    }
    return this._listCache;
  }

  // Canonical deterministic serialization (sorted keys, stable
  // arrays, LF, UTF-8, no timestamps). Byte-identical projects with
  // different provider list() orders serialize identically.
  serializeLock() {
    return canonicalJson(this._lock) + '\n';
  }
}

// ---------- build ----------
// buildProject({ workspace, root }) -> { ok, diagnostics, bundle? }
//
// ALWAYS revalidates the project itself (never trusts a prior
// validate result), then materializes the logical bundle: exact
// bytes, exact sizes, exact SHA-256 over the exact bytes. Builder-
// computed identity only — source manifests cannot supply hashes.
async function buildProject(opts) {
  const o = opts || {};
  assertWorkspace(o.workspace);
  const root = normalizeProjectRoot(o.root);

  const validation = await validateProject({ workspace: o.workspace, root: root });
  if (!validation.ok) {
    return { ok: false, diagnostics: validation.diagnostics };
  }
  const normalized = validation.normalized;
  const diagnostics = [];

  const files = new Map();          // logicalPath -> exact bytes
  const integrity = new Map();      // logicalPath -> { size, sha256 } (builder-computed)
  const artifactEntries = new Map(); // pluginId -> [{path, format, size, sha256}]
  const skillEntries = new Map();    // skillId -> {sourcePath, size, sha256}
  let totalBytes = 0;
  let totalOverflow = false;

  for (const entry of normalized.sourcePlan) {
    assertUnderRoot(entry.providerPath, root);
    const cap = entry.kind === 'artifact' ? PACKAGE_ARTIFACT_MAX_BYTES : PACKAGE_SKILL_MAX_BYTES;
    // Enforce the size bound BEFORE the full read where the provider
    // exposes stat, so an oversized artifact never materializes.
    try {
      const st = await o.workspace.stat(entry.providerPath);
      if (st.kind !== 'file') {
        diagnostics.push(packageDiagnostic(
          entry.kind === 'artifact' ? 'package_artifact_unreadable' : 'package_skill_source_missing',
          entry.logicalPath, entry.logicalPath + ' is not a regular file'));
        continue;
      }
      if (st.size > cap) {
        diagnostics.push(packageDiagnostic(
          entry.kind === 'artifact' ? 'package_artifact_too_large' : 'package_skill_too_large',
          entry.logicalPath, entry.logicalPath + ' is ' + st.size + ' bytes, over the '
          + cap + '-byte limit'));
        continue;
      }
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
        diagnostics.push(packageDiagnostic(
          entry.kind === 'artifact' ? 'package_artifact_missing' : 'package_skill_source_missing',
          entry.logicalPath, 'shipped file disappeared during build: ' + entry.logicalPath));
        continue;
      }
      throw e;
    }
    let bytes;
    try {
      bytes = await o.workspace.readBytes(entry.providerPath);
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) {
        diagnostics.push(packageDiagnostic(
          entry.kind === 'artifact' ? 'package_artifact_missing' : 'package_skill_source_missing',
          entry.logicalPath, 'shipped file disappeared during build: ' + entry.logicalPath));
        continue;
      }
      throw e;
    }
    if (bytes.byteLength > cap) {
      diagnostics.push(packageDiagnostic(
        entry.kind === 'artifact' ? 'package_artifact_too_large' : 'package_skill_too_large',
        entry.logicalPath, entry.logicalPath + ' is ' + bytes.byteLength + ' bytes, over the '
        + cap + '-byte limit'));
      continue;
    }
    if (entry.kind === 'skill-source') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        diagnostics.push(packageDiagnostic('package_skill_source_invalid', entry.logicalPath,
          entry.logicalPath + ' must be UTF-8 text'));
        continue;
      }
    }
    if (totalBytes + bytes.byteLength > PACKAGE_TOTAL_MAX_BYTES) {
      if (!totalOverflow) {
        diagnostics.push(packageDiagnostic('package_total_too_large', root || '.',
          'shipped runtime bytes exceed the ' + PACKAGE_TOTAL_MAX_BYTES + '-byte package total'));
        totalOverflow = true;
      }
      continue; // stop materializing further weight, keep scanning cheaply
    }
    totalBytes += bytes.byteLength;
    const hash = await sha256Hex(bytes);
    files.set(entry.logicalPath, bytes);
    integrity.set(entry.logicalPath, { size: bytes.byteLength, sha256: hash });
    if (entry.kind === 'artifact') {
      if (!artifactEntries.has(entry.pluginId)) artifactEntries.set(entry.pluginId, []);
      artifactEntries.get(entry.pluginId).push({
        path: entry.logicalPath,
        format: entry.format,
        size: bytes.byteLength,
        sha256: hash,
      });
    } else {
      skillEntries.set(entry.skillId, {
        sourcePath: entry.logicalPath,
        size: bytes.byteLength,
        sha256: hash,
      });
    }
  }

  if (diagnostics.length) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }
  if (files.size !== normalized.sourcePlan.length) {
    // A plan entry produced neither bytes nor a diagnostic — an
    // internal invariant, not an author fault.
    throw new Error('capability package: build did not materialize every planned file');
  }

  const lock = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    capability: normalized.capability,
    plugins: normalized.plugins.map((p) => ({
      descriptor: p.descriptor,
      artifacts: artifactEntries.get(p.descriptor.id) || [],
    })),
    skills: normalized.skills.map((s) => ({
      descriptor: s.descriptor,
      sourcePath: skillEntries.get(s.descriptor.id).sourcePath,
      size: skillEntries.get(s.descriptor.id).size,
      sha256: skillEntries.get(s.descriptor.id).sha256,
    })),
    mcps: normalized.mcps.map((m) => m.descriptor),
    files: [...integrity.keys()].sort(compareStrings).map((path) => ({
      path: path,
      size: integrity.get(path).size,
      sha256: integrity.get(path).sha256,
    })),
  };

  return {
    ok: true,
    diagnostics: [],
    bundle: new CapabilityBundle(lock, files),
  };
}

// ---------- inspect ----------
// inspectBundle(bundle) -> SAFE plain summary. No raw bytes, no
// skill Markdown bodies, no source files. Zero side effects.
function inspectBundle(bundle) {
  if (!(bundle instanceof CapabilityBundle)) {
    throw new Error('inspectBundle requires a CapabilityBundle');
  }
  const lock = bundle.lock;
  let totalBytes = 0;
  for (const f of lock.files) totalBytes += f.size;
  return {
    capability: {
      id: lock.capability.id,
      version: lock.capability.version,
      displayName: lock.capability.displayName,
      description: lock.capability.description,
    },
    plugins: lock.plugins.map((p) => ({
      id: p.descriptor.id,
      version: p.descriptor.version,
      runtime: p.descriptor.runtime,
      pythonImports: (p.descriptor.provides && Array.isArray(p.descriptor.provides.pythonImports))
        ? p.descriptor.provides.pythonImports.slice()
        : [],
      artifacts: p.artifacts.map((a) => ({
        path: a.path, format: a.format, size: a.size, sha256: a.sha256,
      })),
    })),
    skills: lock.skills.map((s) => ({
      id: s.descriptor.id,
      version: s.descriptor.version,
      sourcePath: s.sourcePath,
      size: s.size,
      sha256: s.sha256,
    })),
    mcps: lock.mcps.map((m) => ({
      id: m.id, displayName: m.displayName, description: m.description,
    })),
    totalBytes: totalBytes,
    valid: true,
  };
}

// ---------- namespace ----------
// Exactly ONE global: everything else stays module-private.
const LocusCapabilityPackage = Object.freeze({
  validateProject: validateProject,
  buildProject: buildProject,
  inspectBundle: inspectBundle,
  CapabilityBundle: Object.freeze(CapabilityBundle),
  PACKAGE_CONSTANTS: Object.freeze({
    SCHEMA_VERSION: PACKAGE_SCHEMA_VERSION,
    MANIFEST_MAX_BYTES: PACKAGE_MANIFEST_MAX_BYTES,
    SKILL_MAX_BYTES: PACKAGE_SKILL_MAX_BYTES,
    ARTIFACT_MAX_BYTES: PACKAGE_ARTIFACT_MAX_BYTES,
    TOTAL_MAX_BYTES: PACKAGE_TOTAL_MAX_BYTES,
    MAX_COMPONENTS: PACKAGE_MAX_COMPONENTS,
    MAX_SHIPPED_FILES: PACKAGE_MAX_SHIPPED_FILES,
    PLUGIN_RUNTIME: PACKAGE_PLUGIN_RUNTIME,
    ARTIFACT_FORMAT: PACKAGE_ARTIFACT_FORMAT,
    SKILL_SOURCE_NAME: PACKAGE_SKILL_SOURCE_NAME,
  }),
});
globalThis.LocusCapabilityPackage = LocusCapabilityPackage;
