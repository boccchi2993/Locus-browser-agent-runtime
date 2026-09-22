# Candidate capability / plugin requirement studies

Status: exploratory research, **not a committed product batch**.

These documents study possible local file-format capabilities. Their presence does not mean Locus has selected Spreadsheet, Document, or PDF as the first production Capability.

Current `main` deliberately ships empty production Capability/Plugin/Skill/MCP catalogs. The next extension-layer milestone is Trusted Plugin Runtime v1 using a synthetic package artifact; product selection comes later from real trajectories.

## Boundary

> Plugin adds code.  
> Skill adds knowledge.  
> MCP adds authority.  
> Capability composes them for the user.

A future local file-format Capability may combine one or more Plugins with workflow Skills and, separately, optional MCP authority for authenticated remote services.

Local code must not silently gain credentials, browser-session authority, or remote-account access.

## Candidate studies

- [SPREADSHEET.md](SPREADSHEET.md) — local spreadsheet workflows
- [DOCUMENT.md](DOCUMENT.md) — local DOCX workflows
- [PDF.md](PDF.md) — local PDF workflows

They are candidates, not a priority ordering.

## Shared requirements for any future production plugin

A selected Plugin should be:

- optional and capability-scoped;
- loaded/prepared before the task runtime reports READY;
- browser-first where practical;
- restricted to the same local authority as the runtime it joins;
- bounded in asset/input/output size and execution time;
- cancellation-aware;
- failure-isolated;
- explicit about fidelity limits;
- usable through familiar runtime APIs without adding dozens of narrow model tools.

## Installation is separate infrastructure

A requirements study does not define package installation.

Trusted Plugin Runtime v1 must first define:

- trusted descriptor/artifact identity;
- bounded acquisition by the harness;
- content-integrity verification;
- offline runtime installation;
- smoke-import/READY semantics;
- rebuild/cache behavior;
- failure handling.

No candidate document is permission to add arbitrary remote manifests, a marketplace, PyPI auto-resolution, or model-triggered installs.

## Authority

Authenticated Google Sheets, Microsoft 365, OneDrive/SharePoint, email, calendars, GitHub, and similar external systems require an explicit external-authority layer such as MCP. A local parser library is not that authority.

## Acceptance philosophy

A real product capability is selected and accepted when realistic user workflows can be completed safely and reproducibly, with deterministic final-state checks where possible. Importing a library is not the acceptance criterion.
