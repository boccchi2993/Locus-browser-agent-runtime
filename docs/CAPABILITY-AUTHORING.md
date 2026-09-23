# Locus Capability Authoring and Self-Hosting

> Status: **workflow/acceptance specification.** The package core (Phase A steps 1-3) is implemented in `src/capability-package.js` with coverage in `tests/capability-package.test.cjs`; the imported-package registry, import UI, CapabilityManager integration and Plugin artifact delivery remain pending.
> Depends on: [CAPABILITY-PACKAGE.md](CAPABILITY-PACKAGE.md), [EXTENSION-MODEL.md](EXTENSION-MODEL.md), and Trusted Plugin Runtime v1.

The goal is not merely to parse `capability.json`.

The goal is:

> **Starting from an ordinary Capability project directory, Locus can validate, build, explicitly import, install, use, customize, remove, and re-add a Capability without editing runtime source.**

Then the same workflow must become usable by Locus itself.

## 1. One authoring path for humans and agents

There must not be a “real developer flow” and a separate magical “AI-generated Capability flow”.

Both use the same:

- project layout;
- schemas;
- validator;
- builder;
- bundle contract;
- import UI;
- runtime installer;
- tests.

If Locus can only create a Capability by editing `src/extensions.js`, changing Vite config, or calling a test-only catalog injection seam, the framework is not finished.

## 2. Authoring operations

The authoring layer needs three deterministic operations:

### Validate project

Input: project directory.

Output: structured diagnostics only. No installation side effects.

It checks the package contract, component graph, authority rules, Skill source, Plugin artifacts, and test metadata.

### Build project

Input: a validated project.

Output: an immutable logical Capability bundle plus generated lock/integrity metadata.

Build never enables or trusts the Capability.

### Inspect bundle

Input: built bundle.

Output: safe summary:

- Capability id/version/display name;
- Plugins and provided imports;
- Skills and source hashes;
- MCP requirements;
- artifact sizes/hashes;
- validation state.

These operations should eventually be exposed through a small local SDK. CLI spelling is not frozen yet; a future wrapper might look like:

```
python -m locus_capability_sdk validate .
python -m locus_capability_sdk build . --output dist/
python -m locus_capability_sdk inspect dist/
```

The stable contract is the operation, not those exact flags.

## 3. Phase A — framework implementation

Implement the minimum infrastructure required for a package to exist independently of the app source:

1. package/project schema parser;
   [implemented - `src/capability-package.js`: strict source-schema layer over the existing runtime validators]
2. validator;
   [implemented - `validateProject`: structured diagnostics, graph/authority/bounds, zero writes]
3. deterministic builder + generated lock manifest;
   [implemented - `buildProject`: byte-exact bundle, builder-computed size + SHA-256, canonical lock; `inspectBundle` provides the safe summary]
4. page-session imported-package registry;
5. explicit Capability UI import path;
6. integration with CapabilityManager;
7. Plugin artifact provider handing verified bytes to Trusted Plugin Runtime;
8. SkillSourceStore population from the imported bundle;
9. no automatic MCP authorization.

No product Capability is required yet.

## 4. Phase B — Trusted Plugin Runtime

Status: the v1A primitive is implemented — a tiny synthetic pure-Python
wheel is delivered as verified artifact bytes and installed OFFLINE in the
strict-CSP worker before READY (worker-side size + SHA-256 re-verification,
micropip `emfs:` + `deps=False`, declared-import smoke test, installer
retirement). See EXTENSION-MODEL.md section 4 and CAPABILITY-PACKAGE.md
section 11. What remains contract-only is the wiring from an IMPORTED
bundle to that runtime seam (CapabilityManager artifact refs, the
production artifact store, the import UI).

The wheel should have:

- no external dependencies;
- no network behavior;
- one or two deterministic functions;
- declared imports that can be smoke-tested.

Example:

```python
import locus_test_plugin

assert locus_test_plugin.answer() == 42
```

This proof must use package artifact bytes, not a source-string injection.

Required lifecycle:

```
bundle artifact
  -> size/hash verified
  -> runtime environment prepared
  -> offline wheel install
  -> smoke import
  -> READY
  -> ordinary import from user Python
```

A worker reset/crash should rebuild from the verified page cache without granting the worker network authority.

## 5. Phase C — Reference Capability

After the package and Plugin Runtime paths work, build a deliberately small **Reference Capability**.

Recommended reference: `reference-text-analysis`.

It is not a product commitment. It exists to exercise the whole framework with boring, deterministic behavior.

Suggested composition:

```
Capability: reference-text-analysis

Plugin:
  reference_text_tools
  - pure Python wheel
  - word_count(text)
  - top_terms(text, n)

Skill:
  text-analysis-workflow
  - inspect encoding/size
  - choose the local helper when useful
  - write a deterministic report

MCP:
  none
```

