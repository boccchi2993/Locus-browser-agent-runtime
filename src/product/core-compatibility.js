// ============================================================
//  PRODUCT CORE COMPATIBILITY CHECK (M2c, repository split)
//
//  The Product owns the compatibility DECISION between the two cores'
//  PUBLIC capability declarations and ITS OWN explicit requirements
//  (contract docs/REPOSITORY-SPLIT-CONTRACTS.md §5; REPOSITORY-SPLIT §4:
//  "Unknown or incompatible mandatory semantics fail before starting a
//  task, with an actionable compatibility error").
//
//  Pure module: NO Vue, NO DOM, NO storage open, NO worker start, and NO
//  import from either core — the declarations ARRIVE as plain objects
//  (RuntimeHost.capabilities() / the harness entry's harnessCapabilities())
//  and this module never resolves, imports or probes a core itself. The
//  cores cannot depend back on this module.
//
//  Semantics (M2c contract):
//    1. supported versions + all required capabilities      → pass
//    2. unsupported mandatory protocol/registry version     → reject
//    3. missing required capability                         → reject
//    4. invalid declaration shape                           → reject
//    5. unknown EXTRA optional capabilities                 → never a rejection
//    6. missing OPTIONAL capability                         → listed for the
//       Product's explicit rules; never a silent downgrade of approval,
//       cancellation, persistence or execution-boundary guarantees
//    7. no historical-version adaptation framework: only the ACTUAL
//       protocol is supported; unknown mandatory versions are rejected.
//
//  An absent or malformed required field is REPORTED (with required vs
//  provided) — `undefined` never defaults to compatible.
// ============================================================

// ---------- the structured error ----------
// Frozen own fields: code, core, port?, capability?, required, provided,
// message. `compatibility: true` marks the family so a consumer can
// branch without string-matching messages.
export class CompatibilityError extends Error {
  constructor(fields) {
    const f = fields || {};
    super(f.message || 'core compatibility check failed');
    this.name = 'CompatibilityError';
    this.compatibility = true;
    this.code = f.code || 'declaration_invalid';
    this.core = f.core || null;               // 'runtime' | 'harness'
    this.port = f.port !== undefined ? f.port : null;
    this.capability = f.capability !== undefined ? f.capability : null;
    this.required = f.required !== undefined ? f.required : null;
    this.provided = f.provided !== undefined ? f.provided : undefined;
    this.detail = renderDetails(this);
    this.message = (f.message || 'core compatibility check failed')
      + (this.detail ? ' [' + this.detail + ']' : '');
  }
}

