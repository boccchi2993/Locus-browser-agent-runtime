#!/usr/bin/env python3
"""Build the deterministic REAL-WORLD-50 v1 local fixture space.

This module intentionally uses only the Python standard library.  The output
is disposable and is never an oracle: only ``.generated/workspace`` and
``.generated/upload`` are meant to be mounted or selected during dogfood.
"""

from __future__ import annotations

import csv
import hashlib
import html
import json
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
GENERATED = ROOT / ".generated"
WORKSPACE = GENERATED / "workspace"
UPLOAD = GENERATED / "upload"
FIXED_ZIP_DATE = (2026, 9, 17, 12, 0, 0)


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def write_text(path: Path, text: str) -> None:
    write_bytes(path, text.encode("utf-8"))


def csv_text(headers: list[str], rows: list[list[object]]) -> str:
    from io import StringIO

    stream = StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue()


def fixed_zip_entry(info_name: str, data: bytes, is_dir: bool = False) -> tuple[zipfile.ZipInfo, bytes]:
    name = info_name if not is_dir or info_name.endswith("/") else f"{info_name}/"
    info = zipfile.ZipInfo(name, FIXED_ZIP_DATE)
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = ((0o755 if is_dir else 0o644) << 16) | (0x10 if is_dir else 0)
    return info, data


def make_zip(path: Path, entries: list[tuple[str, bytes, bool]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data, is_dir in entries:
            info, payload = fixed_zip_entry(name, data, is_dir)
            archive.writestr(info, payload)


def xml_escape(value: object, attribute: bool = False) -> str:
    return html.escape(str(value), quote=attribute)


def xlsx_cell(ref: str, value: object, style: int | None = None) -> str:
    style_attr = f' s="{style}"' if style is not None else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{style_attr}><v>{xml_escape(value)}</v></c>'
    return (
        f'<c r="{ref}" t="inlineStr"{style_attr}>'
        f'<is><t>{xml_escape(value)}</t></is></c>'
    )


def xlsx_sheet_xml(rows: list[list[object]], freeze_first_row: bool = False, widths: list[int] | None = None,
                   currency_columns: set[int] | None = None) -> str:
    currency_columns = currency_columns or set()
    max_col = max((len(row) for row in rows), default=1)
    max_row = len(rows)

    def col_name(index: int) -> str:
        result = ""
        while index:
            index, remainder = divmod(index - 1, 26)
            result = chr(65 + remainder) + result
        return result

    sheet_rows: list[str] = []
    for row_number, row in enumerate(rows, start=1):
        cells = []
        for col_number, value in enumerate(row, start=1):
            style = 1 if row_number == 1 else (2 if col_number in currency_columns else None)
            cells.append(xlsx_cell(f"{col_name(col_number)}{row_number}", value, style))
        sheet_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')

    columns_xml = ""
    if widths:
        columns_xml = "<cols>" + "".join(
            f'<col min="{i}" max="{i}" width="{width}" customWidth="1"/>'
            for i, width in enumerate(widths, start=1)
        ) + "</cols>"
    pane_xml = ""
    if freeze_first_row:
        pane_xml = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'

    dimension = f"A1:{col_name(max_col)}{max_row}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="{dimension}"/>'
        f"{pane_xml}{columns_xml}<sheetData>{''.join(sheet_rows)}</sheetData>"
        "</worksheet>"
    )


def make_xlsx(sheets: list[tuple[str, list[list[object]], bool, list[int] | None, set[int]]]) -> bytes:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        + "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(f"<sheet name=\"{xml_escape(name, True)}\" sheetId=\"{i}\" r:id=\"rId{i + 1}\"/>" for i, (name, *_rest) in enumerate(sheets, start=1))}</sheets>'
        "</workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + "".join(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        + "</Relationships>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>'
    )

    entries = [
        ("[Content_Types].xml", content_types.encode(), False),
        ("_rels/.rels", root_rels.encode(), False),
        ("xl/workbook.xml", workbook.encode(), False),
        ("xl/_rels/workbook.xml.rels", workbook_rels.encode(), False),
        ("xl/styles.xml", styles.encode(), False),
    ]
    for index, (_name, rows, freeze, widths, currency_columns) in enumerate(sheets, start=1):
        entries.append((f"xl/worksheets/sheet{index}.xml", xlsx_sheet_xml(rows, freeze, widths, currency_columns).encode(), False))

    from io import BytesIO

    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data, is_dir in entries:
            info, payload = fixed_zip_entry(name, data, is_dir)
            archive.writestr(info, payload)
    return stream.getvalue()


