# LIWENCode 指令集手册（v0.1）

`liwen` 终端命令与交互模式完整参考。对应需求：FR-130/134/135/137/173/174。

---

## 1. 启动方式

| 命令 | 说明 |
| --- | --- |
| `liwen` | TTY 终端：播放启动动画后进入 **TUI 常驻界面**（见第 3 节）；管道/非 TTY：进入 readline REPL |
| `liwen "解释这个项目"` | 进入交互模式并把该文本作为首轮输入立即执行 |
| `liwen --no-boot` | 跳过启动动画直接进入 TUI |
| `liwen -p "prompt"` / `liwen exec "prompt"` | 非交互：执行一次、打印结果、退出（无 TTY 场景/脚本/管道） |
| `liwen doctor` | 环境与配置诊断（无需任何密钥） |
| `liwen config list \| get <key> \| path` | 查看生效配置 / 单项 / 配置文件路径 |
| `liwen --version` / `liwen --help` | 版本 / 帮助 |

当前目录即工作区（可用 `--cwd` 覆盖）。首次使用建议先跑 `liwen doctor`，再用 `/model config` 配置模型。

## 2. 全局参数（交互与非交互通用）

### 权限三档（核心用法）

| 启动方式 | 档位 | 行为 |
| --- | --- | --- |
| `liwen`（无参数） | **严格档（默认）** | 一切操作（含读取）都需用户逐条确认；非交互管道下按拒绝处理 |
| `liwen --HuangAura` | **部分权限** | 读取类操作（read/glob/grep、`ls` 等只读命令）免确认；写、删、执行仍需确认 |
| `liwen --WenNova` | **完全权限** | 文件增、删、改、查、读全部免确认，不询问用户（危险命令库仍拒绝，见下） |

- 三档互斥：`--WenNova --HuangAura` 同用报 `LW-CLI-001`
- 优先级：`--permission-mode` > 档位参数 > 用户配置（`~/.liwencode/config.json` 的 `permissionMode`）> 严格档
- **安全底线不随档位放宽**：`rm -rf /`、`mkfs`、`git push --force`、格式化磁盘等危险命令在**任何档位（含 --WenNova）都默认拒绝**（BR-006），需要显式 `--allowed-tools` 用户级规则才可放行；`deny` 永远不能被模型提升为 `allow`
- 档位只是免确认范围的变化；会话内可用 `/permissions mode` 临时调整（如切回 strict）

### 其他参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `-m, --model` | `<provider>:<model>` | 指定模型，如 `mock:default`、`deepseek:deepseek-chat`、`anthropic:claude-sonnet-4` |
| `--permission-mode` | `strict` / `default` / `acceptEdits` / `plan` / `bypass` | 精确指定模式（`default` 即 HuangAura 行为、`bypass` 即 WenNova 行为、`strict` 为三档默认） |
| `--allowed-tools` | 工具名/通配符（空格分隔） | 预授权，如 `--allowed-tools read grep`；在严格档下可放行读取 |
| `--disallowed-tools` | 工具名/通配符 | 显式拒绝；不可放宽内置硬拒绝 |
| `--max-turns` | 正整数 | 轮次上限，触发出码 4 |
| `--max-budget-usd` | 金额 | 费用上限，触发出码 4 |
| `--cwd` | 路径 | 工作区目录 |
| `--no-boot` | — | 跳过 TUI 启动动画（终端 < 40 列或 < 12 行时自动跳过） |
| `--output-format` | `text` / `json` / `stream-json` | 仅 `-p` 模式：结果格式 |
| `--verbose` | — | 诊断信息走 stderr |

优先级：命令行参数 > 环境变量（`LIWEN_MODEL`、`LIWEN_PERMISSION_MODE`）> 用户配置 > 默认。

## 3. TUI 常驻界面（TTY 终端）

TTY 下 `liwen` 进入自研纯 ANSI TUI（零第三方依赖，不依赖 Ink/React）。

### 启动动画（约 6.4 秒，任意键跳过 / `--no-boot`）

1. **城市天际线**（2.0s）：散落粒子聚合为楼群轮廓，暖色窗灯随机闪烁，天空有星星与月亮
2. **蝴蝶**（2.4s）：粒子变形为参数曲线蝴蝶，**扇动两下**后收翅悬停
3. **LIWEN CODE 艺术字**（1.0s + 1.0s hold）：粒子汇成 5x7 点阵放大字样，**纵向三层色：蓝（上）/ 绿（中）/ 紫（下）**，保持期间同层色彩轻微脉动

动画在备用缓冲区播放，结束自动清屏进入主界面；`ESC[?25l` 隐藏光标避免闪烁。

