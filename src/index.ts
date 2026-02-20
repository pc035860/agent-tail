import chalk from 'chalk';
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
import type {
  CliOptions,
  ClaudeSessionResult,
  SessionFile,
} from './core/types.ts';
import {
  SubagentDetector,
  scanForNewSubagents,
} from './claude/subagent-detector.ts';
import {
  ConsoleOutputHandler,
  DisplayControllerOutputHandler,
} from './claude/output-handlers.ts';
import {
  InteractiveSessionHandler,
  NoOpSessionHandler,
} from './claude/session-handlers.ts';
import {
  buildSubagentFiles,
  createOnLineHandler,
  createSuperFollowController,
} from './claude/watch-builder.ts';
import { findLatestMainSessionInProject } from './claude/auto-switch.ts';

/**
 * 條件式日誌輸出 - 在 quiet 模式下抑制非錯誤訊息
 */
function log(quiet: boolean, ...args: unknown[]): void {
  if (!quiet) {
    console.log(...args);
  }
}

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
    log(
      options.quiet,
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
      log(
        options.quiet,
        chalk.green(`Found main session: ${sessionFile.path}`)
      );
      if (subagentFile) {
        log(options.quiet, chalk.green(`Found subagent: ${subagentFile.path}`));
      }
    } else {
      sessionFile = result as SessionFile;
      log(options.quiet, chalk.green(`Found: ${sessionFile.path}`));
    }
    log(
      options.quiet,
      chalk.gray(`Modified: ${sessionFile.mtime.toLocaleString()}`)
    );
  } else if (options.agentType === 'claude' && options.subagent !== undefined) {
    // Claude subagent 模式（使用 --subagent 選項）
    log(
      options.quiet,
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
    log(options.quiet, chalk.green(`Found: ${sessionFile?.path}`));
    log(
      options.quiet,
      chalk.gray(`Modified: ${sessionFile?.mtime.toLocaleString()}`)
    );
  } else {
    // 預設模式：找最新的 session
    log(
      options.quiet,
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

    log(options.quiet, chalk.green(`Found: ${sessionFile.path}`));
    log(
      options.quiet,
      chalk.gray(`Modified: ${sessionFile.mtime.toLocaleString()}`)
    );
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

    const existingSubagentFiles = await buildSubagentFiles(
      subagentsDir,
      existingAgentIds
    );
    for (const { agentId, path } of existingSubagentFiles) {
      files.push({ path, label: `[${agentId}]` });
    }

    if (existingAgentIds.size > 0) {
      log(
        options.quiet,
        chalk.gray(`Found ${existingAgentIds.size} subagent(s)`)
      );
    }
  }
  log(options.quiet, chalk.gray('---'));

  // 為每個來源建立獨立的 parser
  let parsers = new Map<string, LineParser>();
  for (const file of files) {
    const parserAgent = new ClaudeAgent({ verbose: options.verbose });
    parsers.set(file.label, parserAgent.parser);
  }

  // 非 follow 模式且有 subagent：收集所有行後按時間排序輸出
  if (!options.follow && options.withSubagents && files.length > 1) {
    await outputTimeSorted(files, parsers, formatter, options);
    process.exit(0);
  }

  let multiWatcher = new MultiFileWatcher();

  // 建立 SubagentDetector（整合 early detection 和 fallback detection）
  let detector = new SubagentDetector(existingAgentIds, {
    subagentsDir,
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    session: new NoOpSessionHandler(),
    enabled: options.follow && options.withSubagents,
  });
  detector.startDirectoryWatch();

  // ========== Non-Interactive Super-Follow ==========
  let currentSessionPath = sessionFile.path;

  const switchToSession = async (
    nextSessionFile: SessionFile
  ): Promise<void> => {
    // 停止現有監控
    detector?.stop();
    multiWatcher.stop();

    // 更新當前 session 路徑
    currentSessionPath = nextSessionFile.path;

    // 重新初始化監控
    const newProjectDir = dirname(nextSessionFile.path);
    const newSessionId = basename(nextSessionFile.path, '.jsonl');
    const newSubagentsDir = join(newProjectDir, newSessionId, 'subagents');

    const newFiles: WatchedFile[] = [
      { path: nextSessionFile.path, label: '[MAIN]' },
    ];
    const newExistingAgentIds = new Set<string>();

    // 掃描現有的 subagents
    if (options.withSubagents) {
      const dirAgentIds = await scanForNewSubagents(newSubagentsDir, new Set());
      for (const id of dirAgentIds) {
        newExistingAgentIds.add(id);
      }

      const existingSubagentFiles = await buildSubagentFiles(
        newSubagentsDir,
        newExistingAgentIds
      );
      for (const { agentId, path } of existingSubagentFiles) {
        newFiles.push({ path, label: `[${agentId}]` });
      }

      if (newExistingAgentIds.size > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${newExistingAgentIds.size} subagent(s)`)
        );
      }
    }

    // 輸出切換訊息
    log(
      options.quiet,
      chalk.gray(`--- Switched to session ${newSessionId} ---`)
    );
    log(options.quiet, chalk.gray('---'));

    // 重新建立 parsers
    const newParsers = new Map<string, LineParser>();
    for (const file of newFiles) {
      const parserAgent = new ClaudeAgent({ verbose: options.verbose });
      newParsers.set(file.label, parserAgent.parser);
    }
    parsers = newParsers;

    // 重新建立 multiWatcher（先建立，但還不啟動）
    const newMultiWatcher = new MultiFileWatcher();

    // 重新建立 detector（捕獲新的 multiWatcher）
    const newDetector = new SubagentDetector(newExistingAgentIds, {
      subagentsDir: newSubagentsDir,
      output: new ConsoleOutputHandler(),
      watcher: { addFile: (f) => newMultiWatcher.addFile(f) },
      session: new NoOpSessionHandler(),
      enabled: options.follow && options.withSubagents,
    });
    newDetector.startDirectoryWatch();

    // 更新外層變數
    multiWatcher = newMultiWatcher;
    detector = newDetector;

    // 重新啟動監控
    await multiWatcher.start(newFiles, {
      follow: options.follow,
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: createOnLineHandler({
        parsers,
        formatter,
        detector,
        onOutput: (formatted) => console.log(formatted),
        verbose: options.verbose,
      }),
      onError: (error) => {
        console.error(chalk.red(`Error: ${error.message}`));
      },
    });
  };

  const superFollow = createSuperFollowController({
    projectDir,
    getCurrentPath: () => currentSessionPath,
    onSwitch: switchToSession,
    autoSwitch: options.autoSwitch,
    findLatestInProject: findLatestMainSessionInProject,
  });

  // 處理中斷信號
  process.on('SIGINT', () => {
    superFollow.stop();
    console.log(chalk.gray('\nStopping...'));
    detector?.stop();
    multiWatcher.stop();
    process.exit(0);
  });

  await multiWatcher.start(files, {
    follow: options.follow,
    pollInterval: options.sleepInterval,
    initialLines: options.lines,
    onLine: createOnLineHandler({
      parsers,
      formatter,
      detector,
      onOutput: (formatted) => console.log(formatted),
      verbose: options.verbose,
    }),
    onError: (error) => {
      console.error(chalk.red(`Error: ${error.message}`));
    },
  });

  // 如果不是 follow 模式，結束程式
  if (!options.follow) {
    process.exit(0);
  }

  // 啟動 super-follow
  superFollow.start();

  // 保持程式運行
  log(options.quiet, chalk.gray('Watching for changes... (Ctrl+C to stop)'));
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

  let sessionManager!: SessionManager;
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

    const existingSubagentFiles = await buildSubagentFiles(
      subagentsDir,
      existingAgentIds
    );
    for (const { agentId, path } of existingSubagentFiles) {
      sessionManager.addSession(agentId, `[${agentId}]`, path);
    }

    if (showIntro) {
      if (existingAgentIds.size > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${existingAgentIds.size} subagent(s)`)
        );
      }
      log(
        options.quiet,
        chalk.gray('Interactive mode: Press Tab to switch, q to quit')
      );
      log(options.quiet, chalk.gray('---'));
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
    detector.startDirectoryWatch();
  };

  const startWatcher = async (): Promise<void> => {
    if (!multiWatcher || !detector) return;
    const activeDetector = detector;

    const files = sessionManager.getWatchedFiles();

    await multiWatcher.start(files, {
      follow: options.follow,
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: createOnLineHandler({
        parsers,
        formatter,
        detector: activeDetector,
        onOutput: (formatted, label) =>
          sessionManager.handleOutput(label, formatted),
        verbose: options.verbose,
      }),
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

  const switchToSession = async (
    nextSessionFile: SessionFile
  ): Promise<void> => {
    detector?.stop();
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

  const superFollow = createSuperFollowController({
    projectDir: lockedProjectDir,
    getCurrentPath: () => currentSessionFile.path,
    onSwitch: switchToSession,
    autoSwitch: options.autoSwitch,
    findLatestInProject: findLatestMainSessionInProject,
  });

  superFollow.start();

  // 清理函式
  const cleanup = (): void => {
    superFollow.stop();
    // 先清理 DisplayController（恢復終端設定）
    displayController.destroy();
    detector?.stop();
    log(options.quiet, chalk.gray('\nStopping...'));
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
  log(options.quiet, chalk.gray('---'));

  // 取得專案資訊（用於 auto-switch）
  const projectInfo =
    options.autoSwitch && agent.finder.getProjectInfo
      ? await agent.finder.getProjectInfo(sessionFile.path)
      : null;

  let currentPath = sessionFile.path;
  let watcher = new FileWatcher();

  // 為 Gemini 準備可重建的 parser（避免狀態殘留）
  // Codex parser 是無狀態的，不需要重建
  let currentParser = agent.parser;

  // 建立 onLine handler 函數（共用邏輯）
  const createOnLineHandler =
    (parser: LineParser) =>
    (line: string): void => {
      if (options.agentType === 'gemini') {
        // Gemini 模式：parser 有狀態追蹤，每次只回傳一個部分
        // 需要反覆呼叫直到沒有更多內容
        let parsed = parser.parse(line);
        while (parsed) {
          console.log(formatter.format(parsed));
          parsed = parser.parse(line);
        }
      } else {
        // Codex JSONL 模式：每行一個事件，單次處理
        const parsed = parser.parse(line);
        if (parsed) {
          console.log(formatter.format(parsed));
        }
      }
    };

  // 切換到新 session 的函數
  const switchToSession = async (nextFile: SessionFile): Promise<void> => {
    watcher.stop();
    currentPath = nextFile.path;

    log(
      options.quiet,
      chalk.gray(`--- Switched to ${basename(nextFile.path)} ---`)
    );

    // Gemini 需要重建 parser 以清除狀態（processedMessageIds 等）
    if (options.agentType === 'gemini') {
      const newAgent = new GeminiAgent({ verbose: options.verbose });
      currentParser = newAgent.parser;
    }

    watcher = new FileWatcher();
    await watcher.start(nextFile.path, {
      follow: true,
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      jsonMode: options.agentType === 'gemini',
      onLine: createOnLineHandler(currentParser),
      onError: (error) => {
        console.error(chalk.red(`Error: ${error.message}`));
      },
    });
  };

  // 建立 super-follow 控制器（如果支援）
  const superFollow =
    options.autoSwitch && projectInfo && agent.finder.findLatestInProject
      ? createSuperFollowController({
          projectDir: projectInfo.projectDir,
          getCurrentPath: () => currentPath,
          onSwitch: switchToSession,
          autoSwitch: true,
          findLatestInProject: agent.finder.findLatestInProject.bind(
            agent.finder
          ),
        })
      : null;

  // 處理中斷信號
  process.on('SIGINT', () => {
    log(options.quiet, chalk.gray('\nStopping...'));
    superFollow?.stop();
    watcher.stop();
    process.exit(0);
  });

  // 開始監控
  await watcher.start(sessionFile.path, {
    follow: options.follow,
    pollInterval: options.sleepInterval,
    initialLines: options.lines,
    // Gemini 使用完整 JSON 檔案格式，需要啟用 jsonMode
    jsonMode: options.agentType === 'gemini',
    onLine: createOnLineHandler(currentParser),
    onError: (error) => {
      console.error(chalk.red(`Error: ${error.message}`));
    },
  });

  // 如果不是 follow 模式，結束程式
  if (!options.follow) {
    process.exit(0);
  }

  // 啟動 super-follow（如果啟用）
  superFollow?.start();

  // 保持程式運行
  log(options.quiet, chalk.gray('Watching for changes... (Ctrl+C to stop)'));
}

main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${error.message}`));
  process.exit(1);
});
