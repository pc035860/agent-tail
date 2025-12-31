import chalk from 'chalk';
import { parseArgs } from './cli/parser.ts';
import { FileWatcher } from './core/file-watcher.ts';
import type { Agent } from './agents/agent.interface.ts';
import { CodexAgent } from './agents/codex/codex-agent.ts';
import { ClaudeAgent } from './agents/claude/claude-agent.ts';
import { GeminiAgent } from './agents/gemini/gemini-agent.ts';
import type { Formatter } from './formatters/formatter.interface.ts';
import { RawFormatter } from './formatters/raw-formatter.ts';
import { PrettyFormatter } from './formatters/pretty-formatter.ts';

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  // 選擇 Agent
  const agent: Agent =
    options.agentType === 'codex'
      ? new CodexAgent({ verbose: options.verbose })
      : options.agentType === 'gemini'
        ? new GeminiAgent({ verbose: options.verbose })
        : new ClaudeAgent({ verbose: options.verbose });

  // 選擇 Formatter
  const formatter: Formatter = options.raw
    ? new RawFormatter()
    : new PrettyFormatter();

  // 找到最新的 session 檔案
  console.log(
    chalk.gray(`Searching for latest ${options.agentType} session...`)
  );

  const sessionFile = await agent.finder.findLatest({
    project: options.project,
  });

  if (!sessionFile) {
    console.error(
      chalk.red(
        `No session file found for ${options.agentType}${options.project ? ` (project: ${options.project})` : ''}`
      )
    );
    process.exit(1);
  }

  console.log(chalk.green(`Found: ${sessionFile.path}`));
  console.log(chalk.gray(`Modified: ${sessionFile.mtime.toLocaleString()}`));
  console.log(chalk.gray('---'));

  // 建立 FileWatcher
  const watcher = new FileWatcher();

  // 處理中斷信號
  process.on('SIGINT', () => {
    console.log(chalk.gray('\nStopping...'));
    watcher.stop();
    process.exit(0);
  });

  // 開始監控
  await watcher.start(sessionFile.path, {
    follow: options.follow,
    // Gemini 使用完整 JSON 檔案格式，需要啟用 jsonMode
    jsonMode: options.agentType === 'gemini',
    onLine: (line) => {
      const parsed = agent.parser.parse(line);
      if (parsed) {
        console.log(formatter.format(parsed));
      }
    },
    onError: (error) => {
      console.error(chalk.red(`Error: ${error.message}`));
    },
  });

  // 如果不是 follow 模式，結束程式
  if (!options.follow) {
    process.exit(0);
  }

  // 保持程式運行
  console.log(chalk.gray('Watching for changes... (Ctrl+C to stop)'));
}

main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${error.message}`));
  process.exit(1);
});
