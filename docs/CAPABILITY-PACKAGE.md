# Locus Capability Package Contract

> Status: **package core implemented** — `src/capability-package.js` implements project validate, build, inspect, the immutable logical CapabilityBundle and the generated lock. Explicit import UI, the imported-package registry and the Trusted Plugin Runtime remain contract-only (pending).
> Scope: how a Capability project is authored, validated, built, imported, and resolved without editing Locus runtime source.

This document deliberately separates **the authoring/distribution package** from the **runtime Capability object**.

A Capability is still the user-facing ability. A package is how one or more runtime descriptors, Skill defaults, and Plugin artifacts are delivered to Locus.

## 1. Design goal

A new Capability must not require:

- editing `src/extensions.js`;
- adding a hard-coded production catalog entry to the app bundle;
- changing Vite configuration;
- adding a new model-facing tool;
- teaching the model a Locus-specific install RPC;
- using a test-only `replaceCatalogs` seam.

The intended author experience is:

```
create project
  -> validate
  -> build
  -> explicit user import
  -> add/enable Capability
  -> next TaskEnvironment can use it
```

The same project format must be usable by a human developer and, later, by Locus itself.

## 2. Capability project vs built bundle

### Capability project

A **Capability project** is the editable source tree.

Recommended v1 shape:

```
my-capability/
├── capability.json
├── plugins/
│   └── <plugin-id>/
│       ├── plugin.json
│       └── artifacts/
│           └── ...
├── skills/
│   └── <skill-id>/
│       ├── skill.json
│       └── SKILL.md
├── mcp/
│   └── <mcp-id>/
│       └── mcp.json
├── tests/
│   └── ...
└── README.md
```

A project is source. It may contain build inputs and tests. It is not automatically installed merely because it exists under a mounted workspace.

### Capability bundle

A **Capability bundle** is the validated, immutable logical build output.

The bundle contains:

- normalized runtime descriptors;
- trusted default Skill source bytes;
- Plugin artifact bytes plus exact size and SHA-256;
- a generated lock/manifest describing every shipped file and component;
- optional test metadata that is not part of the runtime authority surface.

The exact physical container is **not frozen in this design contract**. V1 may first use a build directory. A later `.locuscap` archive can be a serialization of the same logical bundle without changing runtime semantics.

Do not make ZIP, tar, npm, PyPI, or a remote registry part of the architecture before the import/runtime contract is proven.

## 2b. Implemented core v1 (normative implementation facts)

The package core lives in `src/capability-package.js` (loaded after
`extensions.js`; classic script, one frozen namespace
`globalThis.LocusCapabilityPackage`, zero side effects, no writes, no
network). It depends only on the `WorkspaceAdapter` contract and the
existing runtime descriptor validators - it never re-implements runtime
descriptor semantics and never touches File System Access / OPFS / Node
fs / fetch directly. Unit coverage: `tests/capability-package.test.cjs`
over the real fixture project `tests/fixtures/capability-package/minimal`.

### 2b.1 Source schemas (strict whitelist, unknown fields fail)

- every manifest: `schemaVersion` exactly `1`; unknown top-level and
  unknown nested descriptor fields are validation failures (never
  silently ignored, even where runtime validators tolerate extras);
- `capability.json`: `{ schemaVersion, capability }`; capability fields
  `id, version, displayName, description, plugins, skills, mcps`, then
  normalized by `validateCapabilityDescriptor`;
- `plugins/<id>/plugin.json`: `{ schemaVersion, plugin, artifacts }`;
  plugin fields `id, version, displayName, description, runtime,
  authority, provides`, then normalized by `validatePluginDescriptor`;
  artifact entries allow exactly `path` and `format` - source manifests
  cannot supply `sha256`/`size` (builder-computed only);
- `skills/<id>/skill.json`: `{ schemaVersion, skill, source }`; skill
  fields `id, version, displayName, description`, then normalized by
  `validateSkillDescriptor`; `source` must be exactly `"SKILL.md"`;
  `SKILL.md` must be UTF-8 and within the 256 KiB skill contract;
- `mcp/<id>/mcp.json`: `{ schemaVersion, mcp }`; mcp fields
  `id, displayName, description`, then normalized by
  `validateMcpDescriptor`. Credential-ish fields (token, auth, keys,
  ...) are rejected by the whitelist itself - no secret blacklist.

### 2b.2 Package v1 policy (narrower than the runtime surface)

- plugin `runtime` is `python` only (javascript/wasm package delivery
  is NOT claimed and is rejected with `package_runtime_unsupported`);
