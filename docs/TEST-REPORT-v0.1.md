# LIWENCode v0.1 测试报告

- **版本**：v0.1.0（内部版，对应 WBS M0+M1，未发布；含交互式 CLI、权限三档与 TUI 渲染稳定性增量）
- **日期**：2026-10-16（权限三档增量更新；TUI 渲染稳定性与 /permission 增量）
- **环境**：macOS (darwin 25.5.0, arm64) / Node v24.15.0 / pnpm 12.11.2 / TypeScript 5.7 / Vitest 3.2
- **结论**：✅ 全部通过 —— typecheck 0 错误、**211/211** 单元与合约测试（含 13 项管道式 REPL 冒烟）、10/10 评测任务。测试过程累计发现并修复 25 项缺陷（§4）。

> 增量（权限三档）：新增 `strict` 权限模式（core 引擎一级模式：一切操作含读取都需确认）；CLI 新增 `--HuangAura`（读取免确认，写/删/执行需确认）与 `--WenNova`（文件增删改查读全免确认）档位参数，二者互斥；无参数启动默认严格档；优先级 `--permission-mode > 档位 > 用户配置 > strict`；REPL 横幅与 `/permissions` 显示当前档位。修复 macOS realpath（/var vs /private/var）导致临时目录工作区被判越界的缺陷。

> 增量（渲染稳定性 + `/permission`）：新增 `/permission` 指令（三档直接切换，`/permissions` 与之参数互通）；指令联想改为**全量列表 + 行内中文简介 + 视窗滚动**；TUI chrome 改为**逐行差分渲染 + synchronized update**，实测消除移动选择与空闲时的终端闪烁（§8）。修复光标定位 off-by-one（落在框底边框而非输入行，经 pyte 交叉验证，§4 #25）。

## 1. 测试范围与结果总览

| 验证项 | 结果 | 数量 |
| --- | --- | --- |
| TypeScript 严格检查（`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`） | ✅ 0 错误 | 5 包 |
| 单元/合约测试（vitest） | ✅ 全部通过 | **211 通过 / 0 失败**（core 59、providers 19、tools 18、testing 9、cli 106） |
| 评测集（G1 种子，确定性 MockProvider 驱动真实内核） | ✅ 全部通过 | **10/10** |
| 错误码注册表治理检查 | ✅ 通过 | 79 码、zh-CN 齐全、可重试 14、fatal 3、DEC-007 空缺保持 |
| CLI 冒烟（真实进程） | ✅ 通过 | 交互式 + 非交互共 13 项；TUI pty 冒烟 2 项 |

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

