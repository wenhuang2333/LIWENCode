import {
  createAgent,
  LiwenError,
  nodeRuntime,
  type Agent,
  type AgentEvent,
  type EndReason,
  type PermissionHandler,
  type RunSummary,
} from '@liwencode/core';
import { createBuiltinTools } from '@liwencode/tools';
import { createOpenAICompatibleProvider, createAnthropicProvider } from '@liwencode/providers';
import { MockProvider } from '@liwencode/testing';
import type { CliArgs } from './args';
import { resolvePermissionTier } from './args';
import { readUserConfig } from './model-config';
import { resolveProvider } from './provider-select';

/** BR-042 exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_PERM = 3;
export const EXIT_LIMIT = 4;
export const EXIT_INTERRUPT = 130;

export function exitCodeFor(summary: RunSummary): number {
  switch (summary.endReason) {
    case 'completed':
      return EXIT_OK;
    case 'max_turns':
    case 'budget_exhausted':
    case 'timeout':
      return EXIT_LIMIT;
    case 'aborted':
      return EXIT_INTERRUPT;
    case 'repeated_failure':
    case 'fatal_error':
      return EXIT_ERROR;
    default:
      return EXIT_ERROR;
  }
}

export async function runPrint(args: CliArgs, prompt: string): Promise<number> {
  const runtime = nodeRuntime();
  const out = args.outputFormat;
  const write = (line: string) => process.stdout.write(`${line}\n`);
  const stderr = (msg: string) => process.stderr.write(`${msg}\n`);

  const provider = resolveProvider(args, { mockProvider: (script) => new MockProvider({ script }) });
  const { tools } = createBuiltinTools();
  const tier = resolvePermissionTier(args, readUserConfig().permissionMode);

  // Headless permission policy (BR-042): ask → deny with a clear note.
  const headlessHandler: PermissionHandler = async (req) => ({
    decision: 'deny',
    message: `Non-interactive run: '${req.tool}' needs approval; headless ask resolves to deny (LW-CLI-002). Pre-approve via --allowed-tools, raise the tier (--HuangAura/--WenNova), or run interactively.`,
  });

  const agent: Agent = createAgent({
    provider,
    model: provider.model,
    cwd: args.cwd ?? process.cwd(),
    tools,
    permissionMode: tier.mode,
    permissionHandler: headlessHandler,
    limits: {
      ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
    },
    runtime,
    rules: [
      ...args.allowedTools.map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
      ...args.disallowedTools.map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
    ],
  });

  let exitCode = EXIT_OK;
  let summary: RunSummary | undefined;

  const interrupt = new AbortController();
  process.on('SIGINT', () => {
    interrupt.abort(new Error('SIGINT'));
  });

  try {
    const stream = agent.run(prompt, { signal: interrupt.signal });
    for (;;) {
      const r = await stream.next();
      if (r.done) {
        summary = r.value;
        break;
      }
      emitEvent(r.value);
    }
  } catch (e) {
    if (LiwenError.is(e)) {
      stderr(`error: ${e.code} ${e.message}`);
      exitCode = e.code === 'LW-CLI-002' || e.category === 'permission' ? EXIT_PERM : EXIT_ERROR;
    } else {
      stderr(`error: ${e instanceof Error ? e.message : String(e)}`);
      exitCode = EXIT_ERROR;
    }
  }

  if (summary !== undefined) {
    exitCode = exitCodeFor(summary);
    if (out === 'text') {
      write(summary.finalText);
    } else if (out === 'json') {
      write(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: summary.sessionId,
          endReason: summary.endReason,
          turns: summary.turns,
          usage: summary.totalUsage,
          ...(summary.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
          finalText: summary.finalText,
        }),
      );
    }
  }
  return exitCode;

  function emitEvent(ev: AgentEvent): void {
    if (out === 'stream-json') {
      write(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: summaryAgentSessionId(),
          ts: Date.now(),
          type: ev.type,
          event: ev,
        }),
      );
      return;
    }
    if (out === 'text' && ev.type === 'error') {
      stderr(`[${ev.error.code}] ${ev.error.message}`);
    }
  }
  function summaryAgentSessionId(): string {
    return agent.sessionId;
  }
}

export { resolveProvider };
export type { EndReason };
