import { Glob } from 'bun';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { WatchedFile } from '../core/multi-file-watcher.ts';

// ============================================================
// Interfaces
// ============================================================

/**
 * 輸出處理器介面 - 抽象化不同模式的輸出方式
 */
export interface OutputHandler {
  /** 訊息輸出 */
  info(message: string): void;
  /** 警告輸出（如 early detection） */
  warn(message: string): void;
  /** 錯誤輸出 */
  error(message: string): void;
  /** 輕量級訊息（如 file not found after retries） */
  debug(message: string): void;
}

/**
 * Session 管理器介面 - 抽象化 Interactive 模式的特殊需求
 */
export interface SessionHandler {
  /** 新增 session（Interactive 模式需要） */
  addSession?(agentId: string, label: string, path: string): void;
  /** 標記 session 完成（Interactive 模式需要） */
  markSessionDone?(agentId: string): void;
  /** 更新 UI（Interactive 模式需要） */
  updateUI?(): void;
}

/**
 * Watcher 介面 - 抽象化 MultiFileWatcher 的 addFile 操作
 */
export interface WatcherHandler {
  addFile(file: WatchedFile): Promise<void>;
}

/**
 * 重試配置
 */
export interface RetryConfig {
  /** 最大重試次數 */
  maxRetries: number;
  /** 重試間隔（ms） */
  retryDelay: number;
  /** 初始延遲（ms） */
  initialDelay: number;
}

/**
 * SubagentDetector 配置
 */
export interface SubagentDetectorConfig {
  /** subagents 目錄路徑 */
  subagentsDir: string;
  /** 輸出處理器 */
  output: OutputHandler;
  /** Watcher 處理器 */
  watcher: WatcherHandler;
  /** Session 處理器（可選，Interactive 模式使用） */
  session?: SessionHandler;
  /** 是否啟用（對應 options.follow） */
  enabled: boolean;
  /** 是否啟用目錄監控（預設 true） */
  watchDir?: boolean;
}

// ============================================================
// Constants
// ============================================================

/** Early detection 預設配置 */
export const EARLY_DETECTION_RETRY: RetryConfig = {
  maxRetries: 10,
  retryDelay: 100,
  initialDelay: 50,
};

/** Fallback detection 預設配置 */
export const FALLBACK_DETECTION_RETRY: RetryConfig = {
  maxRetries: 5,
  retryDelay: 100,
  initialDelay: 100,
};

// ============================================================
// Utility Functions
// ============================================================

/**
 * 驗證 agentId 格式
 * 支援 7-40 位十六進制字符（涵蓋短 hash 到完整 SHA-1）
 * 同時防止路徑穿越攻擊
 */
export function isValidAgentId(agentId: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(agentId);
}

/**
 * 從主 session 檔案中提取所有 agentId
 */
