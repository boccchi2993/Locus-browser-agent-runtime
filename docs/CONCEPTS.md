# Locus concepts and terminology

This page is the canonical vocabulary for current Locus architecture.

## Browser substrate

**Execution** — local computation; current production runtime is Python/Pyodide.

**Filesystem** — the Linux-like VFS namespace and mount authorities.

**Network** — bounded HTTP/HTTPS through `NetworkRuntime`.

**Perception** — the model-input boundary for non-text data; current implementation is image input.

These are architecture categories, not four model tools.

## Harness

The orchestration layer: AgentSession, provider adapters, approvals, persistence, capability composition, task binding, and backend selection.

## Model-facing tools

Current registry: `bash` and `cloud_bash` (unconfigured; expected to fail). The shell command registry is a separate layer.

## Capability

The user-facing product unit. A Capability composes Plugins, Skills, and MCP requirements. States: `disabled`, `needs-connection`, `ready`, `error`.

Production catalogs are currently empty.

## Plugin

Local implementation code. Plugin v1 descriptor authority is `none`. Current main has a provider seam and synthetic Python proof, not a production trusted package loader.

## SkillDefinition

Publisher-owned immutable metadata: id, version, displayName, description. Inline source/path fields are rejected.

## SkillSourceStore

Trusted default Markdown for a `(skillId, version)`, separate from descriptor metadata.

## SkillInstance

Capability-private durable working copy at:

```
/home/locus/.skills/<capability-id>/<skill-id>.skill
```

Definitions may be shared; instances are never shared. Read is free; create/write/delete requires a fresh behavior-change confirmation. Remove Capability deletes its instances; re-add restores defaults.

## MCP

External authority: credentials, durable remote state, structured remote operations, or authenticated data.

Composition v1 models requirement state; production MCP transport/auth is future work.

## TaskEnvironment

A deeply frozen per-task identity snapshot containing resolved capabilities, plugins, SkillInstance metadata/paths, MCP states, and runtime extension identity.

It freezes what the task started with, not all mutable filesystem bytes.

## Approval

A suspend/resume human decision about a specific action the harness already has technical authority to attempt.

Approval is not authority.

## Behavior mutation

A persistent change to future agent workflow guidance. SkillInstance create/write/delete is the current behavior-mutation class.

## ModelCapabilityRegistry

The image-input compatibility registry in `src/capabilities.js`.

Despite the shared word, this is not the user-facing Capability composition registry in `src/extensions.js`.

## Workspace

The optional external directory explicitly granted by the user and mounted at `/mnt/workspace`.

It is not the VFS root.

## Artifact

A generated file under `/mnt/download` exposed by the UI for explicit user download.

## Relay

An optional network/model transport helper. A relay is not a remote execution sandbox and must not silently enlarge authority.

## Capability Project

An editable source directory containing one Capability manifest plus its local Plugin, Skill, MCP metadata, tests, and build artifacts. Merely existing in a workspace grants no install authority.

## Capability Bundle

The validated logical build output of a Capability Project: normalized runtime descriptors, immutable Skill default bytes, Plugin artifact bytes, and generated size/hash integrity metadata.

The physical archive/container format is not frozen yet.

## Package Registration

The act of making an imported Capability Bundle available to CapabilityManager. Authoring v1 may keep registration page-session only.

Registration is distinct from enabling a Capability.

## Capability Authoring SDK

The future deterministic local library that validates projects, builds bundles, and inspects generated packages. The later `capability-authoring` Capability will expose this machinery to Locus through ordinary local Python plus a Skill describing the workflow.
