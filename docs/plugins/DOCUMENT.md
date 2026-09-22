# Document plugin requirement

Status: exploratory candidate study; not selected for production  
Working id (research only): `document`

## User problems

The plugin should support practical semantic DOCX workflows such as:

- read paragraphs and headings;
- extract tables;
- replace a known paragraph or section;
- edit table-cell text;
- create a new report from local source material;
- merge several simple DOCX documents into a combined document;
- preserve unrelated document structure where reasonably possible.

The goal is useful semantic document manipulation, not recreating Microsoft Word inside Locus.

## Capability boundary

This plugin adds local DOCX processing code.

It may operate only on workspace files.

It does not grant:

- Microsoft 365/Word Online access;
- OneDrive/SharePoint authority;
- email/sharing authority;
- authenticated remote templates.

Those belong to MCP/connectors.

## MVP format

Required:

- `.docx`

Deferred:

- legacy `.doc`;
- macros;
- protected/encrypted Office files;
- tracked-changes fidelity;
- arbitrary embedded-object editing.

## Required semantic operations

MVP should support:

- list/read paragraphs;
- identify basic heading levels;
- read simple tables;
- create a DOCX;
- add paragraphs;
- add basic headings;
- add basic lists;
- add/edit simple tables;
- exact text replacement with ambiguity detection;
- save to a new workspace path;
- optionally modify an existing DOCX with explicit overwrite rules.

Exact replace should fail when:

- target text is absent;
- target text is ambiguous and the request did not identify which occurrence to edit.

Do not silently guess.

## Candidate implementations

Likely candidates:

- Python `python-docx`;
- a JavaScript DOCX library;
- another browser-compatible OpenXML implementation.

The requirement does not freeze the library.

Selection should consider:

- preservation of unrelated XML parts;
- package size;
- browser/Pyodide viability;
- table support;
- deterministic mutation;
- ability to round-trip ordinary documents without gratuitous damage.

## Fidelity contract

The plugin must distinguish:

> semantic document correctness

from:

> visual/pagination fidelity.

MVP may promise semantic preservation for ordinary paragraphs/tables/headings that it explicitly supports.

It must not promise:

- identical pagination;
- identical line wrapping;
- identical fonts when fonts are unavailable;
- complex floating layout preservation;
- perfect headers/footers/textboxes;
- tracked changes/comments fidelity;
- embedded charts/objects preservation unless tested.

Known fidelity limits must be surfaced rather than hidden.

## Runtime / commit semantics

- workspace confinement;
- bounded file size / paragraph count / table-cell count;
- cancellation checks during parse, traversal, and serialization;
- no network by default;
- derivative output preferred;
- original unchanged on pre-commit failure.

For modifications, use a staged approach where practical:

1. parse and identify target;
2. validate uniqueness/structure;
3. apply change in memory;
4. serialize;
5. commit output;
6. report the exact output path.

## Failure semantics

- malformed DOCX/OpenXML -> clear failure;
- encrypted/protected unsupported document -> explicit unsupported;
- ambiguous replacement -> fail without mutation;
- unsupported structure -> preserve if possible or fail, never silently flatten important content;
- serialization failure -> original untouched;
- cancellation after output commit -> report committed output, no fake rollback.

## Telemetry

Record:

- plugin=`document`;
- operation: inspect/extract/create/edit/merge;
- bytes read/written;
- paragraph/table counts traversed;
- duration;
- error class;
- committed output count.

Do not log paragraph text, table contents, document titles, or path names by default.

## Security

Do not execute:

- macros;
- embedded active content;
- remote templates;
- external hyperlinks as fetches;
- OLE/embedded executables.

Reading hyperlink text is different from following it.

## Non-goals

- Word GUI automation;
- perfect pagination;
- macro execution;
- tracked-changes editing;
- arbitrary embedded-object editing;
- pixel-perfect print rendering;
- Microsoft 365 authority.

## Acceptance criteria

MVP is ready when realistic tests demonstrate:

1. targeted paragraph replacement in an existing report without changing unrelated sections/tables;
2. extraction of a simple DOCX table into structured data;
3. creation of a report with headings, paragraphs, lists, and a simple table;
4. deterministic merge/assembly of several ordinary DOCX sources under a documented preservation contract;
5. safe failure on absent/ambiguous targets;
6. cancellation and workspace confinement.