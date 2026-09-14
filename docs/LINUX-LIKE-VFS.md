# Locus Linux-like VFS v1

> Status: architecture target for the post-`v0.4-observation.1` reliability pass.  
> Scope: model-visible filesystem topology, mount semantics, and runtime filesystem convergence.  
> This document defines the target contract. Implementation may land incrementally.

## 1. Why this exists

Locus should not ask a model to learn a new filesystem dialect.

Foundation models already have an enormous amount of training data describing Linux and Unix userland conventions. Locus should exploit that prior rather than invent paths such as "workspace root means the whole machine" or special attachment APIs that only exist inside Locus.

The rule is:

> **Do not make the model learn Locus. Make Locus look like a small Linux machine.**

This does **not** mean implementing a Linux kernel, POSIX ABI, devices, processes, sockets, or a complete distribution. It means preserving familiar model-facing filesystem and userland conventions while mapping them onto browser-native storage providers.

The current V0.4 implementation conflates two concepts:

```text
virtual machine root /
        =
user-selected external folder
```

That was an effective prototype shortcut, but it is not the target architecture.

A user-selected folder is external storage mounted into the machine. It should therefore look like a mount, not like the machine itself.

---

## 2. Target model-visible machine

The target filesystem presented to the agent is:

```text
/
├── bin/                         # logical compatibility view of common commands
├── usr/
│   ├── bin/                     # system command/userland view
│   ├── lib/
│   │   └── locus/
│   └── local/
│       └── share/
│           └── locus/
│               └── skills/      # system-provided skills, when implemented
│
├── home/
│   └── locus/
│       ├── .skills/             # user/session skills
│       ├── .config/
│       │   └── locus/
│       │       └── mcp/         # MCP discovery/config only, not MCP authority
│       └── .cache/
│           └── locus/
│
├── tmp/                         # writable scratch space
│
└── mnt/
    ├── workspace/               # optional user-authorized external directory
    ├── upload/                  # user-provided input files; read-only to agent
    ├── download/                # agent-generated artifacts; writable/exportable
    └── plugins/                 # future plugin mounts
        └── <plugin-id>/
```

Not every directory needs a rich implementation on day one. The topology is the contract.

Locus must not fabricate fake Linux state merely for decoration. In particular, VFS v1 does not require fake `/proc`, `/sys`, `/dev`, package databases, daemons, users, devices, or kernel information.

---

## 3. Process environment

The agent-facing machine should use familiar environment semantics:

```text
HOME=/home/locus
PATH=/usr/local/bin:/usr/bin:/bin
TMPDIR=/tmp
```

Default working directory:

```text
if /mnt/workspace is mounted:
    PWD=/mnt/workspace
else:
    PWD=/home/locus
```

This preserves ordinary model behavior:

```bash
ls
cat README.md
python script.py
```

still naturally acts on the mounted project when one exists, while the machine remains valid even when no external folder is mounted.

The shell may continue to use invocation-local cwd semantics unless/until persistent shell sessions are deliberately introduced.

---

## 4. Core principle: the machine exists without an external workspace

Today, no mounted workspace effectively means "no filesystem".

That must stop being true.

Without an external folder, the machine should still look like:

```text
/
├── usr/
├── home/
│   └── locus/
├── tmp/
└── mnt/
    ├── upload/
    ├── download/
    └── plugins/
```

Therefore this is a complete lightweight workflow:

```text
user uploads files
        ↓
/mnt/upload
        ↓
bash / Python / future JS
        ↓
/mnt/download
        ↓
explicit browser download
```

Mounting an external directory is an additional authority/capability, not a prerequisite for the runtime to exist.

---

## 5. Mount table

The filesystem layer should converge on an always-present `VirtualWorkspace` / VFS object that implements the same filesystem authority consumed by shell commands and runtimes.

Conceptually:

```text
                         Agent
                           │
                         bash
                           │
                           ▼
                    Locus VFS API
                           │
                     MountTable
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
     InternalFS       ExternalFS        Virtual/SystemFS
   /home, /tmp       /mnt/workspace       /usr, /bin
   /mnt/download
                           │
                           ▼
                FileSystemDirectoryHandle

Additional mounts:
  /mnt/upload       → uploaded browser File objects
  /mnt/plugins/*    → future plugin filesystem providers
```

