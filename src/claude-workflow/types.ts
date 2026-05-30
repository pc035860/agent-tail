// Phase 1 — workflow-internal types (SPEC §6.2).
// These are stable shapes; tests treat them purely as compile-time assertions.
import type { OutputHandler } from '../core/detector-interfaces.ts';

export type WorkflowStatus = 'running' | 'completed' | 'failed';

export interface WorkflowSnapshot {
  runId: string;
  workflowName?: string;
  summary?: string;
  status: WorkflowStatus;
  startTime?: number;
  durationMs?: number;
  agentCount?: number;
  phases?: Array<{ title: string; detail?: string }>;
  workflowProgress?: WorkflowProgressItem[];
}

export type WorkflowProgressItem =
  | { type: 'workflow_phase'; index: number; title: string }
  | {
      type: 'workflow_agent';
      index: number;
      label: string;
      phaseIndex: number;
      phaseTitle: string;
      agentId: string;
      state: 'running' | 'done' | 'error';
      startedAt: number;
      lastProgressAt: number;
      tokens?: number;
      toolCalls?: number;
      durationMs?: number;
    };

export interface JournalEvent {
  type: 'started' | 'result';
  key: string;
  agentId: string;
  result?: unknown;
}

export interface DetectedWorkflow {
  runId: string;
  transcriptDir: string;
  snapshotPath: string;
  scriptPath?: string;
  summary?: string;
}

export interface WorkflowDetectorConfig {
  sessionUuid: string;
  sessionsRoot: string;
  onNewWorkflow: (workflow: DetectedWorkflow) => void;
  outputHandler: OutputHandler;
}
