import { Command } from 'commander';
import type { AgentType, CliOptions } from '../core/types.ts';

const program = new Command();

program
  .name('agent-tail')
  .description('Tail agent session logs (Codex, Claude Code & Gemini CLI) in real-time')
  .version('0.1.0')
  .argument('<agent-type>', 'Agent type: codex, claude, or gemini')
  .option('--raw', 'Output raw JSONL instead of formatted output', false)
  .option('-p, --project <pattern>', 'Filter by project name (fuzzy match)')
  .option('-f, --follow', 'Follow file changes (default: true)', true)
  .option('--no-follow', 'Do not follow, only output existing content');

/**
 * 解析 CLI 參數
 */
export function parseArgs(args: string[]): CliOptions {
  program.parse(args);

  const agentTypeArg = program.args[0];
  const opts = program.opts();

  // 驗證 agent 類型
  if (agentTypeArg !== 'codex' && agentTypeArg !== 'claude' && agentTypeArg !== 'gemini') {
    console.error(`Error: Invalid agent type "${agentTypeArg}". Use "codex", "claude", or "gemini".`);
    process.exit(1);
  }

  return {
    agentType: agentTypeArg as AgentType,
    raw: opts.raw,
    project: opts.project,
    follow: opts.follow,
  };
}
