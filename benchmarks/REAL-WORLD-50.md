# Locus REAL-WORLD-50

Status: benchmark task corpus v1  
Scope: realistic workspace-centric agent tasks for Locus  
Runner: not defined in this document

## Why this exists

Locus should be evaluated on outcomes that resemble work a person would actually hand to an agent, not on isolated shell syntax exercises. This corpus therefore describes user goals, fixture requirements, and observable success conditions while leaving the execution trajectory open.

The design borrows several ideas from public agent benchmarks:

- OSWorld / OSWorld 2.0: realistic initial state, execution-based evaluation, end-to-end workflows.
- AssistantBench: realistic, time-consuming assistant tasks that require planning and transferring information across steps.
- Odysseys: long-horizon tasks should be scored with multiple rubrics and efficiency matters, not just eventual completion.
- WebBench / ClawBench: file manipulation, retrieval, and everyday user workflows expose practical agent failures that synthetic tool-call tests miss.
- OdysseyBench: office-document workflows are legitimate end-user tasks and should be represented even before the corresponding optional capability exists.

This corpus does **not** copy task text from those benchmarks. It adapts their evaluation philosophy to Locus's browser-native workspace model.

## Scoring classes

- **core-now**: intended to be solvable by the current Locus core after the Unix-compatibility baseline lands.
- **plugin-target**: a real user problem that should become solvable through an optional plugin; absence of that plugin is **NOT RUN / UNSUPPORTED**, not a core failure.
- **live-network**: depends on a public HTTPS resource. These should be scored separately because remote content may change.

For every run, record at least:

- outcome pass/fail/partial/not-run,
- tool turns,
- wall-clock duration,
- local vs relay execution,
- bytes moved into Python/runtime,
- number of failed/retried tool calls,
- filesystem mutations,
- whether the final state was verified.

Do not require a unique trajectory. A correct result reached with shell, Python, or another valid capability is still correct.

---

## A. Filesystem and workspace organization

### RW-001 — Clean up a semester download folder
**User request**

> 这个文件夹是我这学期下载的课程资料，文件名和类型都很乱。帮我把 PDF、表格、图片和压缩包分别整理到对应子目录。已经存在的项目目录不要动，最后给我一份你移动了哪些文件的清单。

**Fixture**: 20–30 mixed files, nested project directories, filenames with spaces and Chinese characters, one dotfile.  
**Expected outcome**: eligible top-level files moved into type folders; existing project directories untouched; movement summary produced.  
**Evaluation**: compare final tree against allowed moves; verify no protected directory changed.  
**Capability**: filesystem, shell.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-002 — Find suspiciously large media files
**User request**

> 我磁盘空间快没了。这个目录里哪些图片或视频特别大？把超过 20 MB 的列出来，按大小从大到小生成一个 markdown 清单，但不要删任何东西。

**Fixture**: nested media and non-media files with varied sizes.  
**Expected outcome**: Markdown report contains only matching media files in descending size order.  
**Evaluation**: exact set membership and ordering.  
**Capability**: filesystem, shell, python.  
**Class**: core-now.  
**Difficulty**: easy.

### RW-003 — Archive stale exports without touching current work
**User request**

> 这里有很多自动导出的结果文件。把名字里带 `export` 且 30 天以前的文件移到 `archive/`，但 `current/` 目录里的任何东西都不要动。做完告诉我归档了多少个。

**Fixture**: timestamped files plus a protected current directory.  
**Expected outcome**: only matching stale exports moved; count reported.  
**Evaluation**: final tree and count.  
**Capability**: filesystem, python.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-004 — Detect duplicate text files
**User request**

> 我怀疑这个资料目录里有重复文件，只是名字不一样。帮我找出内容完全相同的文本和 markdown 文件，生成重复组清单。先不要删除。

**Fixture**: exact duplicates, near-duplicates, unrelated binaries.  
**Expected outcome**: duplicate groups based on exact file bytes; binaries ignored unless explicitly text-like.  
**Evaluation**: expected equivalence groups.  
**Capability**: filesystem, python.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-005 — Normalize a batch of filenames
**User request**

