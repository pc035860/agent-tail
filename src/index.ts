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

  // 找到目標 session 檔案
  const searchType =
    options.agentType === 'claude' && options.subagent !== undefined
      ? 'subagent'
      : 'session';
  console.log(
    chalk.gray(`Searching for latest ${options.agentType} ${searchType}...`)
  );

  let sessionFile: SessionFile | null = null;

  // Claude subagent 模式
  if (options.agentType === 'claude' && options.subagent !== undefined) {
    const finder = agent.finder;
    if (finder.findSubagent) {
      const subagentId =
        typeof options.subagent === 'string' ? options.subagent : undefined;

      sessionFile = await finder.findSubagent({
        project: options.project,
        subagentId,
      });

      if (!sessionFile) {
        const idInfo = subagentId ? ` (id: ${subagentId})` : '';
        const projectInfo = options.project
          ? ` in project "${options.project}"`
          : '';
        console.error(
          chalk.red(`No subagent file found${idInfo}${projectInfo}`)
        );
        process.exit(1);
      }
    }
  } else {
    sessionFile = await agent.finder.findLatest({
      project: options.project,
    });
  }

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

  // Claude 主 session 模式：支援 subagent 多檔案監控
  // Claude subagent 模式：單檔案監控
  if (options.agentType === 'claude' && options.subagent === undefined) {
    await startClaudeMultiWatch(sessionFile, formatter, options);
  } else {
    // 其他 agent 或 Claude subagent 模式：單檔案監控
    await startSingleWatch(agent, sessionFile, formatter, options);
  }
}

/**
 * 驗證 agentId 格式（7 位十六進制）
 */
function isValidAgentId(agentId: string): boolean {
  return /^[0-9a-f]{7}$/i.test(agentId);
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
        // 從 toolUseResult 中提取 agentId，並驗證格式以防止路徑穿越
        const agentId = data.toolUseResult?.agentId;
        if (agentId && isValidAgentId(agentId)) {
          agentIds.add(agentId);
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
  const files: WatchedFile[] = [{ path: sessionFile.path, label: '[MAIN]' }];

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
        if (label === '[MAIN]' && options.follow) {
          const raw = parsed.raw as { toolUseResult?: { agentId?: string } };
          const newAgentId = raw?.toolUseResult?.agentId;

          // 驗證 agentId 格式以防止路徑穿越
          if (
            newAgentId &&
            isValidAgentId(newAgentId) &&
            !knownAgentIds.has(newAgentId)
          ) {
            knownAgentIds.add(newAgentId);
            // 動態新增 subagent 監控
            const subagentPath = join(sessionDir, `agent-${newAgentId}.jsonl`);
            const newFile: WatchedFile = {
              path: subagentPath,
              label: `[${newAgentId}]`,
            };
            console.log(chalk.yellow(`New subagent detected: ${newAgentId}`));

            // 重試邏輯：等待檔案建立，最多重試 5 次
            const tryAddSubagent = async (retries = 5): Promise<void> => {
              try {
                const subagentFile = Bun.file(subagentPath);
                if (await subagentFile.exists()) {
                  await multiWatcher.addFile(newFile);
                } else if (retries > 0) {
                  setTimeout(() => tryAddSubagent(retries - 1), 100);
                } else {
                  console.log(
                    chalk.gray(
                      `Subagent file not found after retries: ${newAgentId}`
                    )
                  );
                }
              } catch (error) {
                console.log(
                  chalk.gray(
                    `Failed to add subagent watcher: ${newAgentId} - ${error}`
                  )
                );
              }
            };
            // 初次延遲 100ms 後開始嘗試
            setTimeout(() => tryAddSubagent(), 100);
          } else if (newAgentId && !isValidAgentId(newAgentId)) {
            console.log(
              chalk.gray(`Ignoring invalid agentId format: ${newAgentId}`)
            );
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
