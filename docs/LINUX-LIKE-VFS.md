# Locus Linux-like VFS

> Status: implemented contract on current `main`.  
> Scope: model-visible paths, mount authority, runtime convergence, and capability-private SkillInstances.

## 1. Principle

> **Do not make the model learn Locus. Make Locus look like a small Linux machine.**

This is a userland compatibility goal, not kernel emulation. Locus does not pretend to provide POSIX processes, devices, sockets, `/proc`, package databases, or ELF binaries. It provides familiar paths and commands over browser-native storage.

## 2. Current model-visible topology

```
/
├── bin/                         virtual command view
├── usr/
│   ├── bin/                     virtual command view
│   └── local/share/locus/
│       └── capabilities/        task-scoped safe capability metadata
├── home/
│   └── locus/
│       ├── .skills/
│       │   └── <capability-id>/
│       │       ├── <skill-id>.skill
│       │       └── .locus-installed.json   harness-owned marker
│       ├── .config/locus/mcp/
│       ├── .cache/locus/
│       └── history/             read-only conversation-history view
├── tmp/
└── mnt/
    ├── workspace/               optional user-granted directory
    ├── upload/                  read-only user uploads
    ├── download/                writable downloadable artifacts
    └── plugins/                 durable/reserved plugin namespace;
                                 task-scoped safe plugin metadata may appear here
```

There is intentionally **no active `/usr/local/share/locus/skills` working-copy mount**. SkillDefinitions are publisher templates; enabled capabilities materialize private mutable SkillInstances under `/home/locus/.skills/<capability>/<skill>.skill`.

## 3. The machine exists without a workspace

`/mnt/workspace` is additional user-granted authority, not the root filesystem.

Without a mounted external directory the machine still has home, tmp, uploads, downloads, command views, and durable local state. Default cwd is:

```
/mnt/workspace   when mounted
/home/locus      otherwise
```

Each `bash` invocation starts at that default cwd; `cd` is invocation-local.

## 4. Mount table and providers

`VirtualWorkspace` owns one normalized absolute namespace and routes by longest matching mount prefix.

Important providers include:

- memory/internal providers for ephemeral machine state;
- OPFS for durable `/home/locus` and the plugin namespace when available;
- `LocalDirectoryWorkspace` for `/mnt/workspace`;
- upload-backed read-only files for `/mnt/upload`;
- artifact storage for `/mnt/download`;
- virtual/system providers for `/usr/bin`, `/bin`, capability/plugin introspection, and conversation history;
- task-bound `SkillInstanceWorkspace` overlay at `/home/locus/.skills` when a task has skills.

A provider sees a path relative to its mount root, not the user's real OS path.

## 5. Authority classes

Current VFS authority vocabulary includes:

```
read-only
read-write
external-read-write
system-read-only
```

Typical mapping:

| Path | Meaning | Authority |
|---|---|---|
| `/usr`, `/bin` | virtual system/userland views | system-read-only |
| `/home/locus` | local durable home when OPFS is available | read-write |
| `/home/locus/.skills` | task-bound skill view | read + approval-guarded mutation |
| `/tmp` | scratch | read-write |
| `/mnt/workspace` | user-granted external directory | external-read-write |
| `/mnt/upload` | user-provided inputs | read-only |
| `/mnt/download` | generated artifacts | read-write |
| `/mnt/plugins` | reserved/durable plugin namespace and safe metadata | normally system-controlled |

Approval cannot manufacture authority. An approval card cannot make a read-only mount writable.

## 6. Shell and Python converge on one namespace

The public invariant is:

> the same Locus path names the same logical file from shell and Python.

Python currently mirrors selected VFS mounts into Pyodide, executes, computes a bounded changeset, detects conflicts, and commits through the VFS. This snapshot/diff mechanism is internal. It must not create a second public `/workspace` dialect.

Python write-back honors VFS authority. In particular:

- `/mnt/upload` remains read-only;
- SkillInstance mutations commit through the approval-guarded task overlay;
- external-edit conflicts preserve the newer on-disk version;
- incomplete output collection blocks unsafe deletion phases.

## 7. Skills are capability-private state

A SkillDefinition can be referenced by several Capabilities. Its instances are never shared.

```
Definition X
   ├── Capability A -> ~/.skills/a/x.skill
   └── Capability B -> ~/.skills/b/x.skill
```

First materialization may produce byte-identical files. After installation they are independent.

Reads are free. Create/write/delete of a declared SkillInstance are behavior mutations and require a fresh confirmation each time. Identity-changing operations such as `mv`, undeclared skill creation, install-marker mutation, and recursive removal of a capability skill directory fail closed.

Removing a Capability from Settings deletes its private skill directory. Re-adding materializes the default again.

See `CAPABILITY-BOUNDARIES.md` and `SECURITY-MODEL.md`.

## 8. Plugin namespace

`/mnt/plugins` is reserved for local installed-code state and introspection. Current production Plugin catalogs are empty and there is no production trusted package loader yet.

Capability Composition v1 can expose safe read-only metadata such as:

```
/mnt/plugins/<plugin-id>/plugin.json
```

That metadata is not executable authority, a credential store, or proof that a production plugin artifact is installed.

## 9. Protected roots and destructive operations

Structural roots are protected from recursive deletion, including the filesystem root and mount roots such as `/home/locus`, `/mnt/workspace`, `/mnt/upload`, `/mnt/download`, and `/mnt/plugins`.

This is a harness safety contract, not a claim of GNU `rm` equivalence.

Cross-mount moves cross real providers. They require bounded copy/verify/delete behavior; a read-only source cannot be “moved” by silently creating a destination and then failing the delete.

## 10. Uploads, artifacts, and persistence

- Uploads enter `/mnt/upload` only after explicit user action and remain local.
- Artifacts written to `/mnt/download` are offered to the user; writing does not itself trigger a browser download.
- `/home/locus` is durable through OPFS when available.
- Conversations and provider replay metadata use IndexedDB, while `/home/locus/history` is a read-only filesystem view.
- `/tmp`, active task state, and most upload/download state are ephemeral unless another provider explicitly supplies durability.

See `PERSISTENCE.md`.

## 11. Session and task lifecycle

Changing the external workspace is a session boundary: active work is cancelled, session generation changes, and Python state is rebuilt. A running task holds a forked mount table so late work cannot silently rebind to a newly selected workspace.

Capability changes are between-task operations. A task receives an immutable `TaskEnvironment` identity snapshot and a task-specific VFS fork. Skill file contents may change during that task only through the approval guard; the frozen snapshot itself does not mutate.

## 12. Prompt contract

The model should receive a compact description of the conventional machine, not this entire document.

The live shell registry drives runtime dispatch, `help`, `which`, `/usr/bin`, and prompt text.

When a Capability provides guidance, the prompt advertises only present capability-private SkillInstance paths. Skill bodies are never pre-injected; they enter model history only if the model explicitly reads them as ordinary tool output.
