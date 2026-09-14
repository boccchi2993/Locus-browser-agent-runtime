# PDF plugin requirement

Status: proposed / optional  
Working id: `pdf`

## User problems

The first PDF plugin should solve ordinary file and text workflows:

- inspect metadata/page count;
- extract text from text-based PDFs;
- extract selected pages;
- merge PDFs;
- split a PDF by page ranges;
- save derivative PDFs;
- gather structured facts from several text PDFs for later reasoning.

The initial plugin should be boring and reliable. PDF is already a sufficiently cursed format without volunteering to implement Acrobat.

## Capability boundary

This plugin adds local PDF parsing/manipulation code.

It does not grant:

- remote document authority;
- cloud OCR services;
- signing identities/certificates;
- browser automation;
- authenticated document portals.

Those belong elsewhere.

## MVP capabilities

Required:

- page count;
- basic metadata;
- extract text from text-based pages;
- extract selected page ranges into a new PDF;
- merge multiple PDFs in specified order;
- split a PDF into multiple outputs;
- preserve page order and page bytes/content semantics as supported by the library;
- save outputs locally.

Useful if cheap and reliable:

- per-page text extraction;
- page dimensions/rotation;
- encrypted-PDF detection.

## Candidate implementations

Candidates may include:

- `pypdf`;
- PDF.js for inspection/text extraction;
- JavaScript/WASM PDF libraries.

The final implementation may combine libraries if a single library is weak at both text extraction and file manipulation.

Do not freeze the library in this requirements phase.

## OCR boundary

OCR is explicitly **not** part of PDF MVP.

For scanned/image-only PDFs:

- detect that meaningful text extraction is unavailable;
- report that OCR is required;
- do not hallucinate text.

Future OCR can be a separate optional capability/plugin because it has different cost, model, and privacy characteristics.

## Visual rendering boundary

Pixel rendering and visual QA are not required for the first PDF plugin.

If future tasks need:

- screenshot pages;
- inspect visual layout;
- compare rendered pages;

that should use a separate rendering capability, likely browser/PDF.js-based.

Text/file manipulation and visual understanding should not be conflated.

## Runtime / resource limits

Define bounds for:

- maximum source file bytes;
- maximum pages;
- total pages across merge inputs;
- extracted text bytes;
- number of output files.

Cancellation must be checked between page/file operations where the library permits it.

No automatic network access.

## Commit semantics

For merge/split/extract:

1. validate all source files/ranges;
2. construct output;
3. serialize output;
4. commit output file(s);
5. report exact committed results.

Invalid page ranges should fail before committing misleading partial outputs when feasible.

Original PDFs remain unchanged unless a future explicit in-place operation is designed.

## Failure semantics

- malformed PDF -> clear failure;
- encrypted PDF without supported password flow -> explicit unsupported/encrypted error;
- image-only PDF text request -> explicit OCR-required result;
- invalid page range -> deterministic error;
- output serialization failure -> no claim of success;
- cancellation after some outputs committed -> report committed outputs honestly.

## Telemetry

Record:

- plugin=`pdf`;
- operation: inspect/text/extract/merge/split;
- input/output bytes;
- input/output page counts;
- duration;
- error class;
- committed output count.

Do not log extracted text, metadata strings, or path names by default.

## Security

Do not:

- execute JavaScript embedded in PDFs;
- launch attachments;
- follow remote links;
- execute embedded files;
- bypass encryption;
- claim a PDF is safe merely because parsing succeeded.

Active content should be treated as data.

## Non-goals

- OCR;
- PDF signing;
- encryption cracking;
- form filling;
- annotation editing;
- pixel-perfect visual editing;
- arbitrary embedded-object manipulation;
- browser automation;
- cloud PDF services.

## Acceptance criteria

MVP is ready when realistic tests show:

1. selected pages can be extracted in exact requested order;
2. multiple PDFs can be merged deterministically;
3. page-range splitting is correct and total page counts reconcile;
4. text-based PDFs can yield per-page text suitable for downstream reasoning;
5. scanned/image-only PDFs fail honestly for text extraction;
6. malformed/encrypted files fail safely;
7. workspace confinement and cancellation semantics hold.
