# Locus 全量源码审计

审计对象：[boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime)

固定版本：`da94d1f9537818c436dbbef5948b0b07770cbc59`，main。该提交时间为 2026-09-13 19:45:37 +08:00。以下代码位置全部指向这一版本，不代表之后的提交。

**结论：核心路线可以继续，当前实现仍存在会破坏文件、跨工作区延续执行、扩大同源权限的缺陷。应先补可靠性与权限边界，再拆 AgentSession，最后迁移 Vue。现有测试通过不足以证明真实目录工作流可用。**

## 范围与证据

已审阅全部业务源码、内联 Python Worker、两个 Pages Functions、六个测试文件、README、架构/协议/路线图/TODO、示例和仓库配置；检查了全部 10 个可达提交中的常见私钥、GitHub token、长 sk-token 模式，未发现匹配。凭据扫描是启发式检查，不等于证明不存在任何形式的秘密。

已执行：

| 验证 | 结果 |
|---|---|
| `node tests/model.test.cjs` | 36 passed / 0 failed |
| `node tests/proxy.test.mjs` | 7 passed / 0 failed |
| `node tests/fetch.test.mjs` | 11 passed / 0 failed |
| `node tests/network.test.cjs` | 23 passed / 0 failed |
| 8 个 src 脚本和真实内联 Worker 语法解析 | 通过 |
| 本次补充 10 组针对性复现 | 均观察到预期缺陷/实现行为，详见附录 |
| 真实 Chrome + Pyodide 浏览器 E2E | 未运行：环境没有浏览器二进制，CDN 请求不可达 |
| 真实提供商 API、线上 Cloudflare 部署 | 未验证；没有使用真实 API Key 或攻击部署 |

补充复现直接加载本次提交的源码，仅替换模型、网络、Worker 或文件句柄等外部边界。目录 API 使用遵守 WebIDL options 类型约束的 mock；同源脚本风险验证到服务端响应内容/响应头，未执行浏览器利用。静态推断和 mock 验证分别标明。没有修改或推送项目源码。

严重程度：P1 为应优先修复的核心功能、数据完整性或权限问题；P2 为明确的可靠性、协议或条件性风险。以下归纳为 6 项 P1、11 项 P2；不把未实现的路线图功能当作现版本 bug。

## P1：优先修复

### F01 — 真实目录 stat 调用参数错误，追加写入可能退化为覆盖