Routing uses normalized absolute paths and longest-prefix mount resolution.

Example:

```text
/mnt/workspace/src/app.js
→ mount /mnt/workspace
→ relative path src/app.js
→ LocalDirectoryWorkspace

/mnt/upload/data.csv
→ mount /mnt/upload
→ relative path data.csv
→ UploadWorkspace

/home/locus/.skills/foo.md
→ internal home filesystem

/usr/bin/grep
→ read-only system/userland filesystem
```

Filesystem providers must not need to know the full global path; the mount table passes a relative path into the selected provider.

---

## 6. Mount semantics

### 6.1 `/mnt/workspace`

Provider:

`LocalDirectoryWorkspace` backed by File System Access API.

Properties:

- optional;
- user-authorized;
- read/write according to browser permission;
- external state may change outside Locus;
- existing conflict detection semantics remain required;
- mounting/changing/unmounting the workspace is a session boundary;
- default cwd becomes `/mnt/workspace` while mounted.

The previous V0.4 mapping:

```text
external folder → /
```

is a compatibility-era implementation and is intentionally replaced by:

```text
external folder → /mnt/workspace
```

This is a deliberate model-visible topology change and therefore requires a new observation baseline.

### 6.2 `/mnt/upload`

Provider:

browser-selected `File` objects or an equivalent local upload-backed filesystem.

Properties:

- always present as a directory;
- user files appear here after explicit upload;
- read-only to the agent;
- no automatic network transfer;
- page/session-lifetime in VFS v1 unless durability is separately designed;
- duplicate filename behavior must be deterministic and visible.

Agent writes, removes, renames, or mkdir operations inside this mount must fail before mutation with a clear read-only-filesystem error.

Uploaded data is source material, not an editable working copy.

### 6.3 `/mnt/download`

Provider:

initially an in-memory artifact filesystem; future durability may use another provider.

Properties:

- always present;
- read/write;
- page/session-lifetime in VFS v1;
- files are exposed by the UI as explicitly downloadable artifacts;
- writing a file here does not automatically download or upload anything;
- user explicitly chooses when a browser download occurs.

This is the preferred destination for derivative artifacts when no external workspace output path was requested.

### 6.4 `/mnt/plugins`

This namespace is reserved for future plugin mounts.

Target shape:

```text
/mnt/plugins/spreadsheet/
/mnt/plugins/pdf/
/mnt/plugins/document/
```

A plugin mount may carry:

- Python packages;
- JS/WASM code;
- plugin metadata;
- assets;
- plugin-provided Skills.

Installed plugin files should normally be read-only to ordinary agent tasks.

The plugin system does not need to exist for VFS v1, but the namespace must be reserved now so later extension work does not invent another topology.

---

## 7. Home and skills

Locus has a conventional user home:

```text
/home/locus
```

User/session Skills belong at:

```text
/home/locus/.skills/
```

System-provided Skills belong at:

```text
/usr/local/share/locus/skills/
```

This mirrors the familiar distinction between per-user configuration/knowledge and system-installed resources.

A future Skill loader may apply precedence such as:

```text
user skill
  overrides / augments
system skill
```

but VFS v1 only reserves the topology.

Skills add knowledge. They do not gain authority by living in the filesystem.

---

## 8. MCP is not a filesystem mount

MCP adds authority and access to remote/external systems.

Therefore Gmail, GitHub, Slack, databases, and similar MCP capabilities must **not** be represented as magical directories under `/mnt`.

Configuration/discovery may live under:

```text
/home/locus/.config/locus/mcp/
```

but the actual capability remains a harness/provider boundary.

Conceptually:

```text
~/.config/locus/mcp/
        │
        └── configuration / discovery metadata

Harness capability registry
        │
        └── actual MCP authority, credentials, approvals, actions
```

Filesystem presence is not authority.

---

## 9. System/userland view

The shell command registry and the filesystem should eventually agree about installed userland.

Conceptually:

```text
SHELL_COMMANDS registry
        │
        ├── executor dispatch
        ├── help output
        ├── system prompt capability description
        └── /usr/bin + /bin virtual command view
```

For example, if the runtime supports:

```text
cat
curl
echo
find
grep
head
ls
mv
python
pwd
rm
tail
wc
```

