# Locus testing philosophy

Locus tests contracts, not just happy paths.

## 1. Layers

`npm test` covers fast Node/unit contracts.

`npm run test:e2e` uses real Chrome where the browser is part of the claim: OPFS/File System Access semantics, CSP inheritance, Workers, Pyodide, UI approvals, image materialization, and request-counter network oracles.

REAL-WORLD-50 provides deterministic trajectory verification for ordinary agent work.

## 2. Security proof style

“No request occurred” uses request counters, not exception text.

“Approval protected state” covers denial, cancellation, stale decisions, and TOCTOU.

“Replay is safe” covers dangling/uncheckpointed tool suffixes, not only clean conversations.

## 3. Synthetic infrastructure proofs

Synthetic components are acceptable when they isolate an infrastructure contract. Capability Composition uses synthetic descriptors/module payloads so product selection does not contaminate architecture proof.

The boundary under test should remain real.

## 4. Closure gate

Typical closure includes targeted tests, adversarial browser tests, `npm test`, build, full E2E, relevant REAL-WORLD verification, documentation updates, and clean linear integration into `main`.

Exact suite counts evolve; closure reports should state observed counts rather than turning them into permanent architecture facts.

## 5. Load-bearing invariants

Examples:

- intentionally small model tool registry;
- no Python user-phase network;
- verified Pyodide bootstrap;
- no ambiguous retry of side effects;
- provider-native replay preservation;
- immutable TaskEnvironment identity;
- explicit Skill mutation confirmation;
- private SkillInstances;
- empty production extension catalogs until product selection.

## 6. Test-only seams

Test seams must be explicit and absent from ordinary production paths. Injecting a model/catalog is fine; mocking away the boundary and then claiming the boundary is proven is not.

## 7. Documentation drift

Contradictory documentation is a bug. Before closing an architecture phase, search for future features described as current, old tool names/paths, changed authority rules, and stale milestone status.
