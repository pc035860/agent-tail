import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type {
  OutputHandler,
  SessionHandler,
  WatcherHandler,
  RetryConfig,
} from '../core/detector-interfaces.ts';
import {
  scanCursorSubagents,
  buildCursorSubagentPath,
  makeCursorAgentLabel,
} from './watch-builder.ts';

// ============================================================
// Constants
// ============================================================

/** Subagent 檔案重試配置 */
const SUBAGENT_FILE_RETRY: RetryConfig = {
  maxRetries: 10,
  retryDelay: 100,
  initialDelay: 50,
};

/**
 * Polling backup 間隔 — Cursor 是純 directory-watch 模式（無 JSONL event
 * 補強），fs.watch event miss 影響更大。定期掃描補漏；scheduleScan() +
 * knownAgentIds dedup，安全重入。
 */
const SUBAGENTS_DIR_POLL_BACKUP_MS = 500;

/**
 * subagents/ 與其父目錄都不存在時的指數退避 retry，1s, 2s, 4s, 8s, 16s, 30s, 30s...
 * Cursor 不像 Claude 有 JSONL event fallback，必須持續輪詢直到 dir 出現，
 * 否則漏掉 parent fs.watch event 會永久 stuck。
 */
const SUBAGENTS_DIR_RETRY_DELAY_MS = 1000;
const SUBAGENTS_DIR_RETRY_MAX_DELAY_MS = 30000;

// ============================================================
// CursorSubagentDetector
// ============================================================

/**
 * Cursor Subagent 偵測器
 *
 * 純目錄監控模式（Cursor JSONL 無 subagent spawn/resume 事件）。
 * 透過 fs.watch 監控 subagents/ 目錄變化，偵測新檔案建立。
 *
 * 簡化自 Claude SubagentDetector：
 * - 無 handleEarlyDetection（無 spawn 事件）
 * - 無 handleAgentProgress（無 resume 事件）
 * - 無 handleFallbackDetection（無 toolUseResult）
 * - 無 pendingDescriptions 佇列（無 description 來源）
 */
