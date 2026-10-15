# LIWENCode v0.1 测试报告

- **版本**：v0.1.0（内部版，对应 WBS M0+M1，未发布；含交互式 CLI 增量）
- **日期**：2026-10-16（交互命令集增量更新）
- **环境**：macOS (darwin 25.5.0, arm64) / Node v24.15.0 / pnpm 12.11.2 / TypeScript 5.7 / Vitest 3.2
- **结论**：✅ 全部通过 —— typecheck 0 错误、**125/125** 单元与合约测试（含 8 项管道式 REPL 冒烟）、10/10 评测任务、CLI 冒烟全绿。测试过程累计发现并修复 10 项缺陷（§4）。

> 增量（交互命令集）：新增 `interactive.ts`（REPL：流式渲染/终端权限审批/@路径/!命令/Ctrl+C 取消）、`model-config.ts`（Provider 目录、配置持久化、0600 密钥文件）、`slash.ts`（命令解析与帮助）；`/model /permissions /status /cost /tools /compact /clear /resume /doctor /help /exit` 全套落地，`/agents /goal /mcp /rewind` 按里程碑占位。指令集文档见 `docs/COMMANDS.md`。

## 1. 测试范围与结果总览

| 验证项 | 结果 | 数量 |
| --- | --- | --- |
| TypeScript 严格检查（`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`） | ✅ 0 错误 | 5 包 |
| 单元/合约测试（vitest） | ✅ 全部通过 | **125 通过 / 0 失败**（core 58、providers 18、tools 18、testing 9、cli 22） |
| 评测集（G1 种子，确定性 MockProvider 驱动真实内核） | ✅ 全部通过 | **10/10** |
| 错误码注册表治理检查 | ✅ 通过 | 78 码、zh-CN 齐全、可重试 14、fatal 3、DEC-007 空缺保持 |
| CLI 冒烟（真实进程） | ✅ 通过 | 交互式 + 非交互共 11 项 |

## 2. 各包测试明细

### 2.1 `@liwencode/core`（58 项）

- **错误体系（09 章验收）**：注册表 78 码唯一且格式合法；LW-DEC-007 空缺保持（序号不复用）；每个 active 码有 zh-CN 消息且无孤立项；fatal 集恰为 {CTX-002, ACP-001, INT-001} 且均不可重试；可重试集合与登记表一致；`LiwenError` 序列化为固定 7 字段；`is()` 用 Symbol 品牌判定（不依赖 `instanceof`/`name`，多副本安全）；`wrap()` 对非 LiwenError 装箱为 LW-INT-001；未注册码构造时即刻抛错。
- **权限引擎（FR-040~044）**：deny>ask>allow 优先级（BR-001）；default 模式读允许、写无审批器时按 deny（LW-PERM-005）；审批器拒绝 → LW-PERM-002；plan 模式仅放行只读（含分类为只读的 bash 命令）；acceptEdits 放行工作区内写、拒绝工作区外（LW-PERM-003）；bypass 全放行；危险命令库（rm -rf 根/家目录、mkfs、dd 写盘、git push --force、shutdown 等）默认拒绝（LW-PERM-004）且仅用户级 allow 规则可放行（BR-006）；命令分类 16 组用例（只读白名单、管道/链式拆段、重定向判写）；glob 规则匹配（`mcp__github__*`）。
- **Agent 循环（FR-001~006）**：工具往返直至完成；连续只读调用并行批次且结果按调用顺序回填（BR-008）；每个 tool_use 恰好一个 tool_result（BR-009）；中断时未执行调用以 LW-LOOP-003 回填且历史合法；maxTurns 触发 LW-LOOP-001；同参失败 3 次注入提示、5 次终止（BR-011）；未注册工具返回 LW-TOOL-001 结构化错误并列出可用工具；Zod 校验失败返回 LW-TOOL-002 带字段提示；工具超时不挂死循环并继续；20 个并发 agent 实例状态隔离（NFR-004）。
- **管道（BR-012/BR-025）**：截断保头 40% 尾 60% 并附说明；小结果不动；按行数截断。
- **会话（FR-060~062, BR-016）**：内存与 JSONL 文件存储的 append/load/list/fork/delete；损坏行容忍（≤20% 跳过）与超阈值报 LW-SES-002；版本过高报 LW-SES-003。
- **配置（FR-120, BR-002/BR-024）**：用户→项目→环境→代码分层合并且代码层优先；项目级 bypass 被忽略并告警；项目级不能放宽用户 deny（强制回 deny）；非法配置以 LW-CFG-001 报出字段路径。
- **脱敏（FR-045, BR-023）**：8 类常见密钥形态 + 注册值精确替换；只记录类型不记录值；嵌套结构深度脱敏。
- **上下文（FR-050/052）**：提示词分段组装稳定；CJK token 估算重于拉丁。

