import { FileWatcher, type WatchOptions } from './file-watcher.ts';

/**
 * 要監控的檔案資訊
 */
export interface WatchedFile {
  path: string;
  label: string; // "[MAIN]" 或 "[agentId]"
}

/**
 * 多檔案監控選項
 */
export interface MultiWatchOptions extends Omit<WatchOptions, 'onLine'> {
  onLine: (line: string, label: string) => void;
  onNewFile?: (file: WatchedFile) => void;
}

/**
 * 多檔案監控器 - 管理多個 FileWatcher 實例
 */
export class MultiFileWatcher {
  private watchers: Map<string, FileWatcher> = new Map();
  private options: MultiWatchOptions | null = null;

  /**
   * 開始監控多個檔案
   */
  async start(files: WatchedFile[], options: MultiWatchOptions): Promise<void> {
    this.options = options;

    // 為每個檔案建立獨立的 FileWatcher
    for (const file of files) {
      await this.addFile(file);
    }
  }

  /**
   * 新增監控檔案
   */
  async addFile(file: WatchedFile): Promise<void> {
    if (this.watchers.has(file.path)) return;
    if (!this.options) return;

    const watcher = new FileWatcher();
    this.watchers.set(file.path, watcher);

    const { onLine, onNewFile: _onNewFile, ...restOptions } = this.options;
    await watcher.start(file.path, {
      ...restOptions,
      onLine: (line) => onLine(line, file.label),
    });
  }

  /**
   * 檢查檔案是否已在監控中
   */
  hasFile(path: string): boolean {
    return this.watchers.has(path);
  }

  /**
   * 取得監控中的檔案數量
   */
  get fileCount(): number {
    return this.watchers.size;
  }

  /**
   * 停止所有監控
   */
  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }
}