## 4. 测试驱动的修复与优化（28 项）

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
| 11 | **三档冒烟发现**：macOS 上 `--cwd` 指向 `/var/folders/...` 临时目录时，realpath 返回 `/private/var/...`，与未规范化的 workspaceRoot 不匹配 → 误判"工作区外"（LW-PERM-003） | 权限引擎对 workspaceRoots 做一次性 realpath 规范化后缓存再比较 |
| 12 | 档位断言与固定横幅文案冲突（管道模式提示恒含"无人值守"字样） | 断言改用 `LW-CLI-002` 作为实际拒绝标记（测试侧修正，同时印证横幅提示与真实拒绝可区分） |
| 13 | **TUI 翼展断言发现**：蝴蝶翅膀 `\|cos(4πf)\|` 在扇动窗口内完成 4 个开合周期（扇了四下，不是两下） | 改为 `\|cos(2πf)\|`，恰好两个开合周期=扇两下；身体起伏同步改两周期 |
| 14 | **hold 静止断言发现**：艺术字相位后 hold 阶段起点仍取蝴蝶位置，成型后会重新变形一次 | hold 起点取 art 目标（静止），仅保留同层色彩脉动 |
| 15 | 变形缓动按整个相位时长推进：蝴蝶阶段开始 1.4s 后粒子仍在半途，扇动测试测到的是变形进度而非翅膀开合 | 引入变形窗口（skyline 0.8s / butterfly 0.5s），窗口内完成位移、窗口外粒子锁定目标 |
| 16 | **状态栏测试发现**：provider 未上报缓存字段时命中率被当作 0% 显示 | 引入 `sawCacheField` 标记：从未上报 → 显示 —，上报过（含 0）→ 显示百分比 |
| 17 | **pty 冒烟发现**：pty 下 `output.columns=0`，底边框 `'─'.repeat(cols-2)` 抛 "Invalid count value: -2" 直接 fatal | drawChrome 列数下限保护 `max(24, columns ?? 80)` |
| 18 | **欢迎面板翼展断言发现**：蝴蝶触角横向位置做了 `/wing` 补偿，收翅时触角反向张开成 11px，翼展断言失败 | 触角位置固定不随翅膀缩放 |
| 19 | **翼展断言再发现**：收翅点取在半周期（\|cos(π)\|=1 仍全开），与启动动画同源的 \|cos\| 周期陷阱 | 收翅断言点改为 1/4 周期 |
| 20 | **等宽断言发现**：欢迎面板内容行分隔符实际占 7 列而公式按 8 列算，行宽 87≠88 | `leftW+rightW = panelW−7` 修正 |
| 21 | **pty 全序列冒烟发现的严重 bug**：`/setup` 各步永远报"必填为空"卡在第 1 步——`feed()` 同步处理 Enter 时已清空缓冲区，事件循环里再读 `editor.text()` 得到空串 | 向导 submit 改用事件携带的 `ev.text`（与主输入路径一致）；Tab 确认路径回退读编辑器 |
| 22 | 向导脚注行按硬编码 44 列补 padding，实际文本 38 列导致行宽短 6 列 | 统一走 pushRow 宽度计算 |
| 23 | 向导编辑模式无法"回车沿用现有值"（校验先于编辑语义判断） | 编辑模式下文本步空输入跳过必填校验、保留原值 |
| 24 | **pty 探针发现的闪烁根因**：每次 ↑↓ 移动联想整块 `ESC[J` 擦除 + 全量重画（实测 ~44KB/按键、4–5 次全量擦除）；150ms 状态定时器空闲时也在全量重画（~88KB/1.2s）；根因是「清除下方 → 逐行重写」的整块刷新模式在每次按键都执行 | chrome 改为**逐行差分渲染**：只原位重写变化行（`\r`+行+`ESC[K`），帧收缩时原位清空多余行并保持底部锚定；内容未变时**零写入**；整帧用 synchronized update（DEC 2026）包裹。实测 ~440B/按键、0 次全量擦除、空闲 0 字节 |
| 25 | **模拟器/pyte 双重验证发现的光标 off-by-one**：光标尾部定位用 `CUD(aboveBox+2)`，实际落在输入框**底边框**行而非输入行（内容行应为锚点+aboveBox+1）；且帧收缩路径未补偿帧偏移，关闭联想后光标会飞到屏幕顶部 | 光标定位修正为 `aboveBox+1+帧偏移`；新增 `frameInset` 跟踪帧相对锚点的行偏移，差分/收缩路径统一补偿 |
| 26 | **面板测试发现**：`truncateToWidth` 不识别 ANSI 转义，把转义字节算作可见列——带颜色的表格行被提前截断（`yes`→`ye`，甚至截断在转义序列中间产生乱码残留） | 改为转义序列零宽透传（sticky 正则），不再截断于序列内部 |
| 27 | **pty 冒烟发现**：pty 宽度 24 列 + `edit team` 长标题使 `repeat(负数)` 抛 RangeError 崩溃（两个向导同款风险） | 两个向导渲染均做标题截断与 `Math.max(0, fill)` 下限保护 |
| 28 | 命令重写时按范围替换误删 `switchModel`（typecheck 立即报 5 处未定义） | 恢复函数并全局复核引用 |

