import chalk from 'chalk';
import { dirname, join } from 'node:path';
import { parseArgs } from './cli/parser.ts';
import { FileWatcher } from './core/file-watcher.ts';
import {
  MultiFileWatcher,
  type WatchedFile,
} from './core/multi-file-watcher.ts';
import type { Agent, LineParser } from './agents/agent.interface.ts';
import { CodexAgent } from './agents/codex/codex-agent.ts';
import { ClaudeAgent } from './agents/claude/claude-agent.ts';
import { GeminiAgent } from './agents/gemini/gemini-agent.ts';
import type { Formatter } from './formatters/formatter.interface.ts';
import { RawFormatter } from './formatters/raw-formatter.ts';
import { PrettyFormatter } from './formatters/pretty-formatter.ts';
import type { CliOptions, SessionFile } from './core/types.ts';

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

  // Claude 模式：支援 subagent 多檔案監控
  if (options.agentType === 'claude') {
    await startClaudeMultiWatch(sessionFile, formatter, options);
  } else {
    // 其他 agent：單檔案監控
    await startSingleWatch(agent, sessionFile, formatter, options);
  }
}

/**
 * 從主 session 檔案中提取所有 agentId
 */
async function extractAgentIds(sessionPath: string): Promise<Set<string>> {
  const agentIds = new Set<string>();

  try {
    const file = Bun.file(sessionPath);
    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        // 從 toolUseResult 中提取 agentId
        if (data.toolUseResult?.agentId) {
          agentIds.add(data.toolUseResult.agentId);
        }
      } catch {
        // 忽略解析錯誤
      }
    }
  } catch {
    // 忽略檔案讀取錯誤
  }

  return agentIds;
}

/**
 * Claude 多檔案監控（主 session + subagents）
 */
async function startClaudeMultiWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  const sessionDir = dirname(sessionFile.path);

  // 建立監控檔案列表（主 session）
  const files: WatchedFile[] = [{ path: sessionFile.path, label: '[M]' }];

  // 掃描現有的 subagent
  const existingAgentIds = await extractAgentIds(sessionFile.path);
  for (const agentId of existingAgentIds) {
    const subagentPath = join(sessionDir, `agent-${agentId}.jsonl`);
    // 檢查檔案是否存在
    const subagentFile = Bun.file(subagentPath);
    if (await subagentFile.exists()) {
      files.push({ path: subagentPath, label: `[${agentId}]` });
    }
  }

  if (existingAgentIds.size > 0) {
    console.log(chalk.gray(`Found ${existingAgentIds.size} subagent(s)`));
  }
  console.log(chalk.gray('---'));

  // 為每個來源建立獨立的 parser
  const parsers = new Map<string, LineParser>();
  for (const file of files) {
    const parserAgent = new ClaudeAgent({ verbose: options.verbose });
    parsers.set(file.label, parserAgent.parser);
  }

  // 追蹤已發現的 agentId（用於動態偵測新 subagent）
  const knownAgentIds = new Set(existingAgentIds);

  const multiWatcher = new MultiFileWatcher();

  // 處理中斷信號
  process.on('SIGINT', () => {
    console.log(chalk.gray('\nStopping...'));
    multiWatcher.stop();
    process.exit(0);
  });

  await multiWatcher.start(files, {
    follow: options.follow,
    onLine: (line, label) => {
      let parser = parsers.get(label);
      if (!parser) {
        // 新來源，建立新 parser
        const newAgent = new ClaudeAgent({ verbose: options.verbose });
        parser = newAgent.parser;
        parsers.set(label, parser);
      }

      let parsed = parser.parse(line);
      while (parsed) {
        // 設定來源標籤
        parsed.sourceLabel = label;
        console.log(formatter.format(parsed));

        // 檢查是否有新的 subagent（從主 session 的 toolUseResult）
        if (label === '[M]' && options.follow) {
          const raw = parsed.raw as { toolUseResult?: { agentId?: string } };
          const newAgentId = raw?.toolUseResult?.agentId;
          if (newAgentId && !knownAgentIds.has(newAgentId)) {
            knownAgentIds.add(newAgentId);
            // 動態新增 subagent 監控
            const subagentPath = join(sessionDir, `agent-${newAgentId}.jsonl`);
            const newFile: WatchedFile = {
              path: subagentPath,
              label: `[${newAgentId}]`,
            };
            console.log(chalk.yellow(`New subagent detected: ${newAgentId}`));
            // 延遲一下再新增，確保檔案已創建
            setTimeout(async () => {
              const subagentFile = Bun.file(subagentPath);
              if (await subagentFile.exists()) {
                await multiWatcher.addFile(newFile);
              }
            }, 100);
          }
        }

        parsed = parser.parse(line);
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

/**
 * 單檔案監控（Codex/Gemini）
 */
async function startSingleWatch(
  agent: Agent,
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  console.log(chalk.gray('---'));

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
      if (options.agentType === 'gemini') {
        // Gemini 模式：parser 有狀態追蹤，每次只回傳一個部分
        // 需要反覆呼叫直到沒有更多內容
        let parsed = agent.parser.parse(line);
        while (parsed) {
          console.log(formatter.format(parsed));
          parsed = agent.parser.parse(line);
        }
      } else {
        // Codex JSONL 模式：每行一個事件，單次處理
        const parsed = agent.parser.parse(line);
        if (parsed) {
          console.log(formatter.format(parsed));
        }
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
