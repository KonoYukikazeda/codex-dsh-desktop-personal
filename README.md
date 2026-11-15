# codex-dsh-desktop

让 Codex 中的 GPT 通过 MCP 创建、指挥和监督 DeepSeek Harness（DSH）桌面端会话。GPT 负责拆分模块、传递完整要求、检查进度和审查产物；DeepSeek 在真实的 DSH 工作区会话中执行任务，用户可以在桌面侧栏打开这些会话查看过程。

这是安装在 DSH host 中的插件与本机 Streamable HTTP MCP 服务。服务名称与工作区相同：`codex-dsh-desktop`。端点默认是 `http://127.0.0.1:59873/mcp`，由 DSH 的插件生命周期启动；直接运行 `node index.js` 不会启动一个独立的 DeepSeek 客户端。

## 能做什么

- 在指定工作区创建真实 DSH 会话，选择配置的 DeepSeek 模型；用户能在桌面侧栏查看思考、回复和工具执行过程。
- 将完整模块要求交给多个 worker，并通过事件分页、流式进度和等待工具监督执行。
- 自动把 worker 与 session 绑定保存到当前 DSH profile；DSH 或插件重启后仍用原 `sessionId` 继续派工，MCP 客户端重连也看到同一批 worker。
- 执行结束后返回包含会话 ID 的 `handoff`，由 Codex 审查修改、运行验收，并处理关键步骤。
- 验收需要返工或追加功能时，沿用同一个 `workerId` 和会话上下文，附带工作区文件变更简报。

```text
Codex / GPT：计划、协调、关键步骤、最终验收
    ↓ 本机 Streamable HTTP MCP
DSH host 插件：工具、进度、worker 会话保存与恢复
    ↓ DSH 官方会话 API
DeepSeek worker：读取工作区、执行模块任务、报告结果
    ↓ handoff + 进度事件
Codex 审查 → dsh_assign_task(原 workerId) → 继续同一会话
```

## 安装和连接

以下命令以 Windows PowerShell 为例。

### 1. 准备环境并获取源码

需要：

- 已安装、能够加载 Cordis host bundle 的 DSH 桌面端；已配置可用的 DeepSeek provider 和模型。
- Codex 桌面端，以及能运行 `codex mcp` 的 Codex CLI。
- Git、Node.js 22 或更新版本及 npm。本项目在 Node.js 24 下验证。
- 一个可由 DSH 访问的本地项目目录，作为 worker 工作区。

本插件依赖 DSH 的运行时 API。不同版本若更改插件或会话接口，需要适配；安装前应确认桌面端本身能正常运行所选模型。

```powershell
git clone https://github.com/Hyper66666/codex-dsh-desktop.git
Set-Location codex-dsh-desktop
npm ci
```

`npm ci` 安装锁定依赖；DSH 仍负责实际模型调用与桌面会话运行。

### 2. 修改插件配置

编辑仓库中的 `cordis.patch.yml`。仓库默认配置如下：

```yaml
- insert:
    - id: codex-dsh-desktop
      name: 'codex-dsh-desktop'
      config:
        host: 127.0.0.1
        port: 59873
        path: /mcp
        model:
          provider: deepseek-official
          model: deepseek-flash
          reasoningEffort: high
```

默认使用 DSH 内置的 **DeepSeek 官方 API 渠道**（`deepseek-official`），模型为 `deepseek-flash`，推理强度为 `high`。请先在 DSH 中打开「设置」→「模型」→「DeepSeek」→「编辑」，填写自己的「API 密钥」并「保存」，确认模型可用。密钥在 DSH 中管理，不写入本插件配置。

官方接口地址：

- DSH 当前官方适配器默认使用 Anthropic 兼容地址：`https://api.deepseek.com/anthropic`，消息请求地址为 `https://api.deepseek.com/anthropic/v1/messages`。
- DeepSeek 的 OpenAI 兼容基础地址为 `https://api.deepseek.com`，聊天请求地址为 `https://api.deepseek.com/chat/completions`。

本插件通过 DSH 的 provider 调用模型，API 地址和 API Key 由 DSH 管理；MCP 地址 `http://127.0.0.1:59873/mcp` 是本机桥接服务地址。官方当前推荐的 Flash 模型 ID 是 `deepseek-flash`，也可按需选择 `deepseek-v4-pro`，详见 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/)。如果自行重命名了 DSH provider，应将这里的 `provider` 改成对应标识。

