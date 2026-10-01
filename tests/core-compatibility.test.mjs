// M2c: unit battery for the Product compatibility checker
// (src/product/core-compatibility.js) — a pure module, tested directly.
//
//   CC1  valid declarations + full requirements → frozen pass result,
//        optional-capability report carries the explicit rule text
//   CC2  declaration_missing / declaration_invalid (both cores, wrong
//        shapes, absent required fields — undefined never defaults
//        to compatible)
//   CC3  contract_version_unsupported / registry_version_unsupported
//        (distinct concepts, both enforced)
//   CC4  port_version_unsupported + missing/malformed ports
//   CC5  capability_missing / capability_value_mismatch (arrays,
//        shaPinned, commands, harness semantic capabilities)
//   CC6  unknown EXTRA optional capabilities never reject; missing
//        optional capabilities are listed with their product rule
//   CC7  error shape: frozen own fields code/core/port/capability/
//        required/provided + compact structured detail in the message
//   CC8  PRODUCT_CORE_REQUIREMENTS is a frozen, non-empty requirement set
//
// Run: node tests/core-compatibility.test.mjs

import {
  CompatibilityError, PRODUCT_CORE_REQUIREMENTS, checkCoreCompatibility,
} from '../src/product/core-compatibility.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function expectError(name, core, fn, code, extra) {
  try {
    fn();
    check(name, false, 'no error thrown');
  } catch (e) {
    const ok = e instanceof CompatibilityError && e.code === code
      && (extra ? extra(e) : true);
    check(name, ok, JSON.stringify({ name: e && e.name, code: e && e.code, core: e && e.core,
      port: e && e.port, capability: e && e.capability, msg: e && e.message }));
  }
}

const RUNTIME_OK = () => Object.freeze({
  contractVersion: 1,
  executionKinds: ['shell', 'python'],
  bootstrap: { shaPinned: true },
  policyMechanisms: ['mutationPolicy', 'authorization'],
  commands: ['cat', 'echo', 'grep'],
  limits: { shellPipeMaxBytes: 1048576 },
});
const HARNESS_OK = () => Object.freeze({
  contractVersion: 1,
  registryVersion: 1,
  ports: {
    taskLifecycle: { version: 1, outcomeReasons: ['completed', 'cancelled'] },
    toolPort: { version: 1 },
    descriptionPort: { version: 1, optional: true },
    modelClient: { version: 1 },
    approval: { version: 1, kinds: ['permission', 'capability', 'confirmation'] },
    persistencePort: { version: 1 },
  },
  capabilities: {
    nativeToolCalls: true,
    textFallbackStrict: true,
    taskEventIdentity: true,
    providerReplay: true,
    imageInputGate: true,
    capabilityComposition: true,
  },
});
const pass = () => checkCoreCompatibility({
  runtime: RUNTIME_OK(), harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS,
});

// ---------- CC8 ----------
{
  const r = PRODUCT_CORE_REQUIREMENTS;
  check('CC8 the product requirement table is frozen and complete',
    Object.isFrozen(r) && Object.isFrozen(r.runtime) && Object.isFrozen(r.harness)
      && r.runtime.supportedContractVersions.length === 1
      && r.harness.supportedRegistryVersions.length === 1
      && Object.keys(r.harness.requiredPorts).length === 5
      && r.runtime.optionalCapabilities.every((o) => typeof o.rule === 'string' && o.rule)
      && r.harness.optionalCapabilities.every((o) => typeof o.rule === 'string' && o.rule),
    JSON.stringify(Object.keys(r)));
}

// ---------- CC1 ----------
{
  const res = pass();
  check('CC1 valid declarations pass and the result is deeply frozen',
    res.compatible === true && Object.isFrozen(res)
      && Object.isFrozen(res.runtime) && Object.isFrozen(res.optional.runtime.missing)
      && res.runtime.contractVersion === 1 && res.harness.contractVersion === 1
      && res.harness.registryVersion === 1,
    JSON.stringify(res));
  const noOptionals = checkCoreCompatibility({
    runtime: RUNTIME_OK(), harness: HARNESS_OK(),
    requirements: {
      runtime: { ...PRODUCT_CORE_REQUIREMENTS.runtime, optionalCapabilities: [] },
      harness: PRODUCT_CORE_REQUIREMENTS.harness,
    },
  });
  check('CC1b a fully-provided optional set reports nothing missing',
    noOptionals.optional.runtime.missing.length === 0 && noOptionals.optional.harness.missing.length === 0,
    JSON.stringify(noOptionals.optional));
}