- authority is `none` (enforced by the runtime validator);
- EXACTLY ONE `python-wheel` artifact per plugin under this plugin's
  `artifacts/` directory (no dependency closure format exists yet);
- component directory names MUST equal descriptor ids;
- EXACTLY ONE `capability.json` at the project root; one project is one
  capability (unreferenced components and missing local MCP metadata
  for referenced requirements are rejected).

### 2b.3 Path rules

Author-supplied paths must be POSIX-style relatives under the project:
no absolute paths, no `..`/`.` segments, no empty segments, no drive
letters, no backslashes, no control characters. Hostile paths are
rejected loudly - traversal is never "normalized" into a safe path, and
every builder read is proven to stay under the project root.

### 2b.4 Bounds (package constants, no scattered magic numbers)

| Bound | Value |
|---|---|
| manifest size | 256 KiB each |
| skill source | 256 KiB (existing skill contract) |
| plugin artifact | 64 MiB |
| shipped runtime bytes | 128 MiB total |
| components | 128 total |
| shipped runtime files | 256 total |

Oversized artifacts are bounded by `stat` before full materialization.

### 2b.5 Diagnostics (author faults are data, never throws)

`validateProject`/`buildProject` return `{ ok, diagnostics }` with
structured entries `{ severity, code, path, message }`, deterministically
sorted by (path, code, message) and de-duplicated - provider `list()`
order never influences results. Diagnostic codes: `package_json_invalid`,
`package_schema_version`, `package_field_missing`,
`package_field_unknown`, `package_descriptor_invalid`,
`package_id_invalid`, `package_id_mismatch`, `package_manifest_missing`,
`package_manifest_unreadable`, `package_manifest_too_large`,
`package_source_invalid`, `package_skill_source_missing`,
`package_skill_source_invalid`, `package_skill_too_large`,
`package_path_invalid`, `package_artifact_missing`,
`package_artifact_unreadable`, `package_artifact_too_large`,
`package_artifact_policy`, `package_runtime_unsupported`,
`package_ref_missing`, `package_component_unreferenced`,
`package_component_dir_invalid`, `package_too_many_components`,
`package_too_many_files`, `package_total_too_large`,
`package_duplicate`, `package_root_missing`. Programmer invariants
(non-WorkspaceAdapter input, invalid root, `inspectBundle` on a
non-bundle) throw instead.

### 2b.6 validate / build / inspect contracts

- `await LocusCapabilityPackage.validateProject({ workspace, root })` -
  READ ONLY (list/stat/read only, zero writes); on success returns
  `normalized: { capability, plugins, skills, mcps, sourcePlan }`;
- `await LocusCapabilityPackage.buildProject({ workspace, root })` -
  ALWAYS revalidates internally (never trusts a prior validate result),
  then reads exact bytes and computes exact size + WebCrypto SHA-256
  itself; success returns `{ ok: true, bundle }`;
- `LocusCapabilityPackage.inspectBundle(bundle)` - zero side effects,
  returns a SAFE plain summary (ids, versions, imports, sizes, hashes,
  `totalBytes`, `valid: true`) and never raw bytes or skill bodies.
  `valid: true` means a STRUCTURALLY VALID CapabilityBundle (schema,
  graph coherence, source/path rules, authority policy, bounds,
  declared artifact format, exact content identity and size). It does
  NOT mean any Plugin has been installed or smoke-imported:
  runtime-specific installability is verified by the Trusted Plugin
  Runtime before the runtime reports READY, never by Package Core.

### 2b.7 CapabilityBundle and the lock

`CapabilityBundle` keeps bytes in a private map; `readBytes(path)` hands
out copies (mutating a result can never alias the bundle), `listFiles()`
is deterministic and sorted, `lock` is deeply frozen plain metadata, and
`serializeLock()` emits canonical JSON (sorted keys, stable arrays, LF,
UTF-8, no timestamps). Byte-identical projects with different provider
list orders serialize byte-identically. The lock carries:
`schemaVersion`, normalized `capability`, `plugins` (`descriptor` +
`artifacts[{path, format, size, sha256}]`), `skills` (`descriptor` +
`sourcePath`, `size`, `sha256`), normalized `mcps`, and
`files[{path, size, sha256}]` - descriptors and integrity metadata
only, never skill bodies, never artifact bytes, never credentials.

## 3. Identity rules

Capability, Plugin, Skill, and MCP ids use the existing extension id contract:

```
^[a-z0-9][a-z0-9._-]*$
```

