#!/usr/bin/env python3
"""Independently validate the REAL-WORLD-50 v1 generated fixture space."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent
GENERATED = ROOT / ".generated"
WORKSPACE = GENERATED / "workspace"
UPLOAD = GENERATED / "upload"
ORACLE_PATH = ROOT / "oracle" / "expected.json"
NS_XLSX = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
NS_DOCX = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_oracle() -> dict:
    if not ORACLE_PATH.is_file():
        raise AssertionError("oracle/expected.json is missing")
    return json.loads(ORACLE_PATH.read_text(encoding="utf-8"))


def csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def xlsx_parts(path: Path) -> tuple[zipfile.ZipFile, ElementTree.Element]:
    if not zipfile.is_zipfile(path):
        raise AssertionError(f"{path.name} is not a ZIP container")
    archive = zipfile.ZipFile(path)
    required = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"}
    if not required.issubset(set(archive.namelist())):
        archive.close()
        raise AssertionError(f"{path.name} is missing OOXML parts")
    return archive, ElementTree.fromstring(archive.read("xl/workbook.xml"))


def xlsx_sheet_map(archive: zipfile.ZipFile, workbook: ElementTree.Element) -> dict[str, ElementTree.Element]:
    rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    rel_ns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    targets = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall("r:Relationship", rel_ns)}
    result = {}
    for sheet in workbook.findall("x:sheets/x:sheet", NS_XLSX):
        relation = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
        target = targets[relation]
        if target.startswith("/"):
            target = target[1:]
        elif not target.startswith("xl/"):
            target = "xl/" + target
        result[sheet.attrib["name"]] = ElementTree.fromstring(archive.read(target))
    return result


def xlsx_cell_value(sheet: ElementTree.Element, ref: str) -> str:
    cell = next((node for node in sheet.findall(".//x:c", NS_XLSX) if node.attrib.get("r") == ref), None)
    if cell is None:
        raise AssertionError(f"missing XLSX cell {ref}")
    inline = cell.find("x:is/x:t", NS_XLSX)
    if inline is not None:
        return inline.text or ""
    value = cell.find("x:v", NS_XLSX)
    return "" if value is None else (value.text or "")


def docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
        if not required.issubset(set(archive.namelist())):
            raise AssertionError("DOCX is missing required OOXML parts")
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    return "\n".join(node.text or "" for node in root.findall(".//w:t", NS_DOCX))


def check_workspace_structure(oracle: dict) -> None:
    required_files = [
        "README.md", "package.json", "notes.md", "src/main.js", "src/api.js", "src/utils.ts", "src/config-loader.js", "src/legacy.js", "tests/run.js",
        "config/app.config.json", "config/dev-config.yaml", "config/nested/client-config.json",
        "data/sales.csv", "data/customers.csv", "data/messy-cities.csv", "data/nested.json",
        "logs/app.log", "logs/access.log", "logs/old/archive.log",
        "drafts/draft-alpha.txt", "drafts/draft-beta.txt", "drafts/keep-me.md",
        "loose/move-me.log", "loose/second.log", "loose/table.csv", "loose/untouched.txt",
        "binary/sample.bin", "tmp-output/stale.txt", "tmp-output/nested/stale2.txt",
        "private/customer-notes.txt", "secrets-demo/.env.example", "secrets-demo/fake-config.js",
        "mixed-audit-project/README.md", "mixed-audit-project/data.csv", "mixed-audit-project/notes.txt", "mixed-audit-project/source-summary.txt",
    ]
    # The mixed-audit project also carries the same source CSV under a stable name.
    if not (WORKSPACE / "mixed-audit-project/data.csv").is_file():
        raise AssertionError("mixed-audit-project/data.csv is missing")
    for relative in required_files:
        if not (WORKSPACE / relative).is_file():
            raise AssertionError(f"workspace file missing: {relative}")
    for relative in ["empty-root/existing-empty", "logs/old", "config/nested", "tmp-output/nested"]:
        if not (WORKSPACE / relative).is_dir():
            raise AssertionError(f"workspace directory missing: {relative}")
    if not (UPLOAD.is_dir() and {"report.xlsx", "sales.xlsx", "contract.docx", "report.pdf", "project.zip", "mixed-audit-project.zip"}.issubset({p.name for p in UPLOAD.iterdir()})):
        raise AssertionError("upload fixture set is incomplete")
    if oracle.get("version") != "REAL-WORLD-50-v1":
        raise AssertionError("unexpected oracle version")


def check_csv_oracle(oracle: dict) -> None:
    sales = csv_rows(WORKSPACE / "data/sales.csv")
    region_totals: defaultdict[str, int] = defaultdict(int)
    total = 0
    for row in sales:
        quantity = int(row["quantity"])
        price = int(row["price"])
        revenue = int(row["revenue"])
        if quantity * price != revenue:
            raise AssertionError("sales revenue formula mismatch")
        region_totals[row["region"]] += revenue
        total += revenue
    expected = oracle["sales"]
    if len(sales) != expected["rows"] or dict(region_totals) != expected["regionRevenue"] or total != expected["totalRevenue"]:
        raise AssertionError("sales CSV differs from oracle")

    customers = csv_rows(WORKSPACE / "data/customers.csv")
    if len(customers) != oracle["customers"]["rows"] or {row["active"] for row in customers} != {"true", "false"}:
        raise AssertionError("customers CSV differs from oracle")
    messy = csv_rows(WORKSPACE / "data/messy-cities.csv")
    canonical = {row["city"].strip().casefold() for row in messy if row["city"].strip()}
    if len(canonical) != oracle["messyCities"]["cleanedUniqueRows"]:
        raise AssertionError("messy-cities cleaned row count differs from oracle")

    nested_path = WORKSPACE / "data/nested.json"
    nested = json.loads(nested_path.read_text(encoding="utf-8"))
    if nested["project"]["release"]["year"] != oracle["nestedJson"]["releaseYear"] or nested["project"]["release"]["channel"] != oracle["nestedJson"]["releaseChannel"]:
        raise AssertionError("nested JSON deep fields differ from oracle")
    if sha256(nested_path) != oracle["nestedJson"]["sha256"]:
        raise AssertionError("nested JSON hash differs from oracle")


def check_logs(oracle: dict) -> None:
    app_lines = [line for line in (WORKSPACE / "logs/app.log").read_text(encoding="utf-8").splitlines() if line]
    levels = Counter(line.split(" ", 2)[1] for line in app_lines)
    errors = Counter(line.split(" ", 2)[2] for line in app_lines if " ERROR " in line)
    app_expected = oracle["appLog"]
    if len(app_lines) != app_expected["rows"] or dict(levels) != {"INFO": app_expected["info"], "WARN": app_expected["warn"], "ERROR": app_expected["error"]}:
        raise AssertionError("application log level counts differ from oracle")
    actual_top = [[message, count] for message, count in errors.most_common(3)]
    if actual_top != app_expected["topErrors"]:
        raise AssertionError("application log top errors differ from oracle")

    access_lines = [line for line in (WORKSPACE / "logs/access.log").read_text(encoding="utf-8").splitlines() if line]
    hours = Counter(line[11:13] for line in access_lines)
    status_values = [int(line.split()[3]) for line in access_lines]
    five_xx = sum(500 <= value < 600 for value in status_values)
    access_expected = oracle["accessLog"]
    ratio = five_xx / len(access_lines)
    if len(access_lines) != access_expected["rows"] or hours.most_common(1)[0][0] != access_expected["busiestHour"] or five_xx != access_expected["fiveXX"] or ratio != access_expected["fiveXXRatio"]:
        raise AssertionError("access log aggregate differs from oracle")


def check_binary(oracle: dict) -> None:
    path = WORKSPACE / "binary/sample.bin"
    expected = oracle["workspace"]["binary/sample.bin"]
    if path.stat().st_size != expected["size"] or sha256(path) != expected["sha256"]:
        raise AssertionError("binary fixture differs from oracle")
    if len(set(path.read_bytes())) < 200:
        raise AssertionError("binary fixture does not contain a broad byte pattern")


def check_xlsx(oracle: dict) -> None:
    report_archive, report_workbook = xlsx_parts(UPLOAD / "report.xlsx")
    try:
        report_sheets = xlsx_sheet_map(report_archive, report_workbook)
        expected = oracle["xlsxReport"]
        if list(report_sheets) != expected["sheetNames"]:
            raise AssertionError("report.xlsx sheet names differ")
        for sheet_name, dimension in expected["dimensions"].items():
            actual = report_sheets[sheet_name].find("x:dimension", NS_XLSX).attrib["ref"]
            if actual != dimension:
                raise AssertionError(f"report.xlsx {sheet_name} dimension differs")
        summary = report_sheets["Summary"]
        for ref, value in expected["keyCells"].items():
            if xlsx_cell_value(summary, ref) != str(value):
                raise AssertionError(f"report.xlsx {ref} differs")
    finally:
        report_archive.close()

    sales_archive, sales_workbook = xlsx_parts(UPLOAD / "sales.xlsx")
    try:
        sales_sheets = xlsx_sheet_map(sales_archive, sales_workbook)
        expected = oracle["xlsxSales"]
        if list(sales_sheets) != expected["sheetNames"]:
            raise AssertionError("sales.xlsx sheet names differ")
        sheet = sales_sheets["Sales"]
        if sheet.find("x:dimension", NS_XLSX).attrib["ref"] != expected["dimension"]:
            raise AssertionError("sales.xlsx dimension differs")
        if xlsx_cell_value(sheet, "A1") != "Product" or xlsx_cell_value(sheet, "B1") != "Quantity" or xlsx_cell_value(sheet, "C1") != "Price":
            raise AssertionError("sales.xlsx headers differ")
        if "state=\"frozen\"" not in sales_archive.read("xl/worksheets/sheet1.xml").decode("utf-8"):
            raise AssertionError("sales.xlsx is missing a frozen first row")
        for row in range(2, 13):
            quantity = int(xlsx_cell_value(sheet, f"B{row}"))
            price = int(xlsx_cell_value(sheet, f"C{row}"))
            if quantity * price != expected["expectedTotals"][row - 2]:
                raise AssertionError(f"sales.xlsx total mismatch at row {row}")
    finally:
        sales_archive.close()


def check_docx(oracle: dict) -> None:
    text = docx_text(UPLOAD / "contract.docx")
    expected = oracle["contract"]
    for value in [*expected["parties"], expected["amount"], *expected["dates"]]:
        if value not in text:
            raise AssertionError(f"contract.docx is missing {value}")
    if text.count("2025") != expected["year2025Occurrences"]:
        raise AssertionError("contract.docx year occurrence count differs")
    with zipfile.ZipFile(UPLOAD / "contract.docx") as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        if len(document.findall(".//w:tbl", NS_DOCX)) < 1 or len(document.findall(".//w:p", NS_DOCX)) < 5:
            raise AssertionError("contract.docx lacks expected paragraph/table structure")


def check_pdf(oracle: dict) -> None:
    payload = (UPLOAD / "report.pdf").read_bytes()
    expected = oracle["pdf"]
    if not payload.startswith(b"%PDF") or not payload.rstrip().endswith(b"%%EOF"):
        raise AssertionError("report.pdf header or EOF is invalid")
    page_count = len(re.findall(rb"/Type /Page(?:\s|/)", payload))
    if page_count != expected["pageCount"]:
        raise AssertionError("report.pdf page count differs")
    for heading in expected["sectionHeadings"]:
        if f"({heading})".encode("ascii") not in payload:
            raise AssertionError(f"report.pdf is missing heading {heading}")
    for value in expected["tableValues"]:
        if value.encode("ascii") not in payload:
            raise AssertionError(f"report.pdf is missing table value {value}")


def check_zip(oracle: dict) -> None:
    path = UPLOAD / "project.zip"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        expected = oracle["zip"]
        if names != expected["entries"]:
            raise AssertionError("project.zip entry list differs")
        if "project/assets/empty-dir/" not in names:
            raise AssertionError("project.zip lost its empty directory entry")
        if sha256_bytes(archive.read("project/README.md")) != expected["readmeSha256"]:
            raise AssertionError("project.zip README hash differs")
        config = json.loads(archive.read("project/config/app.json"))
        if config != expected["config"]:
            raise AssertionError("project.zip config differs")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_mixed_audit(oracle: dict) -> None:
    path = UPLOAD / "mixed-audit-project.zip"
    expected = oracle["mixedAudit"]
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if names != expected["entries"]:
            raise AssertionError("mixed audit ZIP entry list differs")
        sales = list(csv.DictReader(archive.read("mixed-audit-project/sales.csv").decode("utf-8").splitlines()))
        if sum(int(row["revenue"]) for row in sales) != 48750:
            raise AssertionError("mixed audit sales total is unexpected")
        contract = archive.read("mixed-audit-project/contract.docx")
        report = archive.read("mixed-audit-project/report.pdf")
        if b"47,850" not in contract or b"120" not in contract:
            raise AssertionError("mixed audit DOCX inconsistency fixture is missing")
        if b"48,750" not in report or b"128" not in report:
            raise AssertionError("mixed audit PDF reference values are missing")
        if len(expected["expectedInconsistencies"]) != 2:
            raise AssertionError("mixed audit oracle does not define two inconsistencies")


def check_oracle_isolation() -> None:
    forbidden_name = re.compile(r"(^|/)(?:oracle|expected\.json)(?:/|$)", re.IGNORECASE)
    for path in GENERATED.rglob("*"):
        relative = path.relative_to(GENERATED).as_posix()
        if forbidden_name.search(relative):
            raise AssertionError(f"oracle path leaked into generated output: {relative}")
        if path.is_file() and path.suffix.lower() in {".txt", ".md", ".js", ".json", ".csv", ".yaml"}:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if "expected.json" in text or "oracle/" in text:
                raise AssertionError(f"oracle reference leaked into generated file: {relative}")


def check_synthetic_secrets() -> None:
    suspicious = re.compile(r"(?:sk-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{24,})")
    allowed_markers = ("FAKE", "TEST_ONLY", "NOT-A-REAL", "SYNTHETIC")
    for path in GENERATED.rglob("*"):
        if not path.is_file() or path.suffix.lower() in {".bin", ".xlsx", ".docx", ".pdf", ".zip"}:
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if suspicious.search(line) and not any(marker in line for marker in allowed_markers):
                raise AssertionError(f"credential-like value lacks a synthetic marker: {path.relative_to(GENERATED)}")


def main() -> None:
    oracle = load_oracle()
    checks = [
        ("workspace structure", lambda: check_workspace_structure(oracle)),
        ("CSV oracle", lambda: check_csv_oracle(oracle)),
        ("logs", lambda: check_logs(oracle)),
        ("binary", lambda: check_binary(oracle)),
        ("XLSX report", lambda: check_xlsx(oracle)),
        ("XLSX sales", lambda: check_xlsx(oracle)),
        ("DOCX", lambda: check_docx(oracle)),
        ("PDF", lambda: check_pdf(oracle)),
        ("ZIP", lambda: check_zip(oracle)),
        ("mixed audit", lambda: check_mixed_audit(oracle)),
        ("oracle isolation", check_oracle_isolation),
    ]
    print("REAL-WORLD-50 fixture verification\n")
    passed = 0
    for label, check in checks:
        try:
            check()
            print(f"[PASS] {label}")
            passed += 1
        except Exception as error:  # noqa: BLE001 - report every named gate cleanly
            print(f"[FAIL] {label}: {error}")
    try:
        check_synthetic_secrets()
        print("[PASS] synthetic secret scan")
        passed += 1
        total_checks = len(checks) + 1
    except Exception as error:  # noqa: BLE001
        print(f"[FAIL] synthetic secret scan: {error}")
        total_checks = len(checks) + 1
    print(f"\n{passed}/{total_checks} PASS")
    if passed != total_checks:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
