// Phase 1 stub — no-op so tests RED on assertions.
import type { WorkflowSnapshot } from './types.ts';

export interface SnapshotWatcherConfig {
  path: string;
  onChange: (snapshot: WorkflowSnapshot) => void;
  onError?: (err: Error) => void;
  debounceMs?: number;
}

export class SnapshotWatcher {
  constructor(_config: SnapshotWatcherConfig) {
    // stub
  }

  async start(): Promise<void> {
    // stub — does not read or watch
  }

  stop(): void {
    // stub
  }
}