> 这些实验截图文件名乱七八糟。把顶层 PNG/JPG 按拍摄顺序改成 `lab-001`、`lab-002`……，保留原扩展名。子目录里的文件不要改，重名时不要覆盖。

**Fixture**: images with sortable timestamps, nested images, one conflicting target name.  
**Expected outcome**: safe sequential renames; conflict handled without overwrite; nested files untouched.  
**Evaluation**: filename mapping and absence of data loss.  
**Capability**: filesystem.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-006 — Collect deliverables from nested project folders
**User request**

> 每个小组项目目录里都有一个最终版文件，但路径不统一。帮我找到文件名里包含 `final` 的 PDF 或 DOCX，把它们复制或整理到一个 `deliverables/` 清单目录，同时保留能看出原项目来源的名字。

**Fixture**: multiple nested projects with final/draft files.  
**Expected outcome**: one collected deliverable per qualifying file, no overwrites, source attribution preserved.  
**Evaluation**: expected collected set and unchanged sources.  
**Capability**: filesystem, shell/python.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-007 — Remove disposable build artifacts
**User request**

> 这个目录里是一个我正在用的小项目。帮我清掉明显可重新生成的缓存和构建产物，比如 `dist-temp`、`*.tmp` 和空的临时目录，但不要删源码、配置、`.git` 或正式的 `dist`。先检查再动手。

**Fixture**: source tree, protected files, disposable artifacts, empty dirs.  
**Expected outcome**: only explicitly disposable artifacts removed; protected state intact.  
**Evaluation**: final tree against allow/deny lists.  
**Capability**: filesystem, shell.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-008 — Reorganize a mixed research folder while preserving structure
**User request**

> 把这个研究资料目录里的原始数据移动到 `data/raw/`，处理后的 CSV 移到 `data/processed/`，说明文档留在原位。原来目录里的空子目录也要保留，不要把结构弄丢。

**Fixture**: nested raw/processed data, docs, empty directories.  
**Expected outcome**: files reorganized as requested; unrelated docs and required empty directories preserved.  
**Evaluation**: exact final tree and file-byte integrity.  
**Capability**: filesystem.  
**Class**: core-now.  
**Difficulty**: hard.

---

## B. Text, logs, notes, and local information extraction

### RW-009 — Summarize errors across application logs
**User request**

> 这里有一周的服务日志。帮我统计最常见的 ERROR 类型、各出现多少次，并给出每类第一次和最后一次出现的时间。输出成 `error-summary.md`。

**Fixture**: multiple UTF-8 logs with repeated error signatures.  
**Expected outcome**: correct grouped counts and time ranges.  
**Evaluation**: deterministic values.  
**Capability**: shell, python.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-010 — Extract action items from meeting notes
**User request**

> 这个文件夹里是最近几次会议纪要。帮我把明确的待办事项、负责人和截止时间汇总成一张 markdown 表。没有负责人或日期的也保留，但标成未知。

**Fixture**: several Markdown/TXT notes with inconsistent formatting.  
**Expected outcome**: one consolidated table with all genuine action items.  
**Evaluation**: rubric-based extraction coverage and no invented owners/deadlines.  
**Capability**: filesystem, text reasoning.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-011 — Compare two policy versions
**User request**

> `policy-old.md` 和 `policy-new.md` 是同一份制度的两个版本。帮我总结真正改变了含义的地方，不要只列标点和格式变化，并保存成 `policy-changes.md`。

**Fixture**: semantically meaningful and cosmetic edits.  
**Expected outcome**: concise semantic change report.  
**Evaluation**: rubric for required changes and penalties for cosmetic-only noise.  
**Capability**: text reasoning, filesystem.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-012 — Build an index of notes by topic
**User request**

> 这些 markdown 笔记没有统一目录。按内容给它们做一个主题索引，至少列出文件名、主要主题和一句摘要，写到 `INDEX.md`。不要改原笔记。

**Fixture**: 12–20 notes on several topics.  
**Expected outcome**: useful index covering every note.  
**Evaluation**: coverage, correct filenames, rubric-based topic accuracy.  
**Capability**: filesystem, text reasoning.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-013 — Locate configuration references
**User request**