仓库默认不绑定作者的本机路径。创建 worker 时传入绝对路径 `cwd`，或已有的 `workspaceId`；两者互斥。如果希望调用时省略工作区，可在 `config` 下添加自己的默认路径，与 `host` 同级：

```yaml
        workspace: D:/projects/my-project
```

`cwd` 可以指向其他项目，MCP 名称保持 `codex-dsh-desktop`。同一 worker 创建后不能更换工作区。Windows YAML 路径建议使用 `/`。

`host` 保持回环地址；若修改 `port` 或 `path`，后面的 Codex URL 也需同步。`selectModel()` 在当前 DSH 实现中还可能更新全局默认模型，创建 worker 后需要留意其他新会话的默认选择。

### 3. 打包并安装到 DSH

```powershell
npm test
npm pack --dry-run
npm pack
Resolve-Path ./codex-dsh-desktop-1.1.0.tgz
```

最后一条命令显示生成包的绝对路径。在 DSH 侧栏进入「插件」→「添加插件」→「安装第三方插件」，在「包名或地址」填入这个 `.tgz` 的绝对路径，然后点击「安装」。确认插件已启用。

也可以在 DSH 的 Creator（创造）模式新建会话，发送以下请求，将路径改成上一步的结果：

> 请使用 plugin_manager 安装并启用本地 bundle，action 为 install_bundle，target 为 D:/path/to/codex-dsh-desktop/codex-dsh-desktop-1.1.0.tgz，enabled 为 true。检查安装结果中的 application 和 warnings，说明插件是否已应用，以及是否需要重启。

对应的官方工具参数是：

```json
{
  "action": "install_bundle",
  "target": "D:/path/to/codex-dsh-desktop/codex-dsh-desktop-1.1.0.tgz",
  "enabled": true
}
```

使用当前 profile 的官方入口完成依赖安装和插件加载。若返回需要重启，按结果操作；以上菜单和工具来自当前开发环境，后续 DSH 版本可能调整。应用成功后，在 DSH 日志中应看到：

```text
MCP endpoint listening at http://127.0.0.1:59873/mcp
```

这是 **DSH host 插件**。直接运行 `node index.js` 不会启动服务；单独执行 `npm ci`、打包或复制目录也不等于安装到 DSH。

worker 与 session 的绑定默认保存在当前 DSH profile 的 `codex-dsh-desktop/workers.json`，由 DSH 的 `profileContext.dir` 决定，普通安装无需额外配置；不要把它指向业务目录或 MCP 客户端目录。

### 4. 注册到 Codex

保持 DSH 运行，在终端执行：

```powershell
codex mcp add codex-dsh-desktop --url http://127.0.0.1:59873/mcp
codex mcp get codex-dsh-desktop
```

也可以在 Codex 使用的 `~/.codex/config.toml` 中配置同等内容：

```toml
[mcp_servers.codex-dsh-desktop]
url = "http://127.0.0.1:59873/mcp"
```

在 Codex 桌面端刷新 MCP 连接，必要时重新打开应用，使它读取更新后的配置。若已有同名配置，先检查当前 URL，避免重复添加。连接后应出现下述七个工具。

### 5. 检查首次运行

在 Codex 中发出一项有明确边界的任务，例如：

> 使用 codex-dsh-desktop，在 D:/projects/my-project 创建 workerId 为 project-reader 的 DeepSeek 会话。要求它阅读 AGENTS.md、README.md 和 package.json，只总结项目结构，不修改文件。持续监督进度，完成后由你检查报告；后续任务复用这个 worker。

将路径换成自己的项目。检查 DSH 对应工作区侧栏是否出现新会话、是否真实读取文件，以及 Codex 是否收到了完成后的报告。`accepted: true` 只表示任务已接收。若等待超时而任务仍在运行，应继续调用等待或进度工具。

## 可选 Bearer 校验

服务仅监听本机回环地址，并校验 Host 和 Origin。需要额外校验时，在插件的 `config` 下设置 `token`，重新打包安装；在本机保存该值，不要将它提交到 GitHub。随后使用同值环境变量注册：

```powershell
codex mcp add codex-dsh-desktop --url http://127.0.0.1:59873/mcp --bearer-token-env-var CODEX_DSH_MCP_TOKEN
```

