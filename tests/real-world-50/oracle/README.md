# REAL-WORLD-50 oracle

`expected.json` is the validator's human-only expected-result definition. It contains hashes, aggregate values, structural expectations, and the deliberately inconsistent values used by the mixed-document cross-check fixture.

Never mount `tests/real-world-50/` into Locus. Only mount `.generated/workspace`, and select upload files from `.generated/upload`. The oracle is intentionally outside both generated roots so an agent cannot inspect the answers.

All values in this oracle and all corresponding fixtures are synthetic. No real credentials, personal records, browser data, or machine-local paths are included.
