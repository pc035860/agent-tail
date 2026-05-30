import { watch, type FSWatcher } from 'node:fs';
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

export interface WorkflowDetectorConfig {
  sessionUuid: string;
  /** Absolute path to {sessionDir} = ~/.claude/projects/{enc-cwd}/{UUID} */
  sessionDir: string;
  onNewWorkflow: (workflow: DetectedWorkflow) => Promise<void> | void;
  outputHandler: OutputHandler;
}

export class WorkflowDetector {
  private dirWatcher: FSWatcher | null = null;
  private readonly knownRunIds = new Set<string>();
  private stopped = false;

  constructor(private readonly config: WorkflowDetectorConfig) {}

  async start(): Promise<void> {
    const workflowsDir = getWorkflowsDir(this.config.sessionDir);
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

  /** P5 stub — RED tests assert real behavior; implementation lands in GREEN. */
  handleMainLine(_parsed: ParsedLine): void {
    // stub
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dirWatcher?.close();
    this.dirWatcher = null;
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
