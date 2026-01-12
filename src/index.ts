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

  // 掃描現有的 subagent（優先使用目錄掃描，確保找到所有檔案）
  const dirAgentIds = await scanForNewSubagents(subagentsDir, new Set());
  const existingAgentIds = new Set(dirAgentIds);

  // 如果有從 sessionId 指定的 subagent，確保它被加入
  if (initialSubagent) {
    const initialAgentId = basename(initialSubagent.path, '.jsonl').replace(
      /^agent-/,
      ''
    );
    existingAgentIds.add(initialAgentId);
  }

  for (const agentId of existingAgentIds) {
    const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    // 檢查檔案是否存在
    const subagentFileCheck = Bun.file(subagentPath);
    if (await subagentFileCheck.exists()) {
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

  const multiWatcher = new MultiFileWatcher();

  // 建立 SubagentDetector（整合 early detection 和 fallback detection）
  const detector = new SubagentDetector(existingAgentIds, {
    subagentsDir,
    output: new ConsoleOutputHandler(),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    session: new NoOpSessionHandler(),
    enabled: options.follow,
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
        if (label === '[MAIN]') {
          const raw = parsed.raw as { toolUseResult?: { agentId?: string } };
          const agentId = raw?.toolUseResult?.agentId;
          if (agentId) {
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

  // 掃描現有的 subagent（優先使用目錄掃描，確保找到所有檔案）
  const dirAgentIds = await scanForNewSubagents(subagentsDir, new Set());
  const existingAgentIds = new Set(dirAgentIds);

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

  // 按建立時間升序排序（最舊的先加入，會被推到右邊；最新的最後加入，留在 MAIN 旁邊）
  existingSubagentFiles.sort(
    (a, b) => a.birthtime.getTime() - b.birthtime.getTime()
  );

  // 依排序後的順序加入
  for (const { agentId, path } of existingSubagentFiles) {
    sessionManager.addSession(agentId, `[${agentId}]`, path);
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

  // 建立 MultiFileWatcher
  const multiWatcher = new MultiFileWatcher();

  // 建立 SubagentDetector（整合 early detection 和 fallback detection）
  const detector = new SubagentDetector(existingAgentIds, {
    subagentsDir,
    output: new DisplayControllerOutputHandler(displayController),
    watcher: { addFile: (f) => multiWatcher.addFile(f) },
    session: new InteractiveSessionHandler(sessionManager, displayController),
    enabled: true, // Interactive 模式一定是 follow
  });

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
          detector.handleEarlyDetection();
        }

        // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
        if (label === '[MAIN]') {
          const raw = parsed.raw as { toolUseResult?: { agentId?: string } };
          const agentId = raw?.toolUseResult?.agentId;
          if (agentId) {
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