## 5. TUI 专项（v0.1 追加，36 项单测 + pty 冒烟）

### 5.1 启动粒子动画 `tui/boot.ts`（11 项）

- **相位时间轴**：skyline(2.0s)→butterfly(2.4s)→art(1.0s)→hold(1.0s) 首尾相接，总时长 6.4s，`phaseAt` 边界切换正确。
- **确定性**：同种子同尺寸 `pixelSnapshot` 逐像素相等（可复现测试）。
- **城市天际线**：聚合完成后建筑轮廓冷色（39/45/81）与窗灯暖色（220/226）同时出现，像素量 >150。
- **蝴蝶扇动两下**（数值断言）：扇动窗口 [2.5s, 3.9s] 内翼展呈 开→收→开→收→开 五点采样，收翅翼展 < 开翅 60%、相邻开收比 >2；收势阶段保持全开。*此断言曾抓出真实 bug：初版 `|cos(4πf)|` 实际扇动四下，修正为 `|cos(2πf)|`。*
- **三层色艺术字**：hold 帧蓝（33/39）、绿（46/48）、紫（135/141）三色同屏；蓝色平均行号 < 紫色（蓝上紫下）。
- **hold 静止**：不同时刻两帧像素几何完全一致（仅色彩脉动）——曾抓出 hold 起点误取蝴蝶位置的相位衔接 bug。
- **门控**：终端 <40 列或 <12 行不播放；`--no-boot` 解析。

### 5.2 行编辑器 `tui/editor.ts`（8 项）

插入/提交/Backspace/Delete/左右/Home/End；CJK 按码点删除（不切半个字）且 `cursorCol` 按 2 列计；↑↓ 历史浏览保留草稿、重复提交不入栈；Ctrl+U/K 行编辑；Ctrl+C 中断、Ctrl+D 空行 EOF / 非空充当 Delete；一次 feed 多键（粘贴）。

### 5.3 状态栏 `tui/status.ts`（8 项）

- 轮次（turn.start）/步数（tool.start）计数；usage 累计与缓存命中率 = cacheRead/(cacheRead+input)。
- **"未上报缓存"与"缓存命中 0"区分**：provider 从未返回缓存字段时命中率显示 —（曾把未上报当 0%，已修）。
- **速度语义**：流式期间按实时字符速率估算 tok/s；message.complete 后固定为末次速度（用户需求"工作结束了就是最后一次输出的速度"）。
- formatTokens 分级缩写；状态行含全部六字段；窄终端自动从右丢弃字段。

### 5.4 宽度与字形 `tui/width.ts` + `tui/font5x7.ts`（9 项）

CJK/全角/emoji 列宽；ANSI 转义零列；truncateToWidth 不切半个宽字符；padToWidth 按显示宽度补齐。5x7 点阵：LIWEN CODE 坐标在网格界内、gridWidth=字数×6−1、未知字符按空格、两次渲染逐点一致。

### 5.5 pty 冒烟（真实终端仿真，2 项）

macOS `script` 分配 pty 驱动真实 TUI：逐字输入实时回显且光标 ESC 序列按 CJK 宽度前进（4C→8C→12C）；提交回显、mock 流式回复渲染于输入框上方、回合结束 chrome 重绘、/exit 退出；mock 未配脚本时 LW-PRV 错误正常打印于 chrome 上方。*曾抓出 pty 下 `output.columns=0` 导致 `'─'.repeat(-2)` 崩溃，已加列数下限保护。*

### 5.6 实现要点（无第三方依赖）

半块渲染（▀ 上/▄ 下，垂直分辨率 ×2）；粒子系统 tick(tMs) 纯时间驱动（确定性可测）；ESC7/ESC8 + 清除下方实现底部锚定 chrome、流式输出零整屏刷新；raw 模式输入统一走 LineEditor 状态机；权限审批/配置向导复用同一输入框（问题显示于框标题）。