### 2.2 `@liwencode/providers`（18 项）

- **OpenAI-compatible（FR-012）**：本地 SSE mock 服务器驱动真实 fetch 流式路径；文本增量重组 + usage；流式 tool_calls 聚合为 tool_use 块（参数跨分片拼接）；tool_result 历史转为 role=tool 消息（线上合法性）；401→LW-PRV-001（不重试）、429→LW-PRV-002（可重试）。
- **Anthropic 原生（FR-011）**：message_start/content_block_* 事件流解析；thinking 与 text 块；input_json_delta 碎片聚合为结构化 tool_use；tool_result 原生回传含 is_error；5xx→LW-PRV-009（可重试）；[DONE] 哨兵兼容。
- **G2 合约（同一套测试跑三个 Provider）**：`defineProviderContract` 分别对 MockProvider、OpenAI-compatible、Anthropic 各 5 项（文本流+usage、tool_use 往返、历史合法性、传输错误映射、withRetry 上限=5 次后放弃）——**三Provider 同合约全绿，G2 目标在 v0.1 内核层面达成**。

### 2.3 `@liwencode/tools`（18 项）

- read：行号输出、offset/limit、LW-FS-005；write：新建免读、未读覆写拒绝（LW-FS-001）、外部修改拒绝（LW-FS-002）；edit：唯一匹配替换、多匹配报数量与行号（LW-FS-003）、replace_all、无匹配带近似行提示（LW-FS-004）、未读先改拦截（BR-004/005 全覆盖）；glob/grep：命中、include 过滤、.gitignore 目录/模式排除、非法正则结构化报错；bash：白名单命令执行与 exit 上报、非零退出标记 isError；FileStateTracker 单元。

### 2.4 `@liwencode/testing`（9 项）

MockProvider 请求记录与脚本耗尽语义（LW-PRV-007）；MemoryRuntime 种子/读写/外部修改注入/确定性时钟与 id。

### 2.5 `liwencode` CLI（22 项）

参数解析（-p/exec/--output-format/--model/工具名单/限额）；非法参数与非法枚举含 LW-CLI-001 提示；退出码映射（BR-042）；doctor 无密钥可运行、不打印密钥值（FR-173）。

**交互命令集增量（16 项新增）**：

- **斜杠解析与帮助（纯逻辑）**：命令/参数解析（含空格规整）；/help 覆盖全部 v0.1 命令并标注 M2+/M3+/M4+ 计划项；单命令帮助与未知命令提示。
- **模型配置（FR-121 安全边界）**：Provider 目录完整性（4 个、密钥环境变量映射）；env 文件解析（注释/引号/空行）与序列化往返；`writeEnvFile` 落盘权限恰为 0600；用户配置读写往返；默认模型解析优先级 flag > env > 已保存配置；`keyStatusOf` 能从密钥文件探测就绪状态；`maskKey` 永不泄露完整值。
- **管道式 REPL 冒烟（真实子进程 + 隔离 HOME）**：横幅 + /help + /status + /exit；mock 对话流式渲染回复；**无人值守权限策略**——管道下 write 工具被自动拒绝且输出 LW-CLI-002 说明（BR-042）；/model show 与 /model list 渲染目录与密钥状态；/permissions 展示并切换模式；`!echo` 只读命令放行执行、`!rm -rf /` 危险命令以 LW-PERM-004 拒绝（BR-006）；/mcp /goal 占位提示明确；/doctor 与子命令一致。

## 3. 评测与冒烟

### 3.1 评测集（evals/，G1 种子）

10 项确定性任务经**真实内核**（agent 循环 + 六工具 + 权限引擎 + MemoryRuntime）执行，10/10 通过：

