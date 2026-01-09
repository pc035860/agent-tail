import chalk from 'chalk';
import { Glob } from 'bun';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from './cli/parser.ts';
import { FileWatcher } from './core/file-watcher.ts';
import {
  MultiFileWatcher,
  type WatchedFile,
} from './core/multi-file-watcher.ts';
import { SessionManager, type WatcherSession } from './core/session-manager.ts';
import { DisplayController } from './interactive/display-controller.ts';
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
    if (options.interactive) {
      // Interactive 模式：使用 SessionManager 管理輸出切換
      await startClaudeInteractiveWatch(sessionFile, formatter, options);
    } else {
      // 普通模式：所有來源輸出到 console
      await startClaudeMultiWatch(sessionFile, formatter, options);
    }
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
 * 掃描 subagents 目錄，找出尚未被監控的新 subagent 檔案
 * @param subagentsDir subagents 目錄路徑
 * @param knownAgentIds 已知的 agentId 集合
 * @returns 新發現的 agentId 陣列
 */
async function scanForNewSubagents(
  subagentsDir: string,
  knownAgentIds: Set<string>
): Promise<string[]> {
  const newAgentIds: string[] = [];

  try {
    // 使用已 import 的 Glob
    const glob = new Glob('agent-*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir })) {
      // 從檔名 "agent-{id}.jsonl" 提取 id
      const match = file.match(/^agent-([0-9a-f]{7})\.jsonl$/i);
      if (match && match[1]) {
        const agentId = match[1];
        if (!knownAgentIds.has(agentId)) {
          newAgentIds.push(agentId);
        }
      }
    }
  } catch {
    // 目錄不存在或無法存取時靜默忽略
    // 這是預期行為：subagent 可能尚未建立目錄
  }

  return newAgentIds;
}

/**
 * Claude 多檔案監控（主 session + subagents）
 */