export async function extractAgentIds(
  sessionPath: string
): Promise<Set<string>> {
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
export async function scanForNewSubagents(
  subagentsDir: string,
  knownAgentIds: Set<string>
): Promise<string[]> {
  const newAgentIds: string[] = [];

  try {
    const glob = new Glob('agent-*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir })) {
      // 從檔名 "agent-{id}.jsonl" 提取 id（支援 7-40 位 hex）
      const match = file.match(/^agent-([0-9a-f]{7,40})\.jsonl$/i);
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

// ============================================================
// Core Functions
// ============================================================

/**
 * 嘗試新增 subagent 檔案監控（含重試邏輯）
 *
 * @param subagentPath - subagent 檔案路徑
 * @param agentId - agent 識別碼
 * @param watcher - watcher 處理器
 * @param output - 輸出處理器
 * @param config - 重試配置
 * @returns Promise<boolean> 是否成功新增
 */
export async function tryAddSubagentFile(
  subagentPath: string,
  agentId: string,
  watcher: WatcherHandler,
  output: OutputHandler,
  config: RetryConfig = FALLBACK_DETECTION_RETRY
): Promise<boolean> {
  const doTry = async (retriesLeft: number): Promise<boolean> => {
    try {
      const file = Bun.file(subagentPath);
      if (await file.exists()) {
        await watcher.addFile({
          path: subagentPath,
          label: `[${agentId}]`,
        });
        return true;
      } else if (retriesLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelay));
        return doTry(retriesLeft - 1);
      } else {
        output.debug(`Subagent file not found after retries: ${agentId}`);
        return false;
      }
    } catch (error) {
      output.error(`Failed to add subagent watcher: ${agentId} - ${error}`);
      return false;
    }
  };

  // 初始延遲後開始嘗試
  await new Promise((resolve) => setTimeout(resolve, config.initialDelay));
  return doTry(config.maxRetries);
}

// ============================================================
// SubagentDetector Class
// ============================================================

/**
 * Subagent 偵測器 - 整合 early detection 和 fallback detection
 */
export class SubagentDetector {
  private knownAgentIds: Set<string>;
  private config: SubagentDetectorConfig;
  private dirWatcher: FSWatcher | null = null;
  private parentWatcher: FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private isWatching = false;

  constructor(initialAgentIds: Set<string>, config: SubagentDetectorConfig) {
    this.knownAgentIds = new Set(initialAgentIds);
    this.config = config;
  }

  /**
   * 啟動 subagents 目錄監控（自動偵測新檔案）
   */
  startDirectoryWatch(): void {
    if (!this.config.enabled) return;
    if (this.isWatching) return;
    if (this.config.watchDir === false) return;

    this.isWatching = true;
    this.tryWatchSubagentsDir();
  }

  /**
   * 停止所有監控
   */
  stop(): void {
    this.isWatching = false;
    this.clearScanTimer();
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
  }

  /**
   * 處理 early subagent detection（Task tool_use 觸發）
   * 使用非同步 setTimeout 來避免阻塞主流程
   */
  handleEarlyDetection(): void {
    if (!this.config.enabled) return;

    // 延遲掃描（讓檔案有機會建立）
    setTimeout(async () => {
      try {
        const newAgentIds = await scanForNewSubagents(
          this.config.subagentsDir,
          this.knownAgentIds
        );

        for (const agentId of newAgentIds) {
          this.registerNewAgent(
            agentId,
            EARLY_DETECTION_RETRY,
            `Early subagent detected: ${agentId}`
          );
        }
      } catch (error) {
        this.config.output.error(`Early detection scan failed: ${error}`);
      }
    }, EARLY_DETECTION_RETRY.initialDelay);
  }

  /**
   * 處理 fallback detection（toolUseResult 觸發）
   * @param agentId - 從 toolUseResult 提取的 agentId
   */
  handleFallbackDetection(agentId: string): void {
    // 驗證 agentId 格式
    if (!isValidAgentId(agentId)) {
      this.config.output.debug(`Ignoring invalid agentId format: ${agentId}`);
      return;
    }

    this.registerNewAgent(
      agentId,
      FALLBACK_DETECTION_RETRY,
      `New subagent detected: ${agentId}`
    );

    // toolUseResult 表示 subagent 已完成
    if (this.config.session?.markSessionDone) {
      this.config.session.markSessionDone(agentId);
      this.config.output.debug(`Subagent completed: ${agentId}`);
    }
    this.config.session?.updateUI?.();
  }

  /**
   * 取得已知的 agentId 集合（供測試使用）
   */
  getKnownAgentIds(): Set<string> {
    return new Set(this.knownAgentIds);
  }

  /**
   * 檢查是否為已知的 agentId
   */
  isKnownAgent(agentId: string): boolean {
    return this.knownAgentIds.has(agentId);
  }

  private clearScanTimer(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private scheduleScan(): void {
    if (!this.isWatching) return;
    this.clearScanTimer();
    this.scanTimer = setTimeout(async () => {
      if (!this.isWatching) return;
      try {
        const newAgentIds = await scanForNewSubagents(
          this.config.subagentsDir,
          this.knownAgentIds
        );
        for (const agentId of newAgentIds) {
          this.registerNewAgent(
            agentId,
            EARLY_DETECTION_RETRY,
            `New subagent detected: ${agentId}`
          );
        }
      } catch (error) {
        this.config.output.error(`Directory scan failed: ${error}`);
      }
    }, 100);
  }

  private tryWatchSubagentsDir(): void {
    if (!this.isWatching) return;

    try {
      this.parentWatcher?.close();
      this.parentWatcher = null;

      this.dirWatcher = watch(this.config.subagentsDir, () => {
        this.scheduleScan();
      });
      this.dirWatcher.on('error', () => {
        this.dirWatcher?.close();
        this.dirWatcher = null;
      });
      // 目錄建立後先掃描一次，避免錯過已存在的新檔案
      this.scheduleScan();
    } catch {
      // subagents 目錄可能尚未建立，改監控父層目錄
      this.watchParentForSubagentsDir();
    }
  }

  private watchParentForSubagentsDir(): void {
    if (!this.isWatching) return;
    if (this.parentWatcher) return;

    const parentDir = join(this.config.subagentsDir, '..');
    try {
      this.parentWatcher = watch(parentDir, () => {
        // 嘗試切回 subagents 目錄監控
        this.tryWatchSubagentsDir();
      });
      this.parentWatcher.on('error', () => {
        this.parentWatcher?.close();
        this.parentWatcher = null;
      });
    } catch {
      // ignore
    }
  }

  private registerNewAgent(
    agentId: string,
    retryConfig: RetryConfig,
    message: string
  ): void {
    if (this.knownAgentIds.has(agentId)) return;
    this.knownAgentIds.add(agentId);

    const subagentPath = join(
      this.config.subagentsDir,
      `agent-${agentId}.jsonl`
    );

    // Session 處理（Interactive 模式）
    this.config.session?.addSession?.(agentId, `[${agentId}]`, subagentPath);

    if (this.config.enabled) {
      this.config.output.warn(message);

      // 非阻塞式新增檔案監控
      setTimeout(() => {
        tryAddSubagentFile(
          subagentPath,
          agentId,
          this.config.watcher,
          this.config.output,
          retryConfig
        );
      }, retryConfig.initialDelay);
    }
  }
}
