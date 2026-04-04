import chalk from 'chalk';
import { basename, dirname } from 'node:path';
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
import { CursorAgent } from './agents/cursor/cursor-agent.ts';
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
  MAIN_LABEL,
  makeAgentLabel,
  extractAgentIdFromLabel,
  buildSubagentPath,
  getSubagentsDir,
} from './claude/subagent-detector.ts';
import {
  CodexSubagentDetector,
  makeCodexAgentLabel,
} from './codex/subagent-detector.ts';
import {
  createCodexOnLineHandler,
  buildCodexSubagentFiles,
  extractCodexSubagentIds,
  extractUUIDFromPath,
  readLastCodexAssistantMessage,
} from './codex/watch-builder.ts';
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
  readLastAssistantMessage,
} from './claude/watch-builder.ts';
import { findLatestMainSessionInProject } from './claude/auto-switch.ts';
import { readCustomTitle } from './claude/custom-title.ts';
import { createTerminalController } from './terminal/controller-factory.ts';
import { PaneManager } from './terminal/pane-manager.ts';
import { CursorSubagentDetector } from './cursor/subagent-detector.ts';
import {
  getCursorSubagentsDir,
  scanCursorSubagents,
  buildCursorSubagentFiles,
  buildCursorSubagentPath,
  makeCursorAgentLabel,
} from './cursor/watch-builder.ts';

/**
 * 條件式日誌輸出 - 在 quiet 模式下抑制非錯誤訊息
 */
function log(quiet: boolean, ...args: unknown[]): void {
  if (!quiet) {
    console.log(...args);
  }
}

/**
 * 顯示 session 資訊（Modified + optional Title）
 */
function logSessionMeta(sessionFile: SessionFile, quiet: boolean): void {
  log(quiet, chalk.gray(`Modified: ${sessionFile.mtime.toLocaleString()}`));
  if (sessionFile.customTitle) {
    log(quiet, chalk.cyan(`Title: "${sessionFile.customTitle}"`));
  }
}

/**
 * --list 模式：列出 session 並退出
 */