// The structured fields rendered compactly for event/UI surfaces — the
// runner's blocked outcome carries code+message strings only, so the
// structured truth rides IN the message rather than being lost.
function renderDetails(e) {
  const parts = [];
  if (e.core) parts.push('core=' + e.core);
  if (e.port) parts.push('port=' + e.port);
  if (e.capability) parts.push('capability=' + e.capability);
  if (e.required !== null && e.required !== undefined) parts.push('required=' + safeJson(e.required));
  if (e.provided !== undefined) parts.push('provided=' + safeJson(e.provided));
  return parts.join(' ');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

// ---------- the explicit Product requirement table ----------
// The ONLY place the Product's supported versions and capability needs
// live. Optional entries carry their explicit degradation RULE — a missing
// optional capability is applied through its rule, never silently.
export const PRODUCT_CORE_REQUIREMENTS = Object.freeze({
  runtime: Object.freeze({
    supportedContractVersions: Object.freeze([1]),
    requiredCapabilities: Object.freeze({
      executionKindsMustInclude: Object.freeze(['shell']),
      policyMechanismsMustInclude: Object.freeze(['mutationPolicy', 'authorization']),
      bootstrapShaPinned: true,
      commandsNonEmpty: true,
    }),
    optionalCapabilities: Object.freeze([
      Object.freeze({
        capability: 'executionKinds.python',
        rule: 'the product tools call execution kind "shell" only; the direct python kind is unused by the product chain',
      }),
    ]),
  }),
  harness: Object.freeze({
    supportedContractVersions: Object.freeze([1]),
    // The DECLARED core registry's internal version — a different concept
    // from the public protocol version above (contract §5).
    supportedRegistryVersions: Object.freeze([1]),
    requiredPorts: Object.freeze({
      taskLifecycle: 1,
      toolPort: 1,
      modelClient: 1,
      approval: 1,
      persistencePort: 1,
    }),
    requiredCapabilities: Object.freeze(['taskEventIdentity', 'providerReplay']),
    optionalCapabilities: Object.freeze([
      Object.freeze({
        capability: 'nativeToolCalls',
        rule: 'the strict text-fallback protocol remains functional without native tool calls (the product chain completes fenced-JSON tool round trips)',
      }),
      Object.freeze({
        capability: 'imageInputGate',
        rule: 'image attachments degrade to text-only with an explicit warning: no attachment read, no ingest, no capability probe, no image send; the user\'s uploaded files are kept; approval/persistence/execution guarantees unchanged',
      }),
      Object.freeze({
        capability: 'capabilityComposition',
        rule: 'capability features are disabled for the task (no refresh, no task environment, no plugin payload, no skill mounts; the runtime returns to core-only); a task with user-enabled capabilities is refused explicitly before any side effect',
      }),
    ]),
  }),
});

// ---------- shape guards ----------
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fail(fields) {
  throw new CompatibilityError(fields);
}

// A supported-version check shared by both version concepts.
function checkVersionSet(core, kind, provided, supported, label) {
  if (provided === undefined || provided === null) {
    fail({
      code: 'declaration_invalid', core, port: kind,
      required: label, provided: provided === undefined ? '(absent)' : null,
      message: core + ' declaration is missing ' + label,
    });
  }
  if (typeof provided !== 'number' || !isFinite(provided) || Math.floor(provided) !== provided) {
    fail({
      code: 'declaration_invalid', core, port: kind,
      required: 'an integer version', provided,
      message: core + ' declaration has a malformed ' + label,
    });
  }
  if (!Array.isArray(supported) || !supported.length || !supported.includes(provided)) {
    fail({
      code: kind === 'contractVersion' ? 'contract_version_unsupported' : 'registry_version_unsupported',
      core, port: kind,
      required: 'one of ' + safeJson(supported),
      provided,
      message: core + ' ' + label + ' ' + provided + ' is not supported (supported: '
        + safeJson(supported) + ')',
    });
  }
}

// required === true → the capability must be exactly true (a declaration
// that says false, or is absent, cannot be defaulted to compatible).
function requireTrueCapability(core, path, provided) {
  if (provided === undefined) {
    fail({
      code: 'capability_missing', core, capability: path,
      required: true, provided: '(absent)',
      message: core + ' declaration is missing required capability ' + path,
    });
  }
  if (provided !== true) {
    fail({
      code: provided === false ? 'capability_value_mismatch' : 'declaration_invalid',
      core, capability: path,
      required: true, provided,
      message: core + ' capability ' + path + ' must be true'
        + (provided === false ? '' : ' (malformed value)'),
    });
  }
}

function requireArrayIncludes(core, path, provided, mustInclude) {
  if (provided === undefined) {
    fail({
      code: 'capability_missing', core, capability: path,
      required: mustInclude, provided: '(absent)',
      message: core + ' declaration is missing ' + path,
    });
  }
  if (!Array.isArray(provided)) {
    fail({
      code: 'declaration_invalid', core, capability: path,
      required: 'an array', provided,
      message: core + ' declaration field ' + path + ' must be an array',
    });
  }
  for (const want of mustInclude) {
    if (!provided.includes(want)) {
      fail({
        code: 'capability_missing', core, capability: path + '.' + want,
        required: want, provided: provided.slice(),
        message: core + ' ' + path + ' does not include the required "' + want + '"',
      });
    }
  }
}

// ---------- the check ----------
// checkCoreCompatibility({ runtime, harness, requirements }) → frozen
// result, or THROWS CompatibilityError. `runtime`/`harness` are the cores'
// public declarations as plain objects (a frozen declaration is fine —
// nothing here mutates the input).
export function checkCoreCompatibility(input) {
  const o = input || {};
  const req = o.requirements || PRODUCT_CORE_REQUIREMENTS;
  checkRuntime(o.runtime, req.runtime);
  checkHarness(o.harness, req.harness);

  // Pass. The result is FROZEN and reports which OPTIONAL capabilities are
  // missing so the Product can apply its explicit rules — unknown extras
  // are ignored by construction (only the requirement table is consulted).
  const result = {
    compatible: true,
    runtime: { contractVersion: o.runtime.contractVersion },
    harness: { contractVersion: o.harness.contractVersion },
    optional: { runtime: { missing: [] }, harness: { missing: [] } },
  };
  if (typeof o.runtime.registryVersion === 'number') {
    result.runtime.registryVersion = o.runtime.registryVersion;
  }
  if (typeof o.harness.registryVersion === 'number') {
    result.harness.registryVersion = o.harness.registryVersion;
  }
  collectOptionalMissing('runtime', o.runtime, req.runtime, result.optional.runtime.missing);
  collectOptionalMissing('harness', o.harness, req.harness, result.optional.harness.missing);
  return deepFreeze(result);
}

function collectOptionalMissing(core, declaration, req, into) {
  const optional = req && Array.isArray(req.optionalCapabilities) ? req.optionalCapabilities : [];
  // Runtime optional paths ('executionKinds.python') resolve against the
  // declaration ROOT; harness optional names ('imageInputGate') are
  // semantic capabilities and resolve against declaration.capabilities.
  const base = core === 'harness' && isPlainObject(declaration.capabilities)
    ? declaration.capabilities : declaration;
  for (const opt of optional) {
    if (!readCapabilityPath(base, opt.capability)) into.push(opt.capability);
  }
}

// 'executionKinds.python' → declaration.executionKinds includes 'python';
// a plain path reads object fields; array paths test membership.
function readCapabilityPath(declaration, path) {
  const segs = String(path).split('.');
  let node = declaration;
  for (let i = 0; i < segs.length; i++) {
    if (!isPlainObject(node) && !Array.isArray(node)) return false;
    const seg = segs[i];
    if (Array.isArray(node)) {
      if (!node.includes(seg)) return false;
      node = seg; // leaf
    } else {
      node = node[seg];
    }
  }
  if (node === undefined || node === null || node === false) return false;
  if (Array.isArray(node)) return node.length > 0;
  return true;
}

function checkRuntime(decl, req) {
  if (!isPlainObject(decl)) {
    fail({
      code: decl === undefined || decl === null ? 'declaration_missing' : 'declaration_invalid',
      core: 'runtime',
      required: 'a RuntimeHost.capabilities() declaration object',
      provided: decl === undefined ? '(absent)' : decl === null ? null : typeof decl,
      message: 'runtime capability declaration is '
        + (decl === undefined || decl === null ? 'missing' : 'not an object')
        + ' — a runtime without a declaration is never assumed compatible',
    });
  }
  checkVersionSet('runtime', 'contractVersion', decl.contractVersion, req.supportedContractVersions, 'contractVersion');
  const r = req.requiredCapabilities || {};
  if (r.executionKindsMustInclude) {
    requireArrayIncludes('runtime', 'executionKinds', decl.executionKinds, r.executionKindsMustInclude);
  }
  if (r.policyMechanismsMustInclude) {
    requireArrayIncludes('runtime', 'policyMechanisms', decl.policyMechanisms, r.policyMechanismsMustInclude);
  }
  if (r.bootstrapShaPinned === true) {
    const bootstrap = decl.bootstrap;
    if (bootstrap === undefined) {
      fail({
        code: 'capability_missing', core: 'runtime', capability: 'bootstrap.shaPinned',
        required: true, provided: '(absent)',
        message: 'runtime declaration is missing bootstrap.shaPinned',
      });
    }
    if (!isPlainObject(bootstrap) || bootstrap.shaPinned !== true) {
      fail({
        code: 'capability_value_mismatch', core: 'runtime', capability: 'bootstrap.shaPinned',
        required: true,
        provided: isPlainObject(bootstrap) ? bootstrap.shaPinned : bootstrap,
        message: 'runtime bootstrap assets must be SHA-pinned (bootstrap.shaPinned !== true)',
      });
    }
  }
  if (r.commandsNonEmpty === true) {
    if (decl.commands === undefined) {
      fail({
        code: 'capability_missing', core: 'runtime', capability: 'commands',
        required: 'a non-empty command list', provided: '(absent)',
        message: 'runtime declaration is missing commands (the actual shell command registry)',
      });
    }
    if (!Array.isArray(decl.commands) || !decl.commands.length
        || !decl.commands.every((c) => typeof c === 'string' && c)) {
      fail({
        code: 'declaration_invalid', core: 'runtime', capability: 'commands',
        required: 'a non-empty array of command names',
        provided: decl.commands,
        message: 'runtime commands declaration must be a non-empty array of command names',
      });
    }
  }
}

function checkHarness(decl, req) {
  if (!isPlainObject(decl)) {
    fail({
      code: decl === undefined || decl === null ? 'declaration_missing' : 'declaration_invalid',
      core: 'harness',
      required: 'a harnessCapabilities() declaration object',
      provided: decl === undefined ? '(absent)' : decl === null ? null : typeof decl,
      message: 'harness capability declaration is '
        + (decl === undefined || decl === null ? 'missing' : 'not an object')
        + ' — a harness without a declaration is never assumed compatible',
    });
  }
  checkVersionSet('harness', 'contractVersion', decl.contractVersion, req.supportedContractVersions, 'contractVersion');
  if (req.supportedRegistryVersions) {
    if (decl.registryVersion === undefined) {
      fail({
        code: 'capability_missing', core: 'harness', port: 'registryVersion',
        required: 'one of ' + safeJson(req.supportedRegistryVersions), provided: '(absent)',
        message: 'harness declaration does not state its registry version',
      });
    }
    checkVersionSet('harness', 'registryVersion', decl.registryVersion, req.supportedRegistryVersions, 'registryVersion');
  }
  const ports = decl.ports;
  if (!isPlainObject(ports)) {
    fail({
      code: ports === undefined ? 'capability_missing' : 'declaration_invalid',
      core: 'harness', port: 'ports',
      required: 'a ports declaration object',
      provided: ports === undefined ? '(absent)' : ports,
      message: 'harness declaration is missing its ports section',
    });
  }
  for (const name of Object.keys(req.requiredPorts || {})) {
    const want = req.requiredPorts[name];
    const port = ports[name];
    if (port === undefined) {
      fail({
        code: 'capability_missing', core: 'harness', port: name,
        required: 'version ' + want, provided: '(absent)',
        message: 'harness does not declare the required port "' + name + '"',
      });
    }
    if (!isPlainObject(port)) {
      fail({
        code: 'declaration_invalid', core: 'harness', port: name,
        required: 'a port declaration object', provided: port,
        message: 'harness port "' + name + '" declaration is malformed',
      });
    }
    if (port.version === undefined) {
      fail({
        code: 'capability_missing', core: 'harness', port: name,
        required: 'version ' + want, provided: '(absent)',
        message: 'harness port "' + name + '" does not declare a version',
      });
    }
    if (port.version !== want) {
      fail({
        code: 'port_version_unsupported', core: 'harness', port: name,
        required: 'version ' + want, provided: port.version,
        message: 'harness port "' + name + '" version ' + port.version
          + ' is not supported (supported: ' + want + ')',
      });
    }
  }
  for (const cap of req.requiredCapabilities || []) {
    requireTrueCapability('harness', cap, decl.capabilities ? decl.capabilities[cap] : undefined);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}