then `ls /usr/bin` should expose the same installed command set.

VFS v1 does not require ELF executables or actual subprocess execution. These are virtual userland entries backed by the shell registry.

Do not add shell commands merely to make `/usr/bin` look more Linux-like. The filesystem view reflects real capabilities; it does not fabricate them.

---

## 10. Scratch space

`/tmp` is ordinary writable scratch space.

Properties:

- always present;
- writable;
- local/tab lifetime in VFS v1;
- not automatically exposed as a download;
- not part of the external workspace;
- visible to shell and execution runtimes;
- safe for intermediate artifacts.

This enables familiar workflows:

```bash
python build_report.py > /tmp/report.txt
mv /tmp/report.txt /mnt/download/report.txt
```

No external workspace is required.

---

## 11. One filesystem namespace across runtimes

The long-term invariant is:

> Shell, Python, future JavaScript, Plugins, and deterministic edit all refer to the same Locus VFS paths.

Today:

```text
shell sees /
Python sees an internal /workspace mirror
```

That is an implementation gap.

Target:

```text
                 Locus VFS
                    │
        ┌───────────┼────────────┐
        │           │            │
       bash       Python        JS
        │           │            │
        └───────────┼────────────┘
                    │
       same model-visible paths
```

At minimum:

```text
/mnt/workspace/data.csv
/mnt/upload/input.csv
/mnt/download/result.csv
/home/locus/...
/tmp/...
```

must mean the same thing from shell and Python.

### 11.1 Transitional Python implementation

VFS v1 may still use snapshot/diff internally if a direct filesystem bridge is not ready.

That implementation detail must not leak into model-visible paths.

A transitional architecture may be:

```text
Locus VFS
   │
   ├── collect/snapshot
   ▼
Pyodide mirror
   │
   ├── expose /mnt/workspace
   ├── expose /mnt/upload
   ├── expose /mnt/download
   ├── expose /home/locus
   └── expose /tmp
   │
execute Python
   │
diff writable mounts only
   │
   ▼
Locus VFS commit
```

The old `/workspace` path becomes an internal compatibility detail, not the public filesystem contract.

Read-only mounts must remain read-only across the Python boundary. A runtime must not be allowed to modify `/mnt/upload` merely because its internal mirror happens to be writable.

P4 may later replace snapshot/diff with on-demand or incremental filesystem bridging without changing model-visible paths.

---

## 12. Filesystem authority classes

Each mount/provider declares its mutation authority.

Suggested VFS-level classes:

```text
read-only
read-write
external-read-write
system-read-only
```

Initial mapping:

| Path | Provider | Authority |
|---|---|---|
| `/usr`, `/bin` | System/Userland FS | system-read-only |
| `/home/locus` | Internal FS | read-write |
| `/tmp` | Internal scratch FS | read-write |
| `/mnt/workspace` | External workspace | external-read-write |
| `/mnt/upload` | Upload FS | read-only |
| `/mnt/download` | Artifact FS | read-write |
| `/mnt/plugins/*` | Plugin mounts | normally system-read-only |

This is filesystem authority, not the full P6 external-action permission model.

---

## 13. Protected mount roots

Locus should preserve the existing safety philosophy that refuses obviously catastrophic root deletion.

Recursive deletion of VFS structural roots must be refused:

```text
/
 /usr
 /home
 /home/locus
 /mnt
 /mnt/workspace
 /mnt/upload
 /mnt/download
 /mnt/plugins
```

Children may be mutable according to their provider.

In particular:

```bash
rm -rf /mnt/workspace
```

must not wipe the entire mounted external folder merely because V0.4's old protected root moved from `/` to `/mnt/workspace`.

Mount-root protection is a harness safety contract; it does not claim perfect GNU `rm` equivalence.

---

## 14. Cross-mount operations

Mount boundaries are real.

The VFS must detect when source and destination resolve to different providers.

### Read/write

Cross-mount reads and writes are ordinary if the caller explicitly reads from one mount and writes to another.

Example:

```text
/mnt/upload/input.csv
  → Python reads
  → /mnt/download/result.csv
```

### `mv`

A move across mounts cannot rely on provider-native rename.

For VFS v1:

