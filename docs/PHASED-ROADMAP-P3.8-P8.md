# Locus Phased Roadmap: Observation to Adaptive Runtime

Status: staged architecture plan  
Baseline: `v0.4-observation.1`  
Baseline SHA: `c49623d50cc1182531bda92af210a8a0d2453985`

This document describes the staged path from the current frozen observation baseline to a mature, extensible, authority-aware agent runtime.

It is intentionally more opinionated than `ROADMAP.md`: each phase has one governing question, explicit exit criteria, and explicit non-goals.

The sequence is:

```text
P3.8  Observe real model behavior
  ↓
P4    Complete and freeze the runtime substrate
  ↓
P5    Move domain capabilities into an extension layer
  ↓
P6    Add authority-aware escalation and provider routing
  ↓
P7    Make extensions and the product safely distributable
  ↓
P8+   Learn adaptive execution/routing policies from real traces
```

The central rule is:

> Do not add a capability merely because it is useful. Add it at the lowest layer that can express it honestly.

And the execution principle remains:

> Model decides WHAT. Harness decides WHERE.

---

## Current frozen baseline

The observation baseline currently fixes:

- Vue P3/P3.1 presentation;
- `AgentSession`;
- provider-neutral model adapter boundary;
- Unix-like shell compatibility baseline;
- shell composition and redirection;
- bounded workspace filesystem mutation;
- correct recursive directory `mv` semantics;
- browser-native public network execution;
- Pyodide Python execution;
- default model `deepseek-flash`;
- default endpoint `https://api.deepseek.com/anthropic`;
- `REAL-WORLD-50` benchmark corpus;
- first-batch optional plugin requirements for Spreadsheet, Document, and PDF.

The tag `v0.4-observation.1` is immutable.

The channels are:

```text
main
  development channel

telemetry/stable
  observation channel
```

`telemetry/stable` must not be routinely rebased onto `main`.

If behavior materially changes, create a new observation baseline instead of silently mutating the existing one.

---

# P3.8 — Observation Layer

## Governing question

> How do real models actually use Locus?

P3.8 exists to replace intuition-driven roadmap decisions with observed execution behavior.

The goal is not to maximize benchmark score yet.

The goal is to make Locus an honest instrument for observing model trajectories.

## P3.8A — Telemetry Schema v1

Build a privacy-preserving event schema that records execution structure without collecting user content.

At minimum, records should identify:

### Build identity

- telemetry schema version;
- build SHA;
- observation tag;
- timestamp.

### Task identity

- session id;
- task id;
- turn index;
- model;
- provider/dialect.

### Execution structure

- tool;
- operation family;
- backend;
- duration;
- input/output byte counts;
- success/failure;
- normalized error class.

### Shell structure

Where applicable:

- command families;
- flags;
- operators;
- command count;
- pipeline length;
- unsupported command/flag/operator;
- path argument count;
- path shape rather than path contents.

### Runtime cost signals

- Python workspace sync bytes;
- network bytes;
- filesystem mutation count;
- cancellation;
- whether committed side effects existed after cancellation.

## Privacy rule

Default telemetry must not record:

- full prompts;
- reasoning;
- complete shell commands;
- tool result bodies;
- file contents;
- actual filenames;
- complete local paths;
- API keys;
- cookies;
- authorization headers;
- URL secrets/query tokens;
- extracted PDF/DOCX/XLSX contents.

Record structure, not private content.

## P3.8B — Local append-only storage

Use browser-local durable storage for observation records.

Preferred first implementation:

```text
OPFS
└── locus-telemetry/
    ├── manifest.json
    ├── events-0001.jsonl
    ├── events-0002.jsonl
    └── ...
```

Requirements:

- append-oriented;
- bounded;
- rotation;
- schema versioned;
- exact build identity;
- no silent remote upload;
- corruption-tolerant enough that one malformed line does not destroy the whole dataset.

## P3.8C — Explicit export

Telemetry leaves the browser only through an explicit user action.

Required UX:

- Export telemetry;
- Clear telemetry;
- show approximate stored size / record count.

Clearing telemetry must not affect:

- conversations;
- workspace files;
- provider history;
- settings.

## P3.8D — Offline analysis

Add an offline analyzer, initially something simple such as:

`scripts/analyze-telemetry.py`

First-version outputs should include:

