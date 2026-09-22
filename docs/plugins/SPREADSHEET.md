# Spreadsheet plugin requirement

Status: exploratory candidate study; not selected for production  
Working id (research only): `spreadsheet`

## User problems

The plugin should make local spreadsheet work practical without putting an entire office stack into Locus core.

Representative problems:

- inspect an existing XLSX workbook and its sheets;
- read tables/ranges;
- update selected cells from CSV or other local data;
- create a summary sheet;
- consolidate several sheets;
- create a new workbook from local structured data;
- identify deterministic data-quality issues and write results to a new sheet;
- save a derivative workbook while preserving unrelated workbook content as far as the implementation reliably supports.

## Capability boundary

This plugin adds **local spreadsheet code**.

It may operate on files already present in the mounted workspace.

It does not grant:

- Google Sheets authority;
- Microsoft 365/OneDrive authority;
- authenticated web access;
- email or sharing authority.

Those belong to MCP/connectors.

## MVP formats

Required:

- `.xlsx`

Explicitly deferred unless proven safe:

- legacy `.xls`;
- macro execution;
- VBA editing;
- perfect `.xlsm` preservation;
- perfect chart/pivot/table rendering fidelity.

If `.xlsm` is read at all, the plugin must not claim preservation of macros unless the chosen library can prove it.

## Required operations

The MVP should support enough primitives to solve real workflows, not merely demonstrate file parsing:

- list sheet names;
- inspect dimensions;
- read cells/ranges;
- read rows as structured data;
- write cell values;
- write formulas as formulas;
- create a sheet;
- create a workbook;
- append rows;
- copy local tabular data into a workbook;
- save to a new workspace path;
- optionally update an existing workbook under explicit overwrite rules.

A small range-oriented API is preferable to dozens of single-cell model tools.

## Preservation expectations

When editing an existing workbook, preserve unrelated workbook state to the extent the chosen library supports it.

At minimum, an edit operation must not intentionally rebuild the entire workbook from extracted values and thereby discard unrelated sheets.

The plugin must document known fidelity losses such as:

- unsupported drawings;
- charts;
- conditional formatting;
- external links;
- macros;
- unsupported formulas/styles.

No silent fidelity claims.

## Candidate implementations

Likely candidates include:

- Python `openpyxl` through the local Python runtime;
- a JavaScript XLSX library;
- a WASM-based spreadsheet library.

The requirement does not freeze the implementation.

Selection criteria:

- browser viability;
- package size/load cost;
- preservation fidelity;
- deterministic read/write behavior;
- performance on ordinary workbooks;
- compatibility with Locus cancellation/resource bounds.

## Runtime / filesystem requirements

- workspace-only paths;
- no arbitrary OS paths;
- explicit per-file size cap;
- workbook/sheet/cell bounds to prevent pathological files from freezing the tab;
- cancellation checks between expensive phases;
- no automatic network access.

Prefer:

1. read/validate source;
2. construct changes in memory or a temporary representation;
3. serialize output;
4. commit output file;
5. report exactly what was written.

## Failure semantics

Examples:

- malformed workbook -> fail clearly, do not create a misleading partial result;
- unsupported encrypted workbook -> explicit unsupported error;
- output serialization failure -> original remains untouched;
- cancellation before commit -> no output commit;
- cancellation after a committed output -> report the committed output, do not claim rollback;
- requested in-place overwrite -> obey explicit overwrite/conflict policy.

## Telemetry

Record:

- plugin=`spreadsheet`;
- operation family: inspect/read/create/edit/consolidate;
- workbook bytes read/written;
- sheet count touched;
- duration;
- success/error class;
- local execution backend;
- committed output count.

Do not log sheet contents, cell values, formulas, or real path names by default.

## Security

Do not execute:

- VBA/macros;
- embedded scripts;
- external workbook links as network requests;
- formula-driven external data refresh.

Formulas may be stored as formulas, but evaluating arbitrary workbook formulas is a separate capability and should not be implied.

## Non-goals

- Excel GUI automation;
- full Excel calculation engine;
- pixel-perfect rendering;
- PowerQuery;
- macros;
- arbitrary external links;
- collaborative editing;
- Google Sheets / Microsoft Graph authority.

## Acceptance criteria

The plugin is MVP-ready when it can reliably pass realistic tests covering:

1. update selected values in an existing multi-sheet XLSX while preserving unrelated sheets;
2. create a correct summary sheet from existing data;
3. consolidate several same-schema sheets;
4. report data-quality issues into a new sheet without mutating source data;
5. build a new multi-sheet workbook from CSV inputs;
6. fail safely on malformed/unsupported files;
7. preserve workspace confinement and cancellation semantics.