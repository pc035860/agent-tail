import { watch, type FSWatcher } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

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
  /**
   * 初始 dump 完成時觸發（v2 設計約束）。
   * 取代「start() await 初始讀取」的隱含契約 — replay filter（如 pi 的
   * 樹狀 active-path 過濾）訂閱這個明確事件，不依賴呼叫順序慣例。
   * 在初始讀取（含 pending drain）完成後、開始 watcher/polling 前觸發。
   */
  onInitialDumpComplete?: () => void;
}

export interface FileWatcherOptions {
  /**
   * 測試用：注入 stat 實作，讓 race 測試直接控制「read 與 baseline 更新
   * 之間」的檔案狀態，不需要依賴同步 onLine 回呼副作用與平台 fs.watch
   * 行為（v2 §4.6）。
   */
  injectedStat?: (path: string) => Promise<Stats>;
}

/**
 * 檔案監控器 - 實作 tail -f 效果
 *
 * ⚠️ baseline 語義（v2 設計約束，修改前必讀）：
 *
 *   baseline 永遠描述「已處理內容」，永不描述「stat 瞬間值」。
 *   - size baseline：JSONL → `lastReadOffset`（含 0 — 空檔案也要對齊，
 *     否則第一行寫入會被 read 後的 stat 吞進 baseline，poll 永遠不觸發）；
 *     jsonMode → `lastContentLength`（已讀內容的 byte 長度）
 *   - mtime baseline：讀取開始前的值（baseline 先行）— read 期間的同長度
 *     rewrite 會讓真實 mtime 偏離 baseline，poll 能觸發重讀
 *   - baseline 的唯一寫入點是 `alignSizeBaseline()`（讀取完成後的對齊），
 *     read 與 baseline 更新之間不存在「吞資料」的中間態
 *
 *   禁止寫出「read 完成後再 stat 一次」的順序 — 那會把空窗期的
 *   append/rewrite 吞進 baseline，poll 誤判「沒有變化」而永久跳過。
 *
 *   pending drain：`while` 迴圈在同一個 `isProcessing` 區間內消化，禁止
 *   遞迴（遞迴會被自己的 guard 擋回，pending 永遠不重跑，read 期間 append
 *   的尾行會遺失）。
 *
 *   `start()` 的錯誤語義：初始讀取錯誤往上拋（`WorkflowAttachment.
 *   attachAgent` 的 rollback 依賴），poll/watch 的錯誤走 `onError` — 兩條
 *   路徑共用 `readAndUpdateBaseline()` 但錯誤處理分離。
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private processedLines = 0;
  private isWatching = false;
  private jsonMode = false;
  private lastContentHash = '';
  /** jsonMode：已讀內容的 byte 長度（size baseline 對齊用） */
  private lastContentLength = 0;
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

  constructor(private readonly watcherOptions: FileWatcherOptions = {}) {}

  /**
   * 測試專用：暴露內部 baseline 狀態（v2 §7 邊界矩陣斷言用）。
   * 生產路徑不應依賴此方法 — 它只為「poll 推進前」的確定性斷言存在。
   */
  getDebugState(): {
    lastSize: number;
    lastReadOffset: number;
    lastContentLength: number;
    lastMtimeMs: number;
    lastContentHash: string;
  } {
    return {
      lastSize: this.lastSize,
      lastReadOffset: this.lastReadOffset,
      lastContentLength: this.lastContentLength,
      lastMtimeMs: this.lastMtimeMs,
      lastContentHash: this.lastContentHash,
    };
  }

  /**
   * 開始監控檔案
   */
  async start(filePath: string, options: WatchOptions): Promise<void> {
    this.jsonMode = options.jsonMode || false;
    this.filePath = filePath;
    this.options = options;
    this.pollInterval = options.pollInterval || 2000;
    this.isFirstRead = true;

    // 初始讀取與後續事件共用同一套 isProcessing guard + pending 消化
    // （避免 onLine 回呼期間到達的 fs.watch 事件與初始讀取交錯），
    // 但錯誤直接往上拋 — caller（如 WorkflowAttachment.attachAgent）
    // 依賴「初始讀取失敗 → throw」觸發 rollback，不能走 onError 吞掉。
    this.isProcessing = true;
    this.pendingRead = false;
    try {
      await this.readAndUpdateBaseline();
      while (this.pendingRead) {
        this.pendingRead = false;
        await this.readAndUpdateBaseline();
      }
    } finally {
      this.isProcessing = false;
    }

    // 初始 dump 完成事件（replay filter 的明確掛載點）
    options.onInitialDumpComplete?.();

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
      await this.readAndUpdateBaseline();

      // 處理完成後，如果有 pending 請求，在同一個 isProcessing 區間內消化。
      // 不能遞迴呼叫 scheduleRead()：此時 isProcessing 仍為 true，遞迴會被
      // 開頭 guard 立即擋回（只再把 pendingRead 設回 true），pending 永遠
      // 不會被實際重跑，導致 read 期間 append 的尾行遺失。
      while (this.pendingRead) {
        this.pendingRead = false;
        await this.readAndUpdateBaseline();
      }
    } catch (error) {
      this.options.onError?.(error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 一輪讀取 + baseline 更新（v2 設計約束的唯一寫入點）。
   * size baseline 在讀取後對齊「已處理內容」（alignSizeBaseline），
   * 而非 stat 瞬間值 — 兩者之間的 append / rewrite 不能被 baseline 吞掉。
   * 注意：updateMtime 在 read 之前跑（baseline 先行），mtime baseline
   * 因此是「讀取開始前」的值 — read 期間的同長度 rewrite 會讓真實 mtime
   * 偏離 baseline，poll 能正確觸發重讀。
   */
  private async readAndUpdateBaseline(): Promise<void> {
    await this.updateMtime(this.filePath!);
    await this.readAndProcess(this.filePath!, this.options!.onLine);
    this.alignSizeBaseline();
  }

  /**
   * 將 size baseline 對齊「已處理內容」：
   * - JSONL：lastReadOffset（含 0 — 空檔案也要對齊，否則第一行寫入會被
   *   read 後的 stat 吞進 baseline，poll 永遠不觸發）
   * - jsonMode：已讀內容的 byte 長度（rewrite 變長/變短都能被 poll 偵測）
   * updateMtime 在 read 之前跑（baseline 先行），若 read 期間/之後有寫入，
   * 真實 size 會偏離已處理內容 — baseline 若含這段資料，poll 的比對會
   * 誤判「沒有新資料」而永遠跳過。對齊後差異會正確觸發增量讀取。
   */
  private alignSizeBaseline(): void {
    this.lastSize = this.jsonMode
      ? this.lastContentLength
      : this.lastReadOffset;
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
      this.lastContentLength = Buffer.byteLength(content, 'utf8');
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
    this.lastContentLength = 0;
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
        const stats = await this.statFor(this.filePath);
        // fingerprint 比對：size baseline 是「已處理內容」長度
        // （JSONL: lastReadOffset；jsonMode: lastContentLength），不是
        // stat 瞬間值 — 空窗期的 append/rewrite 不會被吞進 baseline。
        // mtime 是 fs.watch 的輔助信號（jsonMode 的 same-size rewrite
        // 由 readAndProcess 的 hash 比對命中，這裡只需觸發重讀）。
        const baselineSize = this.jsonMode
          ? this.lastContentLength
          : this.lastReadOffset;
        if (stats.size !== baselineSize || stats.mtimeMs !== this.lastMtimeMs) {
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
      const stats = await this.statFor(filePath);
      this.lastMtimeMs = stats.mtimeMs;
      this.lastSize = stats.size;
    } catch {
      // ignore
    }
  }

  private statFor(path: string): Promise<Stats> {
    return this.watcherOptions.injectedStat
      ? this.watcherOptions.injectedStat(path)
      : stat(path);
  }
}