def docx_paragraph(text: str, style: str | None = None) -> str:
    style_xml = f'<w:pStyle w:val="{xml_escape(style, True)}"/>' if style else ""
    return f'<w:p><w:pPr>{style_xml}</w:pPr><w:r><w:t xml:space="preserve">{xml_escape(text)}</w:t></w:r></w:p>'


def docx_table(rows: list[list[str]]) -> str:
    table_rows = []
    for row in rows:
        cells = "".join(f'<w:tc><w:p><w:r><w:t>{xml_escape(cell)}</w:t></w:r></w:p></w:tc>' for cell in row)
        table_rows.append(f"<w:tr>{cells}</w:tr>")
    return '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr>' + "".join(table_rows) + "</w:tbl>"


def make_docx(amount: str = "USD 48,000", customer_count: str | None = None) -> bytes:
    body = [
        docx_paragraph("SERVICE AGREEMENT", "Heading1"),
        docx_paragraph("Parties:", "Heading2"),
        docx_paragraph("Acme Analytics Ltd."),
        docx_paragraph("Northwind Retail LLC"),
        docx_paragraph("Effective Date: 2025-10-01"),
        docx_paragraph("Expiry Date: 2025-12-31"),
        docx_paragraph(f"Contract Value: {amount}"),
        docx_paragraph("The provider will deliver quarterly operations reporting and maintain the agreed service schedule."),
        docx_paragraph("The customer will provide timely source data and review each report within five business days."),
        docx_paragraph("The parties will meet in 2025 to review service quality, renewal options, and data handling."),
        docx_table([
            ["Obligation", "Responsible party"],
            ["Operations reporting", "Acme Analytics Ltd."],
            ["Source data review", "Northwind Retail LLC"],
        ]),
    ]
    if customer_count is not None:
        body.insert(7, docx_paragraph(f"Customer count: {customer_count}"))

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{"".join(body)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>'
        '</w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>'
    )
    from io import BytesIO

    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in [
            ("[Content_Types].xml", content_types.encode()),
            ("_rels/.rels", rels.encode()),
            ("word/document.xml", document.encode()),
        ]:
            info, payload = fixed_zip_entry(name, data)
            archive.writestr(info, payload)
    return stream.getvalue()


def pdf_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_stream(lines: list[str]) -> bytes:
    commands = ["BT", "/F1 18 Tf", "72 720 Td"]
    for index, line in enumerate(lines):
        if index:
            commands.append("0 -30 Td")
        commands.append(f"({pdf_string(line)}) Tj")
    commands.append("ET")
    return ("\n".join(commands) + "\n").encode("ascii")


def make_pdf() -> bytes:
    page_lines = [
        ["Quarterly Operations Report", "Executive Summary", "Revenue: 48,750", "Customer count: 128"],
        ["Sales Performance", "Region | Revenue", "North | 12,300", "South | 11,650", "East | 12,800", "West | 12,000"],
        ["Risks and Recommendations", "Monitor service latency and review source-data freshness.", "Recommendation: keep a monthly reconciliation checkpoint."],
    ]
    streams = [pdf_stream(lines) for lines in page_lines]
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>",
        b"",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>",
        b"",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>",
        b"",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for object_number, stream in [(4, streams[0]), (6, streams[1]), (8, streams[2])]:
        objects[object_number - 1] = f"<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"endstream"

    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, payload in enumerate(objects, start=1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode("ascii"))
        result.extend(payload)
        result.extend(b"\nendobj\n")
    xref_offset = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    result.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    result.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii"))
    return bytes(result)


def make_sales_rows() -> list[list[object]]:
    revenue_by_region = {
        "North": [(12, 100), (15, 100), (9, 150), (12, 150), (9, 100), (16, 100), (13, 150), (20, 100)],
        "South": [(10, 125), (14, 100), (16, 100), (14, 125), (10, 100), (12, 150), (9, 150), (15, 100)],
        "East": [(15, 100), (16, 100), (10, 170), (12, 150), (14, 100), (14, 150), (13, 100), (14, 100)],
        "West": [(10, 100), (10, 125), (15, 100), (14, 125), (9, 150), (20, 100), (16, 100), (10, 155)],
    }
    products = ["Widget A", "Widget B", "Widget C", "Widget D"]
    rows: list[list[object]] = []
    day = 3
    for region in ("North", "South", "East", "West"):
        for index, (quantity, price) in enumerate(revenue_by_region[region]):
            rows.append([f"2025-01-{day:02d}", region, products[index % len(products)], quantity, price, quantity * price])
            day += 1
    return rows