- task count;
- tool turns per task: mean/P50/P90/P95;
- bash/python/network usage;
- command/flag/operator frequencies;
- unsupported feature ranking;
- error-class ranking;
- repeated failure rate;
- failure -> recovery transition matrix;
- Local Execution Rate;
- browser-direct vs edge-relay share;
- latency percentiles;
- Python workspace sync bytes: P50/P95/max;
- filesystem mutation counts;
- committed-after-cancel occurrences;
- per-model differences when multiple models are tested.

The highest-value report is likely:

```text
failure → next action
```

Example:

```text
unsupported sed
  → python          61%
  → grep            18%
  → retry sed        9%
  → other           12%
```

This shows whether a missing command is actually expensive or whether models recover cheaply.

A useful prioritization heuristic is:

```text
priority ≈ frequency × failure impact × recovery cost
```

## P3.8E — Benchmark observation runs

Do not begin with all 50 tasks.

Start with roughly 10 `core-now` smoke tasks spanning:

- filesystem organization;
- text extraction;
- CSV analysis;
- code search;
- inspect -> decide -> mutate -> verify;
- public network -> local processing;
- multi-step recovery;
- Python-heavy work;
- shell-heavy work;
- mixed workflows.

First run with the frozen default model.

The first purpose is to validate telemetry itself:

> Did we record the data needed to explain success, failure, cost, and recovery?

Only after schema quality is confirmed should the full `core-now` set be run.

## P3.8 exit criteria

P3.8 is complete when:

- telemetry schema v1 is stable enough for repeated observation;
- records persist locally;
- export works explicitly;
- privacy review finds no default content leakage;
- analyzer produces useful aggregate/recovery reports;
- a smoke benchmark run has been completed;
- the full current core task set has been observed at least once;
- the data is sufficient to prioritize P4 work.

## P3.8 non-goals

- telemetry cloud service;
- dashboard product;
- remote analytics ingestion;
- new runtime capabilities;
- shell command expansion;
- plugin implementation;
- P4 work hidden inside instrumentation.

---

# P4 — Runtime Substrate Completion

## Governing question

> What is the smallest complete local runtime substrate that real workloads require?

P4 should be prioritized by P3.8 evidence rather than by aesthetic roadmap order.

The likely candidates are below, but their order is not frozen.

## P4A — Filesystem bridge / Python sync redesign

Current Python execution may require large workspace snapshots.

The target architecture should move from:

```text
workspace
  → full snapshot into Pyodide
  → execute
  → diff
  → write back
```

toward:

```text
Python
JavaScript
plugins
    ↓
shared / on-demand filesystem capability
    ↓
workspace
```

Goals:

- reduce repeated full-workspace copying;
- read files on demand where practical;
- preserve cancellation and confinement;
- keep deterministic mutation semantics;
- expose byte-cost telemetry.

If observation data shows Python sync dominates runtime cost, this becomes the first P4 item.

## P4B — Deterministic edit capability

Add a reliable editing primitive for tasks where shell/Python free-form editing is unnecessarily fragile.

Candidate semantic operations:

- read;
- write;
- exact replace;
- insert;
- rename/delete where appropriate.

Requirements:

- absent match -> fail clearly;
- ambiguous exact match -> fail clearly;
- no silent multi-replace unless requested;
- cancellation-aware;
- committed-side-effect reporting;
- workspace confinement.

The final model-facing shape should be selected based on reliability evidence:

- structured tool;
- shell-compatible command;
- or another minimal interface.

Do not choose merely for aesthetic consistency.

## P4C — Unified network capability

Today, some execution paths can bypass the main network abstraction.

The target should be:

```text
curl
Python
JavaScript
plugins
    ↓
Network Capability
    ↓
browser-direct / edge-relay / future provider
```

This makes networking:

- observable;
- bounded;
- policy-aware;
- replaceable;
- consistent across runtimes.

## P4D — JavaScript userland runtime

Add isolated JavaScript execution only if observation data justifies it.

Requirements:

- dedicated Worker;
- no DOM access;
- no API-key/session access;
- no application globals;
- explicit bridge;
- timeout/cancellation;
- recovery semantics comparable to Python.

## P4 exit criteria — Core Capability Freeze

The runtime should be explainable as three substrate capabilities:

```text
Execution
Filesystem
Network
```

Above them:

```text
Unix-like model interface:
  bash
  deterministic edit

Userland:
  Python
  JavaScript
  curl
  file utilities
```

A new core feature proposal after P4 must explain why it cannot be implemented through:

- Execution + Filesystem + Network;
- Plugin;
- Skill;
- MCP;
- execution backend/provider.

## P4 non-goals

- domain-specific Office tools in core;
- Gmail/Slack/GitHub authority in core;
- full browser automation;
- cloud execution as default;
- capability expansion unsupported by observed workloads.