> 我准备改一个环境变量名。帮我找出项目里所有真正引用 `LEGACY_API_HOST` 的文本文件，排除依赖目录和二进制文件，给我路径和行号。不要修改代码。

**Fixture**: source files, dependencies, binary noise, comments, docs.  
**Expected outcome**: correct path+line references in relevant scope.  
**Evaluation**: precision and recall.  
**Capability**: grep/find, filesystem.  
**Class**: core-now.  
**Difficulty**: easy.

### RW-014 — Merge daily notes without duplicate headers
**User request**

> 把这一周每天的工作日志合成一个 `weekly.md`。按日期排序，每天只保留一个日期标题，重复粘贴的完全相同段落只保留一次，但不要改写我的原文。

**Fixture**: daily Markdown files with duplicates.  
**Expected outcome**: chronologically merged document, exact prose preserved except exact duplicate removal.  
**Evaluation**: deterministic structure and text preservation.  
**Capability**: filesystem, python/text.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-015 — Sanitize a noisy exported chat transcript
**User request**

> 这个聊天导出 txt 里混进了大量系统提示、重复时间戳和空行。帮我清理成容易阅读的版本，但任何真正的聊天消息都不能丢，输出成新文件，不要覆盖原件。

**Fixture**: noisy UTF-8 transcript with repeated metadata.  
**Expected outcome**: cleaned derivative preserving every message.  
**Evaluation**: message preservation plus removal of known noise markers.  
**Capability**: python/text, filesystem.  
**Class**: core-now.  
**Difficulty**: medium.

---

## C. CSV and lightweight data analysis

### RW-016 — Regional sales summary
**User request**

> 用这个季度销售 CSV 算一下每个地区的收入、订单数和平均客单价，按收入从高到低输出 `region-summary.csv`，再给我一句话指出表现最好和最差的地区。

**Fixture**: sales CSV with region/order/revenue fields.  
**Expected outcome**: exact aggregates and sorted output.  
**Evaluation**: numeric equality within tolerance.  
**Capability**: python/pandas, filesystem.  
**Class**: core-now.  
**Difficulty**: easy.

### RW-017 — Find suspicious transaction outliers
**User request**

> 这份交易记录里可能有录入错误。找出金额明显异常的记录，给我一个单独 CSV，并说明你用了什么判定方法。不要直接修改原始数据。

**Fixture**: numeric data with seeded outliers.  
**Expected outcome**: defensible method plus matching flagged rows.  
**Evaluation**: rubric allows multiple reasonable statistical methods; seeded extreme anomalies must be included.  
**Capability**: python.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-018 — Merge customer exports safely
**User request**

> `customers-a.csv` 和 `customers-b.csv` 是两个系统导出的客户表。按 email 合并，重复客户只保留一条，字段冲突时优先用更新时间更晚的记录。生成新文件，原文件别动。

**Fixture**: overlapping rows, missing values, update timestamps.  
**Expected outcome**: one deduplicated merged CSV.  
**Evaluation**: exact record resolution rules.  
**Capability**: python/pandas.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-019 — Audit missing and malformed values
**User request**

> 帮我检查这个报名表 CSV 的数据质量：每列缺失多少、哪些邮箱格式明显不对、年龄有没有不合理值。不要修，先出 `data-quality.md`。

**Fixture**: missing cells, malformed email strings, invalid ages.  
**Expected outcome**: counts and row references.  
**Evaluation**: deterministic rule checks.  
**Capability**: python.  
**Class**: core-now.  
**Difficulty**: easy.

### RW-020 — Compare two monthly snapshots
**User request**

> 这两个库存 CSV 分别是上月和本月。帮我找出新增商品、下架商品，以及库存变化超过 30% 的商品，输出一个差异 CSV。

**Fixture**: two snapshots keyed by SKU.  
**Expected outcome**: exact change classification.  
**Evaluation**: deterministic rows and percentages.  
**Capability**: python/pandas.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-021 — Reconcile payments against invoices
**User request**

> `invoices.csv` 是应收账款，`payments.csv` 是实际付款。按 invoice_id 对账，列出未付款、少付、多付和完全匹配的项目，并算出总缺口。

