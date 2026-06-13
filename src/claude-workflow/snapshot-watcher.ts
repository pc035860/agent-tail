import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { WorkflowSnapshot } from './types.ts';

// SPEC §8.2 — whole-file overwrite watcher for wf_*.json snapshots.
// Not a LineParser. Does not reuse FileWatcher because snapshot is replace,
// not append. fs.watch + debounce + raw-text dedup.

export const DEFAULT_DEBOUNCE_MS = 50;
// fs.watch 在 macOS 上對快速接續寫檔偶發 miss event（整批 test 累積 FSEvents
// 訂閱後尤其明顯）。用 polling backup 主動 reload 蓋住漏網事件 — 200ms 對
// snapshot（檔案小、低頻寫入）成本可忽略；lastJson dedup 保證不重發 onChange。
export const DEFAULT_POLL_BACKUP_MS = 200;

export interface SnapshotWatcherConfig {
  path: string;
  onChange: (snapshot: WorkflowSnapshot) => void;
  onError?: (err: Error) => void;
  debounceMs?: number;
  /** Polling backup 間隔；設 0 關閉。預設 1000ms。 */
  pollBackupMs?: number;
}

export class SnapshotWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastJson: string | null = null;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly pollBackupMs: number;

  constructor(private readonly config: SnapshotWatcherConfig) {
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollBackupMs = config.pollBackupMs ?? DEFAULT_POLL_BACKUP_MS;
  }

  async start(): Promise<void> {
    await this.reload();

    if (this.stopped) return;

    try {
      this.watcher = watch(this.config.path, () => {
        if (this.stopped) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.stopped) return;
          void this.reload();
        }, this.debounceMs);
      });
      this.watcher.on('error', (err) => {
        this.reportError(err);
      });
    } catch (err) {
      // fs.watch can throw synchronously on macOS for missing paths even
      // after readFile failed — swallow and report (caller decides).
      this.reportError(err as Error);
    }

    // Polling backup — fs.watch event miss 時靠 reload 主動補上（lastJson
    // dedup 保證不重複發 onChange）。設 0 關閉。
    if (this.pollBackupMs > 0 && !this.stopped) {
      this.pollTimer = setInterval(() => {
        if (this.stopped) return;
        void this.reload();
      }, this.pollBackupMs);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  // SPEC §8.2 — dedup by raw text. Update lastJson ONLY after successful
  // parse so an invalid write doesn't poison the cache (see plan D6).
  private async reload(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.config.path, 'utf8');
    } catch (err) {
      this.reportError(err as Error);
      return;
    }

    if (text === this.lastJson) return;

    let snapshot: WorkflowSnapshot;
    try {
      snapshot = JSON.parse(text) as WorkflowSnapshot;
    } catch (err) {
      this.reportError(err as Error);
      return;
    }

    this.lastJson = text;
    try {
      this.config.onChange(snapshot);
    } catch (err) {
      // onChange throwing must not crash the watcher (T20 corollary).
      this.reportError(err as Error);
    }
  }

  private reportError(err: Error): void {
    this.config.onError?.(err);
  }
}
