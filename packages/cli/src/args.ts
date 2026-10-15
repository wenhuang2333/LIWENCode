/** Minimal hand-rolled arg parsing (no framework dep). Subset of FR-135 for v0.1. */

export interface CliArgs {
  positional: string[];
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypass';
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  verbose: boolean;
  command?: 'exec' | 'doctor' | 'config' | 'version' | 'help';
  configSub?: 'list' | 'get' | 'path';
}

export const USAGE = `liwen — LIWENCode coding agent CLI (v0.1 internal)

Usage:
  liwen [options] [prompt]        start with an initial prompt
  liwen -p "prompt"                non-interactive run, print result, exit
  liwen exec "prompt"              same as -p
  liwen doctor                     environment & config diagnostics
  liwen config list|get <key>      inspect effective configuration
  liwen --version | --help

Options:
  -p, --print                      non-interactive execution
  --output-format <text|json|stream-json>   result format (default text)
  -m, --model <provider:name>      e.g. mock:test, openai-compatible:gpt-4o-mini,
                                   deepseek:deepseek-chat, anthropic:claude-sonnet-4
      --permission-mode <mode>     default | acceptEdits | plan | bypass
      --allowed-tools <patterns>   space-separated tool names/globs
      --disallowed-tools <pats>    deny overrides (cannot relax built-in denies)
      --max-turns <n>              turn limit (exit code 4 on breach)
      --max-budget-usd <amount>    cost cap
      --cwd <path>                 workspace directory
      --verbose                    diagnostics on stderr
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    positional: [],
    print: false,
    outputFormat: 'text',
    allowedTools: [],
    disallowedTools: [],
    verbose: false,
  };
  let i = 0;
  const next = (flag: string): string => {
    i += 1;
    const v = argv[i];
    if (v === undefined) {
      throw new UsageError(`missing value for ${flag}`);
    }
    return v;
  };
  const untilNextFlag = (): string[] => {
    const values: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      i += 1;
      values.push(argv[i]!);
    }
    return values;
  };
  for (; i < argv.length; i += 1) {
    const a = argv[i]!;
    switch (a) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case 'exec':
        args.command = 'exec';
        args.print = true;
        break;
      case 'doctor':
        args.command = 'doctor';
        break;
      case 'config':
        args.command = 'config';
        break;
      case '--version':
        args.command = 'version';
        break;
      case '--help':
      case '-h':
        args.command = 'help';
        break;
      case '--output-format': {
        const v = next(a);
        if (v !== 'text' && v !== 'json' && v !== 'stream-json') {
          throw new UsageError(`invalid --output-format '${v}' (LW-CLI-001)`);
        }
        args.outputFormat = v;
        break;
      }
      case '-m':
      case '--model':
        args.model = next(a);
        break;
      case '--permission-mode': {
        const v = next(a);
        if (v !== 'default' && v !== 'acceptEdits' && v !== 'plan' && v !== 'bypass') {
          throw new UsageError(`invalid --permission-mode '${v}' (LW-CLI-001)`);
        }
        args.permissionMode = v;
        break;
      }
      case '--allowed-tools':
        args.allowedTools.push(...untilNextFlag());
        break;
      case '--disallowed-tools':
        args.disallowedTools.push(...untilNextFlag());
        break;
      case '--max-turns':
        args.maxTurns = Number(next(a));
        break;
      case '--max-budget-usd':
        args.maxBudgetUsd = Number(next(a));
        break;
      case '--cwd':
        args.cwd = next(a);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new UsageError(`unknown option '${a}' (LW-CLI-001)`);
        }
        args.positional.push(a);
        break;
    }
  }
  if (args.command === 'config') {
    const sub = args.positional[0];
    if (sub !== 'list' && sub !== 'get' && sub !== 'path') {
      throw new UsageError(`config subcommand must be list | get | path (LW-CLI-001)`);
    }
    args.configSub = sub;
  }
  return args;
}

export class UsageError extends Error {}