**Fixture**: invoices and payments including duplicates and partials.  
**Expected outcome**: reconciliation table and total outstanding gap.  
**Evaluation**: exact arithmetic.  
**Capability**: python/pandas.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-022 — Turn event data into a daily funnel
**User request**

> 这个事件 CSV 里有 visit、signup、purchase。按天统计三步人数和 signup→purchase 转化率，保存结果，并指出哪一天的转化率最低。

**Fixture**: event-level rows with user IDs and timestamps.  
**Expected outcome**: per-day unique-user funnel metrics.  
**Evaluation**: exact aggregates.  
**Capability**: python/pandas.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-023 — Normalize inconsistent category labels
**User request**

> 这份表的 category 一列有大小写、前后空格和少量常见同义写法。请在不改其他列的前提下规范 category，保存成新 CSV，并另外列出你做过的映射。

**Fixture**: seeded spelling/casing/synonym variants.  
**Expected outcome**: normalized derivative plus mapping report.  
**Evaluation**: expected canonical categories and untouched other columns.  
**Capability**: python/pandas.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-024 — Split a master roster into team files
**User request**

> 按这份总名单里的 team 列，把人员拆成每个团队一个 CSV。文件名用团队名，团队名里有空格也要正常处理。再生成一个索引，写每个团队有多少人。

**Fixture**: roster CSV with several teams and non-ASCII names.  
**Expected outcome**: one CSV per team and accurate index.  
**Evaluation**: row partition equality.  
**Capability**: python/filesystem.  
**Class**: core-now.  
**Difficulty**: easy.

---

## D. Small code and project-workspace tasks

### RW-025 — Explain a small project structure
**User request**

> 我刚接手这个小项目。先看一下目录和主要源码，给我写一份 `PROJECT-OVERVIEW.md`，说明入口、主要模块、数据怎么流动，以及你认为最值得先读的三个文件。不要修改代码。

**Fixture**: small multi-file web or Python project.  
**Expected outcome**: overview grounded in actual files.  
**Evaluation**: rubric on correct entry points, modules, and no hallucinated components.  
**Capability**: filesystem, text/code reasoning.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-026 — Inventory TODO and FIXME debt
**User request**

> 把源码里的 TODO、FIXME 和 HACK 汇总出来，按文件分组并附行号。测试夹具和第三方依赖不要算，结果写成 markdown。

**Fixture**: source, tests, vendor folders with markers.  
**Expected outcome**: scoped list with line numbers.  
**Evaluation**: precision/recall.  
**Capability**: grep/find.  
**Class**: core-now.  
**Difficulty**: easy.

### RW-027 — Trace an API endpoint definition
**User request**

> 这个项目里 `/api/report` 到底是在哪里定义、经过哪些函数处理的？给我路径和简短调用链说明，不要改代码。

**Fixture**: small app with route registration and helper functions.  
**Expected outcome**: accurate route-to-handler path.  
**Evaluation**: rubric on required nodes.  
**Capability**: search, code reasoning.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-028 — Diagnose a failing test from logs
**User request**

> `test-output.txt` 是 CI 失败日志，源码也在这个目录里。帮我判断最可能的根因，引用相关文件和行，并写一个修复建议，但先别改代码。

**Fixture**: seeded failure log and source.  
**Expected outcome**: correct likely cause and supporting evidence.  
**Evaluation**: rubric.  
**Capability**: text search, code reasoning.  
**Class**: core-now.  
**Difficulty**: hard.

### RW-029 — Update a simple config value consistently
**User request**

> 把这个项目里我们自己维护的配置中 `api.example-old.com` 改成 `api.example-new.com`。不要碰依赖、测试快照或历史文档。改完再检查一次有没有漏掉。

**Fixture**: matching values across owned configs, excluded folders, misleading docs.  
**Expected outcome**: only intended references changed; verification performed.  
**Evaluation**: byte-level diff against allowed set.  
**Capability**: filesystem mutation, search.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-030 — Summarize package versions from manifests
**User request**

> 这个仓库里有几个子项目。帮我从它们的 package.json / requirements.txt 里整理出共同依赖和版本差异，写成一张 markdown 表。不要联网查最新版本。

