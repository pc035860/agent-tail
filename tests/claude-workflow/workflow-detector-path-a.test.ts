import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDetector } from '../../src/claude-workflow/workflow-detector';
import type { OutputHandler } from '../../src/core/detector-interfaces';
import type { ParsedLine } from '../../src/core/types';
import type { DetectedWorkflow } from '../../src/claude-workflow/types';

function createHandler(): OutputHandler & { debugMsgs: string[] } {
  const debugMsgs: string[] = [];
  return {
    debugMsgs,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (m: string) => debugMsgs.push(m),
  };
}

function makeParsedLine(
  asyncLaunch: NonNullable<ParsedLine['workflowAsyncLaunch']> | undefined
): ParsedLine {
  return {
    type: 'tool_result',
    timestamp: '2026-01-01T00:00:00Z',
    raw: null,
    formatted: '',
    ...(asyncLaunch ? { workflowAsyncLaunch: asyncLaunch } : {}),
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WorkflowDetector — handleMainLine (path A)', () => {
  let tempDir: string;
  let sessionDir: string;
  let workflowsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wf-path-a-'));
    sessionDir = join(tempDir, 'session');
    workflowsDir = join(sessionDir, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('parsed with workflowAsyncLaunch triggers onNewWorkflow', async () => {
    const events: DetectedWorkflow[] = [];
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: (wf) => {
        events.push(wf);
      },
    });

    detector.handleMainLine(
      makeParsedLine({
        runId: 'wf_12345678-abc',
        transcriptDir: '/transcripts/wf_12345678-abc',
        scriptPath: '/scripts/x.js',
        summary: 'a workflow',
        taskId: 't1',
      })
    );

    // handleMainLine schedules async work; wait one microtask + small delay
    await waitMs(50);

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe('wf_12345678-abc');
    expect(events[0]!.transcriptDir).toBe('/transcripts/wf_12345678-abc');
    // snapshotPath should be derived from sessionDir + runId, NOT from
    // workflowAsyncLaunch (which doesn't carry snapshotPath).
    expect(events[0]!.snapshotPath).toBe(
      join(workflowsDir, 'wf_12345678-abc.json')
    );
    // Optional decoration fields passed through.
    expect(events[0]!.scriptPath).toBe('/scripts/x.js');
    expect(events[0]!.summary).toBe('a workflow');

    detector.stop();
  });

  test('parsed without workflowAsyncLaunch is no-op', async () => {
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: () => {
        callCount++;
      },
    });

    detector.handleMainLine(makeParsedLine(undefined));
    await waitMs(50);

    expect(callCount).toBe(0);
    detector.stop();
  });

  test('duplicate runId across two handleMainLine calls → only one onNewWorkflow', async () => {
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: () => {
        callCount++;
      },
    });

    const launch = {
      runId: 'wf_aaaaaaaa-bbb',
      transcriptDir: '/x',
    };
    detector.handleMainLine(makeParsedLine(launch));
    detector.handleMainLine(makeParsedLine(launch));
    await waitMs(50);

    expect(callCount).toBe(1);
    detector.stop();
  });

  test('path A then path B for same runId → only one onNewWorkflow (T16)', async () => {
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: () => {
        callCount++;
      },
    });
    await detector.start();

    const runId = 'wf_cccccccc-ddd';
    detector.handleMainLine(makeParsedLine({ runId, transcriptDir: '/x' }));
    await waitMs(50);

    // Now write the snapshot file — path B fs.watch would fire, but
    // runId is already known via path A, so onNewWorkflow stays at 1.
    await writeFile(
      join(workflowsDir, `${runId}.json`),
      JSON.stringify({ runId })
    );
    await waitMs(200);

    expect(callCount).toBe(1);
    detector.stop();
  });

  test('path A failure rolls back; subsequent handleMainLine for same runId can retry', async () => {
    let attempts = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('first attempt fails');
        }
      },
    });

    const launch = { runId: 'wf_eeeeeeee-fff', transcriptDir: '/x' };
    detector.handleMainLine(makeParsedLine(launch));
    await waitMs(50);

    // First attempt threw → knownRunIds rolled back.
    // Calling handleMainLine again with same runId triggers a fresh attempt.
    detector.handleMainLine(makeParsedLine(launch));
    await waitMs(50);

    expect(attempts).toBeGreaterThanOrEqual(2);
    detector.stop();
  });

  test('handleMainLine after stop is no-op', async () => {
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      outputHandler: createHandler(),
      onNewWorkflow: () => {
        callCount++;
      },
    });
    await detector.start();
    detector.stop();

    detector.handleMainLine(
      makeParsedLine({
        runId: 'wf_99999999-zzz',
        transcriptDir: '/x',
      })
    );
    await waitMs(50);

    expect(callCount).toBe(0);
  });
});
