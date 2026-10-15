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
| `liwencode` (CLI) | `liwen -p`/`exec` non-interactive runs, `--output-format text/json/stream-json`, `doctor`, `config`, BR-042 exit codes. Interactive TUI lands in M2. |

Out of v0.1 scope (per WBS): TUI, session resume UI, auto-compaction, MCP, decision plane (JEV), three-role orchestration, /goal.

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