**Fixture**: mixed JS/Python manifests.  
**Expected outcome**: correct cross-project dependency matrix.  
**Evaluation**: deterministic extraction.  
**Capability**: filesystem, python/text.  
**Class**: core-now.  
**Difficulty**: medium.

### RW-031 — Find likely dead local assets
**User request**

> `assets/` 里堆了不少图片。找出在源码和样式表里完全没有被引用的本地资源，先给我清单，不要删除。

**Fixture**: referenced/unreferenced assets with relative paths.  
**Expected outcome**: candidate unused set.  
**Evaluation**: seeded exact references; dynamic-reference caveat allowed.  
**Capability**: filesystem, grep/python.  
**Class**: core-now.  
**Difficulty**: hard.

---

## E. Public network plus local processing

### RW-032 — Download a public CSV and create a local summary
**User request**

> 从给你的公开 HTTPS CSV 地址下载数据，保存原始文件，然后按其中的地区字段做汇总，把结果也留在工作目录里。

**Fixture**: stable public HTTPS URL controlled for benchmark runs.  
**Expected outcome**: downloaded source plus correct local summary.  
**Evaluation**: hash/row checks against fixture server.  
**Capability**: network, filesystem, python.  
**Class**: live-network.  
**Difficulty**: medium.

### RW-033 — Fetch public JSON and filter records
**User request**

> 这个公开 JSON 接口返回很多记录。只保留 status 为 active 且 score 大于 80 的项目，保存成一个新的 JSON，并告诉我有多少条。

**Fixture**: stable benchmark HTTPS endpoint.  
**Expected outcome**: correctly filtered JSON and count.  
**Evaluation**: deterministic fixture response.  
**Capability**: network, python.  
**Class**: live-network.  
**Difficulty**: easy.

### RW-034 — Compare local IDs with a public catalog
**User request**

> `wanted.csv` 里有一列 id。用给你的公开 catalog JSON 查这些 id，把能找到的名称和状态补成一个新 CSV，找不到的保留并标记 missing。

**Fixture**: local wanted.csv and stable public catalog endpoint.  
**Expected outcome**: enriched derivative CSV with missing markers.  
**Evaluation**: exact join result.  
**Capability**: network, python, filesystem.  
**Class**: live-network.  
**Difficulty**: medium.

### RW-035 — Download a text artifact and verify its checksum
**User request**

> 从这个 HTTPS 地址下载文件到工作区，再用旁边给出的 SHA-256 值检查完整性。告诉我是否匹配，不匹配时不要继续处理文件。

**Fixture**: stable downloadable artifact and expected checksum.  
**Expected outcome**: local file plus correct verification decision.  
**Evaluation**: checksum.  
**Capability**: network, python.  
**Class**: live-network.  
**Difficulty**: easy.

### RW-036 — Combine two public datasets
**User request**

> 这两个公开 CSV 地址分别包含实体基本信息和指标。下载后按 id 合并，只保留两个数据集都出现的实体，输出最终 CSV 和一段简短说明。

**Fixture**: two stable benchmark URLs.  
**Expected outcome**: correct inner join and provenance retained.  
**Evaluation**: deterministic rows.  
**Capability**: network, python.  
**Class**: live-network.  
**Difficulty**: hard.

### RW-037 — Refresh a cached public snapshot only when changed
**User request**

> 工作区里已经有一份 `snapshot.json`。重新下载给定公开地址的最新版本，如果内容完全没变就不要重写；如果变了，保留旧版为 `snapshot.previous.json`，再写入新版。

**Fixture**: local snapshot and benchmark HTTP fixture configurable as same/changed.  
**Expected outcome**: no-op on identical content; safe rotation on changed content.  
**Evaluation**: two scenario checks and byte equality.  
**Capability**: network, filesystem, python.  
**Class**: live-network.  
**Difficulty**: hard.

---

## F. Spreadsheet tasks (optional plugin target)

### RW-038 — Update prices in an existing workbook
**User request**

> `catalog.xlsx` 是现有商品表，`price-update.csv` 是新价格。按 SKU 更新 Excel 里的价格列，不要改其他列和 sheet，保存为新文件。

