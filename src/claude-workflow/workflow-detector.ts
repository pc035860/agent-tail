// Phase 3 stub — RED tests assert real behavior; implementation lands in GREEN.
import type { OutputHandler } from '../core/detector-interfaces.ts';
import type { DetectedWorkflow } from './types.ts';

export interface WorkflowDetectorConfig {
  sessionUuid: string;
  sessionDir: string;
  onNewWorkflow: (workflow: DetectedWorkflow) => Promise<void> | void;
  outputHandler: OutputHandler;
}

export class WorkflowDetector {
  constructor(private readonly _config: WorkflowDetectorConfig) {}

  async start(): Promise<void> {
    /* stub */
  }

  markRunIdKnown(_runId: string): boolean {
    return false;
  }

  prefillKnown(_runId: string): void {
    /* stub */
  }

  stop(): void {
    /* stub */
  }
}
