import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDetector } from '../../src/claude-workflow/workflow-detector';
import type { OutputHandler } from '../../src/core/detector-interfaces';
import type { DetectedWorkflow } from '../../src/claude-workflow/types';

function createCapturingHandler(): OutputHandler & { debugMsgs: string[] } {
  const debugMsgs: string[] = [];
  return {
    debugMsgs,
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (m: string) => debugMsgs.push(m),
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WorkflowDetector — path B (directory watch)', () => {
  let tempDir: string;
  let sessionDir: string;
  let workflowsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wf-detector-'));
    sessionDir = join(tempDir, 'session');
    workflowsDir = join(sessionDir, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('start() on non-existent workflows dir does not throw', async () => {
    const handler = createCapturingHandler();
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir: join(tempDir, 'no-such-session'),
      onNewWorkflow: () => {},
      outputHandler: handler,
    });
    let threw = false;
    try {
      await detector.start();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    detector.stop();
  });

  test('new wf_*.json file triggers onNewWorkflow with runId/snapshotPath/transcriptDir', async () => {
    const handler = createCapturingHandler();
    const events: DetectedWorkflow[] = [];
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: (wf) => {
        events.push(wf);
      },
      outputHandler: handler,
    });
    await detector.start();

    await writeFile(
      join(workflowsDir, 'wf_12345678-abc.json'),
      JSON.stringify({ runId: 'wf_12345678-abc', status: 'running' })
    );
    // Slack 必須 > polling backup 間隔 (DIR_POLL_BACKUP_MS=500ms) 才不會在
    // fs.watch event miss 時邊界打架。500ms 間隔 + 1 次 tick + async slack。
    await waitMs(900);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[0]!;
    expect(evt.runId).toBe('wf_12345678-abc');
    expect(evt.snapshotPath).toBe(join(workflowsDir, 'wf_12345678-abc.json'));
    expect(evt.transcriptDir).toBe(
      join(sessionDir, 'subagents', 'workflows', 'wf_12345678-abc')
    );

    detector.stop();
  });

  test('duplicate filesystem events for same runId are deduped', async () => {
    const handler = createCapturingHandler();
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {
        callCount++;
      },
      outputHandler: handler,
    });
    await detector.start();

    const path = join(workflowsDir, 'wf_aaaaaaaa-aaa.json');
    await writeFile(path, JSON.stringify({ runId: 'wf_aaaaaaaa-aaa' }));
    await waitMs(50);
    await writeFile(path, JSON.stringify({ runId: 'wf_aaaaaaaa-aaa' }));
    // Slack 需 > DIR_POLL_BACKUP_MS (500ms) 才不會在 fs.watch event miss
    // 時邊界打架。
    await waitMs(900);

    expect(callCount).toBe(1);
    detector.stop();
  });

  test('filename not matching wf_*.json is ignored', async () => {
    const handler = createCapturingHandler();
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {
        callCount++;
      },
      outputHandler: handler,
    });
    await detector.start();

    await writeFile(join(workflowsDir, 'not-a-wf.json'), '{}');
    await writeFile(join(workflowsDir, 'wf_invalid.json'), '{}');
    await waitMs(400);

    expect(callCount).toBe(0);
    detector.stop();
  });

  test('prefillKnown(runId) suppresses dir-watch emission for that runId', async () => {
    const handler = createCapturingHandler();
    let callCount = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {
        callCount++;
      },
      outputHandler: handler,
    });
    detector.prefillKnown('wf_bbbbbbbb-bbb');
    await detector.start();

    await writeFile(
      join(workflowsDir, 'wf_bbbbbbbb-bbb.json'),
      JSON.stringify({ runId: 'wf_bbbbbbbb-bbb' })
    );
    await waitMs(400);

    expect(callCount).toBe(0);
    detector.stop();
  });

  test('markRunIdKnown is sync-safe: first true, subsequent false', () => {
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {},
      outputHandler: createCapturingHandler(),
    });
    expect(detector.markRunIdKnown('wf_xxxxxxxx-xxx')).toBe(true);
    expect(detector.markRunIdKnown('wf_xxxxxxxx-xxx')).toBe(false);
    expect(detector.markRunIdKnown('wf_yyyyyyyy-yyy')).toBe(true);
  });

  test('stop() is idempotent', async () => {
    const handler = createCapturingHandler();
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {},
      outputHandler: handler,
    });
    await detector.start();
    expect(() => detector.stop()).not.toThrow();
    expect(() => detector.stop()).not.toThrow();
  });

  test('onNewWorkflow rejection → runId rolled back, retried, eventually succeeds', async () => {
    const handler = createCapturingHandler();
    let attempts = 0;
    const detector = new WorkflowDetector({
      sessionUuid: 'uuid',
      sessionDir,
      onNewWorkflow: () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('first attempt fails');
        }
      },
      outputHandler: handler,
    });
    await detector.start();

    await writeFile(
      join(workflowsDir, 'wf_cccccccc-ccc.json'),
      JSON.stringify({ runId: 'wf_cccccccc-ccc' })
    );
    // 最壞時序：fs.watch event miss → polling 500ms tick → onNewWorkflow reject
    // → rollback → retry 100ms 後重發。再加 IO/scheduling slack。
    await waitMs(1200);

    expect(attempts).toBeGreaterThanOrEqual(2);
    detector.stop();
  });
});