## 6. 欢迎面板与指令联想（v0.1 追加，18 项单测 + pty 冒烟）

### 6.1 欢迎面板 `tui/welcome.ts`（6 项）

- 迷你像素字体（"LIWENCode" 专用变宽 5 行）点阵边界与紧凑宽度 32 列。
- 黑白阴影艺术字：主字亮白 250 + 投影深灰 238，**仅两色无彩色**；纵向 ×2 适配半块正方形像素。
- 多彩蝴蝶：彩虹六色（196/208/226/46/44/21）按曲线角度分区，着色 ≥3 色；1/4 周期处翼展 < 全开 60%（持续扇翅，2.4s 周期）；`t` 与 `t+周期` 逐像素一致（周期性）。
- renderPanel：行数=panelH、首尾行圆角边框、去 ANSI 后每行等宽、含 "Welcome to LIWENCode" 与模型/提示、右侧文本无 CJK（全英文）、两时刻帧不同（动画驱动）。
- 终端 <64 列或 <20 行返回空（调用方回退旧横幅）。

### 6.2 指令联想 `tui/palette.ts` + 编辑器 nav（12 项）

- 提示表 18 条全部 `/` 开头、名字唯一、英文 desc 无 CJK、**中文 brief 非空**（行内简短介绍）。
- 前缀过滤：非 `/` 开头 / 空行 / 已带参数（含空格）不触发；**`/` 返回全部 18 条（不截断）**；`/m` → /model+/manage+/mcp；`/p` → /permission+/permissions；`/c` → /cost+/compact+/clear；`/s` → /status+/setup；大小写不敏感；exactIndex 完整命令名命中。
- **视窗滚动 `paletteWindow`（4 项）**：列表不超视窗时全量显示；顶部/中部/底部窗口滑动且选中项始终可见；任意选中位置（0..N−1）都落在视窗内直至最后一条；偶数/奇数视窗尺寸均不越界。
- 编辑器：navCapture 关闭时 ↑↓ 浏览历史、开启时产生 nav 事件不改内容；独立 Esc 与 Tab 事件（Tab 不再自动插空格，由 TUI 按联想状态决定）；setLine 整行替换并复位历史浏览。

### 6.3 pty 冒烟（sized pty，`stty cols 100 rows 40`）

- 欢迎面板真终端渲染：21 帧动画（150ms 刷新）、圆角标题边框、英文欢迎与提示齐全。
- 联想全链路：`/` → 输入 `m` 过滤出 /model+/mcp → `↓` 选择 /mcp → `Enter` 补全 `/mcp ` → 输入 `list` → `Enter` 执行（占位提示输出）→ `Esc` 关闭 → `/exit` 退出。

## 7. /setup 向导与模型档案管理（v0.1 追加，17 项单测 + pty 全序列冒烟）

### 7.1 向导状态机 `tui/setup-wizard.ts`（11 项）

- 六步顺序与需求一致（名称→地址→Key→协议→认证→档案名）；kind 为 text/text/secret/select/select/text。
- 四协议认证字段集合：anthropic=x-api-key；openai-chat=bearer/x-api-key/query-key；openai-responses=bearer/x-api-key；gemini=query-key/x-goog-api-key。
- 完整流转六步作答 done=true、答案齐备；空模型名/非 http URL/非法或重复档案名逐项校验并停留原步；协议切换使认证字段失效时自动回退默认；编辑模式空输入沿用现值（含同名覆盖允许）。
- 渲染：等宽行、步骤标签齐全、◉/●/○ 三态与 ❯ 选项高亮、错误行渲染、全英文。

### 7.2 档案数据层（4 项）

saveProfile 档案入 config.json、**密钥只入 env 文件（0600）且 config 中不含密钥本体**（BR-023 断言）；空密钥不覆盖已存；deleteProfile 删档并对悬空默认模型回退 mock；档案名校验规则。

### 7.3 协议适配（providers +1 项）