---

# P5 — Extension Layer

## Governing question

> How can Locus gain domain capabilities without growing the core tool surface?

P5 turns the architectural boundary into a real extension system.

The invariant remains:

> Plugin adds code. MCP adds authority. Skill adds knowledge.

## P5A — Capability Registry

Introduce a provider-neutral registry for available capabilities.

It should describe:

- capability id;
- availability;
- required substrate capabilities;
- runtime/provider;
- authority level;
- dependencies;
- version;
- resource requirements;
- discovery metadata.

The registry should help the harness answer:

> Can this environment perform this operation, and through which provider?

## P5B — Plugin system

Plugins add implementation code or libraries above the substrate.

First target plugins:

1. Spreadsheet;
2. Document;
3. PDF.

Use the existing plugin requirement documents as acceptance contracts.

The plugin loader should start intentionally small.

Do not start with a marketplace.

Possible later plugins:

- Pillow;
- BeautifulSoup;
- DuckDB-WASM;
- ffmpeg.wasm;
- archive formats;
- compilers;
- OCR engines.

## P5C — Skills

Skills add workflow knowledge without adding authority.

Examples:

- safe spreadsheet editing;
- document-preservation workflow;
- repository modification workflow;
- output validation workflow.

Skills should teach composition and verification, not provide credentials or hidden execution.

## P5D — MCP boundary

MCP/connectors add authority or durable remote state.

Examples:

- GitHub;
- email;
- Slack;
- Jira;
- Notion;
- databases;
- enterprise APIs;
- remote/shared knowledge systems.

Credentials and permissions remain explicit.

## First P5 vertical slice

The first meaningful P5 proof should be:

```text
Spreadsheet plugin
+ spreadsheet Skill
+ existing runtime substrate
→ solve real spreadsheet benchmark tasks
```

without:

- changing AgentSession architecture;
- adding a pile of spreadsheet-specific core tools;
- granting external account authority.

Repeat for Document and PDF.

## P5 exit criteria

P5 is complete when:

- capability registry exists;
- at least one plugin can be installed/discovered/used;
- plugin failure does not break core;
- one plugin+Skill vertical slice passes realistic benchmark tasks;
- Spreadsheet/Document/PDF can be added without expanding core primitives;
- MCP authority remains clearly separate.

## P5 non-goals

- large marketplace;
- hundreds of narrow tools;
- automatic trust of third-party plugins;
- hiding remote authority inside ordinary plugins.

---

# P6 — Authority and Escalation Layer

## Governing question

> When local/browser execution is insufficient, how does Locus safely escalate?

P6 completes the principle:

> Model decides WHAT. Harness decides WHERE.

## P6A — Authority model

Define capability/authority classes such as:

- workspace read;
- workspace write;
- workspace destructive mutation;
- public network;
- authenticated account access;
- browser session control;
- cloud execution;
- external side effect.

Each provider declares its required authority.

The harness can then determine:

- silently allow;
- notify;
- request approval;
- deny.

Permission should govern authority consistently rather than being implemented separately for each command.

## P6B — Execution providers

Possible providers:

- browser-local Python;
- browser-local JavaScript/WASM;
- WebContainer-style environment;
- native/local desktop provider;
- cloud sandbox / `cloud_bash`.

Cloud execution is escalation, not default.

## P6C — Authenticated browser provider

Authenticated browser automation is a separate authority boundary from public HTTPS fetch.

It includes:

- user session/cookies;
- DOM interaction;
- authenticated web applications;
- potentially irreversible external actions.

It must not be smuggled into `curl`.

## P6D — Capability routing

The harness should route according to factors such as:

- required capability;
- data locality;
- authority;
- reliability;
- cost;
- latency;
- availability.

Example:

```text
Task intent
   ↓
required capability set
   ↓
available providers
   ↓
locality / authority / cost / reliability policy
   ↓
chosen execution environment
```

This is where Locus's architectural thesis becomes executable policy.

## P6 exit criteria

P6 is complete when:

- authority classes are explicit;
- at least two execution environments can provide the same abstract capability;
- routing is transparent and observable;
- escalation is user-visible where appropriate;
- external side effects follow a coherent approval policy;
- cloud is a fallback/provider rather than the default machine.

## P6 non-goals

- silently granting credentials;
- provider-specific policy scattered through tools;
- treating browser automation as ordinary public networking;
- automatic cloud use without policy.

---

# P7 — Distribution and Ecosystem

## Governing question

> Can another person safely install, use, and extend Locus?