或在对应 TOML 表中添加：

```toml
bearer_token_env_var = "CODEX_DSH_MCP_TOKEN"
```

`CODEX_DSH_MCP_TOKEN` 必须存在于 **Codex 桌面进程实际能读取的环境**；仅在另一终端临时设置变量，不会更新已启动应用的环境。插件不会自动读取 `.env`。

## 工具

| 工具 | 用途与主要参数 |
| --- | --- |
| `dsh_start_worker` | `workerId`、`task` 必填；可选 `role` 和 `cwd` 或 `workspaceId`。两个工作区选择参数互斥，均省略时使用插件默认工作区。创建可见会话、选择 DeepSeek 模型并派发首项任务；已存在的 `workerId`（包括重启后恢复的）继续使用原会话。 |
| `dsh_bind_worker` | `workerId`、`sessionId` 必填，可选 `role`。只把已有 DSH 会话绑定到 worker 并读取状态，不派发任务、不改历史、不选模型、不归档；用于一次性迁入此前未自动保存的旧会话。同一 `workerId`/`sessionId` 重复绑定幂等，冲突或会话缺失会明确报错。 |
| `dsh_assign_task` | 给现有 `workerId`（包括自动恢复或手动绑定的 worker）派发完整 `task`。`mode: "queue"` 为默认值，排在当前工作之后；`mode: "steer"` 用于重定向进行中的工作。附带从上次派发以来的工作区元数据变更简报。 |
| `dsh_list_workers` | 查看当前 DSH profile 已持久保存的 worker、桌面会话 ID、职责、状态及最近派发的任务。DSH 会话被删除或缺失时会显式报告 `missingSession`/`sessionError`，不会冒充可复用。 |
| `dsh_get_progress` | 根据 `workerId`、`sinceSeq`、`limit` 读取最早一页尚未读取的持久事件，包含文本、思考和工具调用。冷会话历史读取失败会明确报错；历史接口不可用时返回 `historyUnavailable`，不把空结果当作完整历史。 |
| `dsh_wait_worker` | 监督 worker 并返回进度页。默认 `waitFor: "completion"`，最多等待 `timeoutMs` 毫秒（默认 30000、上限 60000），直到当前 turn 结束、失败、取消、阻塞或超时；`waitFor: "progress"` 可在新事件或流式进度出现时及时返回。完成响应带有交回 Codex 审查的 handoff。接受与 get_progress 相同的 `sinceSeq` 和 `limit`。 |
| `dsh_cancel_worker` | 取消该会话当前 turn，保留会话和待办队列。随后读取进度确认状态；队列会被保留，但 DSH 不保证取消后自动唤醒，通常需要再次派发任务才能继续。 |

`workerId` 最长 128 字符，`role` 最长 1024 字符，`sessionId` 最长 256 字符，`task` 最长 200000 字符；工作区路径最长 4096 字符，工作区 ID 最长 256 字符。字符串必须包含非空白字符。工具拒绝未知字段；`limit` 为 1–500，默认 100。

## 完整传递任务

worker 不会自动继承 GPT 的聊天上下文。GPT 应在每次 `task` 中传递目标、职责边界、必读文件、完整要求、约束、验收方式和报告格式。插件保留 `task` 原文：首次派工只自动附加「本会话标题须以 "[GPT] - " 开头。」和「请用中文分析和汇报。」两句（task 已含标题句时不重复），后接原样任务，不再加角色、身份、读文件或主验包装，这些由任务正文和 AGENTS 承载；后续派工直接接原样任务，仅在正文前保留必要的中文工作区变化摘要，不加「本次补充」「任务原文」等标题。DeepSeek 做主验，GPT 复核关键结果与复用证据并做业务裁决。

例如，由 GPT 调用 `dsh_start_worker`：

```json
{
  "workerId": "session-module",
  "role": "会话模块实现",
  "cwd": "D:/codex-dsh-desktop",
  "task": "先阅读 AGENTS.md、package.json、lib/sessions.js 和相关测试。目标：为会话模块补齐指定的进度分页行为。仅修改 lib/sessions.js 及其测试，不修改其他模块。使用已有依赖和项目约定。验收：从 seq=0 开始连续分页，无遗漏或重复；测试通过。完成后报告修改文件、验证命令与结果、剩余问题，然后等待后续任务。"
}
```

