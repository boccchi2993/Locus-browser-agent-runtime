# Locus Architecture

> Status: current architecture on `main`.  
> Normative concepts live alongside the implementation; historical audit documents are snapshots, not current truth.

## 1. What Locus is

Locus is a **browser-native execution harness for AI agents**.

> **Model decides WHAT. Harness decides WHERE.**

> **Do not make the model learn Locus. Make Locus look like a small, honest computer.**

> **Use the closest, cheapest, least-authority environment that can reliably complete the task.**

The browser tab is the default lightweight computer. Remote inference, explicit external authority, and genuinely heavyweight execution may remain remote; ordinary file/data computation should not become cloud work merely because an agent requested it.

## 2. Layer model

```
+------------------------------------------------------+
| User                                                 |
|   selects Capabilities, files, folders, approvals    |
+------------------------------------------------------+
| Product composition                                  |
|   Capability                                         |
|     -> Plugin        local code                      |
|     -> SkillInstance capability-private knowledge    |
|     -> MCP           external authority requirement  |
+------------------------------------------------------+
| Harness                                              |
|   AgentSession | ProviderAdapter | Approval           |
|   TaskEnvironment | Persistence | CapabilityManager  |
+------------------------------------------------------+
| Browser substrate                                    |
|   Execution | Filesystem | Network | Perception      |
+------------------------------------------------------+
| Browser APIs / optional edge relays / model APIs     |
+------------------------------------------------------+
```

These layers are deliberately different. A Plugin cannot smuggle in authority merely because it contains code; an MCP connection is not a local library; a Skill is not executable permission.

## 3. Model-facing surface

Current model-visible tools are exactly:

- `bash` — the local browser machine;
- `cloud_bash` — an unconfigured legacy/escalation stub that currently fails.

There is no current `edit` tool and no JavaScript shell command.

The bounded shell command registry is the source of truth for dispatch, `help`, `which`, `/usr/bin`, and the system-prompt shell contract. Current commands include `pwd`, `cd`, `ls`, `cat`, `echo`, `find`, `grep`, `head`, `tail`, `wc`, `sort`, `mv`, `rm`, `python`, `curl`, `which`, and `help`.

## 4. Four substrate capabilities

### Execution

Local computation. Current production execution is Python through Pyodide. The worker runs under a browser-enforced no-network CSP and additional JS-level lockdown. The trusted harness supplies a fixed, hash-verified bootstrap set.

### Filesystem

One Linux-like VFS with mount authority. External workspace, uploads, artifacts, durable home, tmp, virtual command views, and task overlays share the same namespace.

### Network

Bounded HTTP/HTTPS through `NetworkRuntime`. The harness chooses browser-direct or optional edge relay. Side-effecting methods are approval-gated and never ambiguously retried.

### Perception

The model-input boundary for non-text user data. Current implementation is image input: durable attachment storage, provider/model capability evidence, human/probe fallback when unknown, and provider-native materialization only at request time.

Perception does not change the model tool list.

## 5. AgentSession and task binding

`AgentSession` is UI-independent. The Vue layer projects runtime events; it does not reconstruct provider history.

At task start the harness binds:

- a workspace/VFS fork;
- an immutable `TaskEnvironment`;
- provider/session generation;
- the task AbortSignal;
- optional semantic image references.

A running task keeps those identities for its lifetime. Later workspace/capability changes apply to later tasks, not to the one already running.

## 6. Provider protocol

Provider-native continuation state is preserved. Visible assistant text is not the whole protocol state.

`ProviderAdapter` owns provider-specific serialization/replay while the rest of the harness sees a structured envelope. Raw provider messages, reasoning/opaque fields, and tool-call state are retained where needed for correct replay.

See `MODEL-PROTOCOL.md`.

## 7. Capability composition

The user-facing unit is **Capability**.

```
Capability
  ├── Plugin(s)      code
  ├── Skill(s)       knowledge
  └── MCP reqs       authority
        |
        v
TaskEnvironment
```

Production catalogs are empty today. The composition runtime is real and tested; product capabilities have not yet been selected.

Skill semantics are intentionally stronger than “a prompt file”:

- SkillDefinition = immutable publisher metadata;
- SkillSourceStore = trusted default Markdown source;
- SkillInstance = capability-private durable working copy;
- definitions may be shared; instances are never shared;
- reading is free;
- create/write/delete is a behavior mutation requiring explicit confirmation every time;
- Remove Capability deletes the private instances; re-add restores defaults.

See `EXTENSION-MODEL.md` and `CAPABILITY-BOUNDARIES.md`.

## 8. Authority and approval

Authority answers **what can technically be reached**. Approval answers **whether one already-authorized action may proceed now**.

Approval cannot create filesystem, network, credential, or MCP authority.

Examples:

- user picks a folder -> filesystem authority exists;
- side-effecting HTTP -> explicit approval may be required;
- Skill mutation -> explicit behavior-change confirmation;
- unknown image support -> capability-knowledge question, not an authority grant.

See `SECURITY-MODEL.md` and `APPROVALS.md`.

## 9. Persistence

IndexedDB stores structured metadata/history. OPFS stores durable local bytes such as `/home/locus` when available. Provider replay checkpoints are kept separate from presentation state.

Current persistence schema version is 3.

See `PERSISTENCE.md`.

## 10. Extension direction

The next extension-layer milestone is **Trusted Plugin Runtime v1**: real verified local artifacts, offline runtime installation, and smoke-import before READY, proven first with a synthetic wheel.

It must not reopen the closed Capability/Skill model. It must not add a marketplace, arbitrary remote manifests, model-triggered package installation, or new Plugin authority.

## 11. Documentation authority

For current behavior, executable code and tests are the final evidence. These architecture/security/concept documents define intended invariants and should be changed deliberately with the implementation.

`ROADMAP.md` describes status/planning. Files under `docs/plugins/` are candidate requirement studies, not selected product commitments. Audit files are historical snapshots.