def make_customers_rows() -> list[list[object]]:
    cities = ["Shenyang", "Tokyo", "Berlin", "Osaka", "Dublin", "Seoul", "Nairobi", "Lisbon", "Prague", "Austin"]
    rows = []
    for index in range(20):
        rows.append([index + 1, f"Customer {index + 1:02d}", cities[index % len(cities)], "true" if index % 3 else "false", 850 + index * 125])
    return rows


def make_messy_city_rows() -> list[list[object]]:
    return [
        ["shenyang", 10, 100], ["Shenyang", 11, 110], ["SHENYANG", "", 120],
        [" tokyo", 5, 50], ["Tokyo", 6, 60], ["TOKYO", 7, 70],
        [" new york ", 4, 40], ["New York", 5, 50], ["", 9, 90], ["Berlin", 3, 30],
    ]


def make_app_log() -> str:
    lines = []
    for index in range(1, 301):
        timestamp = f"2026-09-17T10:{(index // 60):02d}:{(index % 60):02d}Z"
        if index % 11 == 0:
            message = "ERROR database timeout"
        elif index % 17 == 0:
            message = "ERROR upstream unavailable"
        elif index % 23 == 0:
            message = "ERROR failed to parse request"
        elif index % 29 == 0:
            message = "ERROR permission denied"
        elif index % 31 == 0:
            message = "ERROR cache serialization failure"
        elif index % 5 == 0:
            message = "WARN cache miss"
        else:
            message = "INFO request completed"
        lines.append(f"{timestamp} {message}")
    return "\n".join(lines) + "\n"


def make_access_log() -> str:
    hour_counts = [(8, 60), (9, 75), (10, 90), (11, 65), (12, 70)]
    statuses = [200, 201, 400, 404, 500, 502, 503]
    paths = ["/", "/api/summary", "/api/customers", "/health"]
    lines = []
    index = 0
    for hour, count in hour_counts:
        for minute_index in range(count):
            minute = (minute_index * 7) % 60
            second = (minute_index * 13) % 60
            status = statuses[index % len(statuses)]
            latency = 18 + ((index * 11) % 240)
            lines.append(f"2026-09-17T{hour:02d}:{minute:02d}:{second:02d}Z GET {paths[index % len(paths)]} {status} {latency}")
            index += 1
    return "\n".join(lines) + "\n"


