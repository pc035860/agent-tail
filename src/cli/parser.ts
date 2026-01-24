import { Command } from 'commander';
import type { AgentType, CliOptions } from '../core/types.ts';

function createProgram(): Command {
  const program = new Command();

  program
    .name('agent-tail')
    .description(
      'Tail agent session logs (Codex, Claude Code & Gemini CLI) in real-time'
    )
    .version('0.1.0')
    .argument('<agent-type>', 'Agent type: codex, claude, or gemini')
    .argument(
      '[session-id]',
      'Optional session ID to load (partial match supported)'
    )
    .option('--raw', 'Output raw JSONL instead of formatted output', false)
    .option('-p, --project <pattern>', 'Filter by project name (fuzzy match)')
    .option('-f, --follow', 'Follow file changes (default: true)', true)
    .option('--no-follow', 'Do not follow, only output existing content')
    .option('-v, --verbose', 'Show full content without truncation')
    .option('--no-verbose', 'Show truncated content (default)')
    .option('-q, --quiet', 'Suppress non-error output messages')
    .option('--no-quiet', 'Show informational messages (default)')
    .option(
      '--subagent [id]',
      'Claude only: tail subagent log (latest if no ID)'
    )
    .option(
      '-s, --sleep-interval <ms>',
      'Set file polling interval in milliseconds (default: 500)',
      parseInt
    )
    .option(
      '-n, --lines <number>',
      'Number of initial lines to show per file (default: all)',
      parseInt
    )
    .option(
      '-i, --interactive',
      'Claude only: interactive mode for switching between sessions (Tab to switch)'
    )
    .option('--no-interactive', 'Disable interactive mode (default)')
    .option(
      '--with-subagents',
      'Claude only: include subagent content in output'
    )
    .option('--no-with-subagents', 'Exclude subagent content (default)')
    .option(
      '--auto-switch',
      'Claude only: auto-switch to latest main session in project'
    )
    .option('--no-auto-switch', 'Disable auto-switch (default)')
    .option(
      '-a, --all',
      'Claude only: show all content (verbose + with-subagents + auto-switch)',
      false
    );

  return program;
}

/**
 * 解析 CLI 參數
 */
export function parseArgs(args: string[]): CliOptions {
  const program = createProgram();
  program.parse(args);

  const agentTypeArg = program.args[0];
  const sessionIdArg = program.args[1];
  const opts = program.opts();

  // 驗證 agent 類型
  if (
    agentTypeArg !== 'codex' &&
    agentTypeArg !== 'claude' &&
    agentTypeArg !== 'gemini'
  ) {
    console.error(
      `Error: Invalid agent type "${agentTypeArg}". Use "codex", "claude", or "gemini".`
    );
    process.exit(1);
  }

  // subagent 選項僅對 claude 有效
  if (opts.subagent !== undefined && agentTypeArg !== 'claude') {
    console.error(
      'Error: --subagent option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // --all preset 選項僅對 claude 有效（需要在展開前驗證）
  if (opts.all && agentTypeArg !== 'claude') {
    console.error(
      'Error: --all option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // 展開 --all preset（只在選項未明確設定時才覆蓋）
  if (opts.all) {
    if (opts.verbose === undefined) opts.verbose = true;
    if (opts.withSubagents === undefined) opts.withSubagents = true;
    if (opts.autoSwitch === undefined) opts.autoSwitch = true;
  }

  // 將 undefined 轉換為 false（對於非 preset 選項）
  const finalVerbose = opts.verbose ?? false;
  const finalInteractive = opts.interactive ?? false;
  const finalWithSubagents = opts.withSubagents ?? false;
  const finalAutoSwitch = opts.autoSwitch ?? false;

  // interactive 選項僅對 claude 有效
  if (finalInteractive && agentTypeArg !== 'claude') {
    console.error(
      'Error: --interactive option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // interactive 和 subagent 互斥
  if (finalInteractive && opts.subagent !== undefined) {
    console.error(
      'Error: --interactive and --subagent options cannot be used together.'
    );
    process.exit(1);
  }

  // interactive 需要 follow 模式
  if (finalInteractive && !opts.follow) {
    console.error(
      'Error: --interactive requires --follow mode (cannot use with --no-follow).'
    );
    process.exit(1);
  }

  // withSubagents 選項僅對 claude 有效
  if (finalWithSubagents && agentTypeArg !== 'claude') {
    console.error(
      'Error: --with-subagents option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // autoSwitch 選項僅對 claude 有效
  if (finalAutoSwitch && agentTypeArg !== 'claude') {
    console.error(
      'Error: --auto-switch option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // sleepInterval 驗證
  if (
    opts.sleepInterval !== undefined &&
    (opts.sleepInterval < 100 || opts.sleepInterval > 60000)
  ) {
    console.error(
      'Error: --sleep-interval must be between 100 and 60000 milliseconds.'
    );
    process.exit(1);
  }

  // lines 驗證
  if (opts.lines !== undefined && Number.isNaN(opts.lines)) {
    console.error('Error: --lines must be a valid number.');
    process.exit(1);
  }

  return {
    agentType: agentTypeArg as AgentType,
    raw: opts.raw,
    project: opts.project,
    follow: opts.follow,
    verbose: finalVerbose,
    quiet: opts.quiet ?? false,
    sleepInterval: opts.sleepInterval ?? 500,
    lines: opts.lines,
    subagent: opts.subagent,
    interactive: finalInteractive,
    withSubagents: finalWithSubagents,
    autoSwitch: finalAutoSwitch,
    sessionId: sessionIdArg,
  };
}
