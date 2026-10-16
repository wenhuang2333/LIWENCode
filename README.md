# LIWENCode

TypeScript coding-agent harness library + reference CLI. Model-neutral, embeddable, auditable.

**Status: v0.1 internal (M0+M1 of the project WBS) — not published.**

## What's in v0.1

| Package | Contents |
| --- | --- |
| `@liwencode/core` | Kernel: content-block message model, Runtime abstraction (all IO injected), event stream, agent loop (streaming, batching, abort, limits, BR-011 loop detection), permission engine (deny>ask>allow, path fence, dangerous-command library), 78-code error registry with zh-CN messages, Zod config layering, JSONL/in-memory session stores, redactor |
| `@liwencode/providers` | OpenAI Chat Completions adapter (DeepSeek-compatible) + native Anthropic Messages adapter; SSE streaming, normalized events, error mapping |
| `@liwencode/tools` | read / write / edit / glob / grep / bash with read-before-write fencing (BR-004), unique-match edits (BR-005), .gitignore-aware search, restricted shell |
| `@liwencode/testing` | MemoryRuntime (fully in-memory), MockProvider (scripted), provider contract suite (G2: same suite over all providers) |
| `liwencode` (CLI) | **权限三档**：默认严格档（一切操作需确认）/ `--HuangAura`（读免确认）/ `--WenNova`（文件增删改查读全免确认，危险命令仍拒绝）；**TUI 常驻界面**（TTY 下自研纯 ANSI 实现，零 UI 依赖）：启动粒子动画（城市天际线→蝴蝶扇两下→蓝/绿/紫三层色 LIWEN CODE 艺术字）+ 边框输入框 + 实时状态栏（模型/上下文/轮步/token 速度/缓存命中率/总消耗）；非 TTY 回退 readline REPL（流式渲染、终端权限审批 y/s/n、Ctrl+C 取消、@路径 引用、!命令 经闸门执行）；斜杠命令 `/help /model /permissions /status /cost /tools /compact /clear /resume /doctor /exit`，非交互 `-p`/`exec` 与 `--output-format text/json/stream-json`，BR-042 退出码。完整参考：`docs/COMMANDS.md` |

Out of v0.1 scope (per WBS): 自动压缩、MCP、决策层 (JEV)、三角色编排、/goal。（原计划的 Ink 式 TUI 已在 v0.1 内以零依赖纯 ANSI 方式交付。）

## Commands

```bash
corepack pnpm install          # install (Node >= 22 required)
corepack pnpm typecheck        # tsc --noEmit across packages (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
corepack pnpm test             # vitest across packages
corepack pnpm test:evals       # 10-task deterministic eval harness (no keys needed)
corepack pnpm lint:registry    # error-registry governance checks

# CLI smoke (offline):
corepack pnpm exec tsx packages/cli/src/main.ts --version
corepack pnpm exec tsx packages/cli/src/main.ts doctor
corepack pnpm exec tsx packages/cli/src/main.ts          # 交互模式（/help 查看命令）
corepack pnpm exec tsx packages/cli/src/main.ts -p "hello" --output-format stream-json
```

## Design invariants (do not break)

- Deny > ask > allow; **no model output can upgrade a deny** (BR-001/026/027).
- Every `tool_use` gets exactly one `tool_result`, even on abort (BR-009).
- Only `LiwenError` crosses boundaries; identify with `LiwenError.is()`, never `instanceof` (BR-025).
- Error codes: `LW-<domain>-<seq>`; **LW-DEC-007 is an intentional gap** — never fill it.
- All IO goes through the injected Runtime (ADR-03); core depends on nothing but zod.
- Zod is the single schema source (ADR-07); `exports` are ESM-only (ADR-08).

Docs live outside this repo (`../document/LIWENCode/`). Test report: `docs/TEST-REPORT-v0.1.md`.
