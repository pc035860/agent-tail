// Phase 3 stub — RED tests assert real behavior; implementation lands in GREEN.
import type {
  OutputHandler,
  SessionHandler,
} from '../core/detector-interfaces.ts';
import type { Formatter } from '../formatters/formatter.interface.ts';
import type { DetectedWorkflow } from './types.ts';

export interface WorkflowAttachmentConfig {
  workflow: DetectedWorkflow;
  withAgents: boolean;
  verbose: boolean;
  follow: boolean;
  pollInterval?: number;
  initialLines?: number;
  formatter: Formatter;
  onOutput: (formatted: string, label: string) => void;
  outputHandler: OutputHandler;
  sessionHandler?: SessionHandler;
}

export function makeWorkflowJournalLabel(runId: string): string {
  return `[wf:${runId}:journal]`;
}

export function makeWorkflowAgentLabel(agentId: string): string {
  return `[wf:${agentId.slice(0, 7)}]`;
}

export class WorkflowAttachment {
  constructor(private readonly _config: WorkflowAttachmentConfig) {}

  async start(): Promise<void> {
    /* stub */
  }

  async attachAgent(_agentId: string, _transcriptPath: string): Promise<void> {
    /* stub */
  }

  async stop(
    _reason: 'completed' | 'directory-removed' | 'user'
  ): Promise<void> {
    /* stub */
  }
}