**Fixture**: XLSX with formatting/multiple sheets plus CSV updates.  
**Expected outcome**: updated workbook preserving unrelated workbook content.  
**Evaluation**: cell-level values and structural checks.  
**Capability**: spreadsheet plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

### RW-039 — Create a summary sheet
**User request**

> 在这份 Excel 里新增一个 `Summary` sheet，按 Region 汇总 Revenue 和 Units。现有 sheet 不要删，也不要覆盖原文件。

**Fixture**: XLSX with data sheet and formatting.  
**Expected outcome**: derivative workbook with correct summary sheet.  
**Evaluation**: workbook structure and values.  
**Capability**: spreadsheet plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

### RW-040 — Consolidate several workbook sheets
**User request**

> 这个工作簿里每个月一个 sheet，列结构相同。把所有月份合并成一个新的 `All Months` sheet，并增加一列标记来源月份。

**Fixture**: multi-sheet XLSX.  
**Expected outcome**: all rows consolidated with source sheet/month.  
**Evaluation**: exact row count and provenance.  
**Capability**: spreadsheet plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

### RW-041 — Flag spreadsheet inconsistencies without changing them
**User request**

> 检查 `budget.xlsx`：找出实际支出大于预算的行、缺失负责人以及日期格式明显异常的行。把检查结果放到新 sheet，不要修改原数据。

**Fixture**: XLSX with seeded issues.  
**Expected outcome**: issue sheet referencing correct rows.  
**Evaluation**: exact seeded issue coverage.  
**Capability**: spreadsheet plugin.  
**Class**: plugin-target.  
**Difficulty**: hard.

### RW-042 — Build a workbook from CSV inputs
**User request**

> 这三个 CSV 分别是销售、退款和目标值。帮我生成一个新的 Excel：原始数据各一个 sheet，再做一个汇总 sheet 算净销售额和目标完成率。

**Fixture**: three CSVs.  
**Expected outcome**: new XLSX with four sheets and correct calculations.  
**Evaluation**: workbook structure and numeric results.  
**Capability**: spreadsheet plugin.  
**Class**: plugin-target.  
**Difficulty**: hard.

---

## G. DOCX tasks (optional plugin target)

### RW-043 — Update a paragraph in an existing report
**User request**

> `report.docx` 里“风险说明”这一节有一段旧文字。把它替换成 `replacement.txt` 里的新版本，其他章节和表格不要改，保存为新 DOCX。

**Fixture**: DOCX with headings, paragraphs, and tables plus replacement text.  
**Expected outcome**: targeted semantic replacement only.  
**Evaluation**: paragraph text and preservation of unrelated structure.  
**Capability**: document plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

### RW-044 — Extract a table from Word
**User request**

> 这份 DOCX 里有一张设备清单表。把表里的设备名、型号、数量提取成 CSV，文档本身不要改。

**Fixture**: DOCX containing multiple paragraphs and one target table.  
**Expected outcome**: correct CSV extraction.  
**Evaluation**: exact table cells.  
**Capability**: document plugin.  
**Class**: plugin-target.  
**Difficulty**: easy.

### RW-045 — Assemble a short report from source notes
**User request**

> 根据 `summary.md` 和 `metrics.csv` 生成一份新的 DOCX 报告，包含标题、两级小标题、摘要段落和一个指标表。内容准确比花哨排版重要。

**Fixture**: Markdown summary and metrics CSV.  
**Expected outcome**: readable DOCX with required semantic structure.  
**Evaluation**: required text/table values and heading hierarchy.  
**Capability**: document plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

### RW-046 — Merge several Word notes into one document
**User request**

> 这四个 DOCX 是四个小组的阶段总结。按文件名顺序合成一份新 DOCX，每个来源前加一个一级标题写原文件名。不要改原文件。

**Fixture**: four simple DOCX files.  
**Expected outcome**: one ordered combined document preserving source text/tables where supported.  
**Evaluation**: ordered section/text coverage.  
**Capability**: document plugin.  
**Class**: plugin-target.  
**Difficulty**: hard.

---

## H. PDF tasks (optional plugin target)

### RW-047 — Extract selected pages into a new PDF
**User request**

