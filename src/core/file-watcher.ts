import { watch, type FSWatcher } from 'node:fs';

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

  /**
   * 開始監控檔案
   */
  async start(filePath: string, options: WatchOptions): Promise<void> {
    this.jsonMode = options.jsonMode || false;

    // 初始讀取現有內容
    await this.readAndProcess(filePath, options.onLine);

    // 如果需要持續監控
    if (options.follow) {
      this.isWatching = true;

      this.watcher = watch(filePath, async (eventType) => {
        if (eventType === 'change' && this.isWatching) {
          try {
            await this.readAndProcess(filePath, options.onLine);
          } catch (error) {
            options.onError?.(error as Error);
          }
        }
      });

      // 處理 watcher 錯誤
      this.watcher.on('error', (error) => {
        options.onError?.(error);
      });
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

      // 只處理新增的行
      const newLines = lines.slice(this.processedLines);
      for (const line of newLines) {
        onLine(line);
      }

      this.processedLines = lines.length;
    }
  }

  /**
   * 停止監控
   */
  stop(): void {
    this.isWatching = false;
    this.watcher?.close();
    this.watcher = null;
  }
}
