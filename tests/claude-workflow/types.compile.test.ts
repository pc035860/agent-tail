import { describe, test, expect } from 'bun:test';
import type {
  CliOptions,
  ParsedLine,
  SessionListItem,
} from '../../src/core/types.ts';
import type {
  DetectedWorkflow,
  JournalEvent,
  WorkflowDetectorConfig,
  WorkflowSnapshot,
} from '../../src/claude-workflow/types.ts';

// Compile-only assertions — accept new workflow fields without errors and reject
// nonsense values. Test bodies do nothing at runtime; the value is in TypeScript
// type-checking. If a future refactor drops a field, this file fails to compile.

describe('types — compile assertions', () => {
  test('ParsedLine accepts workflow fields', () => {
    const _p: ParsedLine = {
      type: 'system',
      timestamp: '2026-05-30T00:00:00.000Z',
      raw: null,
      formatted: '',
      workflowEvent: 'started',
      workflowAgentId: '01234567890abcdef',
      isWorkflowToolUse: true,
      workflowAsyncLaunch: {
        runId: 'wf_xxxxxxxx-xxx',
        transcriptDir: '/tmp/x',
        scriptPath: '/tmp/y',
        summary: '',
        taskId: 't1',
      },
    };
    expect(_p.workflowEvent).toBe('started');
  });

  test('SessionListItem accepts workflow fields', () => {
    const _s: SessionListItem = {
      path: '/x',
      mtime: new Date(0),
      agentType: 'claude',
      shortId: 'wf_xxxxxxxx-xxx',
      logType: 'workflow',
      workflowRunId: 'wf_xxxxxxxx-xxx',
      workflowSessionUuid: '00000000-0000-0000-0000-000000000000',
      workflowStatus: 'completed',
    };
    expect(_s.logType).toBe('workflow');
  });

  test('CliOptions new fields are optional', () => {
    // Should compile without workflow fields (they're all optional in P1).
    const _c: CliOptions = {
      agentType: 'claude',
      raw: false,
      follow: true,
      verbose: false,
      quiet: false,
      sleepInterval: 500,
      interactive: false,
      withSubagents: false,
      autoSwitch: false,
      pane: false,
      list: false,
      summary: false,
    };
    expect(_c.workflow).toBeUndefined();
    expect(_c.withWorkflowAgents).toBeUndefined();
    expect(_c.workflowPane).toBeUndefined();
    expect(_c.workflowAttach).toBeUndefined();
  });

  test('WorkflowSnapshot accepts minimal + full shape', () => {
    const _minimal: WorkflowSnapshot = {
      runId: 'wf_xxx-yyy',
      status: 'running',
    };
    const _full: WorkflowSnapshot = {
      runId: 'wf_xxx-yyy',
      status: 'completed',
      workflowName: 'demo',
      summary: 's',
      startTime: 0,
      durationMs: 1000,
      agentCount: 2,
      phases: [{ title: 'Setup' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Setup' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'a',
          phaseIndex: 1,
          phaseTitle: 'Setup',
          agentId: '01234567890abcdef',
          state: 'done',
          startedAt: 0,
          lastProgressAt: 0,
        },
      ],
    };
    expect(_minimal.runId).toBe('wf_xxx-yyy');
    expect(_full.status).toBe('completed');
  });

  test('JournalEvent shape', () => {
    const _started: JournalEvent = {
      type: 'started',
      key: 'v2:xxx',
      agentId: '01234567890abcdef',
    };
    const _result: JournalEvent = {
      type: 'result',
      key: 'v2:xxx',
      agentId: '01234567890abcdef',
      result: { ok: true },
    };
    expect(_started.type).toBe('started');
    expect(_result.type).toBe('result');
  });

  test('DetectedWorkflow + WorkflowDetectorConfig (outputHandler required)', () => {
    const _w: DetectedWorkflow = {
      runId: 'wf_xxx-yyy',
      transcriptDir: '/tmp/a',
      snapshotPath: '/tmp/b',
    };
    const _cfg: WorkflowDetectorConfig = {
      sessionUuid: '00000000-0000-0000-0000-000000000000',
      sessionsRoot: '/tmp/projects',
      onNewWorkflow: () => {},
      outputHandler: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };
    expect(_w.runId).toBe('wf_xxx-yyy');
    expect(typeof _cfg.outputHandler.info).toBe('function');
  });
});