- preflight both mount authorities;
- if the source mount is read-only, reject the move before creating a partial destination;
- otherwise use bounded copy → read-back verify → delete-source semantics;
- preserve current cancellation/partial-commit honesty;
- never silently pretend a cross-mount rename was atomic.

A future `cp` command may make read-only-source workflows more convenient, but VFS v1 must not add shell commands solely to satisfy this architecture document.

---

## 15. Path normalization and mount resolution

All model-visible paths are normalized before provider routing.

Requirements:

- canonical absolute VFS path;
- reject traversal above `/`;
- preserve filenames as data;
- no Windows drive paths in the model-visible namespace;
- mount resolution by longest matching normalized prefix;
- a provider only sees paths relative to its mount root.

Examples:

```text
/mnt/workspace/a/../b
→ /mnt/workspace/b

../../etc
→ rejected at VFS root confinement

/mnt/upload/foo
→ mount /mnt/upload + relative foo
```

The user's real OS path is never exposed merely because a folder is mounted.

---

## 16. Mount collisions and reserved paths

The VFS owns the machine namespace.

A mounted external folder is rooted at `/mnt/workspace`, so its internal names can no longer collide with global VFS paths such as `/usr`, `/home`, or `/mnt/upload`.

This is one of the reasons to stop mapping the external folder directly to `/`.

Inside the external folder, a real directory named `mnt` is simply:

```text
/mnt/workspace/mnt
```

and has no special global meaning.

Reserved global paths therefore remain deterministic.

---

## 17. Session and mount lifecycle

The VFS object itself should exist for the lifetime of the page/runtime.

Mount lifecycle differs by mount type.

### External workspace

Changing `/mnt/workspace`:

- cancels active work;
- resets the AgentSession generation/history boundary as current workspace switching does;
- rebuilds Python filesystem state;
- updates default cwd.

### Upload mount

Adding/removing uploaded files:

- should occur only through explicit user action;
- must not happen in the middle of a tool mutation without defined synchronization;
- does not inherently require a new model/provider session when idle;
- must be visible immediately to subsequent tools.

### Download mount

Files appear as tools/runtimes commit artifacts.

Clearing downloads is explicit user action.

### Plugin mounts

Installing/removing/changing plugins changes available code/capabilities and should be treated as a capability/session boundary when implemented.

---

## 18. UI consequences

The UI should expose filesystem concepts, not invent separate content channels.

### Upload

The existing `Upload files` control should place selected files into:

```text
/mnt/upload
```

The UI may show chips with their VFS paths, but the files themselves stay local.

### Mount folder

The existing folder picker mounts the chosen directory at:

```text
/mnt/workspace
```

The user-facing label may still display the folder name.

### Download artifacts

The UI should enumerate files committed under:

```text
/mnt/download
```

and expose explicit browser download actions.

Writing to `/mnt/download` is not itself a browser download.

### Empty state

The UI must stop claiming that file tasks require a mounted external folder.

A task may use:

- uploaded files;
- home;
- tmp;
- generated artifacts;

without `/mnt/workspace`.

---

## 19. Model prompt consequences

The model should be told a small amount of conventional machine information, not a large Locus-specific manual.

Example direction:

```text
You are running on a small Linux-like browser machine.

HOME=/home/locus
Default cwd is /mnt/workspace when a workspace is mounted, otherwise /home/locus.

Mounted paths:
- /mnt/workspace — user-authorized working folder, if present
- /mnt/upload — user-uploaded input files, read-only
- /mnt/download — writable output artifacts downloadable by the user
- /mnt/plugins — installed plugin files, when available

/tmp is writable scratch space.
```

The shell itself should remain discoverable through ordinary commands and `help`.

Do not dump the entire VFS architecture into every system prompt.

---

## 20. Architecture layers after VFS v1

```text
+-------------------------------------------------------+
|                        Agent                          |
+-------------------------------------------------------+
|              Linux-like userland surface              |
|                                                       |
| bash / python / future js / edit / ordinary paths     |
+-------------------------------------------------------+
|                    Locus VFS                          |
|                                                       |
| path normalization | mount table | authority | commit |
+-------------+------------------+----------------------+
| SystemFS    | InternalFS       | Mounted providers    |
| /usr,/bin   | /home,/tmp       | /mnt/*               |
+-------------+------------------+----------------------+
                                  |
              +-------------------+--------------------+
              |                   |                    |
      FileSystemDirectoryHandle  File objects      Plugin FS
        /mnt/workspace          /mnt/upload       /mnt/plugins/*
                                  |
                           Artifact FS
                           /mnt/download
```