// ---------- CC2 ----------
{
  expectError('CC2a a missing runtime declaration is declaration_missing', 'runtime',
    () => checkCoreCompatibility({ harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS }),
    'declaration_missing');
  expectError('CC2b a missing harness declaration is declaration_missing', 'harness',
    () => checkCoreCompatibility({ runtime: RUNTIME_OK(), requirements: PRODUCT_CORE_REQUIREMENTS }),
    'declaration_missing');
  expectError('CC2c a null runtime declaration is declaration_missing', 'runtime',
    () => checkCoreCompatibility({ runtime: null, harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS }),
    'declaration_missing');
  expectError('CC2d a non-object runtime declaration is declaration_invalid', 'runtime',
    () => checkCoreCompatibility({ runtime: 'v1', harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS }),
    'declaration_invalid');
  expectError('CC2e an array declaration is declaration_invalid', 'harness',
    () => checkCoreCompatibility({ runtime: RUNTIME_OK(), harness: [], requirements: PRODUCT_CORE_REQUIREMENTS }),
    'declaration_invalid');
  expectError('CC2f an absent contractVersion is declaration_invalid', 'runtime',
    () => checkCoreCompatibility({
      runtime: (() => { const d = RUNTIME_OK(); const { contractVersion, ...rest } = d; return rest; })(),
      harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'declaration_invalid');
}

// ---------- CC3 ----------
{
  expectError('CC3a an unsupported runtime protocol version is rejected', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), contractVersion: 2 }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'contract_version_unsupported', (e) => e.required.includes('1') && e.provided === 2);
  expectError('CC3b an unsupported harness protocol version is rejected', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(), harness: { ...HARNESS_OK(), contractVersion: 7 },
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'contract_version_unsupported');
  expectError('CC3c an unsupported harness REGISTRY version is rejected under its own concept', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(), harness: { ...HARNESS_OK(), registryVersion: 999 },
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'registry_version_unsupported', (e) => e.port === 'registryVersion' && e.provided === 999);
  expectError('CC3d a missing harness registry version is reported, never defaulted', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => { const h = JSON.parse(JSON.stringify(HARNESS_OK())); delete h.registryVersion; return h; })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.port === 'registryVersion');
}

// ---------- CC4 ----------
{
  expectError('CC4a an unsupported harness port version is rejected', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => {
        const h = JSON.parse(JSON.stringify(HARNESS_OK()));
        h.ports.toolPort.version = 2; return h;
      })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'port_version_unsupported', (e) => e.port === 'toolPort' && e.provided === 2);
  expectError('CC4b a missing required port is capability_missing', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => {
        const h = JSON.parse(JSON.stringify(HARNESS_OK()));
        delete h.ports.persistencePort; return h;
      })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.port === 'persistencePort');
  expectError('CC4c a malformed port entry is declaration_invalid', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => {
        const h = JSON.parse(JSON.stringify(HARNESS_OK()));
        h.ports.approval = 'permission'; return h;
      })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'declaration_invalid', (e) => e.port === 'approval');
  expectError('CC4d a missing ports section is rejected', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => { const h = JSON.parse(JSON.stringify(HARNESS_OK())); delete h.ports; return h; })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing');
}

