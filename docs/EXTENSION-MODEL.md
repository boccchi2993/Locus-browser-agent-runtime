# Locus extension model

> **Capability composes them for the user.**  
> **Plugin adds code.**  
> **Skill adds knowledge.**  
> **MCP adds authority.**

## 1. Capability

Capability is the normal user-facing installation/configuration unit. It declaratively references Plugins, SkillDefinitions, and MCP requirements.

Production catalogs are currently empty.

Capability runtime composition and Capability package distribution are separate layers. The package/authoring contract is defined in [CAPABILITY-PACKAGE.md](CAPABILITY-PACKAGE.md); a package must normalize into the existing runtime descriptors rather than replacing them.

## 2. TaskEnvironment

Capability state resolves into an immutable per-task snapshot. Plugins/MCP dedupe by identity. Skill definitions may be reused, but SkillInstances are private to each Capability.

## 3. Plugin

Plugin means local implementation code.

Closed v1 rules:

- authority is `none`;
- no credential/network/DOM bridge;
- preparation happens before runtime READY;
- a broken required plugin fails honestly;
- ordinary runtime APIs are preferred over new domain tools.

Current main has a synthetic provider proof only.

## 4. Trusted Plugin Runtime v1 — milestones

### v1A — offline wheel bootstrap primitive (implemented)

The lowest runtime primitive is implemented and proven with the Package Core
synthetic wheel (`locus_test_plugin-1.0.0-py3-none-any.whl`):

```
verified wheel bytes (trusted harness payload)
  -> strict-CSP Pyodide worker
  -> worker re-verifies exact size + SHA-256 (WebCrypto)
  -> harness-derived /tmp scratch path
  -> OFFLINE install: micropip + emfs: + deps=False (measured on the pinned
     Pyodide 0.26.4; zero network by construction and by request counter)
  -> declared import smoke test
  -> bootstrap installer retired (micropip.install becomes a denial)
  -> network lockdown
  -> READY
  -> ordinary user Python: import locus_test_plugin; answer() == 42
```

Supporting facts:

- `PYTHON_BOOTSTRAP_MANIFEST` gained ONLY the exact micropip closure
  declared by the pinned pyodide-lock.json (`micropip-0.6.0`,
  `packaging-23.2`), size/hash-pinned and verified by
  `scripts/verify-python-bootstrap-manifest.mjs`. Plugin wheels themselves
  NEVER enter the manifest: bootstrap assets are the Locus runtime trusted
  base, plugin artifacts are extension payload delivered in the bootstrap
  MESSAGE.
- The trusted harness (`PythonRuntime.configureExtensions`) validates the
  wheel payload (schema, basename-only `.whl` filename, `python-wheel`
  format, size bounds <= the package artifact bound, lowercase hex SHA-256,
  bytes view with `byteLength == size`) and takes an OWN COPY — a caller
  mutating its bytes afterwards can never change future boots.
- The worker NEVER trusts the channel: it re-verifies byte identity before
  writing anything, installs from `/tmp/locus-plugin-artifacts/<sha256>/`,
  deletes the scratch file in every outcome, and smoke-imports every
  declared import. Any mismatch or failed smoke import fails the boot
  closed: no install, no READY.
- `deps=False` is the Package v1 contract (exactly one wheel, no
  dependency closure, no package index). After the trusted install,
  `micropip.install`/`add_mock_package`/`remove_mock_package` become
  denials; remote installs are additionally dead at the requirement
  parser and behind the browser CSP (zero requests, request-counter
  proven). `pyodide.loadPackage` / `loadPackagesFromImports` stay denied.
  Plugin install time is bounded by the initialization bootstrap budget,
  never the 30s user execution budget.

NOT YET (v1B and beyond):

- CapabilityManager artifact refs / `PluginRuntimeProvider` wheel loader;
- PluginArtifactStore (production artifact storage beyond the test seam);
- Capability Package import UI, imported-package registration;
- Reference Capability; self-hosting;
- the legacy `files: {sourceText}` synthetic composition path still exists
  (explicitly labeled LEGACY SYNTHETIC COMPOSITION PATH in the worker) and
  is scheduled for removal/isolation in v1B.

No worker/Plugin network authority, arbitrary model URL, marketplace, PyPI
resolver, dependency solver, model-triggered install, or new model tool in
v1.

## 5. Capability packages and authoring

A Capability package is an authoring/distribution unit, not a new runtime authority layer.

The intended flow is:

```
project -> validate -> build -> explicit user import -> CapabilityManager -> TaskEnvironment
```

A model may author package files in a user-authorized workspace, but installation remains a separate explicit user trust action.

The package CORE is implemented: `src/capability-package.js` validates a
project, builds an immutable logical bundle (builder-computed sizes +
SHA-256, canonical lock) and inspects it - with zero writes and zero
trust transition. Import UI, imported-package registration and the
Trusted Plugin Runtime that consumes verified artifact bytes remain
pending. See [CAPABILITY-PACKAGE.md](CAPABILITY-PACKAGE.md) section 2b
for the implemented normative facts.

See [CAPABILITY-PACKAGE.md](CAPABILITY-PACKAGE.md) and [CAPABILITY-AUTHORING.md](CAPABILITY-AUTHORING.md).

## 6. Skills

SkillDefinition is immutable metadata. SkillSourceStore holds defaults. Enabling a Capability materializes a private durable SkillInstance. Shared definition does not mean shared user state.

## 7. MCP

MCP is for credentials, durable remote state, structured remote actions, and authenticated data. Current composition models requirement state only; production connector/auth implementation is future work.

## 8. Candidate product studies

`docs/plugins/` contains exploratory Spreadsheet/Document/PDF requirements. They are not a committed first batch or priority order.

Product selection follows real trajectories after Trusted Plugin Runtime is proven.

## 9. Core admission test

Local code -> Plugin. Workflow knowledge -> Skill. External authority -> MCP. Composition -> Capability. Genuine missing machine substrate -> core/provider discussion.

“Convenient as a tool” is not enough.