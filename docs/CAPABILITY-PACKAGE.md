# Locus Capability Package Contract

> Status: **design contract for the next extension-layer milestone; not implemented on current `main`.**  
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
- incompatible runtime/artifact shape.

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

The exact JSON field spelling may change once implementation begins. The normative part is the separation of:

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
- runtime-specific compatibility is checked before the bundle can be called valid.

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

Package validation proves **shape, graph coherence, bounds, and byte identity**. It is not malware scanning and it does not prove that third-party code is benevolent.

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

It receives an artifact whose identity, size, digest, runtime, and expected imports have already been validated.

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