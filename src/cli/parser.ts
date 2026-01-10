import { Command } from 'commander';
import type { AgentType, CliOptions } from '../core/types.ts';

const program = new Command();

program
  .name('agent-tail')
  .description(
    'Tail agent session logs (Codex, Claude Code & Gemini CLI) in real-time'
  )
  .version('0.1.0')
  .argument('<agent-type>', 'Agent type: codex, claude, or gemini')
  .option('--raw', 'Output raw JSONL instead of formatted output', false)
  .option('-p, --project <pattern>', 'Filter by project name (fuzzy match)')
  .option('-f, --follow', 'Follow file changes (default: true)', true)
  .option('--no-follow', 'Do not follow, only output existing content')
  .option('-v, --verbose', 'Show full content without truncation', false)
  .option(
    '-s, --subagent [id]',
    'Claude only: tail subagent log (latest if no ID)'
  )
  .option(
    '-i, --interactive',
    'Claude only: interactive mode for switching between sessions (Tab to switch)',
    false
  );

/**
 * 解析 CLI 參數
 */
export function parseArgs(args: string[]): CliOptions {
  program.parse(args);

  const agentTypeArg = program.args[0];
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

  // interactive 選項僅對 claude 有效
  if (opts.interactive && agentTypeArg !== 'claude') {
    console.error(
      'Error: --interactive option is only available for "claude" agent type.'
    );
    process.exit(1);
  }

  // interactive 和 subagent 互斥
  if (opts.interactive && opts.subagent !== undefined) {
    console.error(
      'Error: --interactive and --subagent options cannot be used together.'
    );
    process.exit(1);
  }

  // interactive 需要 follow 模式
  if (opts.interactive && !opts.follow) {
    console.error(
      'Error: --interactive requires --follow mode (cannot use with --no-follow).'
    );
    process.exit(1);
  }

  return {
    agentType: agentTypeArg as AgentType,
    raw: opts.raw,
    project: opts.project,
    follow: opts.follow,
    verbose: opts.verbose,
    subagent: opts.subagent,
    interactive: opts.interactive,
  };
}