A package schema version is distinct from component versions:

```
package schema version != capability version != plugin version != skill version
```

Paths are derived from validated ids. Manifests do not get to smuggle arbitrary absolute install paths.

A package must fail validation on:

- duplicate component ids;
- traversal;
- control-character/path ambiguity;
- missing referenced local components;
- duplicate logical files;
- unsupported schema version;
- runtime/artifact declaration mismatch (package policy: `python`
  runtime with exactly one declared `python-wheel` artifact — a
  declared-shape check only, not byte-level wheel validation).

## 4. Source manifests

The source format may carry authoring metadata that is normalized away before runtime.

### `capability.json`

Conceptual v1 source:

```json
{
  "schemaVersion": 1,
  "capability": {
    "id": "example",
    "version": "1",
    "displayName": "Example",
    "description": "Example capability",
    "plugins": ["example-code"],
    "skills": ["example-workflow"],
    "mcps": []
  }
}
```

The nested `capability` object normalizes to the existing runtime Capability descriptor.

### `plugins/<id>/plugin.json`

Conceptual Python source manifest:

```json
{
  "schemaVersion": 1,
  "plugin": {
    "id": "example-code",
    "version": "1",
    "displayName": "Example code",
    "description": "Local implementation",
    "runtime": "python",
    "authority": "none",
    "provides": {
      "pythonImports": ["example_code"]
    }
  },
  "artifacts": [
    {
      "path": "artifacts/example_code-1-py3-none-any.whl",
      "format": "python-wheel"
    }
  ]
}
```

The source manifest names local build artifacts. The **builder**, not the author, computes the immutable size and SHA-256 recorded in the bundle lock.

V1 does not allow a model-supplied arbitrary URL here.

### `skills/<id>/skill.json`

```json
{
  "schemaVersion": 1,
  "skill": {
    "id": "example-workflow",
    "version": "1",
    "displayName": "Example workflow",
    "description": "How to use the local implementation reliably"
  },
  "source": "SKILL.md"
}
```

The runtime SkillDefinition remains metadata-only. `source` is authoring metadata consumed by the builder; the Markdown bytes enter the built SkillSourceStore input, not the runtime descriptor.

### `mcp/<id>/mcp.json`

MCP package metadata may name a requirement:

```json
{
  "schemaVersion": 1,
  "mcp": {
    "id": "example-service",
    "displayName": "Example service",
    "description": "External authority required by this capability"
  }
}
```

It must not contain access tokens, cookies, OAuth refresh tokens, or an instruction to auto-connect.

## 5. Build output and lock manifest

The builder produces a generated lock manifest. Conceptually:

```json
{
  "schemaVersion": 1,
  "capability": { "...": "normalized runtime descriptor" },
  "plugins": [
    {
      "descriptor": { "...": "normalized runtime descriptor" },
      "artifacts": [
        {
          "path": "plugins/example-code/artifacts/example.whl",
          "format": "python-wheel",
          "size": 1234,
          "sha256": "..."
        }
      ]
    }
  ],
  "skills": [
    {
      "descriptor": { "...": "metadata only" },
      "sourcePath": "skills/example-workflow/SKILL.md",
      "size": 456,
      "sha256": "..."
    }
  ],
  "mcps": [],
  "files": [
    {
      "path": "...",
      "size": 1234,
      "sha256": "..."
    }
  ]
}
```

The implemented lock spelling is frozen in section 2b.7. The normative part remains the separation of:

1. normalized runtime metadata;
2. immutable content bytes;
3. content integrity metadata.

A SHA-256 proves byte identity, not publisher authenticity. V1 does not invent a signing PKI.

## 6. Validation pipeline

Validation is layered.

### A. Structural validation

- parse every manifest;
- validate schema versions and ids;
- reject unknown/ambiguous required fields where the schema requires strictness;
- ensure all referenced files stay within the project root.

### B. Graph validation

- every Capability Plugin/Skill reference resolves exactly once;
- local MCP metadata is coherent when supplied;
- duplicate ids fail loudly;
- Plugin/Skill/MCP cycles are not fabricated because v1 component descriptors do not depend on other components.

### C. Skill validation

- SkillDefinition is metadata-only;
- source is UTF-8 text;
- source stays within the existing 256 KiB Skill limit;
- inline `body` / `content` / runtime `path` fields remain forbidden.

### D. Plugin validation

