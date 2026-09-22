# Locus extension model

> **Capability composes them for the user.**  
> **Plugin adds code.**  
> **Skill adds knowledge.**  
> **MCP adds authority.**

## 1. Capability

Capability is the normal user-facing installation/configuration unit. It declaratively references Plugins, SkillDefinitions, and MCP requirements.

Production catalogs are currently empty.

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

## 5. Skills

SkillDefinition is immutable metadata. SkillSourceStore holds defaults. Enabling a Capability materializes a private durable SkillInstance. Shared definition does not mean shared user state.

## 6. MCP

MCP is for credentials, durable remote state, structured remote actions, and authenticated data. Current composition models requirement state only; production connector/auth implementation is future work.

## 7. Candidate product studies

`docs/plugins/` contains exploratory Spreadsheet/Document/PDF requirements. They are not a committed first batch or priority order.

Product selection follows real trajectories after Trusted Plugin Runtime is proven.

## 8. Core admission test

Local code -> Plugin. Workflow knowledge -> Skill. External authority -> MCP. Composition -> Capability. Genuine missing machine substrate -> core/provider discussion.

“Convenient as a tool” is not enough.