并行 worker 共享工作区文件。GPT 应分配明确的文件或模块所有权，处理交接和依赖，并在 worker 报告完成后自行审查 diff 和运行适当检查。worker 空闲只表示当前执行已结束，不代表它已经满足验收标准。

## 监督、游标和流式进度

DSH 持久事件的 `seq` 从 **0** 开始。首次读取省略 `sinceSeq`，或设置为 **-1**：

```json
{ "workerId": "session-module", "sinceSeq": -1, "limit": 100 }
```

响应的 `events` 按 `seq` 升序返回。使用当前页的 `nextSeq`（当前页最后事件的序号，也就是分页用的 `lastSeq`）作为下一次的 `sinceSeq`；`hasMore: true` 时继续读取。`latestSeq` 描述整个会话已知的最后序号，不能用它跳过尚未读完的页面。空页保留已有游标。

新持久事件通常在一段模型消息或工具活动完成后写入。模型仍在输出时，响应还可包含独立的 `transientProgress` 快照：

```text
{ attemptId, revision, lastChunkIndex, text, truncated, updatedAt }
```

该字段展示当前 attempt 的思考、文本或工具参数流，`revision` 是 DSH 的流修订号，`lastChunkIndex` 表示已观察到的输出位置；它与持久事件的 `seq` 独立，不应拿来推进事件游标。快照最多保留最近 12000 字符，attempt 结束后清空，以持久事件为准。

单个持久事件文本最多 6000 字符，每页事件文本总计最多 60000 字符。截断时响应明确标记 `truncated` 并保留事件序号；需要完整内容时应查看 DSH 会话或相关工作区文件。`dsh_wait_worker` 的等待被 MCP 请求取消时只停止此次等待；要停止 DeepSeek 当前工作，应调用 `dsh_cancel_worker`。

派发返回的 `accepted: true` 只表示 DSH 接受任务，并带有 `phase: "deepseek-running"` 的 handoff。默认等待 `waitFor: "completion"` 会在 DeepSeek 当前 turn 结束后返回 `handoff.phase: "deepseek-complete"`（或失败、取消、阻塞对应的终态），其中包含 `workerId`、`sessionId`、`awaitingReview: true` 和下一步建议。这个会话仍由插件保留并持久绑定，Codex 应读取 diff、检查 DeepSeek 报告并运行关键验收；`succeeded: true` 仅表示当前 turn 以 `completed` 结束，绝不代表最终验收通过。验收不合格或需要追加功能时，必须调用 `dsh_assign_task` 并传回同一个 `workerId`，这样会沿用同一个 `sessionId` 和对话上下文；只有职责真正独立或需要完全隔离的上下文时才创建新的 worker。若冷会话已从当前 DSH agent 运行时释放，状态为 `released`，这不等于任务成功或失败；仍可继续用同一 `workerId` 派发任务唤醒它。插件会保留观察到的 `agent/error`，直到下次派发时清除。

完成 handoff 的 `nextAction` 会明确要求 Codex 审查工作区并在需要时复用原 worker。MCP 客户端断线只会结束 MCP 传输会话，不会主动取消 DeepSeek；插件还会定期回收闲置的 MCP 传输会话以释放连接容量，回收不会删除已保存的 worker。

`handoff` 是工具响应中的交接信息。Codex 需要继续调用等待或进度工具来接收结果；它不会在 Codex 已结束当前工作后，主动唤醒一段新的 Codex 对话。建议的监督循环是：派发 → 等待或读取进度 → 用 `nextSeq` 继续分页 → 超时则继续等 → 完成后验收 → 必要时向原 worker 追加任务。

例如验收后返工，调用 `dsh_assign_task`，而不是另建会话：

```json
{
  "workerId": "session-module",
  "mode": "queue",
  "task": "继续刚才的会话。先重新阅读发生变化的文件与 git diff。验收发现：空事件页的游标回退。请仅修复已分配模块并补充回归验证，完成后报告结果，等待下一轮审查。"
}
```

## 复用、自动保存和恢复

在同一 DSH profile 中，worker 完成一项任务后保留会话和上下文，GPT 可用 `dsh_assign_task` 继续派发工作。上下文复用可减少重复背景，但实际 token 用量仍受 DSH 的上下文整理、模型请求和缓存机制影响。