def build_workspace() -> None:
    write_text(WORKSPACE / "README.md", """# Acme Metrics\n\nAcme Metrics is a small fictional analytics service used for local development. It collects sales events, loads application configuration, and produces quarterly reports. All data in this workspace is synthetic.\n\n## Common commands\n\n- `npm start` launches the sample service.\n- `npm test` runs the lightweight local checks.\n\n## Layout\n\n- `src/` contains application code and helpers.\n- `config/` contains application and client configuration.\n- `data/` contains CSV and JSON source data.\n- `logs/` contains application and access logs.\n\nThe project package manifest is illustrative; dependencies are not installed in this fixture.\n""")
    write_text(WORKSPACE / "package.json", json.dumps({
        "name": "acme-metrics", "version": "1.4.2",
        "scripts": {"start": "node src/main.js", "test": "node tests/run.js"},
        "dependencies": {"tiny-http-client": "^2.1.0"},
    }, indent=2) + "\n")
    write_text(WORKSPACE / "notes.md", """# Working notes\n\nThe quarterly report pipeline reads source data, applies configuration, and emits a reviewable summary. Keep changes small and record the reason for any data cleanup.\n""")
    write_text(WORKSPACE / "src/main.js", """const { fetchMetricSummary } = require('./api.js');\nconst { loadConfig } = require('./config-loader.js');\n\nasync function main() {\n  const config = loadConfig();\n  // TODO: add a graceful shutdown hook for long-running report jobs.\n  return fetchMetricSummary(config.apiBaseUrl);\n}\n\nmodule.exports = { main };\n""")
    write_text(WORKSPACE / "src/api.js", """async function fetchMetricSummary(endpoint) {\n  const response = await fetch(endpoint + '/summary');\n  if (!response.ok) throw new Error('summary request failed');\n  // FIXME: retry transient upstream failures with bounded backoff.\n  const health = await fetch(endpoint + '/health');\n  if (!health.ok) throw new Error('health request failed');\n  return response.json();\n}\n\nmodule.exports = { fetchMetricSummary };\n""")
    write_text(WORKSPACE / "src/utils.ts", """export function sum(values: number[]): number {\n  return values.reduce((total, value) => total + value, 0);\n}\n\nexport function normalizeRegion(value: string): string {\n  return value.trim().toLowerCase();\n}\n""")
    write_text(WORKSPACE / "src/config-loader.js", """const fs = require('fs');\nconst path = require('path');\n\nfunction loadConfig() {\n  const configPath = path.join(__dirname, '..', 'config', 'app.config.json');\n  return JSON.parse(fs.readFileSync(configPath, 'utf8'));\n}\n\nmodule.exports = { loadConfig };\n""")
    write_text(WORKSPACE / "src/legacy.js", """// HACK: retained until the old CSV importer is removed.\nfunction legacyRegionName(value) {\n  return String(value || '').trim();\n}\n\nmodule.exports = { legacyRegionName };\n""")
    write_text(WORKSPACE / "tests/run.js", """const assert = require('assert');\nassert.strictEqual(2 + 2, 4);\nconsole.log('local fixture checks passed');\n""")
    write_text(WORKSPACE / "config/app.config.json", json.dumps({"apiBaseUrl": "https://api.example.test", "reportYear": 2025, "regionMode": "strict"}, indent=2) + "\n")
    write_text(WORKSPACE / "config/dev-config.yaml", """service: acme-metrics\nport: 4310\nlogLevel: info\nfeatures:\n  - quarterly-reports\n  - csv-import\n""")
    write_text(WORKSPACE / "config/nested/client-config.json", json.dumps({"client": {"name": "Acme Dashboard", "refreshSeconds": 60}, "theme": "light"}, indent=2) + "\n")

    sales_rows = make_sales_rows()
    write_text(WORKSPACE / "data/sales.csv", csv_text(["date", "region", "product", "quantity", "price", "revenue"], sales_rows))
    write_text(WORKSPACE / "data/customers.csv", csv_text(["id", "name", "city", "active", "spend"], make_customers_rows()))
    write_text(WORKSPACE / "data/messy-cities.csv", csv_text(["city", "visits", "revenue"], make_messy_city_rows()))
    nested = {
        "project": {"name": "Acme Metrics", "release": {"year": 2025, "channel": "stable"}},
        "features": ["quarterly-reports", "csv-import", "audit-export"],
        "owners": [{"team": "analytics", "role": "maintainer"}, {"team": "operations", "role": "reviewer"}],
    }
    write_text(WORKSPACE / "data/nested.json", json.dumps(nested, indent=2, ensure_ascii=False) + "\n")

    write_text(WORKSPACE / "logs/app.log", make_app_log())
    write_text(WORKSPACE / "logs/access.log", make_access_log())
    write_text(WORKSPACE / "logs/old/archive.log", "2025-12-31T23:59:59Z INFO archived synthetic log\n")
    write_text(WORKSPACE / "drafts/draft-alpha.txt", "Alpha draft for quarterly report review.\n")
    write_text(WORKSPACE / "drafts/draft-beta.txt", "Beta draft for quarterly report review.\n")
    write_text(WORKSPACE / "drafts/keep-me.md", "# Keep me\nThis note should remain during rename exercises.\n")
    write_text(WORKSPACE / "loose/move-me.log", "loose synthetic log\n")
    write_text(WORKSPACE / "loose/second.log", "second loose synthetic log\n")
    write_text(WORKSPACE / "loose/table.csv", "label,value\nalpha,1\nbeta,2\n")
    write_text(WORKSPACE / "loose/untouched.txt", "This file is intentionally outside batch patterns.\n")
    write_bytes(WORKSPACE / "binary/sample.bin", bytes((index * 73 + 19) % 256 for index in range(4096)))
    write_text(WORKSPACE / "tmp-output/stale.txt", "stale generated output\n")
    write_text(WORKSPACE / "tmp-output/nested/stale2.txt", "nested stale generated output\n")
    write_text(WORKSPACE / "private/customer-notes.txt", "Customer A prefers monthly billing.\nCustomer B requested an invoice correction.\nInternal test record only.\n")
    write_text(WORKSPACE / "secrets-demo/.env.example", "# ALL VALUES ARE SYNTHETIC TEST DATA\nAPI_KEY=sk-test-LOCUS-THIS-IS-NOT-A-REAL-KEY\nSERVICE_TOKEN=TEST_ONLY_TOKEN_123456789\n")
    write_text(WORKSPACE / "secrets-demo/fake-config.js", "// ALL VALUES ARE SYNTHETIC TEST DATA\nconst auth = 'Bearer FAKE_TEST_BEARER_LOCUS_000000';\nmodule.exports = { auth };\n")
    (WORKSPACE / "empty-root/existing-empty").mkdir(parents=True, exist_ok=True)
    write_text(WORKSPACE / "mixed-audit-project/README.md", "# Mixed audit project\n\nA small collection of quarterly report source material for document cross-checking.\n")
    write_text(WORKSPACE / "mixed-audit-project/sales.csv", csv_text(["date", "region", "product", "quantity", "price", "revenue"], sales_rows))
    write_text(WORKSPACE / "mixed-audit-project/data.csv", csv_text(["date", "region", "product", "quantity", "price", "revenue"], sales_rows))
    write_text(WORKSPACE / "mixed-audit-project/notes.txt", "Review note: customer count is recorded in the accompanying report materials.\n")
    write_text(WORKSPACE / "mixed-audit-project/source-summary.txt", "Quarterly source summary for Acme Metrics.\n")


