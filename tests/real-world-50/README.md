# REAL-WORLD-50 Fixture Space

This directory contains the deterministic local fixture space for REAL-WORLD-50 v1. It is test infrastructure only; it does not change the Locus runtime, provider adapters, VFS, persistence, UI, network, plugins, or telemetry.

## Setup and verification

From the repository root:

```text
python tests/real-world-50/setup.py
python tests/real-world-50/verify.py
```

On this Windows checkout, `py` is an equivalent Python launcher when `python` is not on `PATH`.

`setup.py` removes and recreates `tests/real-world-50/.generated/`, then writes fresh synthetic workspace and upload fixtures. The output is deterministic, including the timestamps used inside XLSX, DOCX, and ZIP containers. `verify.py` independently checks the generated content against the human-only oracle.

## Manual Locus testing

1. Open Locus.
2. Mount only `tests/real-world-50/.generated/workspace`.
3. For upload or plugin tests, select files from `tests/real-world-50/.generated/upload`.
4. Run one task at a time.
5. Before a destructive test, reset the fixtures with `python tests/real-world-50/setup.py` when an isolated run is needed.

**Do not mount `tests/real-world-50` itself.** Mount only `.generated/workspace`; mounting the parent would expose `oracle/` and invalidate the benchmark.

The workspace is intentionally a small, fictional software project plus data-analysis area. It includes source search targets, structured data, logs, rename/move/delete candidates, binary content, synthetic secret-like values, an empty directory, and a mixed-document audit project. All personal-looking records and credential-like values are synthetic test data.

## Stateful modes

### MODE A — isolated (recommended)

Run `setup.py` before each destructive or stateful question. This makes each question reproducible and keeps PASS/FAIL comparisons meaningful.

### MODE B — sequential dogfood

Run all 50 questions in order against one mounted workspace to observe long-lived workspace evolution. Results from this mode are not directly comparable with isolated benchmark results because earlier questions may rename, move, delete, append, or create files.

Tests 30 and 31 create `/home/locus` and `/tmp` during the Locus run; the generator does not pre-populate those runtime-managed locations. NET tests 32–37 require live Internet access and do not use fake network responses.

The generator never launches Locus, drives a browser, calls a model API, runs REAL-WORLD-50, or scores an agent.

## Repository hygiene

`.generated/` is ignored and must not be committed. `oracle/expected.json` is for the human validator only and must never be mounted into an agent-visible workspace. The fixtures are kept below the intended small local test size; they are not an I/O stress benchmark.