插件在成功创建、派工或绑定后，把 `workerId`、`sessionId`、`role`、`workspaceId`、`cwd`、创建/更新时间及派工元数据保存到当前 DSH profile 的数据目录：`<profileContext.dir>/codex-dsh-desktop/workers.json`。这是 DSH 官方提供的 profile 作用域位置，不依赖 `process.cwd()`、MCP 客户端目录或业务目录，普通安装无需配置。写入使用同目录临时文件 + 原子重命名，并串行化并发保存；文件带版本号，损坏、版本不兼容、重复 worker/session 或读写失败都会明确报错，不会被静默当作空 registry 覆盖。测试或特殊部署可用 `config.stateFile` 显式覆盖路径。

服务启动时先加载 registry，再开放 MCP 工具。插件用 DSH 的真实会话列表和会话状态校验旧绑定：恢复 `cwd` 等元数据，但不会自动发送 prompt、重放上次任务、取消任务、重新选模型或归档会话；冷会话需要新的 turn 事件才会被视为本轮完成。MCP 客户端断开或重连只影响传输会话，不会删除 registry；两个不同客户端看到同一批 worker。DSH 或插件重启后，原 `workerId` 继续派工时仍使用原 `sessionId`，不会额外创建会话。

如果 DSH 会话已被真正删除，`dsh_list_workers` 会返回 `missingSession: true` 和 `sessionError`，派工/进度/取消会明确报错，插件不会静默新建替代会话。此前未保存的旧会话，用 `dsh_bind_worker` 把 `workerId` 与已有 `sessionId` 一次性绑定；它只绑定并读取状态，不发送任务、不改历史、不选模型、不归档，之后由 registry 自动恢复。同一 worker/session 重复绑定幂等；worker 与 session 的冲突会明确报错，写入失败会回滚，不留半绑定。

再次派发前，若当前 DSH 提供 `workspaceRegistry.unarchiveSession`，插件会通过这个官方接口恢复已归档的原会话；恢复失败会返回派发错误，不会悄悄创建替代会话。

变更简报的基线是该 worker **上次成功派发任务前采集的快照**，不是任务完成时的快照，因此上次任务自身造成的文件变化也会出现在后续简报中。

快照只扫描文件路径、大小和修改时间，不读取文件正文。默认最多采集 5000 个文件、访问 1000 个目录，并跳过符号链接及 `.git`、`.dsh`、`.omx`、`node_modules`、缓存和常见构建输出目录。简报最多列出 80 个变更路径，其余数量会明确显示。达到上限或读取失败时明确报告覆盖不完整，不把未读取到的路径误报为删除；基线不完整时也不会推断无法确认的新增。

这是一份帮助 worker 定位变化的简报。大小和修改时间都不变的内容变化、被忽略的目录和扫描期间发生的并发修改都可能未被发现。worker 每次继续工作都应重新阅读相关文件，并结合 `git diff` 检查实际变化。

## 文件与模块对应关系

| 文件 / 目录 | 职责 |
| --- | --- |
| `package.json` | ESM 入口、依赖、DSH bundle 声明、运行时文件白名单与测试命令。 |
| `package-lock.json` | 锁定 npm 依赖版本，供 `npm ci` 使用。 |
| `cordis.patch.yml` | 将插件插入 DSH profile，并配置监听地址、模型和可选默认工作区。 |
| `index.js` | 插件入口，注入 DSH 服务、订阅事件，通过 Cordis effect 管理长期运行的资源。 |
| `lib/server.js` | 回环 HTTP 端点、MCP 握手与工具调用、每客户端独立的 stateful transport、连接回收和关闭。 |
| `lib/sessions.js` | worker 与 DSH 会话映射、创建/派发/复用/恢复/绑定/取消、生命周期判断、进度等待与 handoff。 |
| `lib/registry.js` | profile 作用域的版本化 worker registry：加载校验、原子写入、串行化保存与冲突检测。 |
| `lib/tools.js` | 七个 MCP 工具的名称、说明、JSON Schema 与输入校验。 |
| `lib/render.js` | 将持久事件和临时模型流转换成可读进度，处理分页文本上限及截断标记。 |
| `lib/briefing.js` | 扫描工作区文件元数据，比较快照，为后续任务生成增量变更简报。 |
| `lib/token.js` | 可选 Bearer token 校验。 |
| `locale/zh.json`、`locale/en.json` | DSH 插件的中文、英文标题与描述。 |
| `icon.svg` | 插件图标。 |
| `scripts/smoke.mjs` | 连接真实 DSH 的只读端到端检查，验证文件读取证据、进度与同会话二次派发。 |
| `test/*.test.js` | Node 内置测试，覆盖工具、会话恢复、registry、传输、插件生命周期、渲染、变更简报及 token。 |
| `docs/plans/2026-10-18-desktop-mcp.md` | MCP 架构与验证计划。 |
| `.gitignore` | 排除依赖、本机凭据、打包文件和临时产物。 |

