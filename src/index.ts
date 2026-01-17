import chalk from 'chalk';
import { basename, dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';
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
import type {
  CliOptions,
  ClaudeSessionResult,
  SessionFile,
} from './core/types.ts';
import {
  SubagentDetector,
  scanForNewSubagents,
} from './claude/subagent-detector.ts';
import { findLatestMainSessionInProject } from './claude/super-follow.ts';
import {
  ConsoleOutputHandler,
  DisplayControllerOutputHandler,
} from './claude/output-handlers.ts';
import {
  InteractiveSessionHandler,
  NoOpSessionHandler,
} from './claude/session-handlers.ts';

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
  let sessionFile: SessionFile | null = null;
  let subagentFile: SessionFile | null = null; // Claude subagent 關聯

  // 判斷搜尋模式
  if (options.sessionId) {
    // 使用 sessionId 搜尋特定 session
    console.log(
      chalk.gray(
        `Searching for ${options.agentType} session "${options.sessionId}"...`
      )
    );

    const finder = agent.finder;
    if (!finder.findBySessionId) {
      console.error(
        chalk.red(
          `Session ID lookup not supported for ${options.agentType} agent`
        )
      );
      process.exit(1);
    }

    const result = await finder.findBySessionId(options.sessionId, {
      project: options.project,
    });

    if (!result) {
      const projectInfo = options.project
        ? ` in project "${options.project}"`
        : '';
      console.error(
        chalk.red(
          `No session found matching "${options.sessionId}"${projectInfo}`
        )
      );
      process.exit(1);
    }

    // 判斷是否為 ClaudeSessionResult（有 main 和 subagent）
    if ('main' in result && 'subagent' in result) {
      const claudeResult = result as ClaudeSessionResult;
      sessionFile = claudeResult.main;
      subagentFile = claudeResult.subagent || null;
      console.log(chalk.green(`Found main session: ${sessionFile.path}`));
      if (subagentFile) {
        console.log(chalk.green(`Found subagent: ${subagentFile.path}`));
      }
    } else {
      sessionFile = result as SessionFile;
      console.log(chalk.green(`Found: ${sessionFile.path}`));
    }
    console.log(chalk.gray(`Modified: ${sessionFile.mtime.toLocaleString()}`));
  } else if (options.agentType === 'claude' && options.subagent !== undefined) {
    // Claude subagent 模式（使用 --subagent 選項）
    console.log(
      chalk.gray(`Searching for latest ${options.agentType} subagent...`)
    );

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
    console.log(chalk.green(`Found: ${sessionFile?.path}`));
    console.log(chalk.gray(`Modified: ${sessionFile?.mtime.toLocaleString()}`));
  } else {
    // 預設模式：找最新的 session
    console.log(
      chalk.gray(`Searching for latest ${options.agentType} session...`)
    );

    sessionFile = await agent.finder.findLatest({
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
  }

  if (!sessionFile) {
    console.error(chalk.red('No session file found'));
    process.exit(1);
  }

  // Claude 模式判斷：
  // 1. sessionId 指定 subagent → 多檔案監控（main + 指定的 subagent）
  // 2. Claude 主 session 模式 → 多檔案監控
  // 3. --subagent 選項 → 單檔案監控
  // 4. 其他 agent → 單檔案監控
  if (options.agentType === 'claude' && options.subagent === undefined) {
    if (options.interactive) {
      // Interactive 模式：使用 SessionManager 管理輸出切換
      await startClaudeInteractiveWatch(
        sessionFile,
        formatter,
        options,
        subagentFile
      );
    } else {
      // 普通模式：所有來源輸出到 console
      await startClaudeMultiWatch(
        sessionFile,
        formatter,
        options,
        subagentFile
      );
    }
  } else {
    // 其他 agent 或 Claude subagent 模式：單檔案監控
    await startSingleWatch(agent, sessionFile, formatter, options);
  }
}

/**
 * Claude 多檔案監控（主 session + subagents）
 * @param initialSubagent - 從 sessionId 參數指定的 subagent（可選）
 */
async function startClaudeMultiWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions,
  initialSubagent: SessionFile | null = null
): Promise<void> {
  const projectDir = dirname(sessionFile.path);
  const sessionId = basename(sessionFile.path, '.jsonl');
  const subagentsDir = join(projectDir, sessionId, 'subagents');

  // 建立監控檔案列表（主 session）
  const files: WatchedFile[] = [{ path: sessionFile.path, label: '[MAIN]' }];

  // 只有在 withSubagents 為 true 時才掃描 subagent
  const existingAgentIds = new Set<string>();
  if (options.withSubagents) {
    // 掃描現有的 subagent（優先使用目錄掃描，確保找到所有檔案）
    const dirAgentIds = await scanForNewSubagents(subagentsDir, new Set());
    for (const id of dirAgentIds) {
      existingAgentIds.add(id);
    }

    // 如果有從 sessionId 指定的 subagent，確保它被加入
    if (initialSubagent) {
      const initialAgentId = basename(initialSubagent.path, '.jsonl').replace(
        /^agent-/,
        ''
      );
      existingAgentIds.add(initialAgentId);
    }

    // 取得現有 subagents 並按檔案建立時間排序（舊到新）
    const existingSubagentFiles: Array<{
      agentId: string;
      path: string;
      birthtime: Date;
    }> = [];

    for (const agentId of existingAgentIds) {
      const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
      const subagentFile = Bun.file(subagentPath);
      if (await subagentFile.exists()) {
        const stats = await stat(subagentPath);
        existingSubagentFiles.push({
          agentId,
          path: subagentPath,
          birthtime: stats.birthtime,
        });
      }
    }

    // 按建立時間升序排序（最舊的先加入，輸出順序會是舊到新）
    existingSubagentFiles.sort(
      (a, b) => a.birthtime.getTime() - b.birthtime.getTime()
    );

    // 依排序後的順序加入
    for (const { agentId, path } of existingSubagentFiles) {
      files.push({ path, label: `[${agentId}]` });
    }

    if (existingAgentIds.size > 0) {
      console.log(chalk.gray(`Found ${existingAgentIds.size} subagent(s)`));
    }
  }
  console.log(chalk.gray('---'));

  // 為每個來源建立獨立的 parser
  const parsers = new Map<string, LineParser>();
  for (const file of files) {
    const parserAgent = new ClaudeAgent({ verbose: options.verbose });
    parsers.set(file.label, parserAgent.parser);
  }

  // 非 follow 模式且有 subagent：收集所有行後按時間排序輸出
  if (!options.follow && options.withSubagents && files.length > 1) {
    await outputTimeSorted(files, parsers, formatter, options);
    process.exit(0);
  }

  const multiWatcher = new MultiFileWatcher();

  // 建立 SubagentDetector（整合 early detection 和 fallback detection）
  const detector = new SubagentDetector(existingAgentIds, {
    subagentsDir,
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    session: new NoOpSessionHandler(),
    enabled: options.follow && options.withSubagents,
  });

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
        if (label === '[MAIN]' && parsed.isTaskToolUse) {
          detector.handleEarlyDetection();
        }

        // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
        // 注意：只處理 Task subagent，過濾掉 forked slash command（有 commandName 或 status === 'forked'）
        if (label === '[MAIN]') {
          const raw = parsed.raw as {
            toolUseResult?: {
              agentId?: string;
              commandName?: string;
              status?: string;
            };
          };
          const agentId = raw?.toolUseResult?.agentId;
          const commandName = raw?.toolUseResult?.commandName;
          const status = raw?.toolUseResult?.status;

          // 只處理沒有 commandName 且不是 forked 的（真正的 Task subagent）
          if (agentId && !commandName && status !== 'forked') {
            detector.handleFallbackDetection(agentId);
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
 * 時間排序輸出（用於 --no-follow --with-subagents 模式）
 * 收集所有檔案的行，按時間戳排序後輸出
 */
async function outputTimeSorted(
  files: WatchedFile[],
  parsers: Map<string, LineParser>,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  // 收集所有已解析的行
  const allParsedLines: Array<{
    parsed: import('./core/types.ts').ParsedLine;
    timestamp: Date;
  }> = [];

  for (const file of files) {
    const parser = parsers.get(file.label);
    if (!parser) continue;

    // 讀取檔案內容
    const bunFile = Bun.file(file.path);
    if (!(await bunFile.exists())) continue;

    const content = await bunFile.text();
    const lines = content.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      // 為每行建立新的 parser 實例避免狀態衝突
      const parserAgent = new ClaudeAgent({ verbose: options.verbose });
      let parsed = parserAgent.parser.parse(line);
      while (parsed) {
        parsed.sourceLabel = file.label;
        allParsedLines.push({
          parsed,
          timestamp: new Date(parsed.timestamp),
        });
        parsed = parserAgent.parser.parse(line);
      }
    }
  }

  // 按時間戳排序（舊到新）
  allParsedLines.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // 依序輸出
  for (const { parsed } of allParsedLines) {
    console.log(formatter.format(parsed));
  }
}

/**
 * Claude Interactive 模式（使用 SessionManager 和 DisplayController 管理輸出切換）
 */
async function startClaudeInteractiveWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions,
  initialSubagent: SessionFile | null = null
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
    await startClaudeMultiWatch(
      sessionFile,
      formatter,
      options,
      initialSubagent
    );
    return;
  }

  const lockedProjectDir = dirname(sessionFile.path);

  // 建立 DisplayController
  const displayController = new DisplayController({
    persistentStatusLine: true,
    historyLines: 50,
  });

  let sessionManager: SessionManager;
  let parsers = new Map<string, LineParser>();
  let multiWatcher: MultiFileWatcher | null = null;
  let detector: SubagentDetector | null = null;
  let currentSessionFile = sessionFile;

  const createSessionManager = (): SessionManager => {
    const manager = new SessionManager({
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
          manager.getAllSessions(),
          manager.getActiveIndex()
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
          manager.getActiveIndex()
        );

        // 顯示切換訊息和歷史內容
        displayController.showSwitchMessage(session, historyContent);

        // 不清空 buffer，保留完整歷史供回看
      },
    });

    return manager;
  };

  const buildInteractiveState = async (
    targetSessionFile: SessionFile,
    initialSubagentFile: SessionFile | null,
    showIntro: boolean
  ): Promise<void> => {
    const projectDir = dirname(targetSessionFile.path);
    const sessionId = basename(targetSessionFile.path, '.jsonl');
    const subagentsDir = join(projectDir, sessionId, 'subagents');

    sessionManager = createSessionManager();
    sessionManager.addSession('main', '[MAIN]', targetSessionFile.path);

    // 掃描現有的 subagent（優先使用目錄掃描，確保找到所有檔案）
    const dirAgentIds = await scanForNewSubagents(subagentsDir, new Set());
    const existingAgentIds = new Set(dirAgentIds);

    // 如果有從 sessionId 指定的 subagent，確保它被加入
    if (initialSubagentFile) {
      const initialAgentId = basename(
        initialSubagentFile.path,
        '.jsonl'
      ).replace(/^agent-/, '');
      existingAgentIds.add(initialAgentId);
    }

    // 取得現有 subagents 並按檔案建立時間排序（舊到新）
    const existingSubagentFiles: Array<{
      agentId: string;
      path: string;
      birthtime: Date;
    }> = [];

    for (const agentId of existingAgentIds) {
      const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
      const subagentFile = Bun.file(subagentPath);
      if (await subagentFile.exists()) {
        const stats = await stat(subagentPath);
        existingSubagentFiles.push({
          agentId,
          path: subagentPath,
          birthtime: stats.birthtime,
        });
      }
    }

    // 按建立時間升序排序（最舊的先加入，會被推到右邊；最新的最後加入，留在 MAIN 旁邊）
    existingSubagentFiles.sort(
      (a, b) => a.birthtime.getTime() - b.birthtime.getTime()
    );

    // 依排序後的順序加入
    for (const { agentId, path } of existingSubagentFiles) {
      sessionManager.addSession(agentId, `[${agentId}]`, path);
    }

    if (showIntro) {
      if (existingAgentIds.size > 0) {
        console.log(chalk.gray(`Found ${existingAgentIds.size} subagent(s)`));
      }
      console.log(
        chalk.gray('Interactive mode: Press Tab to switch, q to quit')
      );
      console.log(chalk.gray('---'));
    }

    // 為每個來源建立獨立的 parser
    parsers = new Map<string, LineParser>();
    for (const session of sessionManager.getAllSessions()) {
      const parserAgent = new ClaudeAgent({ verbose: options.verbose });
      parsers.set(session.label, parserAgent.parser);
    }

    const watcher = new MultiFileWatcher();
    multiWatcher = watcher;

    detector = new SubagentDetector(existingAgentIds, {
      subagentsDir,
      output: new DisplayControllerOutputHandler(displayController),
      watcher: { addFile: (f) => watcher.addFile(f) },
      session: new InteractiveSessionHandler(sessionManager, displayController),
      enabled: true, // Interactive 模式一定是 follow
    });
  };

  const startWatcher = async (): Promise<void> => {
    if (!multiWatcher || !detector) return;

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
            detector.handleEarlyDetection();
          }

          // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
          // 注意：只處理 Task subagent，過濾掉 forked slash command（有 commandName 或 status === 'forked'）
          if (label === '[MAIN]') {
            const raw = parsed.raw as {
              toolUseResult?: {
                agentId?: string;
                commandName?: string;
                status?: string;
              };
            };
            const agentId = raw?.toolUseResult?.agentId;
            const commandName = raw?.toolUseResult?.commandName;
            const status = raw?.toolUseResult?.status;

            // 只處理沒有 commandName 且不是 forked 的（真正的 Task subagent）
            if (agentId && !commandName && status !== 'forked') {
              detector.handleFallbackDetection(agentId);
            }
          }

          parsed = parser.parse(line);
        }
      },
      onError: (error) => {
        displayController.write(chalk.red(`Error: ${error.message}`));
      },
    });
  };

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

  // 初始化狀態並啟動監控
  await buildInteractiveState(currentSessionFile, initialSubagent, true);

  // 初始化 DisplayController
  displayController.init();

  // 顯示初始狀態列
  displayController.updateStatusLine(
    sessionManager.getAllSessions(),
    sessionManager.getActiveIndex()
  );

  await startWatcher();

  const SUPER_FOLLOW_POLL_MS = 500;
  const SUPER_FOLLOW_DELAY_MS = 5000;
  let superFollowStopped = false;
  let pendingSwitchPath: string | null = null;
  let pendingSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingSwitch = (): void => {
    if (pendingSwitchTimer) {
      clearTimeout(pendingSwitchTimer);
      pendingSwitchTimer = null;
    }
    pendingSwitchPath = null;
  };

  const switchToSession = async (
    nextSessionFile: SessionFile
  ): Promise<void> => {
    if (multiWatcher) {
      multiWatcher.stop();
    }

    currentSessionFile = nextSessionFile;
    await buildInteractiveState(nextSessionFile, null, false);

    displayController.updateStatusLine(
      sessionManager.getAllSessions(),
      sessionManager.getActiveIndex()
    );

    await startWatcher();

    const nextSessionId = basename(nextSessionFile.path, '.jsonl');
    displayController.write(
      chalk.gray(`Switched to latest session: ${nextSessionId}`)
    );
  };

  const scheduleSwitch = (nextPath: string): void => {
    if (pendingSwitchPath === nextPath) return;
    pendingSwitchPath = nextPath;
    if (pendingSwitchTimer) clearTimeout(pendingSwitchTimer);

    pendingSwitchTimer = setTimeout(async () => {
      if (superFollowStopped || !pendingSwitchPath) return;
      try {
        const latest = await findLatestMainSessionInProject(lockedProjectDir);
        if (latest && latest.path === pendingSwitchPath) {
          if (latest.path !== currentSessionFile.path) {
            await switchToSession(latest);
          }
        }
      } catch {
        // ignore
      } finally {
        clearPendingSwitch();
      }
    }, SUPER_FOLLOW_DELAY_MS);
  };

  const startSuperFollow = (): void => {
    if (!options.super) return;

    const poll = async (): Promise<void> => {
      if (superFollowStopped) return;
      try {
        const latest = await findLatestMainSessionInProject(lockedProjectDir);
        if (latest && latest.path !== currentSessionFile.path) {
          scheduleSwitch(latest.path);
        } else if (!latest) {
          clearPendingSwitch();
        }
      } catch {
        // ignore
      } finally {
        pollTimer = setTimeout(poll, SUPER_FOLLOW_POLL_MS);
      }
    };

    poll();
  };

  startSuperFollow();

  // 清理函式
  const cleanup = (): void => {
    superFollowStopped = true;
    clearPendingSwitch();
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    // 先清理 DisplayController（恢復終端設定）
    displayController.destroy();
    console.log(chalk.gray('\nStopping...'));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    if (multiWatcher) {
      multiWatcher.stop();
    }
  };

  // 處理中斷信號
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
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
