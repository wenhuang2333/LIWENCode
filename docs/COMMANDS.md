# LIWENCode 指令集手册（v0.1）

`liwen` 终端命令与交互模式完整参考。对应需求：FR-130/134/135/137/173/174。

---

## 1. 启动方式

| 命令 | 说明 |
| --- | --- |
| `liwen` | 进入交互模式（REPL） |
| `liwen "解释这个项目"` | 进入交互模式并把该文本作为首轮输入立即执行 |
| `liwen -p "prompt"` / `liwen exec "prompt"` | 非交互：执行一次、打印结果、退出（无 TTY 场景/脚本/管道） |
| `liwen doctor` | 环境与配置诊断（无需任何密钥） |
| `liwen config list \| get <key> \| path` | 查看生效配置 / 单项 / 配置文件路径 |
| `liwen --version` / `liwen --help` | 版本 / 帮助 |

当前目录即工作区（可用 `--cwd` 覆盖）。首次使用建议先跑 `liwen doctor`，再用 `/model config` 配置模型。

## 2. 全局参数（交互与非交互通用）

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `-m, --model` | `<provider>:<model>` | 指定模型，如 `mock:default`、`deepseek:deepseek-chat`、`anthropic:claude-sonnet-4` |
| `--permission-mode` | `default` / `acceptEdits` / `plan` / `bypass` | 权限模式；`bypass` 仅用户级配置可启用（BR-002），`plan` 仅允许只读操作 |
| `--allowed-tools` | 工具名/通配符（空格分隔） | 预授权，如 `--allowed-tools read grep bash` |
| `--disallowed-tools` | 工具名/通配符 | 显式拒绝；不可放宽内置硬拒绝 |
| `--max-turns` | 正整数 | 轮次上限，触发出码 4 |
| `--max-budget-usd` | 金额 | 费用上限，触发出码 4 |
| `--cwd` | 路径 | 工作区目录 |
| `--output-format` | `text` / `json` / `stream-json` | 仅 `-p` 模式：结果格式 |
| `--verbose` | — | 诊断信息走 stderr |

优先级：命令行参数 > 环境变量（`LIWEN_MODEL`、`LIWEN_PERMISSION_MODE`）> 用户配置 > 默认。

## 3. 交互模式输入语法

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

## 4. 斜杠命令

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
| `/permissions` | 当前模式 + 本会话临时规则列表 |
| `/permissions mode <m>` | 切换 `default`/`acceptEdits`/`plan`/`bypass` |
| `/permissions allow <tool>` | 添加会话级放行规则（如 `/permissions allow write`、`/permissions allow mcp__github__*`） |
| `/permissions deny <tool>` | 添加会话级拒绝规则 |

规则语义（不可绕过）：`deny > ask > allow`；危险命令默认拒绝；项目级配置不能放宽用户级 deny（BR-024）；**任何模型输出都不能提升权限**。

### 计划中的命令（当前为占位提示）

| 命令 | 计划 | 功能 |
| --- | --- | --- |
| `/agents` | M3+ | 三角色编排（hyaki 摘要 / sota 规划 / common 执行） |
| `/goal` | M3+ | 目标设定与确定性验收（BR-050） |
| `/mcp` | M4+ | MCP 服务器管理（`mcp__{server}__{tool}`） |
| `/rewind` | M2+ | 检查点回滚 |

## 5. 非交互输出协议（`-p` 模式）

- `--output-format text`：仅最终文本到 stdout
- `--output-format json`：单个版本化对象 `{schemaVersion, sessionId, endReason, turns, usage, costUsd?, finalText}`
- `--output-format stream-json`：每行一个事件 `{schemaVersion, sessionId, ts, type, event}`
- stdout 只承载协议数据，诊断/进度走 stderr（FR-174）；无人值守时 ask 一律按拒绝（BR-042）

**退出码（BR-042）**：`0` 完成；`1` 一般错误；`2` 用法/配置错误；`3` 权限拒绝未完成；`4` 轮次/预算/时长上限；`130` 用户中断。

## 6. 配置与密钥文件

| 文件 | 用途 | 权限 |
| --- | --- | --- |
| `~/.liwencode/config.json` | 默认模型、权限模式等**非机密**配置 | 普通 |
| `~/.liwencode/env` | `KEY=VALUE` 密钥（`/model config` 写入），启动时合并进环境变量，**不覆盖**已有变量 | 0600 |
| `~/.liwencode/sessions/` | JSONL 会话日志（追加式，BR-016） | 普通 |
| `<项目>/.liwencode/config.json` | 项目级配置；首次使用需信任确认（BR-043） | — |

红线：密钥绝不进入会话文件、日志、错误信息与仓库（BR-023）；脱敏器在所有出口前生效。

## 7. 常见示例

```bash
# 离线体验（无需密钥）
liwen doctor
liwen                      # 进入交互 → /help

# 配置并使用 DeepSeek
liwen                      # /model config → 选 deepseek → 粘贴 key
liwen -m deepseek:deepseek-chat "总结这个仓库的结构"

# 只读审查（plan 模式：写/执行一律拒绝）
liwen --permission-mode plan "审查 src/agent.ts 的错误处理"

# 脚本化使用
cat error.log | liwen -p "分析报错原因" --output-format json
liwen -p "跑一遍测试并修复失败项" --permission-mode acceptEdits --max-turns 20; echo "exit=$?"

# 会话恢复
liwen                      # /resume → 选择历史会话 → 继续对话
```

---

*命令语义与错误码以《09-错误体系专项设计》《05-业务规则文档》为准；本文档随版本更新。*
