#!/usr/bin/env node
import { loadConfig, nodeRuntime, LiwenError } from '@liwencode/core';
import { USAGE, parseArgs, UsageError } from './args';
import { EXIT_OK, EXIT_USAGE, runPrint } from './run';
import { formatDoctor, runDoctor } from './doctor';
import { runInteractive } from './interactive';
import { runTui } from './tui/tui';
import { loadSecretsIntoEnv } from './model-config';

export const VERSION = 'liwen v0.1.0 (LIWENCode internal, M0+M1)';

async function main(argv: string[]): Promise<number> {
  // Merge ~/.liwencode/env (0600) into process env first — never overrides
  // real env vars; secrets never reach sessions or logs (BR-023/FR-121).
  loadSecretsIntoEnv();

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw e;
  }

  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.command === 'doctor') {
    const checks = runDoctor(args.cwd ?? process.cwd());
    process.stdout.write(`${formatDoctor(checks)}\n`);
    return checks.some((c) => c.status === 'fail') ? EXIT_USAGE : EXIT_OK;
  }
  if (args.command === 'config') {
    const runtime = nodeRuntime();
    const config = await loadConfig({ runtime });
    if (args.configSub === 'path') {
      process.stdout.write(`user:    ${process.env.HOME ?? ''}/.liwencode/config.json\n`);
      process.stdout.write(`project: ${args.cwd ?? process.cwd()}/.liwencode/config.json\n`);
      return EXIT_OK;
    }
    if (args.configSub === 'get') {
      const key = args.positional[1];
      if (key === undefined) {
        process.stderr.write('config get requires a key (LW-CLI-001)\n');
        return EXIT_USAGE;
      }
      const value = (config as unknown as Record<string, unknown>)[key];
      process.stdout.write(`${value === undefined ? '(unset)' : JSON.stringify(value)}\n`);
      return EXIT_OK;
    }
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return EXIT_OK;
  }

  // agent run
  const prompt = args.positional.join(' ');
  if (!args.print) {
    // TTY（交互终端）→ TUI：启动粒子动画 + 常驻输入界面（FR-137/TUI）；
    // 非 TTY（管道）→ readline REPL：无动画、权限按无人值守策略拒绝（BR-042）。
    const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (isTTY) {
      return runTui({ args, ...(prompt !== '' ? { initialPrompt: prompt } : {}) });
    }
    return runInteractive({ args, ...(prompt !== '' ? { initialPrompt: prompt } : {}) });
  }
  if (prompt === '') {
    process.stderr.write(`-p/exec requires a prompt (LW-CLI-001)\n`);
    return EXIT_USAGE;
  }
  return runPrint(args, prompt);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (LiwenError.is(e)) {
      process.stderr.write(`fatal: ${e.code} ${e.message}\n`);
      process.exitCode = e.code === 'LW-CFG-001' || e.code === 'LW-CFG-002' ? 2 : 1;
    } else {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  });