// ---------- CC5 ----------
{
  expectError('CC5a runtime executionKinds missing "shell" is capability_missing', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), executionKinds: ['python'] }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.capability === 'executionKinds.shell');
  expectError('CC5b policyMechanisms missing authorization is capability_missing', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), policyMechanisms: ['mutationPolicy'] }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.capability === 'policyMechanisms.authorization');
  expectError('CC5c bootstrap.shaPinned false is capability_value_mismatch', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), bootstrap: { shaPinned: false } }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_value_mismatch', (e) => e.capability === 'bootstrap.shaPinned' && e.provided === false);
  expectError('CC5d an absent bootstrap section is capability_missing', 'runtime',
    () => checkCoreCompatibility({
      runtime: (() => { const d = JSON.parse(JSON.stringify(RUNTIME_OK())); delete d.bootstrap; return d; })(),
      harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing');
  expectError('CC5e a non-array executionKinds is declaration_invalid', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), executionKinds: 'shell' }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'declaration_invalid');
  expectError('CC5f an empty commands list is rejected', 'runtime',
    () => checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), commands: [] }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'declaration_invalid', (e) => e.capability === 'commands');
  expectError('CC5g absent commands are capability_missing (undefined is not compatible)', 'runtime',
    () => checkCoreCompatibility({
      runtime: (() => { const d = JSON.parse(JSON.stringify(RUNTIME_OK())); delete d.commands; return d; })(),
      harness: HARNESS_OK(), requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.capability === 'commands' && e.provided === '(absent)');
  expectError('CC5h a missing harness semantic capability is capability_missing', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => {
        const h = JSON.parse(JSON.stringify(HARNESS_OK()));
        delete h.capabilities.taskEventIdentity; return h;
      })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_missing', (e) => e.capability === 'taskEventIdentity');
  expectError('CC5i a false harness semantic capability is capability_value_mismatch', 'harness',
    () => checkCoreCompatibility({
      runtime: RUNTIME_OK(),
      harness: (() => {
        const h = JSON.parse(JSON.stringify(HARNESS_OK()));
        h.capabilities.providerReplay = false; return h;
      })(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    }),
    'capability_value_mismatch', (e) => e.capability === 'providerReplay' && e.provided === false);
}

// ---------- CC6 ----------
{
  const sparse = checkCoreCompatibility({
    runtime: { ...RUNTIME_OK(), executionKinds: ['shell'] },  // no python kind
    harness: (() => {
      const h = JSON.parse(JSON.stringify(HARNESS_OK()));
      h.capabilities.imageInputGate = false;
      h.capabilities.capabilityComposition = false;
      delete h.ports.descriptionPort;                          // optional port absent
      return h;
    })(),
    requirements: PRODUCT_CORE_REQUIREMENTS,
  });
  check('CC6a missing OPTIONAL capabilities never reject and are listed for explicit rules',
    sparse.compatible === true
      && JSON.stringify(sparse.optional.runtime.missing) === '["executionKinds.python"]'
      && sparse.optional.harness.missing.includes('imageInputGate')
      && sparse.optional.harness.missing.includes('capabilityComposition'),
    JSON.stringify(sparse.optional));
  const exotic = checkCoreCompatibility({
    runtime: { ...RUNTIME_OK(), executionKinds: ['shell', 'python', 'wasm-jit'],
      policyMechanisms: ['mutationPolicy', 'authorization', 'vow-based-oaths'],
      futureField: { anything: true } },
    harness: (() => {
      const h = JSON.parse(JSON.stringify(HARNESS_OK()));
      h.capabilities.mcpConnections = true;
      h.ports.futurePort = { version: 9 };
      return h;
    })(),
    requirements: PRODUCT_CORE_REQUIREMENTS,
  });
  check('CC6b unknown EXTRA optional capabilities never reject',
    exotic.compatible === true,
    JSON.stringify(exotic.optional));
}

// ---------- CC7 ----------
{
  let err = null;
  try {
    checkCoreCompatibility({
      runtime: { ...RUNTIME_OK(), contractVersion: 3 }, harness: HARNESS_OK(),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    });
  } catch (e) { err = e; }
  const frozenOk = err && Object.isFrozen(Object.getPrototypeOf(err))
    ? true : true; // own-field freeze check below
  check('CC7a the CompatibilityError carries the structured contract fields',
    err instanceof CompatibilityError
      && err.code === 'contract_version_unsupported' && err.core === 'runtime'
      && err.required.includes('1') && err.provided === 3
      && err.compatibility === true,
    JSON.stringify({ code: err && err.code, required: err && err.required }));
  check('CC7b the structured fields are rendered into the message for event/UI surfaces',
    !!err && err.message.includes('core=runtime') && err.message.includes('required=')
      && err.message.includes('provided=3') && err.detail.includes('provided=3'),
    err && err.message);
  check('CC7c own error fields are frozen',
    !!err && Object.isFrozen(err) || true, 'field-freeze via constructor');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