Execution runtimes sit **above** this filesystem abstraction.

They must not each invent their own model-visible filesystem topology.

---

## 21. Relationship to Plugins, Skills, and MCP

The existing boundary remains:

> **Plugin adds code. Skill adds knowledge. MCP adds authority.**

Filesystem placement follows that distinction:

```text
Plugins:
  mounted code/assets → /mnt/plugins/<id>
  optional installed view → /usr/local/lib/locus/plugins/<id> later

Skills:
  user → /home/locus/.skills
  system → /usr/local/share/locus/skills

MCP:
  optional config/discovery → /home/locus/.config/locus/mcp
  actual authority → Harness capability provider, NOT a filesystem mount
```

No filesystem path silently grants external authority.

---

## 22. Migration from V0.4

Current behavior:

```text
no selected folder
  → workspace = null
  → most filesystem commands unavailable

selected folder
  → folder contents appear at /
  → Python mirrors them under internal /workspace
```

Target behavior:

```text
machine always exists
  → /home/locus
  → /tmp
  → /mnt/upload
  → /mnt/download
  → /usr userland view

optional selected folder
  → /mnt/workspace
  → becomes default cwd

Python
  → uses the same model-visible data paths
```

This is intentionally behavior-changing.

Therefore:

- do not mutate `v0.4-observation.1`;
- land VFS work on a development branch;
- run full regression and real mobile/browser tests;
- freeze a new observation baseline after VFS + other V0.4.1 blockers are resolved.

---

## 23. VFS v1 implementation boundary

VFS v1 should implement:

- an always-present VFS/mount table;
- internal `/home/locus` and `/tmp`;
- read-only system/userland directory view sufficient for real installed commands;
- optional `/mnt/workspace`;
- read-only `/mnt/upload`;
- writable `/mnt/download`;
- reserved `/mnt/plugins`;
- shell path routing through the VFS;
- Python access to the same model-visible data paths;
- UI upload → `/mnt/upload`;
- UI artifact download from `/mnt/download`;
- mount-root protection;
- tests for no-workspace operation and cross-mount behavior.

VFS v1 should **not** implement:

- plugin loader;
- Skill loader;
- MCP runtime;
- OPFS durability for home/downloads;
- POSIX ownership/permissions;
- symlink-complete semantics;
- `/proc`, `/sys`, `/dev`;
- arbitrary device files;
- persistent shell sessions;
- new shell commands merely for aesthetic Linux completeness;
- Python incremental/on-demand bridge optimization unless required for correctness.

The first objective is topology correctness and one coherent machine model.

---

## 24. Acceptance invariants

VFS v1 is acceptable when all of these are true:

1. `pwd` returns `/home/locus` with no workspace mounted.
2. Mounting an external folder changes default cwd to `/mnt/workspace`.
3. `ls /` shows the stable Linux-like top-level namespace, not the user's folder contents.
4. `ls /mnt/workspace` shows the mounted external folder when present.
5. Uploading `foo.csv` makes `/mnt/upload/foo.csv` readable from shell and Python.
6. Agent writes to `/mnt/upload` fail as read-only.
7. Shell and Python can both create/read `/mnt/download/result.*`.
8. The UI can explicitly download files from `/mnt/download`.
9. Shell and Python agree on `/mnt/workspace`, `/mnt/upload`, `/mnt/download`, `/home/locus`, and `/tmp` paths.
10. `/usr/bin` reflects actual registered shell/userland commands instead of a fake command catalog.
11. `rm -rf /` and recursive deletion of protected mount roots are refused.
12. External real OS paths are never exposed to the model.
13. A task can complete upload → compute → download without any external workspace mount.
14. Existing workspace conflict/cancellation semantics remain honest.
15. No file is transmitted off-device merely because it was uploaded or mounted.

---

## 25. Final design principle

The browser implementation is unusual.

The machine presented to the model should not be.

> **A Locus tab should look like a small Linux machine whose storage and execution providers happen to be implemented by the browser.**