### 常驻界面布局

```
  （流式输出区：回复文本、工具调用 ⚙/✔/✖ 行，自然向上滚动）
┌─ liwen (deepseek:deepseek-chat) · 部分权限：读免确认 ──────┐
│ ❯ 输入内容（CJK 宽度感知，超宽横向滚动，↑↓ 历史）      ▮
└────────────────────────────────────────────────────────────┘
 模型 deepseek:deepseek-chat  上下文 3.2k/128k（3%）  轮次 2:5  速度 41.2 tok/s  缓存 67%  总token 9.8k
```

- **输入框**：边框标题实时显示 `provider:model`、当前权限档位、处理中/排队状态；权限审批与 `/model config` 向导的问题也显示在框标题，答案在同一输入框键入
- **状态栏字段**（窄终端下自动从右丢弃）：当前模型 / 上下文已用（含窗口占比）/ 第几轮:第几步 / 实时 token 输出速度（流式期间实时更新，结束后保留末次值）/ 缓存命中率（provider 未上报缓存时显示 —）/ 总消耗 token
- 流式输出通过 `ESC7/ESC8` 光标保存恢复 + 清除下方重绘实现：输入框与状态栏始终锚定底部，回复在其上方追加，无整屏刷新
- 轮次 = 本次会话用户发起的第 N 轮；步数 = 累计工具执行次数

### 键位

| 键 | 行为 |
| --- | --- |
| 可打印字符 / 中文 | 插入输入框（CJK 按码点处理，删除不切半个字） |
| `Enter` | 提交（生成中提交则排队，本轮结束后自动执行） |
| `←/→/Home/End` | 光标移动（列宽感知）；`Backspace/Delete` 删除 |
| `↑/↓` | 浏览输入历史（浏览中保留未提交草稿） |
| `Ctrl+A/E/U/K` | 行首/行尾/清行/删至行尾 |
| `Ctrl+C` | 生成中 = 取消本轮；权限审批 = 拒绝；空闲 2 秒内两次 = 退出 |
| `Ctrl+D` | 空输入框 = 退出 |

## 4. 交互模式输入语法

| 语法 | 说明 |
| --- | --- |
| 普通文本 | 作为用户消息发给模型，流式渲染回复 |
| `@路径` | 把文件内容附加进本次提问（最多 8 个文件、每个截取 500 行），如 `总结 @src/agent.ts 和 @README.md` |
| `!命令` | 直接执行 shell 命令：**仍然经过权限闸门**——危险命令（`rm -rf /`、`git push --force`、`mkfs` 等）直接拒绝，只读命令（`ls`、`git status` 等）直接放行，其余弹出审批 |
| `/命令` | 斜杠命令（见下节） |
| `Ctrl+C` | 生成中 = 取消本轮；空闲时 2 秒内按两次 = 退出（退出码 130） |

### 权限审批（交互模式）

当模型请求写文件或执行命令时，终端弹出：

```
⚠ 权限请求 bash 执行 "npm install"（exec）
  允许执行? [y]本次允许 / [s]本次会话均允许 / [n]拒绝 (默认 n):
```

- `y` = 本次允许；`s` = 本次会话内同类操作不再询问；其他/回车 = 拒绝
- 管道/无人值守输入时**不阻塞**，按拒绝处理并提示 `LW-CLI-002`（BR-042）

## 5. 斜杠命令

### 会话与信息

| 命令 | 说明 |
| --- | --- |
| `/help [命令]` | 全部命令一览，或单条详细用法 |
| `/status` | 会话 ID、当前模型、权限模式、轮次、上下文 token 占用百分比 |
| `/cost` | 累计请求次数、输入/输出 token、费用（provider 提供定价时） |
| `/tools` | 已注册工具及风险级别（read/write/exec）、是否只读、并发安全 |
| `/doctor` | 与 `liwen doctor` 相同的 12 项诊断 |
| `/clear` | 清空对话历史，开启新会话 |
| `/compact` | 手动压缩：清理旧工具结果（保留最近 6 轮），显示前后 token 对比 |
| `/resume [id]` | 列出最近 5 个会话；`/resume <id>` 恢复指定会话（下一条消息接续其历史） |
| `/exit` `/quit` | 退出 |

### 模型管理：`/model`

| 用法 | 说明 |
| --- | --- |
| `/model` 或 `/model show` | 当前模型、端点、密钥状态（只显示"已设置/未设置"，不显示值） |
| `/model list` | Provider 目录：4 个 provider、推荐模型、密钥是否就绪 |
| `/model use <provider:model>` | 切换模型（校验密钥就绪），**历史保留**，并保存为下次默认 |
| `/model config [provider]` | **交互式配置向导**：选 provider → 填模型名（有默认）→ 可改 Base URL → 可录入 API Key（存入 `~/.liwencode/env`，权限 0600） |

