import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface WatchOptions {
  follow: boolean;
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  /** JSON 模式：不分割行，把整個檔案當作一個整體傳給 onLine */
  jsonMode?: boolean;
}

/**
 * 檔案監控器 - 實作 tail -f 效果
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private processedLines = 0;
  private isWatching = false;
  private jsonMode = false;
  private lastContentHash = '';
  private lastMtimeMs = 0;
  private lastSize = 0;
  private filePath: string | null = null;
  private options: WatchOptions | null = null;
  private isRestarting = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  // 競態條件防護：isProcessing 和 pending 標誌
  private isProcessing = false;
  private pendingRead = false;

  /**
   * 開始監控檔案
   */
  async start(filePath: string, options: WatchOptions): Promise<void> {
    this.jsonMode = options.jsonMode || false;
    this.filePath = filePath;
    this.options = options;

    // 初始讀取現有內容（直接呼叫，不需排程）
    await this.readAndProcess(filePath, options.onLine);
    await this.updateMtime(filePath);

    // 如果需要持續監控
    if (options.follow) {
      this.isWatching = true;
      this.startWatcher();
      this.startPolling();
    }
  }

  /**
   * 排程讀取操作（防止競態條件）
   * 如果正在處理，設為 pending 並返回
   * 處理完成後如果 pending 為 true，再執行一次
   */
  private async scheduleRead(): Promise<void> {
    if (!this.filePath || !this.options) return;

    if (this.isProcessing) {
      this.pendingRead = true;
      return;
    }

    this.isProcessing = true;
    this.pendingRead = false;

    try {
      await this.readAndProcess(this.filePath, this.options.onLine);
      await this.updateMtime(this.filePath);

      // 處理完成後，如果有 pending 請求，再執行一次
      if (this.pendingRead) {
        this.pendingRead = false;
        await this.scheduleRead();
      }
    } catch (error) {
      this.options.onError?.(error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 讀取並處理檔案內容
   */
  private async readAndProcess(
    filePath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    const file = Bun.file(filePath);
    const content = await file.text();

    if (this.jsonMode) {
      // JSON 模式：把整個檔案當作一個整體
      // 使用簡單的 hash 來檢測內容是否有變化
      const contentHash = Bun.hash(content).toString();
      if (contentHash !== this.lastContentHash) {
        this.lastContentHash = contentHash;
        onLine(content);
      }
    } else {
      // JSONL 模式：按行分割
      const lines = content.split('\n').filter(Boolean);

      // 檔案被截斷或重寫時，重置已處理行數
      if (lines.length < this.processedLines) {
        this.processedLines = 0;
      } else if (lines.length <= this.processedLines) {
        const contentHash = Bun.hash(content).toString();
        if (this.lastContentHash && this.lastContentHash !== contentHash) {
          this.processedLines = 0;
        }
        this.lastContentHash = contentHash;
      }

      // 只處理新增的行
      const newLines = lines.slice(this.processedLines);
      for (const line of newLines) {
        onLine(line);
      }

      this.processedLines = lines.length;
      if (lines.length > 0) {
        this.lastContentHash = Bun.hash(content).toString();
      }
    }
  }

  /**
   * 停止監控
   */
  stop(): void {
    this.isWatching = false;
    this.watcher?.close();
    this.watcher = null;
    this.isRestarting = false;
    this.stopPolling();
  }

  private startWatcher(): void {
    if (!this.filePath || !this.options) return;

    this.watcher = watch(this.filePath, async (eventType) => {
      if (!this.isWatching || !this.options || !this.filePath) return;

      if (eventType === 'rename') {
        await this.restartWatcher();
        return;
      }

      if (eventType === 'change') {
        // 使用 scheduleRead 避免與 polling 競態
        await this.scheduleRead();
      }
    });

    this.watcher.on('error', (error) => {
      this.options?.onError?.(error);
    });
  }

  private async restartWatcher(): Promise<void> {
    if (this.isRestarting || !this.options || !this.filePath) return;
    this.isRestarting = true;

    this.watcher?.close();
    this.watcher = null;

    // 檔案可能被原子替換，需重置狀態避免漏讀
    this.processedLines = 0;
    this.lastContentHash = '';

    // 使用 scheduleRead 避免與 polling 競態
    await this.scheduleRead();

    if (this.isWatching) {
      this.startWatcher();
    }

    this.isRestarting = false;
  }

  private startPolling(): void {
    if (this.isPolling || !this.filePath || !this.options) return;
    this.isPolling = true;

    this.pollTimer = setInterval(async () => {
      if (!this.isWatching || !this.filePath || !this.options) return;
      try {
        const stats = await stat(this.filePath);
        // 檢查 mtime 或 size 是否有變化
        if (
          stats.mtimeMs !== this.lastMtimeMs ||
          stats.size !== this.lastSize
        ) {
          // 使用 scheduleRead 避免與 fs.watch 競態
          await this.scheduleRead();
        }
      } catch {
        // ignore
      }
    }, 500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async updateMtime(filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath);
      this.lastMtimeMs = stats.mtimeMs;
      this.lastSize = stats.size;
    } catch {
      // ignore
    }
  }
}