def build_upload() -> None:
    report_rows = [["Metric", "Value"], ["Year", 2025], ["Revenue", 48750], ["Customers", 128]]
    report_data_rows = [["Region", "Revenue", "Status"]] + [[region, amount, "reviewed"] for region, amount in [("North", 12300), ("South", 11650), ("East", 12800), ("West", 12000)]] + [[f"Metric {index}", index * 10, "synthetic"] for index in range(1, 12)]
    report = make_xlsx([
        ("Summary", report_rows, False, [20, 18], {2}),
        ("Data", report_data_rows, False, [18, 16, 16], {2}),
    ])
    sales_rows = [["Product", "Quantity", "Price"]] + [
        [product, quantity, price]
        for product, quantity, price in [
            ("Widget A", 12, 100), ("Widget B", 15, 100), ("Widget C", 9, 150),
            ("Widget D", 12, 150), ("Widget E", 10, 125), ("Widget F", 14, 100),
            ("Widget G", 16, 100), ("Widget H", 12, 150), ("Widget I", 13, 150),
            ("Widget J", 20, 100), ("Widget K", 14, 125),
        ]
    ]
    sales = make_xlsx([("Sales", sales_rows, True, [20, 14, 14], {3})])
    contract = make_docx()
    pdf = make_pdf()
    project_entries = [
        ("project/README.md", b"Project Zip Fixture\nVersion 1.0\n", False),
        ("project/package.json", b'{"name":"project-zip-fixture","version":"1.0.0"}\n', False),
        ("project/src/index.js", b"const { label } = require('./helper.js');\nmodule.exports = { label };\n", False),
        ("project/src/helper.js", b"function label(value) { return String(value); }\nmodule.exports = { label };\n", False),
        ("project/config/app.json", b'{"mode":"fixture","enabled":true}\n', False),
        ("project/assets/empty-dir/", b"", True),
    ]
    project_zip = make_zip(UPLOAD / "project.zip", project_entries)
    mixed_contract = make_docx("USD 47,850", "120")
    mixed_entries = [
        ("mixed-audit-project/sales.csv", csv_text(["date", "region", "product", "quantity", "price", "revenue"], make_sales_rows()).encode(), False),
        ("mixed-audit-project/contract.docx", mixed_contract, False),
        ("mixed-audit-project/report.pdf", pdf, False),
        ("mixed-audit-project/notes.txt", b"Review note: customer count is recorded in the accompanying report materials.\n", False),
        ("mixed-audit-project/README.md", b"# Mixed audit project\n\nQuarterly report source material.\n", False),
    ]
    mixed_zip = make_zip(UPLOAD / "mixed-audit-project.zip", mixed_entries)
    write_bytes(UPLOAD / "report.xlsx", report)
    write_bytes(UPLOAD / "sales.xlsx", sales)
    write_bytes(UPLOAD / "contract.docx", contract)
    write_bytes(UPLOAD / "report.pdf", pdf)


def main() -> None:
    if GENERATED.exists():
        shutil.rmtree(GENERATED)
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    UPLOAD.mkdir(parents=True, exist_ok=True)
    build_workspace()
    build_upload()

    files = [path for path in GENERATED.rglob("*") if path.is_file()]
    directories = [path for path in GENERATED.rglob("*") if path.is_dir()]
    workspace_bytes = sum(path.stat().st_size for path in WORKSPACE.rglob("*") if path.is_file())
    print("REAL-WORLD-50 fixture space ready")
    print(f"\nWorkspace:\n{WORKSPACE}")
    print(f"\nUploads:\n{UPLOAD}")
    print(f"\nFiles: {len(files)}")
    print(f"Directories: {len(directories)}")
    print(f"Workspace bytes: {workspace_bytes}")


if __name__ == "__main__":
    main()
