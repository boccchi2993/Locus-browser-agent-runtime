# Repository split M3a — Runtime extraction record

Status: M3a deliverable (documentation-only branch — NO product code change;
the product's Runtime implementation is untouched and keeps working).
Source baseline of the extraction: this repository @
`2aec76e78431382873be1db8a6db6310cc89c782` (`refactor/repository-split-m2c`,
head of OPEN PR #7 — the same commit this branch stacks on). Companion
documents: [REPOSITORY-SPLIT.md](REPOSITORY-SPLIT.md) §7 M3,
[REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md),
[REPOSITORY-SPLIT-M2C-VERIFICATION.md](REPOSITORY-SPLIT-M2C-VERIFICATION.md)
(§8.3 — the F3 evidence correction referenced below).

## 1. What was created

| Item | Value |
|---|---|
| Target repository | https://github.com/boccchi2993/locus-runtime (PUBLIC — same visibility as this repository; created for this round; the name was unoccupied) |
| Minimal main | `5bedeeb` — LICENSE (Apache-2.0, verbatim), provenance, README marked "extraction pending" |
| Extraction branch | `refactor/extract-runtime`, head `f620f42` (implementation + docs + CI) |
| Extraction PR | https://github.com/boccchi2993/locus-runtime/pull/1 (`refactor/extract-runtime` → `main`, **OPEN — not merged**) |
| CI | GitHub Actions workflow on the target repo; first PR-branch run GREEN (run 36883712482): unit (23 suites, 1216 checks), build + pack content check + boundary gate, out-of-repo tarball consumer (headless Chrome), full browser gate set (8 suites) |

Import method: **snapshot import from the pinned commit** — no history
filter/rewrite, no new commits attributed to the original authors. Per-file
source→target mapping, the deleted assembly mechanisms, the API deltas and
the two new TEST-ONLY seams are recorded in the target repository:
`docs/EXTRACTION-PLAN.md`; licensing/third-party notes:
`docs/PROVENANCE.md`; per-suite test migration mapping (incl. the
stayed-behind list and the count reconciliation):
`docs/TEST-COVERAGE-MAP.md`; gate evidence, first failures, F3 facts and the
honest boundary: `docs/M3A-VERIFICATION.md`.

## 2. Authority during the dual-implementation window

- The **product repository remains authoritative** until M3c: this
  repository's in-repo Runtime still runs the product, unchanged, and its
  gates still run against it.
- `locus-runtime` @ PR #1 is the **extraction candidate** only. It must not
  be treated as merged or authoritative until its review completes.
- **No parallel feature development** on both copies during this window. A
  defect found on one side is recorded with its diff and a back-port
  requirement — never silently fixed on one side only.
- At M3c the product switches to consuming the external Runtime; the
  in-repo copy is then deleted or reduced to a one-way delegation, together
  with the remaining declared compat surfaces (`__LOCUS_RUNTIME_CORE__`
  tables — already deleted in the extraction —, the classic-script/eval
  loading model, the legacy `Model`/`callModel` wrappers, the
  `persistence.js` replay delegates, the `?e2e=1`/`__LOCUS_HOOKS__` seams).
- Known temporary duplicate: `tests/fixtures/relay/fetch.js` in the target
  repository is a provenance-noted copy of this repository's
  `functions/fetch.js`, used only as the network gates' reference relay;
  its removal/migration gate is recorded in the target's EXTRACTION-PLAN §6.

## 3. Stale-statement correction (per the M2c review record)

`REPOSITORY-SPLIT-INVENTORY.md` §4 step 5 described the M2c sequential-run
`python-authority` failure as "the M0-baseline load-type **flake**, green on
its standalone re-run". That attribution was withdrawn in
[REPOSITORY-SPLIT-M2C-VERIFICATION.md §8.3](REPOSITORY-SPLIT-M2C-VERIFICATION.md):
the **root cause is NOT confirmed** (the enforcement boundary held — zero
requests —; the presentation layer twice surfaced Pyodide's SystemError; the
named deterministic load-generator experiment has not been performed). The
wording in the INVENTORY is hereby corrected to that record; the M0-baseline
occurrence and the unchanged-worker facts stand, but they do not establish a
root cause. No historical first-failure record is rewritten.

M3a added one data point without changing the conclusion: the extracted
Runtime's `e2e-python-authority` (same checks, packaged standalone host
page) ran **56/56 with E3 green on the first attempt** (cold boot 2s, CDN
prewarmed) — consistent with the M2c standalone re-run; still a data point,
not a proof. The follow-up experiment remains open (now tracked on the
Runtime side).

## 4. M3b / M3c follow-ups

1. **M3b — Harness extraction** (`locus-harness`): same method — pin the
   accepted baseline, snapshot import, ESM module conversion over the
   declared `__LOCUS_HARNESS_CORE__` table removal, suite migration with a
   coverage map, standalone gates, tarball consumer, CI. Prerequisite: PR #7
   review completes (this branch's base chain stays intact).
2. **M3c — Product switch**: the product consumes the two external
   repositories at pinned SHAs, removes the in-repo authoritative copies and
   the declared compat surfaces behind their removal gates, and records the
   first dependency-lock tuple (REPOSITORY-SPLIT §6).
3. **F3 follow-up**: the deterministic load-generator experiment against
   the Pyodide exception bridge (owner: Runtime repository now; the source
   record in M2C-VERIFICATION §8.3 stays the historical evidence).
4. **Relay fixture gate**: when M4's lock tuple lands, migrate the network
   gates' relay fixture consumption (target EXTRACTION-PLAN §6).
