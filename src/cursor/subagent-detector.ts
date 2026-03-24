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
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
  }

  /**
   * 取得已知的 agentId 集合
   */
  getKnownAgentIds(): Set<string> {
    return new Set(this.knownAgentIds);
  }

  // ============================================================
  // Private Methods
  // ============================================================

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
      });
      // 目錄建立後先掃描一次
      this.scheduleScan();
    } catch {
      // subagents 目錄可能尚未建立，改監控父層目錄
      this.watchParentForSubagentsDir();
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
      });
    } catch {
      // ignore
    }
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
