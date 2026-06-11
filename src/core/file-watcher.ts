import { watch, type FSWatcher } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';

export interface WatchOptions {
  follow: boolean;
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  /** JSON 模式：不分割行，把整個檔案當作一個整體傳給 onLine */
  jsonMode?: boolean;
  /** Polling interval in milliseconds (default: 2000) */
  pollInterval?: number;
  /** Number of initial lines to show (default: all) */
  initialLines?: number;
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
  private pollInterval = 2000;
  private isFirstRead = true;
  // 競態條件防護：isProcessing 和 pending 標誌
  private isProcessing = false;
  private pendingRead = false;
  // JSONL 增量讀取狀態（jsonMode 不使用）
  private lastReadOffset = 0;
  private pendingBuffer = '';
  // 持久 fd 與可重用 buffer：避免每次 watcher 觸發都建新 Bun.file()/Blob slice，
  // 後者經實測會在 macOS 累積 IOAccelerator swap pages（即使每次讀取量很小）。
  private fileHandle: FileHandle | null = null;
  private readBuffer: Buffer = Buffer.alloc(64 * 1024);

  /**
   * 開始監控檔案
   */
  async start(filePath: string, options: WatchOptions): Promise<void> {
    this.jsonMode = options.jsonMode || false;
    this.filePath = filePath;
    this.options = options;
    this.pollInterval = options.pollInterval || 2000;
    this.isFirstRead = true;

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
   *
   * - jsonMode：整檔讀，比對 hash 後整體傳給 onLine（Gemini/Agy 語義）
   * - JSONL 模式：首次讀整檔（為了支援 initialLines），之後改用 byte
   *   offset 增量讀取，避免長時間 follow 大檔時每次都把整個檔案
   *   再讀進記憶體。
   */
  private async readAndProcess(
    filePath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    if (this.jsonMode) {
      const file = Bun.file(filePath);
      const content = await file.text();
      const contentHash = Bun.hash(content).toString();
      if (contentHash !== this.lastContentHash) {
        this.lastContentHash = contentHash;
        onLine(content);
      }
      return;
    }

    await this.readAndProcessJsonl(filePath, onLine);
  }

  /**
   * JSONL 模式讀取：首次走整檔（支援 initialLines），後續走增量。
   */
  private async readAndProcessJsonl(
    filePath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    if (this.isFirstRead) {
      await this.firstReadJsonl(filePath, onLine);
      return;
    }

    await this.incrementalReadJsonl(filePath, onLine);
  }

  /**
   * 首次讀取：保留原本「整檔 → 取最後 N 行」語義，
   * 讀完後把 byte offset 設為當前檔案大小，後續走增量。
   */
  private async firstReadJsonl(
    filePath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    const file = Bun.file(filePath);
    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    let linesToProcess: string[];
    if (this.options?.initialLines !== undefined) {
      const n = this.options.initialLines;
      if (n < 0) {
        linesToProcess = lines;
      } else if (n === 0) {
        linesToProcess = [];
      } else if (n >= lines.length) {
        linesToProcess = lines;
      } else {
        linesToProcess = lines.slice(-n);
      }
    } else {
      linesToProcess = lines;
    }

    for (const line of linesToProcess) {
      onLine(line);
    }

    this.processedLines = lines.length;
    this.isFirstRead = false;
    // 用實際讀到的 byte 長度當作 offset，下次只讀新增區塊
    this.lastReadOffset = Buffer.byteLength(content, 'utf8');
    this.pendingBuffer = '';
  }

  /**
   * 確保 fileHandle 已開啟。Lazy open，第一次增量讀時建立。
   * truncate / restartWatcher 時會關掉，下次呼叫會自動重開。
   */
  private async ensureFileHandle(filePath: string): Promise<FileHandle> {
    if (this.fileHandle !== null) return this.fileHandle;
    this.fileHandle = await open(filePath, 'r');
    return this.fileHandle;
  }

  /**
   * 關閉並清掉 fileHandle。錯誤吞掉（已經被外部關掉等情況不該擋住流程）。
   */
  private async closeFileHandle(): Promise<void> {
    if (this.fileHandle === null) return;
    const fh = this.fileHandle;
    this.fileHandle = null;
    try {
      await fh.close();
    } catch {
      // ignore
    }
  }

  /**
   * 增量讀取：只讀 [lastReadOffset, currentSize) 範圍。
   * 處理 truncate / atomic replace / partial line buffer。
   *
   * 使用持久 fd + 可重用 Buffer，避免每次都建新的 Bun.file()/Blob slice
   * （後者在 macOS 上會累積 IOAccelerator backing pages 無法回收）。
   */
  private async incrementalReadJsonl(
    filePath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    let handle = await this.ensureFileHandle(filePath);
    let stats = await handle.stat();
    let currentSize = stats.size;

    // Truncate / atomic replace：當前 size 比已讀 offset 還小，視同檔案被截斷。
    // 關掉舊 fd（可能指向舊 inode）並重開到新檔案。
    if (currentSize < this.lastReadOffset) {
      this.lastReadOffset = 0;
      this.pendingBuffer = '';
      this.processedLines = 0;
      await this.closeFileHandle();
      handle = await this.ensureFileHandle(filePath);
      stats = await handle.stat();
      currentSize = stats.size;
    }

    // 沒有新增 bytes，也沒有暫存的尾段 → 跳過
    if (currentSize === this.lastReadOffset && this.pendingBuffer === '') {
      return;
    }

    let newContent = '';
    if (currentSize > this.lastReadOffset) {
      const bytesToRead = currentSize - this.lastReadOffset;
      if (bytesToRead > this.readBuffer.length) {
        // 放大 buffer 為兩倍或必要大小，取大者；之後重複使用
        const nextLen = Math.max(bytesToRead, this.readBuffer.length * 2);
        this.readBuffer = Buffer.alloc(nextLen);
      }
      const { bytesRead } = await handle.read(
        this.readBuffer,
        0,
        bytesToRead,
        this.lastReadOffset
      );
      newContent = this.readBuffer.toString('utf8', 0, bytesRead);
      this.lastReadOffset += bytesRead;
    }

    const combined = this.pendingBuffer + newContent;
    const lastNewlineIdx = combined.lastIndexOf('\n');

    if (lastNewlineIdx === -1) {
      // 沒有完整行，全部暫存等下次
      this.pendingBuffer = combined;
      return;
    }

    const linesPortion = combined.slice(0, lastNewlineIdx);
    this.pendingBuffer = combined.slice(lastNewlineIdx + 1);

    const newLines = linesPortion.split('\n').filter(Boolean);
    for (const line of newLines) {
      onLine(line);
    }
    this.processedLines += newLines.length;
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
    // fire-and-forget：close 是非同步但不擋 stop()
    void this.closeFileHandle();
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
    this.lastReadOffset = 0;
    this.pendingBuffer = '';
    this.isFirstRead = false; // 重啟不算首次讀取
    // 舊 fileHandle 可能還指向被 rename 的 inode，必須關掉重開
    await this.closeFileHandle();

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
    }, this.pollInterval);
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