openai-compatible 新增 authStyle：x-api-key 头与 ?key= 查询参数按配置附着（本地 SSE mock 服务器断言实际请求头/URL）；Anthropic 固定原生认证。@profile 解析：openai-chat 档案构建适配器、未实现协议（openai-responses/gemini）抛 LW-PRV-010（注册表新增第 79 码）、未知档案报 not found。

### 7.4 pty 全序列冒烟（真实终端）

/setup 六步依次输入（含协议选择 ↓+Enter、认证 Enter、掩码显示）→ 保存摘要（协议/认证/密钥字段状态）→ `设为当前模型? [Y/n]` 选 n → /manage 列出档案 → 详情（协议/认证/密钥状态）→ 删除确认 → 回到"暂无档案" —— 全程通过；磁盘核对：config.json `models` 字段创建与清空、env 文件创建，密钥不进 config。

### 7.5 蝴蝶冻结

欢迎面板新增 frozen 参数：任意键后蝴蝶取固定姿态（t=0 全开），不同时刻渲染逐字节一致（单测断言）；pty 冒烟中确认冻结后无动画帧差异。

## 8. 渲染稳定性与 `/permission` 指令（v0.1 追加，12 项单测 + 双探针验证）

### 8.1 `/permission`（三档快捷切换，7 项单测 + 1 项 REPL 冒烟 + 1 项 TUI 探针）

- 档位解析 `parsePermissionArg`：三档名正映射（strict→strict / HuangAura→default / WenNova→bypass）；大小写与连字符/下划线不敏感（`huang-aura`、`wen_nova`）；`default`/`bypass` 模式别名；`acceptEdits`/`plan` 高级模式；无法识别返回 null（`mode`/`allow`/`deny` 保留给子命令）。
- 展示文本：`permissionModeShort` 覆盖全部模式；`permissionTierPanel` 列出三档并以 `●` 标记当前档位（含 plan/acceptEdits 当前态）。
- 集成（REPL 管道冒烟）：`/permission` 展示速查表；`/permission HuangAura|WenNova|strict` 三档直接切换且消息含档位说明；非法参数给出用法。
- TUI 路径（PTY 探针）：输入 `/perm` → Tab 补全 `/permission ` → 输入 `HuangAura` 回车 → 输出区出现切换消息、输入框标题档位更新为「部分权限：读免确认」。
- `/permissions` 与 `/permission` 参数互通（`mode/allow/deny` 子命令与档位参数在同一处理器内解析）。

### 8.2 chrome 帧差分渲染（闪烁消除，PTY 字节级 + 屏幕级双探针）

- **根因**（探针实测）：每次 ↑↓ 移动都整块 `ESC[J` 擦除 + 全量重画（~44KB/按键、4–5 次擦除）；150ms 状态定时器空闲时同样全量重画（~88KB/1.2s）。
- **修复**：`buildChromeFrame` 组帧 + `paintChromeFrame` 三路径——同高/收缩帧逐行差分原位重写（收缩帧保持底部锚定、原位清空多余行）；增高帧/失效帧全量；内容未变**零写入**；整帧 synchronized update（DEC 2026）包裹，支持它的终端原子提交。
- **字节级探针**（24 行 PTY，逐按键统计）：移动 ~440B/按键、窗口滚动步 ~2KB、`ESC[J` 恒为 0；Esc 关闭 193B/0 次擦除；空闲 1.2s **0 字节**；联想首屏 14 条 + 标题 `1-14/18`，↓×10 滚动到 `5-18/18`，底部可见 `/agents /goal /mcp /rewind`。
- **屏幕级探针**（自研最小 VT100 模拟器 + pyte 交叉验证）：启动面板/输入框/状态栏自顶排布；联想层紧贴输入框上方、反显选中行 = /help、行内中文简介随命令显示；Esc 后无残留且输入框保持原区域底部；输入 `abc` 后光标落于输入行文本末尾（修正 off-by-one）；`/permission` 全链路可见。
- 附带修复：打开联想时自动收起欢迎面板（避免弹层与 22 行面板叠加超出屏幕）。

