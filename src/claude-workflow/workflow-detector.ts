import { watch, type FSWatcher } from 'node:fs';
import { Glob } from 'bun';
import type { OutputHandler } from '../core/detector-interfaces.ts';
import type { ParsedLine } from '../core/types.ts';
import {
  getWorkflowsDir,
  getWorkflowSubagentsDir,
  getWorkflowSnapshotPath,
  parseWorkflowSnapshotFilename,
} from './paths.ts';
import { join } from 'node:path';
import type { DetectedWorkflow } from './types.ts';

// SPEC §9.1 path B — directory watch on `{session}/workflows/` for
// `wf_*.json` snapshot file creation. Path A (main JSONL Workflow tool_use)
// lands in P5.

const RETRY_DELAY_MS = 100;
// fs.watch 在 macOS 上對 dir 內新檔事件偶發 miss。Polling backup 主動掃描補
// 漏 — knownRunIds 在 markRunIdKnown 內做 dedup，安全重入。
const DIR_POLL_BACKUP_MS = 500;

export interface WorkflowDetectorConfig {
  sessionUuid: string;
  /** Absolute path to {sessionDir} = ~/.claude/projects/{enc-cwd}/{UUID} */
  sessionDir: string;
  onNewWorkflow: (workflow: DetectedWorkflow) => Promise<void> | void;
  outputHandler: OutputHandler;
}

export class WorkflowDetector {
  private dirWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private workflowsDir: string | null = null;
  private readonly knownRunIds = new Set<string>();
  private stopped = false;

  constructor(private readonly config: WorkflowDetectorConfig) {}

  async start(): Promise<void> {
    const workflowsDir = getWorkflowsDir(this.config.sessionDir);
    this.workflowsDir = workflowsDir;
    try {
      this.dirWatcher = watch(workflowsDir, (_eventType, filename) => {
        if (this.stopped || !filename) return;
        const runId = parseWorkflowSnapshotFilename(filename);
        if (!runId) return;
        if (!this.markRunIdKnown(runId)) return;
        void this._handleNewRunId(runId, /* retries */ 10);
      });
      this.dirWatcher.on('error', (err) =>
        this.config.outputHandler.debug(
          `[workflow-detector] dir watch error: ${err}`
        )
      );
    } catch (err) {
      this.config.outputHandler.debug(
        `[workflow-detector] watch ${workflowsDir} failed: ${err}`
      );
    }

    // Polling backup — fs.watch event miss 時主動掃描補漏。
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      void this._pollDirectory();
    }, DIR_POLL_BACKUP_MS);
  }

  private async _pollDirectory(): Promise<void> {
    if (!this.workflowsDir) return;
    try {
      const glob = new Glob('wf_*.json');
      for await (const file of glob.scan({ cwd: this.workflowsDir })) {
        if (this.stopped) return;
        if (file.includes('/')) continue;
        const runId = parseWorkflowSnapshotFilename(file);
        if (!runId) continue;
        if (!this.markRunIdKnown(runId)) continue;
        void this._handleNewRunId(runId, /* retries */ 10);
      }
    } catch {
      /* dir 可能尚未建立或剛被刪除，下一輪重試 */
    }
  }

  /** SPEC §9.1.1 — synchronous mark + insert (race-safe). */
  markRunIdKnown(runId: string): boolean {
    if (this.knownRunIds.has(runId)) return false;
    this.knownRunIds.add(runId);
    return true;
  }

  /**
   * Pre-register a runId as known. Used by **P5 path-A dispatcher**
   * (main-JSONL handleMainLine) when it has already attached a workflow,
   * so directory-watch fallback doesn't emit a duplicate onNewWorkflow.
   * P3 does not call this — included now so the API contract is tested
   * before P5 wires it.
   */
  prefillKnown(runId: string): void {
    this.knownRunIds.add(runId);
  }

  /**
   * SPEC §9.1 path A — main-JSONL Workflow tool_result detection.
   * Called by createOnLineHandler when parsed.workflowAsyncLaunch is set.
   * Sync mark + insert via markRunIdKnown; async _handleNewRunIdFromPathA
   * handles onNewWorkflow invocation with rollback on failure.
   */
  handleMainLine(parsed: ParsedLine): void {
    if (this.stopped) return;
    const launch = parsed.workflowAsyncLaunch;
    if (!launch) return;
    if (!this.markRunIdKnown(launch.runId)) return;
    void this._handleNewRunIdFromPathA(launch);
  }

  private async _handleNewRunIdFromPathA(
    launch: NonNullable<ParsedLine['workflowAsyncLaunch']>
  ): Promise<void> {
    try {
      await this.config.onNewWorkflow({
        runId: launch.runId,
        transcriptDir: launch.transcriptDir,
        snapshotPath: getWorkflowSnapshotPath(
          this.config.sessionDir,
          launch.runId
        ),
        ...(launch.scriptPath ? { scriptPath: launch.scriptPath } : {}),
        ...(launch.summary ? { summary: launch.summary } : {}),
      });
    } catch (err) {
      // Path A failure rolls back so path B (dir watch) can retry on a
      // subsequent fs event (e.g. snapshot status update).
      this.knownRunIds.delete(launch.runId);
      this.config.outputHandler.debug(
        `[workflow-detector] path A attach ${launch.runId} failed: ${err}`
      );
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async _handleNewRunId(runId: string, retries: number): Promise<void> {
    const snapshotPath = getWorkflowSnapshotPath(this.config.sessionDir, runId);
    const transcriptDir = join(
      getWorkflowSubagentsDir(this.config.sessionDir),
      runId
    );
    let succeeded = false;
    try {
      await this.config.onNewWorkflow({
        runId,
        transcriptDir,
        snapshotPath,
      });
      succeeded = true;
    } catch (err) {
      this.config.outputHandler.debug(
        `[workflow-detector] onNewWorkflow ${runId} failed: ${err}`
      );
    } finally {
      if (!succeeded) {
        this.knownRunIds.delete(runId);
        if (retries > 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          if (!this.stopped && this.markRunIdKnown(runId)) {
            void this._handleNewRunId(runId, retries - 1);
          }
        }
      }
    }
  }
}