export class CursorSubagentDetector {
  private knownAgentIds: Set<string>;
  private dirWatcher: FSWatcher | null = null;
  private parentWatcher: FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private isWatching = false;
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private dirPollTimer: ReturnType<typeof setInterval> | null = null;
  private dirRetryAttempts = 0;
  // 單一 pending retry timer：多次 schedule 互相疊加會讓 dirRetryAttempts 飛漲
  private pendingDirRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private subagentsDir: string,
    private config: {
      output: OutputHandler;
      watcher: WatcherHandler;
      session?: SessionHandler;
      enabled: boolean;
      onNewSubagent?: (agentId: string, subagentPath: string) => void;
    }
  ) {
    this.knownAgentIds = new Set();
  }

  /**
   * 註冊已知的 subagent（啟動時預填既有 subagent）
   */
  registerExistingAgent(agentId: string, path: string): void {
    this.knownAgentIds.add(agentId);
    // Session 處理（Interactive 模式）
    this.config.session?.addSession?.(
      agentId,
      makeCursorAgentLabel(agentId),
      path
    );
  }

  /**
   * 啟動 subagents 目錄監控
   */
  startDirectoryWatch(): void {
    if (!this.config.enabled) return;
    if (this.isWatching) return;

    this.isWatching = true;
    this.tryWatchSubagentsDir();
  }

  /**
   * 啟動 polling backup（僅在 subagents/ 成功 attach 後呼叫）。
   * 避免在 dir 不存在時做無止境的 500ms 輪詢。
   */
  private _startDirPollBackup(): void {
    if (!this.isWatching) return;
    if (this.dirPollTimer) return;
    this.dirPollTimer = setInterval(() => {
      if (!this.isWatching) return;
      this.scheduleScan();
    }, SUBAGENTS_DIR_POLL_BACKUP_MS);
  }

  private _clearDirPollBackup(): void {
    if (this.dirPollTimer) {
      clearInterval(this.dirPollTimer);
      this.dirPollTimer = null;
    }
  }

  /**
   * 停止所有監控
   */
  stop(): void {
    this.stopped = true;
    this.isWatching = false;
    this.clearScanTimer();
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this._clearDirPollBackup();
    this.dirRetryAttempts = 0;
    this.pendingDirRetryTimer = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
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
      if (!this.isWatching || this.stopped) return;
      try {
        const newAgentIds = await scanCursorSubagents(
          this.subagentsDir,
          this.knownAgentIds
        );
        for (const agentId of newAgentIds) {
          if (this.stopped) return;
          this.registerNewAgent(agentId);
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

      this.dirWatcher = watch(this.subagentsDir, () => {
        this.scheduleScan();
      });
      this.dirWatcher.on('error', () => {
        this.dirWatcher?.close();
        this.dirWatcher = null;
        // dir 掉了 → 停 polling、退到 retry 退避；dir 回來再 attach
        this._clearDirPollBackup();
        this._scheduleSubagentsDirRetry();
      });
      // 成功 attach → 重置 retry 計數 + 啟動 polling backup
      this.dirRetryAttempts = 0;
      this._startDirPollBackup();
      // 目錄建立後先掃描一次
      this.scheduleScan();
    } catch {
      // subagents 目錄可能尚未建立，改監控父層目錄 + 排程退避 retry
      // （fs.watch 漏 parent event 也有 retry 兜底）
      this.watchParentForSubagentsDir();
      this._scheduleSubagentsDirRetry();
    }
  }

  private watchParentForSubagentsDir(): void {
    if (!this.isWatching) return;
    if (this.parentWatcher) return;

    const parentDir = join(this.subagentsDir, '..');
    try {
      this.parentWatcher = watch(parentDir, () => {
        this.tryWatchSubagentsDir();
      });
      this.parentWatcher.on('error', () => {
        this.parentWatcher?.close();
        this.parentWatcher = null;
        // parent watcher 掉了 → 排 retry，否則永久 stuck
        this._scheduleSubagentsDirRetry();
      });
    } catch {
      // 父層也不存在 → 排 retry
      this._scheduleSubagentsDirRetry();
    }
  }

  /**
   * subagents/ 與其父目錄都不存在時排程 retry（指數退避，上限 30s）。
   * Cursor 沒有 JSONL spawn event 補強，必須持續 retry 直到目錄出現，
   * 否則漏 fs.watch event 後永遠不會 attach。
   */
  private _scheduleSubagentsDirRetry(): void {
    if (!this.isWatching) return;
    // 已有 pending retry 就跳過，避免疊加讓 dirRetryAttempts 飛漲
    if (this.pendingDirRetryTimer) return;
    const delay = Math.min(
      SUBAGENTS_DIR_RETRY_DELAY_MS * 2 ** this.dirRetryAttempts,
      SUBAGENTS_DIR_RETRY_MAX_DELAY_MS
    );
    this.dirRetryAttempts++;
    const timer = setTimeout(() => {
      this.pendingDirRetryTimer = null;
      this.pendingTimers.delete(timer);
      if (!this.isWatching) return;
      if (this.dirWatcher) return;
      // 注意：parent watcher 可能漏 event，這裡仍要 retry
      // （tryWatchSubagentsDir 自身有 catch 處理 dir 不存在的情況）
      this.tryWatchSubagentsDir();
    }, delay);
    this.pendingDirRetryTimer = timer;
    this.pendingTimers.add(timer);
  }

  private registerNewAgent(agentId: string): void {
    if (this.knownAgentIds.has(agentId)) return;
    if (this.stopped) return;

    this.knownAgentIds.add(agentId);

    const subagentPath = buildCursorSubagentPath(this.subagentsDir, agentId);

    // Session 處理（Interactive 模式）
    this.config.session?.addSession?.(
      agentId,
      makeCursorAgentLabel(agentId),
      subagentPath
    );

    if (this.config.enabled) {
      this.config.output.warn(`New subagent detected: ${agentId}`);

      // 觸發 onNewSubagent 回呼
      this.config.onNewSubagent?.(agentId, subagentPath);

      // 非阻塞式新增檔案監控
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (!this.isWatching || this.stopped) return;

        this.tryAddSubagentFile(subagentPath, agentId);
      }, SUBAGENT_FILE_RETRY.initialDelay);
      this.pendingTimers.add(timer);
    }
  }

  private async tryAddSubagentFile(
    subagentPath: string,
    agentId: string
  ): Promise<void> {
    const config = SUBAGENT_FILE_RETRY;
    let retriesLeft = config.maxRetries;

    while (retriesLeft > 0) {
      if (this.stopped) return;

      try {
        const file = Bun.file(subagentPath);
        if (await file.exists()) {
          await this.config.watcher.addFile({
            path: subagentPath,
            label: makeCursorAgentLabel(agentId),
          });
          return;
        }
      } catch (error) {
        // watcher.addFile 失敗也需要回滾，讓下次掃描重試
        this.knownAgentIds.delete(agentId);
        this.config.output.error(
          `Failed to add subagent watcher: ${agentId} - ${error}`
        );
        return;
      }

      retriesLeft--;
      if (retriesLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelay));
      }
    }

    // 回滾 knownAgentIds，讓下次掃描能重新偵測
    // Cursor 沒有 JSONL 事件提供第二次機會（不像 Claude 的 fallback detection）
    this.knownAgentIds.delete(agentId);
    this.config.output.debug(
      `Subagent file not found after retries, will retry on next scan: ${agentId}`
    );
  }
}