P7 converts architecture into a distributable product and extension ecosystem.

## P7A — Extension packaging

Define stable packaging/version rules for:

- Plugins;
- Skills;
- MCP integration metadata.

Needs may include:

- ids;
- semantic versions;
- compatibility ranges;
- dependencies;
- integrity hashes/signatures;
- update/rollback behavior.

## P7B — Safe installation

Installation must make clear:

- what code is being added;
- what authority it requires;
- what runtime dependencies it uses;
- whether it can access network/workspace/external services.

Third-party code should not inherit unlimited authority merely because the user installed it.

## P7C — Product seams become real

Current placeholder/demo seams should mature where justified:

- file upload runtime pipeline;
- actual terminal view;
- durable conversation persistence;
- capability/plugin management UI;
- connection/authority management.

## P7D — Release evaluation

Real-world benchmarks should become part of release quality.

A release report should be able to compare:

- task success;
- regressions;
- latency;
- tool turns;
- Local Execution Rate;
- fallback/escalation rate;
- repeated failures;
- cost/byte movement where measurable.

## P7E — Registry / discovery later

Only after packaging and trust semantics are sound should Locus consider:

- extension registry;
- discovery;
- ratings;
- marketplace-like UX.

A marketplace is not an MVP requirement.

## P7 exit criteria

P7 is complete when:

- another user can install and remove an extension safely;
- extension compatibility/version failures are understandable;
- authority requirements are visible;
- upgrade/rollback has defined semantics;
- core product seams no longer rely on fake/reserved UI;
- releases can be compared with real-world benchmark evidence.

---

# P8+ — Adaptive Runtime

## Governing question

> Can the harness learn which execution route works best from real trajectories?

P8 begins only after enough telemetry exists to support decisions.

The system should eventually reason about observations such as:

```text
Model A + task class X:
Python success 98%, mean 3.4 turns

JavaScript success 82%, mean 5.1 turns

Cloud success 99%, much higher cost
```

Then a policy might learn:

```text
prefer Python
→ fall back to JavaScript when appropriate
→ escalate to cloud only when needed
```

## Adaptive routing dimensions

Potential signals:

- task/capability class;
- model identity;
- historical success rate;
- recovery cost;
- local execution rate;
- latency;
- byte movement;
- authority cost;
- monetary cost;
- provider availability.

The long-term architecture becomes:

```text
                    capability graph
                          ↓
model → intent → harness router
                          ↓
      browser / WASM / MCP / browser-control / cloud
```

Locus then behaves less like a fixed list of tools and more like a model-independent execution layer.

## Possible later research directions

These should remain evidence-driven rather than roadmap obligations.

### Local/edge inference

Potential uses:

- classification;
- embeddings;
- OCR;
- local transforms;
- small routing models.

### Retrieval / knowledge

A likely boundary remains:

```text
ephemeral local retrieval
  → Plugin + Skill

durable/shared remote knowledge
  → MCP / external authority
```

Do not make generic RAG a core primitive without evidence.

### Multi-agent execution

Do not add multi-agent architecture merely because it is fashionable.

Add it only when real workload data demonstrates that:

- parallel specialists;
- planner/executor separation;
- delegated subagents;

materially improve outcome/cost/reliability beyond a single `AgentSession` with capabilities.

---

# Stage transition rules

The roadmap should move forward based on evidence.

## P3.8 → P4

Proceed when observation data clearly identifies the most expensive core substrate gaps.

## P4 → P5

Proceed when the local runtime substrate can be treated as frozen enough that domain capabilities no longer need new primitives.

## P5 → P6

Proceed when extension composition works locally and the next hard problems are authority and execution-environment escalation.

## P6 → P7

Proceed when capabilities/providers can be routed safely enough to expose them to ordinary users.

## P7 → P8

Proceed only when enough high-quality traces exist to justify adaptive routing.

---

# Architectural invariants across all phases

1. Browser-local execution is preferred when it can reliably complete the task.
2. Data locality matters.
3. Least authority is preferred.
4. Cloud is escalation, not default.
5. Provider-native model semantics are preserved.
6. Presentation state never reconstructs provider history.
7. Plugins do not secretly add authority.
8. Skills do not secretly add authority.
9. MCP/external connectors make authority explicit.
10. Cancellation and partial side effects are reported honestly.
11. New core features require stronger justification after P4.
12. Real workload evidence outranks architectural fashion.

The long-term target is not merely:

> an agent that can run Python in a browser.

The target is:

> a model-independent agent operating layer in which a browser tab is the first execution machine, not the only one.