async function listCommand(agent: Agent, options: CliOptions): Promise<void> {
  const { formatSessionList } = await import('./list/session-lister.ts');

  if (!agent.finder.listSessions) {
    console.error(
      chalk.red(`List not supported for ${options.agentType} agent`)
    );
    process.exit(1);
  }

  const limit = options.lines ?? 20;
  const items = await agent.finder.listSessions({
    project: options.project,
    limit,
  });

  if (items.length === 0) {
    const projectInfo = options.project
      ? ` in project "${options.project}"`
      : '';
    log(
      options.quiet,
      chalk.gray(`No ${options.agentType} sessions found${projectInfo}`)
    );
    return;
  }

  const color = process.stdout.isTTY ?? false;
  const lines = formatSessionList(items, { color });
  for (const line of lines) {
    console.log(line);
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
        : options.agentType === 'cursor'
          ? new CursorAgent({ verbose: options.verbose })
          : new ClaudeAgent({ verbose: options.verbose });

  // --list 模式：列出 session 後退出
  if (options.list) {
    await listCommand(agent, options);
    return;
  }

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
    logSessionMeta(sessionFile, options.quiet);
  } else if (
    (options.agentType === 'claude' ||
      options.agentType === 'codex' ||
      options.agentType === 'cursor') &&
    options.subagent !== undefined
  ) {
    // Claude/Codex/Cursor subagent 模式（使用 --subagent 選項）
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
    logSessionMeta(sessionFile, options.quiet);
  }

  if (!sessionFile) {
    console.error(chalk.red('No session file found'));
    process.exit(1);
  }

  // 監控模式判斷：
  // 1. Claude 主 session 模式 → Claude 多檔案監控
  // 2. Codex 主 session + withSubagents/pane → Codex 多檔案監控
  // 3. Cursor 主 session + withSubagents/pane → Cursor 多檔案監控
  // 4. --subagent 選項 → 單檔案監控（Claude/Codex/Cursor）
  // 5. 其他 agent → 單檔案監控
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
  } else if (options.agentType === 'codex' && options.interactive) {
    // Codex 互動模式（Phase 3）
    await startCodexInteractiveWatch(sessionFile, formatter, options);
  } else if (
    options.agentType === 'codex' &&
    options.subagent === undefined &&
    (options.withSubagents || options.pane)
  ) {
    // Codex 多檔案監控（主 session + subagents）
    await startCodexMultiWatch(sessionFile, formatter, options);
  } else if (options.agentType === 'cursor' && options.interactive) {
    // Cursor 互動模式
    await startCursorInteractiveWatch(sessionFile, formatter, options);
  } else if (
    options.agentType === 'cursor' &&
    options.subagent === undefined &&
    (options.withSubagents || options.pane)
  ) {
    // Cursor 多檔案監控（主 session + subagents，純目錄監控）
    await startCursorMultiWatch(sessionFile, formatter, options);
  } else {
    // 其他 agent 或 Claude/Codex subagent 模式：單檔案監控
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
  let subagentsDir = getSubagentsDir(sessionFile.path);

  // 建立監控檔案列表（主 session）
  const files: WatchedFile[] = [{ path: sessionFile.path, label: MAIN_LABEL }];

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
      files.push({ path, label: makeAgentLabel(agentId) });
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

  // 建立 PaneManager（--pane 模式時自動開啟 tmux pane）
  let paneManager: PaneManager | null = null;
  if (options.pane) {
    const controller = createTerminalController();
    if (controller.isAvailable()) {
      paneManager = new PaneManager(
        controller,
        (agentId, _subagentPath) => {
          // 使用當前執行方式重建指令（支援 bun run、npx、全域安裝等）
          // 用雙引號包覆路徑，防止空格造成 shell 指令斷裂
          const runtime = `"${process.argv[0]}"`;
          const script = `"${process.argv[1]}"`;
          return `${runtime} ${script} claude --subagent ${agentId} -q --no-pane`;
        },
        (msg) => log(options.quiet, chalk.gray(msg))
      );
    } else {
      log(
        options.quiet,
        chalk.yellow('Warning: tmux not detected, --pane disabled')
      );
    }
  }

  // 提取 pane 相關回呼（消除 paneManager! 斷言，用 const 捕獲確認非 null 的參照）
  const pm = paneManager; // 閉包捕獲，不受外部重賦值影響
  const openPaneForSubagent = pm
    ? (agentId: string, subagentPath: string, description?: string) => {
        pm.openPane(agentId, subagentPath, description).catch((err) => {
          log(
            options.quiet,
            chalk.yellow(`[pane] Failed to open pane: ${err}`)
          );
        });
      }
    : undefined;

  const onSubagentDone = pm
    ? (agentId: string) => {
        const subagentPath = buildSubagentPath(subagentsDir, agentId);

        // 先讀取並輸出最後的 assistant 訊息，再關閉 pane
        (async () => {
          try {
            const parts = await readLastAssistantMessage(
              subagentPath,
              options.verbose
            );
            const label = makeAgentLabel(agentId);
            for (const part of parts) {
              part.sourceLabel = label;
              console.log(formatter.format(part));
            }
          } catch {
            // 讀取失敗不影響 pane 關閉
          } finally {
            await pm.closePaneByAgentId(agentId);
          }
        })().catch(() => {});
      }
    : undefined;

  const hasPaneCallback = pm
    ? (agentId: string) => pm.hasPaneForAgent(agentId)
    : undefined;

  // pane 模式下，進入時既有 subagent 加入 suppress set，避免歷史內容污染 main pane
  const suppressedForPane = pm ? new Set(existingAgentIds) : new Set<string>();

  const shouldOutput = pm
    ? (label: string) => {
        if (label === MAIN_LABEL) return true;
        const agentId = extractAgentIdFromLabel(label);
        if (suppressedForPane.has(agentId)) return false;
        return !pm.hasPaneForAgent(agentId);
      }
    : undefined;

  // 建立 SubagentDetector（整合 early detection 和 fallback detection）
  let detector = new SubagentDetector(existingAgentIds, {
    subagentsDir,
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    session: new NoOpSessionHandler(),
    enabled: options.follow && options.withSubagents,
    onNewSubagent: openPaneForSubagent,
    onSubagentEnter: openPaneForSubagent,
    onSubagentDone,
    hasPane: hasPaneCallback,
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
    const newSessionId = basename(nextSessionFile.path, '.jsonl');
    const newSubagentsDir = getSubagentsDir(nextSessionFile.path);

    const newFiles: WatchedFile[] = [
      { path: nextSessionFile.path, label: MAIN_LABEL },
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
        newFiles.push({ path, label: makeAgentLabel(agentId) });
      }

      if (newExistingAgentIds.size > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${newExistingAgentIds.size} subagent(s)`)
        );
      }
    }

    // 更新 suppress set：清空後填入新 session 的既有 subagent
    if (pm) {
      suppressedForPane.clear();
      for (const agentId of newExistingAgentIds) suppressedForPane.add(agentId);
    }

    // 輸出切換訊息
    const switchTitle = await readCustomTitle(nextSessionFile.path);
    const switchTitleSuffix = switchTitle ? ` "${switchTitle}"` : '';
    log(
      options.quiet,
      chalk.gray(
        `--- Switched to session ${newSessionId}${switchTitleSuffix} ---`
      )
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

    // 重新建立 detector（捕獲新的 multiWatcher，沿用 pane 回呼）
    const newDetector = new SubagentDetector(newExistingAgentIds, {
      subagentsDir: newSubagentsDir,
      output: new ConsoleOutputHandler(),
      watcher: { addFile: (f) => newMultiWatcher.addFile(f) },
      session: new NoOpSessionHandler(),
      enabled: options.follow && options.withSubagents,
      onNewSubagent: openPaneForSubagent,
      onSubagentEnter: openPaneForSubagent,
      onSubagentDone,
      hasPane: hasPaneCallback,
    });
    newDetector.startDirectoryWatch();

    // 更新外層變數
    subagentsDir = newSubagentsDir;
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
        shouldOutput,
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
    // best-effort 清理所有 pane（async 但不等待，因為即將 exit）
    paneManager?.closeAll();
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
      shouldOutput,
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
  _options: CliOptions
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
      let parsed = parser.parse(line);
      while (parsed) {
        parsed.sourceLabel = file.label;
        allParsedLines.push({
          parsed,
          timestamp: new Date(parsed.timestamp),
        });
        parsed = parser.parse(line);
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
 * Interactive 模式共用：建立 SessionManager（Claude/Codex 兩種 interactive 模式都相同）
 */
function createInteractiveSessionManager(
  displayController: DisplayController
): SessionManager {
  const manager = new SessionManager({
    bufferSize: 1000,
    onOutput: (content: string, _session: WatcherSession) => {
      displayController.write(content);
    },
    onSessionAdded: (session: WatcherSession) => {
      displayController.write(
        chalk.yellow(`New session added: ${session.label}`)
      );
      displayController.updateStatusLine(
        manager.getAllSessions(),
        manager.getActiveIndex()
      );
    },
    onSessionSwitched: (
      session: WatcherSession,
      allSessions: WatcherSession[]
    ) => {
      const historyContent = session.buffer.slice();
      displayController.updateStatusLine(allSessions, manager.getActiveIndex());
      displayController.showSwitchMessage(session, historyContent);
    },
  });
  return manager;
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

  const buildInteractiveState = async (
    targetSessionFile: SessionFile,
    initialSubagentFile: SessionFile | null,
    showIntro: boolean
  ): Promise<void> => {
    const subagentsDir = getSubagentsDir(targetSessionFile.path);

    sessionManager = createInteractiveSessionManager(displayController);
    const mainTitle =
      targetSessionFile.customTitle ??
      (await readCustomTitle(targetSessionFile.path)) ??
      undefined;
    sessionManager.addSession(
      'main',
      MAIN_LABEL,
      targetSessionFile.path,
      mainTitle
    );

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
      sessionManager.addSession(agentId, makeAgentLabel(agentId), path);
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
        onTitleUpdate: (title) => {
          sessionManager.updateSessionDisplayName('main', title);
          displayController.updateStatusLine(
            sessionManager.getAllSessions(),
            sessionManager.getActiveIndex()
          );
        },
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
    const switchTitle = await readCustomTitle(nextSessionFile.path);
    const switchTitleSuffix = switchTitle ? ` "${switchTitle}"` : '';
    displayController.write(
      chalk.gray(
        `Switched to latest session: ${nextSessionId}${switchTitleSuffix}`
      )
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
 * Codex Interactive 模式（使用 SessionManager 和 DisplayController 管理輸出切換）
 */
async function startCodexInteractiveWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  // TTY 檢查：非 TTY 環境自動降級到 Codex 多檔案監控模式
  if (!process.stdin.isTTY) {
    console.warn(
      chalk.yellow(
        'Warning: Interactive mode not available in non-TTY environment.\n' +
          'Switching to standard multi-watch mode.\n' +
          'Keyboard controls (Tab to switch) will not be available.'
      )
    );
    await startCodexMultiWatch(sessionFile, formatter, options);
    return;
  }

  // codexAgent + projectDir（super-follow 用）
  const codexAgent = new CodexAgent({ verbose: options.verbose });
  const projectInfo = codexAgent.finder.getProjectInfo
    ? await codexAgent.finder.getProjectInfo(sessionFile.path)
    : null;
  const projectDir = projectInfo?.projectDir ?? dirname(sessionFile.path);

  // 建立 DisplayController
  const displayController = new DisplayController({
    persistentStatusLine: true,
    historyLines: 50,
  });

  let sessionManager!: SessionManager;
  let multiWatcher: MultiFileWatcher | null = null;
  let detector: CodexSubagentDetector | null = null;
  let currentSessionFile = sessionFile;

  // Codex parser 無狀態，所有 session 共用 sharedParser
  const sharedParser = codexAgent.parser;
  // detectionHandler 在 buildInteractiveState 結尾更新，確保 switchToSession 後指向新 detector
  let detectionHandler: (line: string, label: string) => void = () => {};

  const buildInteractiveState = async (
    targetSessionFile: SessionFile,
    showIntro: boolean
  ): Promise<void> => {
    const dateDirLocal = dirname(targetSessionFile.path);

    sessionManager = createInteractiveSessionManager(displayController);
    sessionManager.addSession('main', MAIN_LABEL, targetSessionFile.path);

    // Codex 掃描：用 extractCodexSubagentIds 取代 scanForNewSubagents
    const existingIds = await extractCodexSubagentIds(targetSessionFile.path);
    const existingSubFiles = await buildCodexSubagentFiles(
      dateDirLocal,
      existingIds
    );

    for (const f of existingSubFiles) {
      const agentId = extractUUIDFromPath(f.path);
      const label = makeCodexAgentLabel(agentId);
      sessionManager.addSession(agentId, label, f.path);
    }

    if (showIntro) {
      if (existingIds.length > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${existingIds.length} subagent(s)`)
        );
      }
      log(
        options.quiet,
        chalk.gray('Interactive mode: Press Tab to switch, q to quit')
      );
      log(options.quiet, chalk.gray('---'));
    }

    const watcher = new MultiFileWatcher();
    multiWatcher = watcher;

    detector = new CodexSubagentDetector(existingIds, {
      sessionDateDir: dateDirLocal,
      output: new DisplayControllerOutputHandler(displayController),
      watcher: { addFile: (f) => watcher.addFile(f) },
      enabled: true, // Interactive 一定是 follow
      onNewSubagent: (agentId, path, _description) => {
        const label = makeCodexAgentLabel(agentId);
        sessionManager.addSession(agentId, label, path);
        displayController.updateStatusLine(
          sessionManager.getAllSessions(),
          sessionManager.getActiveIndex()
        );
      },
      onSubagentDone: (agentId) => {
        sessionManager.markSessionDone(agentId);
        displayController.write(
          chalk.gray(`[subagent] ${agentId.slice(0, 8)} done`)
        );
        displayController.updateStatusLine(
          sessionManager.getAllSessions(),
          sessionManager.getActiveIndex()
        );
      },
    });

    // 預填既有 subagent 路徑，讓 resume_agent 事件能找到路徑
    for (const f of existingSubFiles) {
      detector.registerExistingAgent(extractUUIDFromPath(f.path), f.path);
    }

    // 更新 detectionHandler（確保 switchToSession 後指向新 detector）
    detectionHandler = createCodexOnLineHandler(detector);
  };

  const startWatcher = async (): Promise<void> => {
    if (!multiWatcher) return;

    const files = sessionManager.getWatchedFiles();

    await multiWatcher.start(files, {
      follow: true, // Interactive 一定是 follow
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: (line: string, label: string) => {
        // detectionHandler 透過 let 引用最新 detector
        detectionHandler(line, label);
        const parsed = sharedParser.parse(line);
        if (!parsed) return;
        parsed.sourceLabel = label;
        sessionManager.handleOutput(label, formatter.format(parsed));
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
      if (key === '\u0003') {
        cleanup();
        process.exit(0);
      }
      if (key === 'q' || key === 'Q') {
        cleanup();
        process.exit(0);
      }
      if (key === '\t') {
        sessionManager.switchNext();
      }
      if (key === '\u001b[Z') {
        sessionManager.switchPrev();
      }
      if (key === 'n' || key === 'N') {
        sessionManager.switchNext();
      }
      if (key === 'p' || key === 'P') {
        sessionManager.switchPrev();
      }
    });
  }

  // 初始化狀態並啟動監控
  await buildInteractiveState(currentSessionFile, true);

  // 初始化 DisplayController
  displayController.init();

  // 顯示初始狀態列
  displayController.updateStatusLine(
    sessionManager.getAllSessions(),
    sessionManager.getActiveIndex()
  );

  await startWatcher();

  const switchToSession = async (nextFile: SessionFile): Promise<void> => {
    detector?.stop();
    multiWatcher?.stop();

    currentSessionFile = nextFile;
    await buildInteractiveState(nextFile, false);

    displayController.updateStatusLine(
      sessionManager.getAllSessions(),
      sessionManager.getActiveIndex()
    );

    await startWatcher();

    const nextSessionId = basename(nextFile.path, '.jsonl');
    displayController.write(
      chalk.gray(`Switched to latest session: ${nextSessionId}`)
    );
  };

  const superFollow = createSuperFollowController({
    projectDir,
    getCurrentPath: () => currentSessionFile.path,
    onSwitch: switchToSession,
    autoSwitch: options.autoSwitch,
    findLatestInProject: (cwd) => codexAgent.finder.findLatestInProject!(cwd),
  });

  superFollow.start();

  // 清理函式
  const cleanup = (): void => {
    superFollow.stop();
    displayController.destroy();
    detector?.stop();
    log(options.quiet, chalk.gray('\nStopping...'));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    multiWatcher?.stop();
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
 * Codex 多檔案監控（主 session + subagents）
 */
async function startCodexMultiWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  // 1. dateDir（Codex subagent 與主 session 在同一個日期目錄）
  const dateDir = dirname(sessionFile.path);

  // 2. projectDir（super-follow 用），從 session_meta 取得 cwd
  const codexAgent = new CodexAgent({ verbose: options.verbose });
  const projectInfo = codexAgent.finder.getProjectInfo
    ? await codexAgent.finder.getProjectInfo(sessionFile.path)
    : null;
  const projectDir = projectInfo?.projectDir ?? dateDir;

  // 3. 掃描既有 subagent IDs
  const existingIds = options.withSubagents
    ? await extractCodexSubagentIds(sessionFile.path)
    : [];

  // 4. 建立監控檔案列表
  const existingSubFiles =
    options.withSubagents && existingIds.length > 0
      ? await buildCodexSubagentFiles(dateDir, existingIds)
      : [];

  const files: WatchedFile[] = [
    { path: sessionFile.path, label: MAIN_LABEL },
    ...existingSubFiles.map((f) => {
      // makeCodexAgentLabel 接受 UUID，不是路徑
      const agentId = extractUUIDFromPath(f.path);
      return { path: f.path, label: makeCodexAgentLabel(agentId) };
    }),
  ];

  if (existingIds.length > 0) {
    log(options.quiet, chalk.gray(`Found ${existingIds.length} subagent(s)`));
  }
  log(options.quiet, chalk.gray('---'));

  // 5. Codex parser 無狀態，多 file 共用一個實例
  const parser = codexAgent.parser;

  // 6. PaneManager 初始化（Phase 2: --pane 支援）
  let paneManager: PaneManager | null = null;
  if (options.pane) {
    const controller = createTerminalController();
    if (controller.isAvailable()) {
      paneManager = new PaneManager(
        controller,
        (agentId, _subagentPath) => {
          const runtime = `"${process.argv[0]}"`;
          const script = `"${process.argv[1]}"`;
          return `${runtime} ${script} codex --subagent ${agentId} -q --no-pane`;
        },
        (msg) => log(options.quiet, chalk.gray(msg))
      );
    } else {
      log(
        options.quiet,
        chalk.yellow('Warning: tmux not detected, --pane disabled')
      );
    }
  }

  const pm = paneManager;

  // Codex label 用短 ID（如 019cc375-8a57），但 PaneManager 用完整 UUID 作 key
  // 此映射讓 shouldOutput 能從短 ID 反查完整 UUID
  const shortIdToFullId = new Map<string, string>();
  function registerShortId(agentId: string): void {
    const parts = agentId.split('-');
    const shortId = `${parts[0]}-${(parts[4] ?? '').slice(0, 4)}`;
    shortIdToFullId.set(shortId, agentId);
  }

  // pane 模式下：既有 subagent 加入 suppress set（完整 UUID v7），避免歷史內容污染 main pane
  const suppressedForPane = new Set<string>();

  /** 預填既有 subagent 路徑到 detector，同步短 ID 映射，並填充 suppressedForPane（若有 pane） */
  function prefillExistingSubagents(
    det: CodexSubagentDetector,
    files: SessionFile[]
  ): void {
    for (const f of files) {
      const uuid = extractUUIDFromPath(f.path);
      if (pm) {
        registerShortId(uuid);
        suppressedForPane.add(uuid);
      }
      det.registerExistingAgent(uuid, f.path);
    }
  }
  const shouldOutput = pm
    ? (label: string) => {
        if (label === MAIN_LABEL) return true;
        const shortId = extractAgentIdFromLabel(label);
        const fullId = shortIdToFullId.get(shortId) ?? shortId;
        if (suppressedForPane.has(fullId)) return false;
        return !pm.hasPaneForAgent(fullId);
      }
    : undefined;

  const openPaneForSubagent = pm
    ? (agentId: string, subagentPath: string, description?: string) => {
        registerShortId(agentId);
        pm.openPane(agentId, subagentPath, description).catch(
          (err: unknown) => {
            log(
              options.quiet,
              chalk.yellow(`[pane] Failed to open pane: ${err}`)
            );
          }
        );
      }
    : undefined;

  const onSubagentDone = pm
    ? (agentId: string) => {
        // 使用 detector.getAgentPath() 取路徑（detector 是 let 變數，切換 session 後自動指向新 detector）
        const subPath = detector.getAgentPath(agentId);

        (async () => {
          try {
            if (subPath) {
              const parts = await readLastCodexAssistantMessage(
                subPath,
                parser
              );
              const label = makeCodexAgentLabel(agentId);
              for (const part of parts) {
                part.sourceLabel = label;
                console.log(formatter.format(part));
              }
            }
          } finally {
            await pm.closePaneByAgentId(agentId);
          }
        })().catch(() => {});
      }
    : undefined;

  // 7. MultiFileWatcher + CodexSubagentDetector
  let multiWatcher = new MultiFileWatcher();

  let detector = new CodexSubagentDetector(existingIds, {
    sessionDateDir: dateDir,
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    enabled: options.follow && options.withSubagents,
    onNewSubagent: openPaneForSubagent,
    onSubagentEnter: openPaneForSubagent,
    onSubagentDone,
  });

  // 預填既有 subagent 路徑，讓 resume_agent 事件能找到路徑（用於 --pane onSubagentEnter）
  // 同時填充 suppressedForPane（由 prefillExistingSubagents 內部處理）
  prefillExistingSubagents(detector, existingSubFiles);

  // 8. 組合 line handler：detection + output
  // makeOnLine() 使用 closure，switchToSession 更新 detectionHandler 後自動生效
  let detectionHandler = createCodexOnLineHandler(detector);
  const makeOnLine = () => (line: string, label: string) => {
    detectionHandler(line, label); // 只對 MAIN label 做 detection（內部已過濾）
    if (shouldOutput && !shouldOutput(label)) return;
    const parsed = parser.parse(line);
    if (!parsed) return;
    parsed.sourceLabel = label;
    console.log(formatter.format(parsed));
  };

  // 9. Super-follow：包含完整的 switchToSession 重建邏輯
  let currentSessionPath = sessionFile.path;

  const switchToSession = async (nextFile: SessionFile): Promise<void> => {
    paneManager?.closeAll(); // 關閉現有 pane
    shortIdToFullId.clear();
    if (pm) suppressedForPane.clear(); // 與 prefillExistingSubagents 配對清空
    detector.stop();
    multiWatcher.stop();

    currentSessionPath = nextFile.path;
    const newDateDir = dirname(nextFile.path);

    const newExistingIds = options.withSubagents
      ? await extractCodexSubagentIds(nextFile.path)
      : [];
    const newSubFiles =
      options.withSubagents && newExistingIds.length > 0
        ? await buildCodexSubagentFiles(newDateDir, newExistingIds)
        : [];

    const newFiles: WatchedFile[] = [
      { path: nextFile.path, label: MAIN_LABEL },
      ...newSubFiles.map((f) => {
        const agentId = extractUUIDFromPath(f.path);
        return { path: f.path, label: makeCodexAgentLabel(agentId) };
      }),
    ];

    log(
      options.quiet,
      chalk.gray(
        `--- Switched to session ${basename(nextFile.path, '.jsonl')} ---`
      )
    );

    const newMultiWatcher = new MultiFileWatcher();
    const newDetector = new CodexSubagentDetector(newExistingIds, {
      sessionDateDir: newDateDir,
      output: new ConsoleOutputHandler(),
      watcher: { addFile: (f) => newMultiWatcher.addFile(f) },
      enabled: options.follow && options.withSubagents,
      onNewSubagent: openPaneForSubagent,
      onSubagentEnter: openPaneForSubagent,
      onSubagentDone,
    });

    // 預填既有 subagent 路徑 + 短 ID 映射
    prefillExistingSubagents(newDetector, newSubFiles);

    multiWatcher = newMultiWatcher;
    detector = newDetector;
    detectionHandler = createCodexOnLineHandler(newDetector);

    await multiWatcher.start(newFiles, {
      follow: options.follow,
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: makeOnLine(),
      onError: (error) => console.error(chalk.red(`Error: ${error.message}`)),
    });
  };

  const superFollow = createSuperFollowController({
    projectDir,
    getCurrentPath: () => currentSessionPath,
    onSwitch: switchToSession,
    autoSwitch: options.autoSwitch,
    findLatestInProject: (cwd) => codexAgent.finder.findLatestInProject!(cwd),
  });

  // 10. 信號處理
  process.on('SIGINT', () => {
    superFollow.stop();
    detector.stop();
    multiWatcher.stop();
    paneManager?.closeAll();
    console.log(chalk.gray('\nStopping...'));
    process.exit(0);
  });

  // 11. 啟動監控
  await multiWatcher.start(files, {
    follow: options.follow,
    pollInterval: options.sleepInterval,
    initialLines: options.lines,
    onLine: makeOnLine(),
    onError: (error) => console.error(chalk.red(`Error: ${error.message}`)),
  });

  if (!options.follow) process.exit(0);
  superFollow.start();
  log(options.quiet, chalk.gray('Watching for changes... (Ctrl+C to stop)'));
}

/**
 * Cursor 互動模式（SessionManager + DisplayController）
 * 與 Codex 模式相同：共用無狀態 parser，無 JSONL 事件偵測
 * 純目錄監控偵測 subagent
 */
async function startCursorInteractiveWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  // TTY check → fallback to multi-watch
  if (!process.stdin.isTTY) {
    console.warn(
      chalk.yellow(
        'Warning: Interactive mode not available in non-TTY environment.\n' +
          'Switching to standard multi-watch mode.'
      )
    );
    await startCursorMultiWatch(sessionFile, formatter, options);
    return;
  }

  const cursorAgent = new CursorAgent({ verbose: options.verbose });
  const projectInfo = cursorAgent.finder.getProjectInfo
    ? await cursorAgent.finder.getProjectInfo(sessionFile.path)
    : null;

  const displayController = new DisplayController({
    persistentStatusLine: true,
    historyLines: 50,
  });

  let sessionManager!: SessionManager;
  let multiWatcher: MultiFileWatcher | null = null;
  let detector: CursorSubagentDetector | null = null;
  let currentSessionFile = sessionFile;

  // Cursor parser 無狀態，所有 session 共用（同 Codex）
  const sharedParser = cursorAgent.parser;

  // ========== buildInteractiveState ==========
  const buildInteractiveState = async (
    targetSessionFile: SessionFile,
    showIntro: boolean
  ): Promise<void> => {
    const subagentsDirLocal = getCursorSubagentsDir(targetSessionFile.path);

    sessionManager = createInteractiveSessionManager(displayController);
    sessionManager.addSession('main', MAIN_LABEL, targetSessionFile.path);

    // 掃描既有 subagent
    const existingIds = await scanCursorSubagents(subagentsDirLocal, new Set());
    const existingSubFiles = await buildCursorSubagentFiles(
      subagentsDirLocal,
      existingIds
    );

    for (const { agentId, path } of existingSubFiles) {
      const label = makeCursorAgentLabel(agentId);
      sessionManager.addSession(agentId, label, path);
    }

    if (showIntro) {
      if (existingIds.length > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${existingIds.length} subagent(s)`)
        );
      }
      log(
        options.quiet,
        chalk.gray('Interactive mode: Press Tab to switch, q to quit')
      );
      log(options.quiet, chalk.gray('---'));
    }

    const watcher = new MultiFileWatcher();
    multiWatcher = watcher;

    // 注意：不傳 session 給 detector，避免 double registration
    // CursorSubagentDetector.registerExistingAgent 和 registerNewAgent 內部都會呼叫 session?.addSession
    // 如果同時傳 session 又在 onNewSubagent 呼叫 sessionManager.addSession 會造成重複
    detector = new CursorSubagentDetector(subagentsDirLocal, {
      output: new DisplayControllerOutputHandler(displayController),
      watcher: { addFile: (f) => watcher.addFile(f) },
      enabled: true, // interactive 必定 follow
      onNewSubagent: (agentId: string, path: string) => {
        const label = makeCursorAgentLabel(agentId);
        sessionManager.addSession(agentId, label, path);
        displayController.updateStatusLine(
          sessionManager.getAllSessions(),
          sessionManager.getActiveIndex()
        );
      },
    });

    // 預填既有 subagent（只更新 detector 的 knownAgentIds）
    for (const { agentId, path } of existingSubFiles) {
      detector.registerExistingAgent(agentId, path);
    }

    detector.startDirectoryWatch();
  };

  // ========== startWatcher ==========
  const startWatcher = async (): Promise<void> => {
    if (!multiWatcher) return;

    const files = sessionManager.getWatchedFiles();

    await multiWatcher.start(files, {
      follow: true, // interactive 必定 follow
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: (line: string, label: string) => {
        // Cursor 無 JSONL 事件，不需要 detectionHandler
        const parsed = sharedParser.parse(line);
        if (!parsed) return;
        parsed.sourceLabel = label;
        sessionManager.handleOutput(label, formatter.format(parsed));
      },
      onError: (error) => {
        displayController.write(chalk.red(`Error: ${error.message}`));
      },
    });
  };

  // ========== Keyboard Handling ==========
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      if (key === '\u0003') {
        cleanup();
        process.exit(0);
      }
      if (key === 'q' || key === 'Q') {
        cleanup();
        process.exit(0);
      }
      if (key === '\t') sessionManager.switchNext();
      if (key === '\u001b[Z') sessionManager.switchPrev(); // Shift+Tab
      if (key === 'n' || key === 'N') sessionManager.switchNext();
      if (key === 'p' || key === 'P') sessionManager.switchPrev();
    });
  }

  // ========== Session Switch (Super-Follow) ==========
  const switchToSession = async (nextFile: SessionFile): Promise<void> => {
    detector?.stop();
    multiWatcher?.stop();

    currentSessionFile = nextFile;
    await buildInteractiveState(nextFile, false);

    displayController.updateStatusLine(
      sessionManager.getAllSessions(),
      sessionManager.getActiveIndex()
    );

    await startWatcher();

    const nextSessionId = basename(dirname(nextFile.path));
    displayController.write(
      chalk.gray(`Switched to latest session: ${nextSessionId}`)
    );
  };

  const superFollow = projectInfo
    ? createSuperFollowController({
        projectDir: projectInfo.projectDir,
        getCurrentPath: () => currentSessionFile.path,
        onSwitch: switchToSession,
        autoSwitch: options.autoSwitch,
        findLatestInProject: (dir) =>
          cursorAgent.finder.findLatestInProject!(dir),
      })
    : { start: () => {}, stop: () => {} };

  // ========== Initialization ==========
  await buildInteractiveState(currentSessionFile, true);
  displayController.init();
  displayController.updateStatusLine(
    sessionManager.getAllSessions(),
    sessionManager.getActiveIndex()
  );
  await startWatcher();

  const cleanup = (): void => {
    superFollow.stop();
    displayController.destroy();
    detector?.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    multiWatcher?.stop();
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  superFollow.start();
  displayController.write(
    chalk.gray('Watching for changes... (Tab to switch, q to quit)')
  );
}

/**
 * Cursor 多檔案監控（主 session + subagents）
 * 純目錄監控偵測（Cursor JSONL 無 spawn/resume 事件）
 */
async function startCursorMultiWatch(
  sessionFile: SessionFile,
  formatter: Formatter,
  options: CliOptions
): Promise<void> {
  const cursorAgent = new CursorAgent({ verbose: options.verbose });
  let subagentsDir = getCursorSubagentsDir(sessionFile.path);

  // 建立監控檔案列表（主 session）
  const files: WatchedFile[] = [{ path: sessionFile.path, label: MAIN_LABEL }];

  // 掃描現有的 subagent
  const existingAgentIds: string[] = [];
  if (options.withSubagents) {
    const dirAgentIds = await scanCursorSubagents(subagentsDir, new Set());
    existingAgentIds.push(...dirAgentIds);

    const existingSubagentFiles = await buildCursorSubagentFiles(
      subagentsDir,
      existingAgentIds
    );
    for (const { agentId, path } of existingSubagentFiles) {
      files.push({ path, label: makeCursorAgentLabel(agentId) });
    }

    if (existingAgentIds.length > 0) {
      log(
        options.quiet,
        chalk.gray(`Found ${existingAgentIds.length} subagent(s)`)
      );
    }
  }
  log(options.quiet, chalk.gray('---'));

  // Cursor parser 無狀態，所有 session 共用
  const parser = cursorAgent.parser;

  // 非 follow 模式且有 subagent：依序輸出（Cursor 無時間戳，不用 outputTimeSorted）
  if (!options.follow && options.withSubagents && files.length > 1) {
    for (const file of files) {
      const bunFile = Bun.file(file.path);
      if (!(await bunFile.exists())) continue;

      const content = await bunFile.text();
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        const parsed = parser.parse(line);
        if (parsed) {
          parsed.sourceLabel = file.label;
          console.log(formatter.format(parsed));
        }
      }
    }
    process.exit(0);
  }

  let multiWatcher = new MultiFileWatcher();

  // 建立 PaneManager（--pane 模式）
  let paneManager: PaneManager | null = null;
  if (options.pane) {
    const controller = createTerminalController();
    if (controller.isAvailable()) {
      paneManager = new PaneManager(
        controller,
        (agentId, _subagentPath) => {
          const runtime = `"${process.argv[0]}"`;
          const script = `"${process.argv[1]}"`;
          return `${runtime} ${script} cursor --subagent ${agentId} -q --no-pane`;
        },
        (msg) => log(options.quiet, chalk.gray(msg))
      );
    } else {
      log(
        options.quiet,
        chalk.yellow('Warning: tmux not detected, --pane disabled')
      );
    }
  }

  const pm = paneManager;
  // Cursor 沒有 subagent 完成事件，pane 不會自動關閉
  // 使用 FIFO eviction 策略：達到上限時關閉最舊的 pane
  const paneAgentOrder: string[] = [];
  const CURSOR_MAX_PANES = 6;

  const openPaneForSubagent = pm
    ? (agentId: string, subagentPath: string) => {
        // Evict oldest pane if at capacity
        if (
          pm.activePaneCount >= CURSOR_MAX_PANES &&
          paneAgentOrder.length > 0
        ) {
          const oldestId = paneAgentOrder.shift()!;
          pm.closePaneByAgentId(oldestId).catch(() => {});
        }
        pm.openPane(agentId, subagentPath)
          .then(() => {
            // 只在 pane 成功開啟後加入 FIFO，避免幽靈 agentId
            if (pm.hasPaneForAgent(agentId)) {
              paneAgentOrder.push(agentId);
            }
          })
          .catch((err) => {
            log(
              options.quiet,
              chalk.yellow(`[pane] Failed to open pane: ${err}`)
            );
          });
      }
    : undefined;

  // pane 模式下，既有 subagent 加入 suppress set
  const suppressedForPane = pm ? new Set(existingAgentIds) : new Set<string>();

  const shouldOutput = pm
    ? (label: string) => {
        if (label === MAIN_LABEL) return true;
        const shortId = extractAgentIdFromLabel(label);
        // Cursor 標籤用 UUID 前 8 字元，pane 用完整 UUID
        // 需要反查完整 UUID
        const fullId = shortIdToFullId.get(shortId) ?? shortId;
        if (suppressedForPane.has(fullId)) return false;
        return !pm.hasPaneForAgent(fullId);
      }
    : undefined;

  // 短 ID → 完整 UUID 映射（pane 輸出過濾需要）
  const shortIdToFullId = new Map<string, string>();

  function registerShortId(fullUUID: string): void {
    const shortId = fullUUID.slice(0, 8);
    shortIdToFullId.set(shortId, fullUUID);
  }

  // 建立 CursorSubagentDetector（純目錄監控）
  let detector = new CursorSubagentDetector(subagentsDir, {
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    enabled: options.follow && options.withSubagents,
    onNewSubagent: (agentId: string, subagentPath: string) => {
      registerShortId(agentId);
      openPaneForSubagent?.(agentId, subagentPath);
    },
  });

  // 預填既有 subagent
  for (const agentId of existingAgentIds) {
    if (pm) {
      registerShortId(agentId);
      suppressedForPane.add(agentId);
    }
    detector.registerExistingAgent(
      agentId,
      buildCursorSubagentPath(subagentsDir, agentId)
    );
  }

  detector.startDirectoryWatch();

  // Cursor onLine handler（共用，避免 switchToSession 中重複）
  const cursorOnLine = (line: string, label: string) => {
    if (shouldOutput && !shouldOutput(label)) return;
    const parsed = parser.parse(line);
    if (!parsed) return;
    parsed.sourceLabel = label;
    console.log(formatter.format(parsed));
  };

  // ========== Non-Interactive Super-Follow ==========
  let currentSessionPath = sessionFile.path;

  const switchToSession = async (
    nextSessionFile: SessionFile
  ): Promise<void> => {
    detector.stop();
    multiWatcher.stop();

    currentSessionPath = nextSessionFile.path;
    const newSubagentsDir = getCursorSubagentsDir(nextSessionFile.path);

    const newFiles: WatchedFile[] = [
      { path: nextSessionFile.path, label: MAIN_LABEL },
    ];
    const newExistingAgentIds: string[] = [];

    if (options.withSubagents) {
      const dirAgentIds = await scanCursorSubagents(newSubagentsDir, new Set());
      newExistingAgentIds.push(...dirAgentIds);

      const existingSubagentFiles = await buildCursorSubagentFiles(
        newSubagentsDir,
        newExistingAgentIds
      );
      for (const { agentId, path } of existingSubagentFiles) {
        newFiles.push({ path, label: makeCursorAgentLabel(agentId) });
      }

      if (newExistingAgentIds.length > 0) {
        log(
          options.quiet,
          chalk.gray(`Found ${newExistingAgentIds.length} subagent(s)`)
        );
      }
    }

    // 更新 suppress set + 清空 pane FIFO 佇列
    if (pm) {
      pm.closeAll();
      paneAgentOrder.length = 0;
      suppressedForPane.clear();
      shortIdToFullId.clear();
    }

    const newSessionId = basename(dirname(nextSessionFile.path));
    log(
      options.quiet,
      chalk.gray(`--- Switched to session ${newSessionId} ---`)
    );
    log(options.quiet, chalk.gray('---'));

    const newMultiWatcher = new MultiFileWatcher();

    const newDetector = new CursorSubagentDetector(newSubagentsDir, {
      output: new ConsoleOutputHandler(),
      watcher: { addFile: (f) => newMultiWatcher.addFile(f) },
      enabled: options.follow && options.withSubagents,
      onNewSubagent: (agentId: string, subagentPath: string) => {
        registerShortId(agentId);
        openPaneForSubagent?.(agentId, subagentPath);
      },
    });

    // 預填既有 subagent（一次迴圈處理 shortId 映射 + suppress + detector）
    for (const agentId of newExistingAgentIds) {
      if (pm) {
        registerShortId(agentId);
        suppressedForPane.add(agentId);
      }
      newDetector.registerExistingAgent(
        agentId,
        buildCursorSubagentPath(newSubagentsDir, agentId)
      );
    }

    newDetector.startDirectoryWatch();

    subagentsDir = newSubagentsDir;
    multiWatcher = newMultiWatcher;
    detector = newDetector;

    await multiWatcher.start(newFiles, {
      follow: options.follow,
      pollInterval: options.sleepInterval,
      initialLines: options.lines,
      onLine: cursorOnLine,
      onError: (error) => {
        console.error(chalk.red(`Error: ${error.message}`));
      },
    });
  };

  // 取得專案資訊用於 super-follow
  const projectInfo =
    options.autoSwitch && cursorAgent.finder.getProjectInfo
      ? await cursorAgent.finder.getProjectInfo(sessionFile.path)
      : null;

  const superFollow = projectInfo
    ? createSuperFollowController({
        projectDir: projectInfo.projectDir,
        getCurrentPath: () => currentSessionPath,
        onSwitch: switchToSession,
        autoSwitch: options.autoSwitch,
        findLatestInProject: (dir) =>
          cursorAgent.finder.findLatestInProject!(dir),
      })
    : { start: () => {}, stop: () => {} };

  // 處理中斷信號
  process.on('SIGINT', () => {
    superFollow.stop();
    console.log(chalk.gray('\nStopping...'));
    detector.stop();
    multiWatcher.stop();
    paneManager?.closeAll();
    process.exit(0);
  });

  await multiWatcher.start(files, {
    follow: options.follow,
    pollInterval: options.sleepInterval,
    initialLines: options.lines,
    onLine: cursorOnLine,
    onError: (error) => {
      console.error(chalk.red(`Error: ${error.message}`));
    },
  });

  if (!options.follow) process.exit(0);
  superFollow.start();
  log(options.quiet, chalk.gray('Watching for changes... (Ctrl+C to stop)'));
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

  // 建立 onLine handler 函數（單一 agent 用，與 Claude 多檔案的 createOnLineHandler 不同）
  const makeSingleLineHandler =
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
      onLine: makeSingleLineHandler(currentParser),
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
    onLine: makeSingleLineHandler(currentParser),
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