打包时使用 `package.json` 的 `files` 白名单。测试与开发脚本保留在 Git 仓库中，不装入运行时 bundle。

## 开发与验证

```powershell
npm test
npm pack --dry-run
```

测试覆盖本地逻辑及真实 MCP SDK 传输。`npm pack --dry-run` 检查 bundle 文件完整性。它们通过后，还需要实际 DSH 联调才能验证模型可用性与桌面侧栏显示。

真实端到端检查：先安装并启用插件，将插件的默认 `workspace` 配置为**本仓库绝对路径**，再运行：

```powershell
node scripts/smoke.mjs --endpoint http://127.0.0.1:59873/mcp
```

该脚本会调用真实 DeepSeek，可能消耗模型额度。它要求实际读取指定文件并观察工具调用证据，随后向同一个 `workerId` 派发第二个只读任务，检查 `sessionId` 是否保持一致；只读约束通过任务要求传达，实际工具权限仍由 DSH 控制。脚本最多观察 120 秒，超时或断线不会主动取消 worker。输出为 JSON 行，便于查看进度和失败原因。可选 token 使用环境变量 `CODEX_DSH_MCP_TOKEN`。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| Codex 连接被拒绝 | 确认 DSH 正在运行、插件启用、日志已显示监听；核对端口和路径。Windows 可用 `Test-NetConnection 127.0.0.1 -Port 59873` 检查 TCP，完整握手仍以 MCP 工具列表为准。 |
| 日志出现 `EADDRINUSE` | 本机端口已占用，检查是否重复启用插件；修改插件端口后同步 Codex URL。 |
| HTTP 401 | Bearer token 缺失或不一致，检查插件配置与 Codex 进程的环境变量。 |
| HTTP 403 / Host、Origin 错误 | 使用配置的本机回环 URL；来自其他网页源、代理或远程主机的请求可能被拒绝。 |
| 提示没有工作区 | 在 `dsh_start_worker` 传入绝对 `cwd` 或已有 `workspaceId`，或配置插件默认 `workspace`。 |
| 模型不存在 / provider 不可用 | 在 DSH 中配置官方 DeepSeek 渠道的 API Key，确认 `deepseek-official` 下的 `deepseek-flash` 可用；若自定义了 provider 标识或模型配置，同步修改插件配置。 |
| 接收任务后没有输出 / 状态为 blocked | 打开返回的 `sessionId` 对应桌面会话，检查模型错误、权限、审批与事件中的阻塞原因；修正后向原 worker 重派。 |
| `Unknown worker` | 该 `workerId` 尚未创建或绑定。先调用 `dsh_start_worker`；若旧会话此前未保存，用 `dsh_bind_worker` 迁入。若 registry 损坏或读写失败，按错误中的文件路径修复或移动文件；插件不会用空 registry 覆盖。 |
| 工具列表没有 `waitFor` 等新参数 | 确认 DSH 应用的是新包，再刷新或重连 Codex MCP；仅修改源码不会更新已安装包。 |
| 等待返回 `timedOut: true` | 本次观察达到时限，检查状态并继续等待；超时不代表 DeepSeek 已结束。 |
| 多个 worker 修改互相覆盖 | worker 共享工作区，需由 Codex 划分文件所有权、串行处理依赖并在交接后检查 diff。 |

更新插件时，修改配置、重新打包并通过同一官方入口安装新包，确认已应用后刷新 Codex 连接。重新加载或重启不再结束 worker 绑定；registry 会保留并在下次启动时校验恢复，但正在运行的任务仍应先安排好，避免安装/重启打断当前 turn。移除 Codex 连接可执行 `codex mcp remove codex-dsh-desktop`；卸载插件则使用 DSH 的插件管理入口。