位置：[src/workspace.js L115–127](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/src/workspace.js#L115)，并影响 `exists()` L106–112、`src/shell.js` L267–270。

代码向 `getFileHandle(base, false)` 和 `getDirectoryHandle(base, false)` 传入布尔值。第二参数是 dictionary/options，应省略或传 `{ create: false }`。与 `_fileHandle()` 正确使用对象的写法不一致。

后果不只是报错：

- `cat` 先调用 stat，因而无法正常读取真实文件。
- Python 收集工作区时逐文件 stat；非空真实目录会在启动执行前失败。
- `exists()` 吞掉全部异常并返回 false。`echo text >> existing.txt` 因而跳过读取原内容，直接写入新内容，可能覆盖已有文件。

证据：R1，加载真实 LocalDirectoryWorkspace，使用符合 options 类型约束的句柄，稳定抛出 TypeError。浏览器原生句柄尚需补测。

修复：修正两处 options；stat 仅在明确的文件/目录类型不匹配时尝试另一个分支；exists 仅把 NotFoundError 转为 false，其余异常上抛。验收必须使用真实 FileSystemDirectoryHandle，覆盖 stat、cat、Python snapshot 和追加保留旧内容。

### F02 — 工作区切换与在途任务竞态，旧指令可执行到新目录

位置：[src/ui.js L110–139](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/src/ui.js#L110)、[src/agent.js L93–145](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/src/agent.js#L93)。

终端 busy 只阻止输入，没有阻止右上角选目录。模型请求等待期间选择 B，会修改全局 `App.workspace` 并清空历史；旧请求返回后，工具从此刻的 `App.workspace` 取 B 执行。若切换发生在旧工具执行期间，旧工具结果又会进入清空后的新历史。

证据：R2 在 A 发起请求，等待期间模拟选择 B，再放回旧工具响应，实际 executeTool 收到 B。

修复：一次任务绑定不可变 workspace/session 引用与 generation；切换时取消或等待旧任务完成，拒绝过期模型响应、工具结果和回写。短期可以 busy 时禁用切换，并在 picker 返回后再次检查状态；仅加按钮 disabled 不足以解决先打开 picker 后发生状态变化的情况。

验收：分别在模型等待、工具等待、回写等待三个阶段切换，确认旧指令不进入 B，旧结果不进入 B 的历史。

### F03 — 切换目录没有重置 Python，旧变量、模块和镜像外文件仍可读取

位置：[index.html L180–193、214–225、270–282](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/index.html#L180)、`src/ui.js` L125–129。

工作区切换只清空 Agent.history。Worker 和 Pyodide interpreter 持续复用；syncIn 仅删除 `/workspace`，不清除 Python globals、模块状态或 `/tmp` 等位置。

静态复现场景：A 中执行 `secret = open('private.txt').read()`，切换 B 后执行 `print(secret)`。旧变量仍属于同一个解释器；保存在 `/tmp` 的副本也不受 syncIn 清理。F01 修复后，正常非空目录即可触发该场景；不依赖旧 agent 任务仍在运行。

证据级别：源码状态生命周期分析，尚未运行真实 Pyodide。

修复：在工作区/session 边界终止并新建 Worker；同一 session 内可以保留 Python 状态。不要仅通过清理 globals 尝试消除所有模块、文件与后台任务残留。与 F02 的取消/回写边界一起设计。

### F04 — 重命名目标回写失败后仍删除源文件，并报告成功

位置：[src/shell.js L97–127](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/src/shell.js#L97)、L340–343。

Worker 将 rename 转换为 changed + deleted。主线程逐个写 changed，异常只拼进 stderr；随后无条件删除 deleted。磁盘满、权限变化、目标目录冲突等情况可能导致目标没写成而源文件已删除。最终 `isError` 只检查 `result.error`，不会把回写错误算成失败。

证据：R3 注入“new.txt 写入 disk full、old.txt 删除成功”，结果为 `success: true`，且 old.txt 已进入 remove。

修复：最小止血是任一写入失败就停止所有删除、返回结构化失败并保留源文件；进一步引入变更集、预检查、分阶段提交和可恢复记录。需要准确表达部分成功，不能笼统宣称事务原子性。没有工作区但生成了文件，也应返回未持久化状态而不是让最终用户以为文件已保存。

验收：写目标失败、close 失败、删除失败、多个文件部分写成，均不得错误报告完整成功，rename 失败不得丢失源文件。

### F05 — /fetch 将不可信 HTML 以应用同源页面提供

位置：[functions/fetch.js L175–179](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/functions/fetch.js#L175)。

服务端复制上游 Content-Type 和原始字节，没有为 HTML/SVG 主动内容设置隔离策略、下载处置或限制性 CSP。访问 `https://应用域名/fetch?url=https://外部域名/页面` 时，外部页面会以应用域名响应。

这不等于“curl 展示文本自动执行脚本”：现有终端输出路径不是这里的触发条件。风险是用户导航到这个响应、将它嵌入同源 frame，或未来做文件预览。导航在原会话标签页发生时，脚本可访问同 origin 的 sessionStorage；若存在可访问的应用窗口/frame，还可能触及应用状态。具体能力取决于窗口关系、会话位置以及部署层是否额外提供 CSP。

证据：R4 原样返回 `<script>`、`Content-Type: text/html`，响应没有 CSP/Content-Disposition；未进行真实浏览器 exploit，未核实线上附加响应头。

修复：将不可信资源交付到无凭据独立 origin，或在同源 relay 响应强制适当的 CSP sandbox/下载策略，并补 `nosniff` 等防御。须同时考虑 HTML、SVG、JS 的嵌入方式；保留 curl 下载能力不要求让资源成为应用同源可执行页面。

**不需要提供商白名单。这个问题是响应的 origin 与执行权限，不是是否允许访问任意站点。**

### F06 — Python 的 JS bridge 绕开 curl 网络权限与遥测

位置：[index.html L261–289](https://github.com/boccchi2993/Locus-browser-agent-runtime/blob/da94d1f9537818c436dbbef5948b0b07770cbc59/index.html#L261)、`src/shell.js` L17–40、`src/network.js`。

模型代码直接进入同源 Pyodide Worker。该环境的 Python/JavaScript bridge 没有被限制；Python 可通过 `js` 使用 Worker 的 fetch、JS 执行及其他 Worker 能力，因此“唯一网络入口是 curl，只允许匿名 HTTPS GET”不是整个执行环境实际强制的边界。

影响：可以绕过 NetworkRuntime 发起 POST、绕过其未来限额和 network telemetry。浏览器自身 CORS、mixed-content 等约束仍然存在，但不等于项目声明的 GET-only 限制；CORS 通常也不阻止所有请求被发送。Worker 没有直接 DOM/sessionStorage，不应据此夸大为直接拿到主页面 API Key。

证据级别：源码与 Pyodide bridge 的静态边界分析；真实 Pyodide 请求路径待复测。当前代码未建立独立来源、网络 CSP 或可证明的 capability membrane。更换为普通 JS Worker 同样不会自然解决。

修复：先确定是否有意允许 Python 自行联网。若允许，必须修改能力声明、界面和威胁模型，并提供可审计的权限策略；若只允许受控联网，应将计算放到独立隔离执行来源并用明确 RPC 请求权限，配合浏览器强制的网络策略。仅在提示词里说“不要 import js”或简单覆盖一个 fetch 名称不是可靠沙箱。

## P2：可靠性与语义问题

### F07 — 资源限制只覆盖部分路径，网络或输出可使任务长时间卡住

位置：`src/model.js` L98–104；`src/network.js` L41–43、54–73；`index.html` L241–250、274–275；`src/shell.js` L84–94。

直连模型、直连下载没有 AbortSignal、超时或响应体上限；浏览器到 relay 的这一段也没有客户端期限。UI 等待完整结果，不能取消。Python 的 30s 只覆盖 postMessage 之后，未覆盖文件收集和主线程回写；stdout/stderr 无上限，diffOut 对全部产物读入并 base64 编码，输入 25 MiB 限制并不限制输出。超时不能保证在内存耗尽前终止。

证据：R8 验证直接 fetch 没有 signal；其余由源码确认。TODO 已列 curl 直连限额，但模型、Worker 输出和完整任务生命周期尚未一起覆盖。

修复：每个网络操作覆盖 headers+body 的 deadline、流式字节计数及取消；为 Python 输出、回写总量和文件数设定独立上限；区分启动、执行、同步期限。用户取消必须贯穿 agent、网络、计算及回写。

验收：直连挂起、收完 headers 后挂起、持续大响应、巨量 stdout、巨大产物、慢目录遍历均能结束且状态准确。

### F08 — 自动模型代理掩盖 401/429/5xx 并触发额外请求

位置：`src/model.js` L139–145、161–163、197–204。

自动 fallback 到 `/proxy` 后，任何异常都会被替换成最初的 direct TypeError。于是代理真实返回的额度、认证、限流或超时错误丢失；外层把没有 status 的 TypeError 当作可重试，继续换路径。

证据：R6 中 direct→CORS、relay→429，最终显示 CORS，实际发出 4 次请求（两个直连、两个代理）。显式配置 proxy 不走这一吞错分支。

修复：保留 relay 的权威 HTTP/结构化错误；只有确认 relay 不存在或不可用时才考虑显示原错误，并保留 cause/routing 记录。验收覆盖自动 relay 的 401、402、429、500、504，不能继续探测端点。

### F09 — HTTP 200 的语义错误被当成端点错误；终止原因与模型原生状态丢失

位置：`src/model.js` L55–88、161–163、191–204；`src/agent.js` L99–119。

解析器抛出的普通 Error 没有 status，外层照样换 endpoint 重试。即使第一次推理已成功收费，仅因输出为空、只有 reasoning、或格式不符合预期，也可能再次推理。与此同时，text-only 返回值丢弃 reasoning/native blocks、usage 与 stop reason；达到 token 上限的非空文本可能被当成最终回答，截断工具块也可能直接终止任务。

证据：R7 模拟 HTTP 200、空 content + reasoning_content + finish_reason=length，发生两次请求。当前单元测试明确断言 reasoning 被丢弃；协议文档把这列为后续应改行为。

修复：transport、HTTP、parse、model-stop 使用不同错误类型；成功 HTTP 响应的解析失败不得自动改路径。按 MODEL-PROTOCOL 的 envelope 保存原生返回及 stop reason，provider adapter 决定 replay。不能反向宣称所有模型都必须回传 raw reasoning，也不能统一丢弃。

### F10 — 部分文件镜像产生“本地存在、Python 不存在”，可能覆盖被跳过文件

位置：`src/shell.js` L152–180；`index.html` L214–225；`src/shell.js` L97–105。

Python 只同步最多 200 个文件、单文件 5 MiB、总计 25 MiB。relay 却允许 16 MiB 下载，因而一个合法下载的 6 MiB 数据文件，下一步 Python 无法读取。跳过只显示数量，不显示路径，也不阻止 Python 在相同路径创建文件。代码若执行“文件不存在则创建默认文件”，回写可覆盖实际存在但没同步进来的大文件。

证据级别：静态完整调用链分析；此项不依赖取消限制，输入与输出接口语义本身不一致。

修复：保留 skipped-path manifest，未载入路径明确禁止覆盖；优先做按需读取或显式选取输入。受限 snapshot 不能伪装成完整 workspace。至少在开始前报告缺失路径并失败，而非执行后只给数量提示。

### F11 — Python 回写不检查外部修改，可能覆盖用户在运行期间的新编辑

位置：`src/shell.js` L84–105、113–116；`index.html` L241–258。

manifest 仅用于比较 Worker 输入与输出；回写前不核对真实文件仍等于原快照。用户或编辑器在 Python 运行期间修改/替换文件，会被后到的回写覆盖；删除也可能删掉刚由用户更新的版本。

证据级别：静态分析，适用于真实本地目录同时被其他程序访问的常见场景。

修复：基于原始快照 hash/版本实施 optimistic concurrency；在写/删前检测冲突，返回冲突且保留两份内容。FS Access API 不提供万能事务，不能把“检查后写入”宣传为绝对原子，但仍应消除显而易见的无检查覆盖。

### F12 — relay 不能正确返回无 body 状态，部分流错误逃逸为平台异常

位置：`functions/fetch.js` L94–96、171–179；`functions/proxy.js` L104–106、165–179。

fetch relay 即使读到 204/205/304 的空数据，也用 Uint8Array 作为 Response body；这些状态要求 null body，构造器会抛错。proxy 对 204/205 用空字符串也存在同类问题（其 3xx 已提前转 502）。两端非 timeout 的流读取异常重新抛出，外层只有 finally，没有统一转为 relay error。

证据：R5 upstream 204 稳定触发 `Response constructor: Invalid response status code 204`。非 timeout 流异常为静态分析。

修复：对 null-body status 使用 null；捕获上游读流异常并保留明确的 502/relay 标记。验收 204、205、304（fetch）、流中途断开以及现有超时测试。

### F13 — 直连 curl 不强制匿名，重定向也没有 relay 的逐跳 HTTPS 约束

位置：`src/network.js` L41–49、86–96。

fetch 默认 credentials 是 same-origin，代码没有显式 `credentials: 'omit'`。请求同源资源或重定向到同源时可能携带浏览器 cookie，违背“匿名 GET”的统一声明。初始 URL 校验 HTTPS 后直接 `redirect: 'follow'`，没有逐跳验证；是否允许降级取决于页面与浏览器，而 relay 有显式拒绝逻辑。

证据：R8 确认实际请求配置仅 method/redirect，没有 credentials；cookie 与降级行为尚未进行浏览器验证。单纯没有 CORS 不代表目标是公共资源，私网/localhost 的可达性也不能仅凭 scheme 断言。

修复：显式 omit；拒绝 URL userinfo；明确浏览器重定向策略。浏览器不一定允许读取跨域 manual redirect 的 Location，可对无法验证的跳转转交受控 relay，或返回明确错误，不能假定自己能透明逐跳跟踪。

### F14 — Pyodide 一次加载失败会永久复用 rejected promise

位置：`index.html` L183–193、290–291；`src/shell.js` L43–45。

pyodideLoading 缓存 Promise，CDN/初始化失败后不清除。下一次执行复用同一个 rejected Promise；Worker 仍存在，因此不会重新启动。worker.onerror 也只失败 pending，不清理 worker/status。现有恢复测试覆盖 timeout，不覆盖加载错误。

证据：R10 连续两次调用真实 ensurePyodide，底层 loadPyodide 实际只调用一次，两次均返回第一次失败。

修复：初始化失败应重置 loading Promise 或销毁 Worker；区分 fatal/runtime/user-code error，避免任意普通 Python 异常都重启解释器。验收首次失败、第二次依赖恢复后成功。

### F15 — tokenizer 丢弃引号信息，使普通文本变为重定向

位置：`src/shell.js` L185–190、256–270。

shellTokenize 去掉外层引号，echo 后续再按字符串 `>`/`>>` 寻找重定向，无法区分语法 token 和 quoted text。

证据：R9 `echo ">" victim.txt` 应输出文本，但真实 runShellCommand 调用了 workspace.write('victim.txt', ...)。这是限定 shell 已宣称支持的 echo/quotes 的语义错误，不是要求实现完整 POSIX。

修复：词法结果保留 quoted/operator 信息；未支持的组合（管道、逻辑运算、多命令等）应明确拒绝，避免悄悄当作参数而报告成功。验收 quoted >、quoted >>、含空格路径、未闭合引号。

### F16 — /proxy 入站大小限制发生在完整读入之后

位置：`functions/proxy.js` L67–73、133。

先 req.text() 完整读入，再 TextEncoder 重新编码计数。默认 1 MiB 限制只限制“转发给上游的内容”，没有限制进入 Worker 内存的请求体；入站读取还不在后面的 upstream timeout 范围内。

证据级别：源码明确。未进行大流量或 DoS 测试，不推断平台一定崩溃。

修复：Content-Length 早拒绝加流式硬计数，超限取消；设置入站读取期限，并保留平台配额作为补充。可以继续保持 provider-agnostic。

### F17 — 历史无限增长且没有会话重置命令

位置：`src/agent.js` L13–15、94、111、145；`src/ui.js` L177–189；`functions/proxy.js` 的默认 1 MiB body 限制。

每个用户回合、模型输出和工具反馈永久累加进 Agent.history。6000 字符工具截断与 15 次迭代只限制单条/单任务，不限制整个会话。最终会超过提供商上下文或本应用 proxy body 上限。`clear` 仅清空终端，并不会重置历史；界面没有单独 reset/new session。

证据级别：静态生命周期分析。clear 只清显示本身是合理设计，问题是缺少独立的会话管理与预算。

修复：显式 New session/Reset；进入模型前做预算判断，必要时按 provider-native message 边界压缩/归档。避免破坏工具调用配对和 opaque replay state。验收长会话到阈值后能够正常继续或明确创建新会话。

## 其他审阅结果与不应夸大的问题

- **路线图方向正确。** 先 AgentSession 再 Vue，provider history 与 UI timeline 分离，domain 能力通过扩展组合，这几条无需推翻。但“Worker 隔离”要明确隔离到什么权限，不应等到插件层才补。
- **原生 tool calling 未实现不单列 P1。** 当前协议清楚要求整段 fenced JSON，严格解析降低误执行概率。它是可行兼容路径，但不应被写成已经实现 native function calling 或动态 API 方言协商。
- **工具输出标签是提示层防护，不是授权层。** 输出可包含结束标签、指令等内容；当前 user-role feedback 也不是 native tool-role。无法因此宣称提示注入已解决，但没有证据表明所有文件内容都会自动执行。关键是把允许产生的副作用收在 harness。
- **路径 normalize 的越界拒绝有价值。** 没有发现通过普通 `../` 直接逃出所选 FileSystemDirectoryHandle 的链路。Python 的 WASM 虚拟 FS 不等于宿主系统根目录；不能把访问 Pyodide `/tmp` 说成访问真实机器 `/tmp`。
- **provider-agnostic proxy 是明确选择。** 不设域名白名单本身不计缺陷；未做线上访问控制、速率限制和 DNS/平台内网可达性检查，因此不宣称已经证明 SSRF 到内部服务。应解决的是实际数据权限、资源边界、错误语义与主动内容 origin。
- **API URL 配置仍容易踩坑。** Anthropic base 如果已含 `/v1` 会拼成 `/v1/v1/messages`；官方域名检测是整串 regex 而非 URL.hostname；OpenAI base 已含 `/v1` 后，fallback 会生成 `/v1/v1/chat/completions`。建议显式 API dialect + URL 规范化/输入提示；这不意味着要增加提供商名单。
- **模型接入能力不宜泛称所有兼容端点。** 固定 max_tokens 与 128-token 连接探测不适合所有模型；未测试实际默认模型或第三方网关可用性。兼容范围应由真实 adapter contract 和测试描述。
- **Telemetry 不是可靠的完整审计日志。** Python 内部联网不会记作 network；网络异常或回写异常可能丢失 backend；base64 长度×0.75 会计入 padding（1 字节可被算成 3）；失败时 error 取输出第一行不一定是实际错误。UI/backend 值当前来自内部固定值，未据此报告一个未经证明的 DOM XSS。
- **CDN 已固定版本，但未见 SRI/CSP 和离线依赖缓存。** 不做 CVE 推断；没有联网完成依赖漏洞库审计。固定版本是好事，但测试仍依赖 Pyodide CDN，不能称完全离线回归。
- **测试缺口比测试数量更重要。** 当前 E2E 使用自写 MemWS，绕过真实 LocalDirectoryWorkspace；没有完整 agent-loop/session-switch 测试、真实 FS options 测试、失败回写测试。未见仓库内 CI workflow 或统一测试入口；这属于工程建议，不是单独高危漏洞。
- **空目录与复杂 rename 语义不完整。** snapshot/diff 仅处理文件，空目录不会保留或输出；file↔directory 类型变换可能遇到真实目录冲突。walkFs 使用 stat 跟随虚拟 symlink，循环/特殊文件会令导出失败；还需设计明确支持集和 lstat 策略。
- **每次 Python 调用全量镜像成本偏高。** 即使只 print(1)，也遍历、读取、base64 编码整个允许镜像；输出又全量遍历/编码比较。未来优先按需文件桥/增量同步，而不是先加更多库。
- **权限授予目前是目录级 readwrite。** 对可信、可丢弃 demo 目录可用；这不等于每次改动都有事务/回滚。没有必要在此阶段为每条命令强加确认弹窗，但失败提交和跨 session 访问必须由实现保证。

## 建议修复顺序

1. **先修真实文件链路：F01、F04。** 一处参数错误会让基本 demo 不成立；失败 rename 会损坏用户数据。补原生句柄与失败提交测试。
2. **封住状态与来源边界：F02、F03、F05、F06。** 在完成这些前，不宜宣称工作区上下文隔离和 GET-only 执行安全。
3. **补限额、错误与镜像契约：F07–F16。** 特别处理自动 relay 权威错误、输入缺失/输出覆盖和取消。
4. **落 AgentSession + ProviderAdapter。** session 持有 workspace、worker、native history、generation、abort 和事件；UI 只消费事件。不要把这套状态迁进 Vue store 后继续混在一起。
5. **迁移 Vue，再做 JS/Edit/扩展。** JS 复用经过验证的计算隔离原则；Edit 复用变更/冲突/提交语义；最后才让 Plugin/MCP/Skill 接入能力注册。

合理的下一版验收不是新增多少工具，而是：真实目录可读可写；失败不会删源；工作区切换不会跨界；超时可以恢复；网络与文件行为有一致的权限和错误语义。

## 附录：本次针对性复现摘要

| 编号 | 方法 | 观察 |
|---|---|---|
| R1 | 真实 LocalDirectoryWorkspace + WebIDL-conforming handle mock | stat 的 false options 导致 TypeError |
| R2 | 真实 runAgentTask，延迟模型响应并替换工作区 | A 发起的旧任务调用 executeTool 时使用 B |
| R3 | 真实 PythonRuntime.run / executeTool，模拟回写失败 | 目标失败、源被删、success=true |
| R4 | 真实 onRequestGet，mock 上游 HTML | text/html、script 原样输出，无响应隔离头 |
| R5 | 真实 onRequestGet，mock 上游 204 | Response 构造器抛 TypeError |
| R6 | 真实 model.js，直连 TypeError + relay 429 | 429 丢失，共 4 次请求 |
| R7 | 真实 model.js，HTTP 200 + reasoning-only/length | 发起第二次端点请求 |
| R8 | 真实 NetworkRuntime，捕获 fetch options | 只有 GET/follow，没有 credentials omit 或 signal |
| R9 | 真实 shell/tool router，执行 quoted > | 调用 victim.txt 写入而非打印文本 |
| R10 | 从 index.html 提取真实 ensurePyodide，初始化失败 | 第二次复用 rejected Promise，底层仅加载一次 |

这些复现用于证明根因，不是拟提交的生产测试。下附可运行脚本，加载位置默认相对于命令行传入的项目根目录；全部使用 mock，不连接真实上游、不操作用户目录。

保存以下代码为 `audit-repro.cjs`，运行 `node audit-repro.cjs /path/to/Locus-browser-agent-runtime`。

```javascript
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const root=require('path').resolve(process.argv[2] || '.')+'/';
function ctx(files,extra={}){const c=vm.createContext({console,TextEncoder,TextDecoder,URL,Response,Request,Headers,AbortController,TypeError,setTimeout,clearTimeout,setInterval,clearInterval,performance,atob,btoa,window:{location:{protocol:'https:'},addEventListener(){}},document:{getElementById:()=>({})},...extra});for(const f of files) vm.runInContext(fs.readFileSync(root+f,'utf8'),c);return c}
(async()=>{
// 1 real adapter, WebIDL-conforming handle stub
const c=ctx(['src/workspace.js']); c.handle={name:'test',async getFileHandle(n,opts){if(opts!==undefined&&opts!==null&&typeof opts!=='object')throw new TypeError('FileSystemGetFileOptions must be an object');return{getFile:async()=>({size:1,lastModified:0})}},async getDirectoryHandle(n,opts){if(opts!==undefined&&opts!==null&&typeof opts!=='object')throw new TypeError('FileSystemGetDirectoryOptions must be an object');return{}}};
try{await vm.runInContext('new LocalDirectoryWorkspace(handle).stat("a.txt")',c);assert.fail()}catch(e){console.log('R1 stat options:',e.message)}
// 2 old task writes into newly selected workspace
let resolveModel; const writes=[]; const a=ctx(['src/agent.js'],{App:{workspace:{name:'A'}},Model:{model:'m'},callModelText:async()=>new Promise(r=>resolveModel=r),executeTool:async(t,input,ws)=>{writes.push(ws.name);return{success:true,output:'ok'}}});
a.term={echo(){},update(){}};const task=vm.runInContext('runAgentTask(term,"write A")',a);await Promise.resolve();vm.runInContext('App.workspace={name:"B"};Agent.history=[]',a);resolveModel('```json\n{"tool":"bash","input":"echo x > target"}\n```');await new Promise(r=>setTimeout(r,0));resolveModel('done');await task;assert.deepEqual(writes,['B']);console.log('R2 old task wrote to:',writes.join(','));
// 3 bridge: failed destination then successful source deletion
const s=ctx(['src/telemetry.js','src/shell.js','src/tools.js']);s.ws={name:'w',list:async()=>[],write:async()=>{throw Error('disk full')},remove:async(p)=>{s.deleted=p}};
vm.runInContext('PythonRuntime._ensureWorker=()=>{};PythonRuntime.worker={postMessage(msg){queueMicrotask(()=>{const p=PythonRuntime._pending.get(msg.id);clearTimeout(p.timer);PythonRuntime._pending.delete(msg.id);p.resolve({files:[{path:"new.txt",b64:"eA=="}],deleted:["old.txt"]})})}}',Object.assign(s,{queueMicrotask}));
const rr=await vm.runInContext('executeTool("bash","python -c \'print(1)\'",ws)',s);assert.equal(rr.success,true);assert.equal(s.deleted,'old.txt');console.log('R3 failed write + deleted source + success=true:',JSON.stringify(rr));
// 4 actual relay active content and null body statuses
const source=fs.readFileSync(root+'functions/fetch.js','utf8');const relay=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
global.fetch=async()=>new Response('<script>document.title="executed"</script>',{headers:{'content-type':'text/html'}});
let res=await relay.onRequestGet({request:new Request('https://locus.test/fetch?url=https://remote.test/payload'),env:{}});console.log('R4 relay active response:',res.status,JSON.stringify(Object.fromEntries(res.headers)),await res.text());
global.fetch=async()=>new Response(null,{status:204});try{await relay.onRequestGet({request:new Request('https://locus.test/fetch?url=https://remote.test/empty'),env:{}});assert.fail()}catch(e){console.log('R5 upstream 204 exception:',e.message)}
// 5 model masks authoritative relay errors then retries
const m=ctx(['src/model.js']);m.calls=[];m.fetch=async(url)=>{m.calls.push(url);if(url==='/proxy')return new Response(JSON.stringify({error:{message:'quota exhausted'}}),{status:429});throw new TypeError('CORS')};vm.runInContext('Model.apiBase="https://model.test";Model.apiKey="test"',m);
try{await vm.runInContext('callModelText({messages:[]})',m)}catch(e){console.log('R6 relay 429 masked:',e.message,'calls=',JSON.stringify(m.calls));assert.equal(m.calls.length,4)}
// 6 successful response parse failure still triggers another paid request
m.calls=[];m.fetch=async(url)=>{m.calls.push(url);return new Response(JSON.stringify({choices:[{message:{content:null,reasoning_content:'thinking'},finish_reason:'length'}]}))};try{await vm.runInContext('callModelText({messages:[]})',m)}catch(e){console.log('R7 HTTP 200 parse failure retries:',m.calls.length);assert.equal(m.calls.length,2)}
// 7 direct request configuration
const n=ctx(['src/network.js']);n.fetch=async(url,opts)=>{n.opts=opts;return new Response('ok')};await vm.runInContext('NetworkRuntime.fetch("https://locus.test/private")',n);console.log('R8 direct fetch options:',JSON.stringify(n.opts));assert.equal(n.opts.credentials,undefined);assert.equal(n.opts.signal,undefined);
// 8 quoted redirect actually writes
s.ws.write=async(p,data)=>{s.writePath=p};const er=await vm.runInContext('executeTool("bash",\'echo ">" victim.txt\',ws)',s);console.log('R9 quoted > writes:',s.writePath,er.success);assert.equal(s.writePath,'victim.txt');
console.log('All 9 reproduction groups completed. Mocks used; no real workspace or external endpoint modified.');
})().catch(e=>{console.error(e);process.exitCode=1});
```

R10 单独保存为 `audit-worker-repro.cjs`，同样传入项目目录。

```javascript
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(require('path').resolve(process.argv[2] || '.', 'index.html'),'utf8');const src=html.match(/<script type="text\/worker" id="py-worker-src">([\s\S]*?)<\/script>/)[1];
let attempts=0;
const c=vm.createContext({self:{},importScripts(){},loadPyodide:async()=>{attempts++;throw Error('temporary CDN failure')}});vm.runInContext(src,c);
(async()=>{for(let i=0;i<2;i++)try{await vm.runInContext('ensurePyodide()',c)}catch(e){console.log('R10 ensurePyodide attempt',i+1,e.message)}assert.equal(attempts,1);console.log('R10 actual load attempts:',attempts,'(second call reuses failed promise)')})()
```