## 9. agent 群与信息面板（v0.1 追加，22 项单测 + pty 全流程冒烟）

### 9.1 agent 群数据层（5 项）

- save/list/get/delete；激活群把 common 角色写入当前模型并记录 `activeAgentGroup`；删除激活群自动清理该标记。
- **同一模型可担任多个角色**（三角色同模型保存并激活通过）；`availableModelRefs` = 内置 Provider 全部模型 + `@档案`。

### 9.2 /set-agents 群向导（6 项）

- 步骤结构 target→name→hyaki→sota→common；有群时先选目标（已有群进入编辑并预填三角色、进入角色步自动高亮预填模型）；无群时直接开始命名。
- 新建完整流程达 done 且答案齐备（含同模型多角色）；空名/非法名/重名校验停留原步；↑↓ 循环选择与选项窗口滚动；渲染等宽、三态标记（◉●○）与角色标签齐全。

### 9.3 信息面板（11 项）

- `panel()`：圆角边框、等宽、标题居中、超宽截断；`table()`：按显示宽度对齐、分隔线；`bar()/badge()/kv()/section()` 基础件（含 clamp 与大小写）。
- views：`/status`（会话+上下文进度条+激活群）、`/cost`（输入/输出/缓存占比条+计费）、`/tools`（风险表）、`/permissions`（档位徽标+规则表）、`/doctor`（✔/!/✘ 诊断表与失败计数）、`/model`（当前+内置+档案+agent 群三段）、`/manage`（档案表）、`/help`（命令表+输入语法）。

### 9.4 pty 全流程冒烟（80 列 pty）

`/set-agents` 新建群 team（hyaki=mock / sota=deepseek-chat / common=mock，↓ 选择生效）→ 保存摘要三角色齐全 → 激活（"已激活 agent 群"）→ `/model` 面板显示 agent groups 段与 `@team` → `/setting` 进入编辑当前群（标题 `set agents · edit team`，四步回车沿用）→ 再激活 → `/cost` 面板（cache rd 行）→ `/permissions` 问答引导（档位/allow/deny 三问 + 最终面板）→ `/agents` M3 面板（work mode / ships in M3）→ `/exit`。磁盘核对：`agentGroups.team` 三角色、`activeAgentGroup=team`。

### 9.5 交互式命令问答化

- `/permissions`（及 `/permission`）无参数：面板先行，随后逐项引导 —— 切换档位（可空）→ 添加 allow 规则（可空）→ 添加 deny 规则（可空）→ 输出最终状态面板；带参数快路径保持。
- `/set-agents`、`/setting`、`/setup`、`/manage <name>` 全部为问答/向导式；`/model` 面板式展示 + `/model use` 切换（provider:model / @档案 / @群）。

## 10. 已知限制（v0.1 范围外，按 WBS 顺延）

- 真实模型 Provider 仅经本地 SSE mock 验证合约（G2 的"真实密钥联调"待 M1 收尾/用户提供密钥后补充 DeepSeek 实测）。
- TUI、会话恢复 CLI、自动压缩、MCP、决策层、三角色编排未实现（M2~M4 范围）。
- 评测集为 10 项种子，G1 要求的 30 项任务集在 M1 后续扩充。
- CI 工作流已就绪（.github/workflows/ci.yml，ubuntu/macos × Node 22），推送后首跑验证。

## 11. 复现命令

```bash
corepack pnpm install
corepack pnpm typecheck      # 0 errors
corepack pnpm test           # 211 passed
corepack pnpm lint:registry  # 78 codes OK
corepack pnpm test:evals     # 10/10

# 交互模式冒烟（无需密钥）
printf '/help\n/model list\n/status\n/exit\n' | corepack pnpm exec tsx packages/cli/src/main.ts
```
