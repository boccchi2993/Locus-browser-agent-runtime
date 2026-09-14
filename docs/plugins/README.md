# Optional plugin requirements

Status: proposed  
Scope: first optional plugin family for Locus

## Purpose

Locus core should remain small. Optional plugins add reusable local code capabilities for file formats or computations that do not belong in the core runtime.

The boundary is:

> Plugin adds code. MCP adds authority. Skill adds knowledge.

That means:

- a plugin may parse or modify a file the user already mounted into the workspace;
- a plugin must not silently gain credentials, authenticated SaaS access, or remote account authority;
- a plugin may be paired with a Skill that teaches the agent how to use it reliably;
- authenticated Google Sheets, Microsoft 365, Dropbox, email, calendars, and similar external systems belong behind MCP/connectors rather than ordinary file-format plugins.

## First batch

1. Spreadsheet — local XLSX creation, inspection, and deterministic editing.
2. Document — local DOCX creation, extraction, and semantic editing.
3. PDF — local PDF inspection, extraction, merge, split, and page operations.

These three are chosen because they correspond to common office-work tasks that are not well represented by shell+Python alone unless Locus bundles heavy format-specific libraries into core. They should stay optional.

## Common requirements

Every first-batch plugin should be:

- optional: Locus runs normally when absent;
- lazy-loadable: code is loaded only when selected/needed;
- browser-first where practical;
- workspace-confined: no filesystem authority outside the mounted workspace;
- no automatic upload of user files;
- bounded in input size, output size, file count, and execution time;
- cancellation-aware;
- telemetry-visible;
- failure-isolated: plugin failure must not crash AgentSession or corrupt unrelated runtime state;
- explicit about fidelity limits;
- usable without adding a new model-facing tool for every individual operation.

## Installation / loading expectations

This document does **not** freeze a public plugin manifest yet.

A future loader will probably need at least:

- stable plugin id,
- plugin version,
- compatible Locus/runtime version range,
- runtime dependencies,
- optional package/WASM assets,
- declared capabilities,
- resource limits,
- availability check.

Those are requirements, not a final schema.

Installation must never imply new external authority. Package download/installation policy and integrity verification are separate design work.

## Model-facing surface

Prefer one of these patterns, chosen by evidence rather than aesthetics:

1. expose the plugin through the existing local execution environment so the model can use a familiar library/API;
2. expose a very small deterministic command/capability surface;
3. pair the plugin with a Skill that provides workflow knowledge.

Do not create dozens of narrow tools such as `xlsx_read_cell`, `xlsx_write_cell`, `xlsx_add_sheet` unless benchmark evidence shows that structured tools are materially more reliable.

## Commit semantics

Mutating plugins should follow the same philosophy as current workspace mutation:

- validate before destructive commit where possible;
- never claim rollback when side effects already committed;
- cancellation must stop future writes;
- prefer writing a new output file unless the user explicitly asks to replace an original;
- if in-place update is supported, define conflict and overwrite behavior explicitly.

## Telemetry requirements

At minimum record:

- plugin id/version,
- operation family,
- input/output bytes,
- duration,
- success/failure class,
- number of files read/written,
- cancellation,
- committed side effects,
- whether execution stayed local.

Do not log workbook/document contents, cell values, paragraphs, real file paths, or extracted private text by default.

## Security requirements

Plugins must not:

- read API keys/sessionStorage/application globals;
- bypass workspace path confinement;
- introduce unrestricted network access as an incidental side effect;
- execute embedded macros or arbitrary active content;
- auto-upload files;
- claim isolation stronger than the runtime actually provides.

Network access required by a plugin must route through an explicit Locus network capability or be declared unsupported.

## Non-goals for the first batch

- plugin marketplace,
- auto-install based solely on model request,
- authenticated SaaS integrations,
- Office GUI automation,
- perfect pixel-level fidelity,
- arbitrary macro execution,
- arbitrary browser automation,
- freezing a plugin ABI before one real plugin exists.

## Acceptance philosophy

A plugin is not accepted because a library imports successfully.

It is accepted when realistic user workflows can be completed safely and reproducibly, with deterministic final-state checks where possible.

The first batch should be evaluated against realistic spreadsheet, DOCX, and PDF workspace tasks after benchmark fixtures and a runner exist.