async function startClaudeMultiWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  const projectDir = dirname(sessionFile.path);
  const sessionId = basename(sessionFile.path, '.jsonl');
  const subagentsDir = join(projectDir, sessionId, 'subagents');

  // 建立監控檔案列表（主 session）
  const files: WatchedFile[] = [{ path: sessionFile.path, label: '[MAIN]' }];

  // 掃描現有的 subagent
  const existingAgentIds = await extractAgentIds(sessionFile.path);
  for (const agentId of existingAgentIds) {
    const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
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

        // 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
        if (label === '[MAIN]' && parsed.isTaskToolUse && options.follow) {
          // 延遲一小段時間讓檔案有機會建立
          setTimeout(async () => {
            const newAgentIds = await scanForNewSubagents(
              subagentsDir,
              knownAgentIds
            );

            for (const agentId of newAgentIds) {
              knownAgentIds.add(agentId);

              const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
              const newFile: WatchedFile = {
                path: subagentPath,
                label: `[${agentId}]`,
              };

              console.log(chalk.yellow(`Early subagent detected: ${agentId}`));

              // 重試邏輯：等待檔案建立
              const tryAddSubagent = async (retries = 10): Promise<void> => {
                try {
                  const subagentFile = Bun.file(subagentPath);
                  if (await subagentFile.exists()) {
                    await multiWatcher.addFile(newFile);
                  } else if (retries > 0) {
                    setTimeout(() => tryAddSubagent(retries - 1), 100);
                  }
                } catch (error) {
                  console.error(
                    chalk.red(`Failed to add early subagent: ${error}`)
                  );
                }
              };

              tryAddSubagent();
            }
          }, 50); // 50ms 延遲
        }

        // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
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
            const subagentPath = join(
              subagentsDir,
              `agent-${newAgentId}.jsonl`
            );
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
 * Claude Interactive 模式（使用 SessionManager 和 DisplayController 管理輸出切換）
 */
async function startClaudeInteractiveWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  // TTY 檢查：非 TTY 環境自動降級到普通多檔案監控模式
  if (!process.stdin.isTTY) {
    console.warn(
      chalk.yellow(
        'Warning: Interactive mode not available in non-TTY environment.\n' +
          'Switching to standard multi-watch mode.\n' +
          'Keyboard controls (Tab to switch) will not be available.'
      )
    );
    await startClaudeMultiWatch(sessionFile, formatter, options);
    return;
  }

  const projectDir = dirname(sessionFile.path);
  const sessionId = basename(sessionFile.path, '.jsonl');
  const subagentsDir = join(projectDir, sessionId, 'subagents');

  // 建立 DisplayController
  const displayController = new DisplayController({
    persistentStatusLine: true,
    historyLines: 50,
  });

  // 建立 SessionManager
  const sessionManager = new SessionManager({
    bufferSize: 1000,
    onOutput: (content: string, _session: WatcherSession) => {
      // 使用 DisplayController 輸出（確保不覆蓋狀態列）
      displayController.write(content);
    },
    onSessionAdded: (session: WatcherSession) => {
      displayController.write(
        chalk.yellow(`New session added: ${session.label}`)
      );
      // 更新狀態列
      displayController.updateStatusLine(
        sessionManager.getAllSessions(),
        sessionManager.getActiveIndex()
      );
    },
    onSessionSwitched: (
      session: WatcherSession,
      allSessions: WatcherSession[]
    ) => {
      // 取得切換前的緩衝內容
      const historyContent = session.buffer.slice();

      // 更新狀態列
      displayController.updateStatusLine(
        allSessions,
        sessionManager.getActiveIndex()
      );

      // 顯示切換訊息和歷史內容
      displayController.showSwitchMessage(session, historyContent);

      // 不清空 buffer，保留完整歷史供回看
    },
  });

  // 新增主 session
  sessionManager.addSession('main', '[MAIN]', sessionFile.path);

  // 掃描現有的 subagent
  const existingAgentIds = await extractAgentIds(sessionFile.path);
  for (const agentId of existingAgentIds) {
    const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    const subagentFile = Bun.file(subagentPath);
    if (await subagentFile.exists()) {
      sessionManager.addSession(agentId, `[${agentId}]`, subagentPath);
    }
  }

  // 顯示初始訊息
  if (existingAgentIds.size > 0) {
    console.log(chalk.gray(`Found ${existingAgentIds.size} subagent(s)`));
  }
  console.log(chalk.gray('Interactive mode: Press Tab to switch, q to quit'));
  console.log(chalk.gray('---'));

  // 初始化 DisplayController
  displayController.init();

  // 顯示初始狀態列
  displayController.updateStatusLine(
    sessionManager.getAllSessions(),
    sessionManager.getActiveIndex()
  );

  // 為每個來源建立獨立的 parser
  const parsers = new Map<string, LineParser>();
  for (const session of sessionManager.getAllSessions()) {
    const parserAgent = new ClaudeAgent({ verbose: options.verbose });
    parsers.set(session.label, parserAgent.parser);
  }

  // 追蹤已發現的 agentId
  const knownAgentIds = new Set(existingAgentIds);

  // 建立 MultiFileWatcher
  const multiWatcher = new MultiFileWatcher();

  // 設定鍵盤監聽
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      // Ctrl+C
      if (key === '\u0003') {
        cleanup();
        process.exit(0);
      }
      // q - quit
      if (key === 'q' || key === 'Q') {
        cleanup();
        process.exit(0);
      }
      // Tab - switch next
      if (key === '\t') {
        sessionManager.switchNext();
      }
      // Shift+Tab (varies by terminal, common: \u001b[Z)
      if (key === '\u001b[Z') {
        sessionManager.switchPrev();
      }
      // n - switch next (alternative)
      if (key === 'n' || key === 'N') {
        sessionManager.switchNext();
      }
      // p - switch prev (alternative)
      if (key === 'p' || key === 'P') {
        sessionManager.switchPrev();
      }
    });
  }

  // 清理函式
  const cleanup = (): void => {
    // 先清理 DisplayController（恢復終端設定）
    displayController.destroy();
    console.log(chalk.gray('\nStopping...'));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    multiWatcher.stop();
  };

  // 處理中斷信號
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  // 取得要監控的檔案
  const files = sessionManager.getWatchedFiles();

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

        // 使用 SessionManager 處理輸出（會根據 active 狀態決定輸出或緩衝）
        const formattedOutput = formatter.format(parsed);
        sessionManager.handleOutput(label, formattedOutput);

        // 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
        if (label === '[MAIN]' && parsed.isTaskToolUse) {
          setTimeout(async () => {
            const newAgentIds = await scanForNewSubagents(
              subagentsDir,
              knownAgentIds
            );

            for (const agentId of newAgentIds) {
              if (knownAgentIds.has(agentId)) continue;
              knownAgentIds.add(agentId);

              const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);

              // 新增到 SessionManager
              sessionManager.addSession(agentId, `[${agentId}]`, subagentPath);
              displayController.write(
                chalk.yellow(`Early subagent detected: ${agentId}`)
              );

              // 重試邏輯：等待檔案建立
              const tryAddSubagent = async (retries = 10): Promise<void> => {
                try {
                  const subagentFile = Bun.file(subagentPath);
                  if (await subagentFile.exists()) {
                    const newFile: WatchedFile = {
                      path: subagentPath,
                      label: `[${agentId}]`,
                    };
                    await multiWatcher.addFile(newFile);
                  } else if (retries > 0) {
                    setTimeout(() => tryAddSubagent(retries - 1), 100);
                  }
                } catch (error) {
                  displayController.write(
                    chalk.red(`Failed to add early subagent: ${error}`)
                  );
                }
              };

              tryAddSubagent();
            }
          }, 50); // 50ms 延遲
        }

        // 備援機制：檢查 subagent 相關事件（僅處理主 session 的事件）
        if (label === '[MAIN]') {
          const raw = parsed.raw as { toolUseResult?: { agentId?: string } };
          const agentId = raw?.toolUseResult?.agentId;

          if (agentId && isValidAgentId(agentId)) {
            // toolUseResult 表示 subagent 已完成
            if (!knownAgentIds.has(agentId)) {
              // 新發現的 subagent（可能之前沒偵測到）
              knownAgentIds.add(agentId);
              const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
              const newFile: WatchedFile = {
                path: subagentPath,
                label: `[${agentId}]`,
              };

              // 新增 session 到 SessionManager
              sessionManager.addSession(agentId, `[${agentId}]`, subagentPath);

              // 重試邏輯：等待檔案建立
              const tryAddSubagent = async (retries = 5): Promise<void> => {
                try {
                  const subagentFile = Bun.file(subagentPath);
                  if (await subagentFile.exists()) {
                    await multiWatcher.addFile(newFile);
                  } else if (retries > 0) {
                    setTimeout(() => tryAddSubagent(retries - 1), 100);
                  } else {
                    displayController.write(
                      chalk.gray(
                        `Subagent file not found after retries: ${agentId}`
                      )
                    );
                  }
                } catch (error) {
                  displayController.write(
                    chalk.gray(
                      `Failed to add subagent watcher: ${agentId} - ${error}`
                    )
                  );
                }
              };
              setTimeout(() => tryAddSubagent(), 100);
            }

            // 標記 subagent 為已完成（toolUseResult 表示 subagent 結束）
            sessionManager.markSessionDone(agentId);
            displayController.write(
              chalk.gray(`Subagent completed: ${agentId}`)
            );

            // 更新狀態列
            displayController.updateStatusLine(
              sessionManager.getAllSessions(),
              sessionManager.getActiveIndex()
            );
          } else if (agentId && !isValidAgentId(agentId)) {
            displayController.write(
              chalk.gray(`Ignoring invalid agentId format: ${agentId}`)
            );
          }
        }

        parsed = parser.parse(line);
      }
    },
    onError: (error) => {
      displayController.write(chalk.red(`Error: ${error.message}`));
    },
  });

  // 保持程式運行（interactive 模式必須是 follow）
  displayController.write(
    chalk.gray('Watching for changes... (Tab to switch, q to quit)')
  );
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