**Provider 目录（v0.1）**

| Provider | 推荐模型 | 密钥环境变量 | 说明 |
| --- | --- | --- | --- |
| `mock` | `default` | 无 | 离线确定性测试；用 `LIWEN_MOCK_SCRIPT` 注入剧本 |
| `deepseek` | `deepseek-chat` / `deepseek-reasoner` | `DEEPSEEK_API_KEY` | OpenAI 兼容 |
| `openai-compatible` | `gpt-4o` / `gpt-4o-mini` | `OPENAI_API_KEY` | OpenAI 及任何兼容端点（可用 `OPENAI_BASE_URL` 覆盖） |
| `anthropic` | `claude-sonnet-4` / `claude-haiku-4` | `ANTHROPIC_API_KEY` | 原生 Messages 协议 |

### 权限管理：`/permissions`

| 用法 | 说明 |
| --- | --- |
| `/permissions` | 当前模式（含档位说明）+ 本会话临时规则列表 |
| `/permissions mode <m>` | 切换 `strict`/`default`/`acceptEdits`/`plan`/`bypass`（等价于临时升降档） |
| `/permissions allow <tool>` | 添加会话级放行规则（如 `/permissions allow write`、`/permissions allow mcp__github__*`） |
| `/permissions deny <tool>` | 添加会话级拒绝规则 |

规则语义（不可绕过）：`deny > ask > allow`；危险命令任何档位默认拒绝；项目级配置不能放宽用户级 deny（BR-024）；**任何模型输出都不能提升权限**。档位（strict/HuangAura/WenNova）只是改变"哪些操作免确认"，不改变这些硬规则。

### 计划中的命令（当前为占位提示）

| 命令 | 计划 | 功能 |
| --- | --- | --- |
| `/agents` | M3+ | 三角色编排（hyaki 摘要 / sota 规划 / common 执行） |
| `/goal` | M3+ | 目标设定与确定性验收（BR-050） |
| `/mcp` | M4+ | MCP 服务器管理（`mcp__{server}__{tool}`） |
| `/rewind` | M2+ | 检查点回滚 |

## 6. 非交互输出协议（`-p` 模式）

- `--output-format text`：仅最终文本到 stdout
- `--output-format json`：单个版本化对象 `{schemaVersion, sessionId, endReason, turns, usage, costUsd?, finalText}`
- `--output-format stream-json`：每行一个事件 `{schemaVersion, sessionId, ts, type, event}`
- stdout 只承载协议数据，诊断/进度走 stderr（FR-174）；无人值守时 ask 一律按拒绝（BR-042）

**退出码（BR-042）**：`0` 完成；`1` 一般错误；`2` 用法/配置错误；`3` 权限拒绝未完成；`4` 轮次/预算/时长上限；`130` 用户中断。

## 7. 配置与密钥文件

| 文件 | 用途 | 权限 |
| --- | --- | --- |
| `~/.liwencode/config.json` | 默认模型、权限模式等**非机密**配置 | 普通 |
| `~/.liwencode/env` | `KEY=VALUE` 密钥（`/model config` 写入），启动时合并进环境变量，**不覆盖**已有变量 | 0600 |
| `~/.liwencode/sessions/` | JSONL 会话日志（追加式，BR-016） | 普通 |
| `<项目>/.liwencode/config.json` | 项目级配置；首次使用需信任确认（BR-043） | — |

红线：密钥绝不进入会话文件、日志、错误信息与仓库（BR-023）；脱敏器在所有出口前生效。

## 8. 常见示例

```bash
# 严格档（默认）：每个操作都确认
liwen

# 部分权限：读免确认，写/删要确认
liwen --HuangAura
liwen --HuangAura -m deepseek:deepseek-chat "审查这个仓库"

# 完全权限：文件增删改查读都不问（危险命令仍拒绝）
liwen --WenNova "跑一遍测试并修复失败项"

# 只读审查（plan 模式：写/执行一律拒绝）
liwen --permission-mode plan "审查 src/agent.ts 的错误处理"

# 脚本化使用
cat error.log | liwen -p "分析报错原因" --output-format json --HuangAura
liwen -p "跑测试并修复" --WenNova --max-turns 20; echo "exit=$?"

# 会话恢复
liwen                      # /resume → 选择历史会话 → 继续对话
```

---

*命令语义与错误码以《09-错误体系专项设计》《05-业务规则文档》为准；本文档随版本更新。*