Why this kind of reference?

Because it proves the extension plumbing without dragging Office fidelity, rendering, external services, or dependency hell into the first end-to-end test. Humanity has enough variables already.

## 6. Reference Capability end-to-end acceptance

The acceptance test starts from a **source project directory**, not pre-injected catalogs.

It must prove:

### Author

- manifests and Skill source exist as ordinary files;
- Plugin wheel is produced by the test/build fixture;
- no runtime source file is edited.

### Validate

- valid project passes;
- malformed ids/refs/authority/artifacts fail deterministically;
- hashes/sizes are generated from real bytes.

### Build

- produces a logical bundle/lock;
- repeated build from identical inputs is deterministic where timestamps are excluded from identity;
- no hidden network dependency is required.

### Import

- user explicitly imports the bundle;
- package becomes visible as a Capability;
- no test-only `replaceCatalogs` path is used.

### Enable

- Plugin artifact verifies;
- Python environment installs it offline before READY;
- SkillInstance materializes under the Capability-private path;
- TaskEnvironment references the real instance.

### Use

A subsequent ordinary agent task:

1. sees the Capability index;
2. reads the Skill on demand;
3. uses ordinary Python;
4. `import reference_text_tools` succeeds;
5. completes a deterministic text-analysis task.

### Customize

The task/user changes the SkillInstance.

- behavior-mutation confirmation appears;
- approved change persists;
- next task sees the customized guidance;
- another Capability sharing the same SkillDefinition would remain independent.

### Remove / re-add

- Remove deletes the private SkillInstances and releases refs;
- re-add rematerializes default Skill source;
- Plugin remains governed by normal reference/runtime lifecycle;
- the customized copy does not magically return.

That is the first point at which “making a Capability” can be called end-to-end complete.

## 7. Phase D — Capability Authoring Capability

Only after the Reference Capability passes should Locus receive an authoring Capability of its own.

Working product name:

`capability-authoring`

Conceptual composition:

```
Capability: Capability Authoring

Plugin:
  locus_capability_sdk
  - validate project
  - build project
  - inspect bundle
  - deterministic schema helpers

Skill:
  capability-authoring-workflow
  - decide Plugin vs Skill vs MCP vs core
  - project layout
  - descriptor rules
  - security/authority invariants
  - testing expectations
  - build/validation workflow

MCP:
  none for v1
```

The Skill contains design knowledge. The Plugin contains deterministic schema/build machinery.

Do not put architecture prose into code when a Skill is the right layer, and do not ask the model to hand-roll hashes/schema validation when deterministic code is the right layer.

## 8. Self-hosting security boundary

Locus being able to **write** a Capability project does not mean Locus can silently **install** it.

Self-hosting flow:

```
user: "make me a capability for X"
  -> Locus reads capability-authoring Skill
  -> writes project files into user-authorized workspace
  -> validates
  -> builds bundle
  -> presents result
  -> USER explicitly imports/adds the bundle
  -> next task can use it
```

The install/import click is a trust transition.

A prompt injection, generated Skill, or model-authored Plugin cannot auto-promote its own code into trusted extension state.

## 9. Self-hosting acceptance test

The final bootstrap test is:

> Starting from a plain-language capability request and an empty Capability project directory, Locus produces a valid installable Capability. After explicit user import, a subsequent Locus task uses that Capability successfully, with no manual edits to Locus runtime source.

Hard disqualifiers:

- editing `src/extensions.js`;
- rebuilding Locus solely to register the generated Capability;
- calling a hidden e2e/test catalog injector;
- manually patching the generated manifest;
- manually moving Skill text into a registry;
- letting the generated Plugin fetch/install dependencies from the network;
- skipping explicit user import/trust.

## 10. Dogfood criterion

The authoring framework becomes mature enough to build real product Capabilities when:

- Locus can author a non-trivial second Capability through the same path;
- failures produce diagnostics the model can act on;
- the model does not need private knowledge of runtime source layout;
- package validation catches mistakes before installation;
- installation does not enlarge authority;
- the same package can be inspected and built by a human without Locus.

At that point Spreadsheet, Document, PDF, RAG, repository workflows, or other product capabilities can be selected from real trajectories rather than hard-coded into the core.

## 11. Milestone sequence

```
DONE
Capability Composition + mutable SkillInstances
Documentation / terminology foundation

NOW / NEXT
Capability Package + Authoring contract
        |
        v
Trusted Plugin Runtime v1
        |
        v
Authoring validator / builder / import path
        |
        v
Reference Capability E2E
        |
        v
Capability Authoring Capability
        |
        v
Self-hosted Capability E2E
        |
        v
First real product Capability selected from trajectories
```

The order matters. Self-hosting before the package/runtime path is real would only teach the model to automate internal hacks.