> 从 `manual.pdf` 里把第 3、4、9 页单独抽出来，按原顺序保存成一个新 PDF。原文件不要改。

**Fixture**: multi-page PDF.  
**Expected outcome**: 3-page derivative PDF in requested order.  
**Evaluation**: page count and page-content fingerprints.  
**Capability**: pdf plugin.  
**Class**: plugin-target.  
**Difficulty**: easy.

### RW-048 — Merge PDFs in a specified order
**User request**

> 把 `cover.pdf`、`body.pdf`、`appendix.pdf` 按这个顺序合并成 `package.pdf`，并告诉我合并后的总页数。

**Fixture**: three PDFs.  
**Expected outcome**: ordered merged PDF and correct page count.  
**Evaluation**: page fingerprints and count.  
**Capability**: pdf plugin.  
**Class**: plugin-target.  
**Difficulty**: easy.

### RW-049 — Extract facts from several text PDFs
**User request**

> 这几份 PDF 是供应商报价。帮我提取每家的公司名、总价、交付周期和报价有效期，汇总成 CSV；找不到的字段留空，不要猜。

**Fixture**: text-based PDFs with varied layouts.  
**Expected outcome**: one row per supplier with grounded fields only.  
**Evaluation**: rubric/exact values.  
**Capability**: pdf plugin, text reasoning.  
**Class**: plugin-target.  
**Difficulty**: hard.

### RW-050 — Split a large PDF by page ranges
**User request**

> `booklet.pdf` 需要拆成三份：1–12 页、13–28 页、29 页到结尾。分别保存成三个 PDF，并确认页数加起来和原文件一致。

**Fixture**: PDF with at least 35 pages.  
**Expected outcome**: three correctly ranged PDFs; page totals reconcile.  
**Evaluation**: page counts and page-content fingerprints.  
**Capability**: pdf plugin.  
**Class**: plugin-target.  
**Difficulty**: medium.

---

## Corpus summary

| Area | IDs | Count |
|---|---:|---:|
| Filesystem / organization | RW-001–008 | 8 |
| Text / logs / notes | RW-009–015 | 7 |
| CSV / data analysis | RW-016–024 | 9 |
| Code / project workspace | RW-025–031 | 7 |
| Public network + local processing | RW-032–037 | 6 |
| Spreadsheet plugin target | RW-038–042 | 5 |
| DOCX plugin target | RW-043–046 | 4 |
| PDF plugin target | RW-047–050 | 4 |
| **Total** |  | **50** |

Class totals:

- core-now: 31
- live-network: 6
- plugin-target: 13

Difficulty target is intentionally mixed. The benchmark should contain boring work as well as hard work because a useful agent spends much of its life doing routine tasks correctly.

## Fixture policy for the future runner

Fixtures should be deterministic, small enough for repeatable local runs, and contain realistic messiness:

- filenames with spaces and non-ASCII characters,
- nested and empty directories,
- duplicate and near-duplicate data,
- UTF-8 text plus some binary files,
- protected directories/files that must remain untouched,
- CSV missing values and duplicates,
- stable benchmark-hosted HTTPS endpoints for network tasks.

Do not silently substitute live third-party sites when a deterministic fixture server can express the same capability.

## Evaluation policy

Prefer execution/state checks over LLM judging whenever possible:

1. final filesystem tree,
2. file hashes/byte equality,
3. structured CSV/JSON/XLSX/DOCX/PDF checks,
4. deterministic numeric checks,
5. rubric-based semantic checks only when the outcome cannot be reduced to state.

For long tasks, keep separate metrics for:
- completion quality,
- number of tool turns,
- failed calls,
- repeated failures,
- wall-clock time,
- bytes copied between runtime layers.

A task can pass through any valid trajectory. Benchmark tasks must not teach the agent which command or library to use.

## Design references

- OSWorld: https://os-world.github.io/
- AssistantBench: https://assistantbench.github.io/
- Odysseys: https://arxiv.org/abs/2604.24964
- WebBench: https://github.com/Halluminate/WebBench
- ClawBench: https://github.com/TIGER-AI-Lab/ClawBench
- OdysseyBench: https://arxiv.org/abs/2508.09124