| 任务 | 轮次 | 验证 |
| --- | --- | --- |
| E01 读取并报告 | 1 | 文本包含目标行 |
| E02 新建文件 | 1 | 文件内容一致 |
| E03 唯一匹配编辑 | 2 | 文件内容一致 |
| E04 未读先改防护与恢复 | 3 | 先失败（LW-FS-001）→ 重读 → 成功 |
| E05 glob 查找 | 1 | 结果含目标文件 |
| E06 grep 定位 | 1 | 结果含定义位置 |
| E07 安全命令执行 | 1 | 输出含命令结果 |
| E08 危险命令拒绝 | 1 | rm -rf / 被拒并改述 |
| E09 读→改→验多步流 | 3 | 修复 bug + 检查命令 |
| E10 信息汇总报告 | 1 | 报告含版本号 |

### 3.2 CLI 冒烟（真实进程）

`--version` ✓；`doctor`（12 项检查，无密钥环境正常，不泄露值）✓；`-p` mock text 输出 exit=0 ✓；`--output-format stream-json` 每行含 schemaVersion/sessionId/ts ✓；`--output-format json` 输出版本化结果对象 ✓；非法参数 exit=2 ✓；**真实工作区端到端**（read 工具读真实文件 → mock 汇报 → exit=0）✓。

## 4. 测试驱动的修复与优化（10 项）

| # | 发现 | 修复 |
| --- | --- | --- |
| 1 | tool.start/result 事件只进内部 EventBus，`run()` 消费者看不到（违反 ADR-02 事件流唯一出口） | 事件按调用缓冲、批次结束后按调用顺序 yield，保证确定性顺序 |
| 2 | 忽略 abort 信号的工具会挂死整个循环（违反 NFR-007） | 管道加 hang guard：执行与超时/中断信号 race，永不悬挂 |
| 3 | 中断与超时都报 LW-TOOL-003，语义混用 | guard 区分：外部中断 → LW-LOOP-003 回填（BR-009），超时 → LW-TOOL-004 |
| 4 | **评测发现的真 bug**：权限引擎对相对路径不做工作区锚定，导致 acceptEdits 下所有写入被判"工作区外"（4 个评测任务失败） | `resolve()` 以 workspaceRoots[0] 锚定相对路径 |
| 5 | `LiwenError.is()` 依赖 `name` 字段，子类（SessionError 等）判定失败 | 改为 `Symbol.for` 品牌判定 |
| 6 | `echo hi > out.txt` 被分类为只读（重定向未优先判断） | 重定向检查移到只读白名单之前 |
| 7 | `checkSubject` 不做命令分类，plan 模式误拒 `ls` 类命令 | 分类逻辑内联到引擎入口（FR-043 语义） |
| 8 | `@liwencode/testing` 主入口引入 vitest，导致 evals 等纯 tsx 运行时崩溃 | 合约套件拆到 `@liwencode/testing/contract` 子路径 |
| 9 | **REPL 冒烟发现**：管道输入 EOF 触发 readline `close` 后，`rl.prompt()` 抛 "readline was closed"，后续命令全部丢失 | 全部 prompt/question 调用走 `safePrompt` 关闭守卫；审批器在输入关闭时按拒绝返回 |
| 10 | 流式渲染缺失：循环只发 message.complete，UI 无法增量显示 | 循环转发 provider block_delta 为 `text.delta` 事件（ADR-02），REPL 增量渲染 |

## 5. 已知限制（v0.1 范围外，按 WBS 顺延）

- 真实模型 Provider 仅经本地 SSE mock 验证合约（G2 的"真实密钥联调"待 M1 收尾/用户提供密钥后补充 DeepSeek 实测）。
- TUI、会话恢复 CLI、自动压缩、MCP、决策层、三角色编排未实现（M2~M4 范围）。
- 评测集为 10 项种子，G1 要求的 30 项任务集在 M1 后续扩充。
- CI 工作流已就绪（.github/workflows/ci.yml，ubuntu/macos × Node 22），推送后首跑验证。

## 6. 复现命令

```bash
corepack pnpm install
corepack pnpm typecheck      # 0 errors
corepack pnpm test           # 125 passed
corepack pnpm lint:registry  # 78 codes OK
corepack pnpm test:evals     # 10/10

# 交互模式冒烟（无需密钥）
printf '/help\n/model list\n/status\n/exit\n' | corepack pnpm exec tsx packages/cli/src/main.ts
```
