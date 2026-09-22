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

## 4. Trusted Plugin Runtime v1 — next milestone

Prove real code delivery with a synthetic wheel before selecting a product package:

```
trusted descriptor
 -> fixed artifact identity
 -> trusted harness bounded acquisition
 -> exact size + SHA-256
 -> verified cache
 -> strict-CSP Python worker
 -> offline install before READY
 -> smoke import
 -> ordinary import during user code
```

No worker/Plugin network authority, arbitrary model URL, marketplace, PyPI resolver, dependency solver, model-triggered install, or new model tool in v1.

The exact offline wheel installation mechanism is an implementation question to measure.

Trusted Plugin Runtime is also the code-delivery half of Capability packaging: the package/import layer validates artifact identity and bytes; the runtime receives verified artifacts and prepares them before READY.

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