- runtime is supported;
- authority is exactly `none`;
- Python imports match the existing module-name contract;
- artifacts exist and stay within package bounds;
- builder computes size + SHA-256;
- Package Core validates the declared artifact format, bounds,
  identity and exact bytes. Runtime-specific installability is
  verified by the Trusted Plugin Runtime before the runtime reports
  READY — it is not checked here, and a valid CapabilityBundle is
  not yet a proven-installable Plugin.

### E. Authority validation

A package cannot create authority by declaration.

- Plugin: local code, authority `none`;
- Skill: knowledge;
- MCP: requirement only;
- Capability: composition only.

A package that asks a Plugin to gain network, DOM, browser credentials, API keys, arbitrary parent RPC, or MCP authority is invalid.

## 7. Import and installation boundary

**Building a package is not installing it.**

This is especially important for self-authoring.

The model may create code in an ordinary user-authorized workspace. That must not silently turn the new code into trusted runtime extension code.

V1 import/install requires an explicit user action in the Capability UI.

Conceptual flow:

```
user selects/imports built Capability bundle
  -> package schema + graph validation
  -> content size/hash verification
  -> page-session package registration
  -> Capability becomes available to Add
  -> Add resolves Plugin / Skill / MCP requirements
  -> Plugin runtime prepares verified artifacts before READY
  -> Skill defaults materialize to capability-private SkillInstances
  -> disconnected MCP remains needs-connection
  -> next task receives the new TaskEnvironment
```

The model cannot invoke a hidden “trust this package” shell command.

## 8. What validation and import do — and do not — prove

Package validation proves **shape, graph coherence, bounds, and byte identity**. It is not malware scanning and it does not prove that third-party code is benevolent. It also does not parse or install artifact bytes: a declared `python-wheel` artifact is checked as a declared format with exact identity, not as a structurally installable wheel. That proof belongs to the Trusted Plugin Runtime (offline install + smoke import before READY).

An explicit import is therefore a trust transition:

- the user chooses to admit local extension code into Locus;
- that code still runs inside the existing runtime authority boundary;
- Plugin authority `none` means it gains no extra network, DOM, API-key, browser-credential, parent-RPC, or MCP authority;
- a Python Plugin may use the filesystem/computation authority that the task's Python runtime already has, because otherwise it could not implement local file capabilities;
- hashes make the installed bytes identifiable; they do not make them safe.

A Capability authored by the model is subject to exactly the same rule. “I generated this code myself” is not a bypass around explicit import.

## 9. Imported-package persistence in authoring v1

Current Capability enablement is page-session state. The first authoring implementation should preserve that honesty.

Therefore v1 may use:

- **page-session package registration**;
- durable SkillInstances after a Capability has been added;
- verified in-memory Plugin artifact cache according to the Plugin Runtime contract.

Reload may require re-importing the package before it can be enabled again. Persisting an installed-package catalog is a separate milestone and must not be smuggled into the authoring proof.

This limitation does not block the self-hosting acceptance test, which only requires a subsequent task in the same runtime session.

## 10. Remove, re-add, and package registration

These are separate operations:

- **Remove Capability** — disables the Capability, releases component refs, deletes its private SkillInstances; re-add restores default Skill sources.
- **Package registration** — makes a package's descriptors/artifacts available to the manager for the current session.
- **Uninstall package** — not a v1 product concept. Page reload can discard page-session registrations.

Do not overload Remove Capability into an implicit package-manager uninstall.

## 11. Trusted Plugin Runtime relationship

Capability packaging and Trusted Plugin Runtime meet at **verified artifact bytes**.

The Plugin Runtime should not care whether verified bytes came from:

- a user-imported local Capability bundle;
- a future built-in trusted catalog provider;
- a future pinned remote artifact provider.

It receives an artifact whose identity, size, digest, runtime, and expected imports have already been validated. Package Core never parses, installs, or executes artifact bytes — `python-wheel` is a declaration whose semantics only the runtime verifies.

For Python v1:

```
verified wheel bytes
  -> strict-CSP worker
  -> offline installation before READY
  -> smoke import every declared pythonImports entry
  -> normal user import afterwards
```

The worker never resolves dependencies or fetches packages from the network.

## 12. What is deliberately not in package v1

- marketplace;
- remote package registry;
- publisher signing/PKI;
- dependency solver;
- arbitrary PyPI install;
- model-triggered trusted install;
- persistent installed-package catalog;
- automatic Skill upgrade/merge;
- hidden MCP credential import;
- new model-facing package-management tools;
- product commitment to Spreadsheet/DOCX/PDF.

Those can be designed after the package/runtime/import loop is real.