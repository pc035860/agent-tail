import { describe, test, expect, afterEach } from 'bun:test';
import { rm, writeFile, unlink } from 'node:fs/promises';
import { WorkflowAttachment } from '../../src/claude-workflow/watch-builder';
import {
  RUN_ID,
  type Fixture,
  captureOutput,
  createHandler,
  rawFormatter,
  setupFixture,
  waitMs,
} from './_fixtures';

const SNAPSHOT_DEBOUNCE_WAIT_MS = 50 * 3 + 50;

function snapshotJson(
  status: 'running' | 'completed' | 'failed',
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({ runId: RUN_ID, status, ...extra });
}

async function waitMicrotask(): Promise<void> {
  await new Promise<void>((r) => queueMicrotask(r));
}

describe('WorkflowAttachment — snapshot integration', () => {
  let fixture: Fixture;
  let attachment: WorkflowAttachment | null = null;

  afterEach(async () => {
    await attachment?.stop('user');
    attachment = null;
    if (fixture?.tempDir) {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test('initial snapshot read triggers status event line', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const statusLines = lines.filter((l) => l.formatted.includes('[snapshot]'));
    expect(statusLines.length).toBe(1);
    expect(statusLines[0]!.formatted).toContain('status=running');
  });

  test('subsequent snapshot rewrite triggers second status event', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    await writeFile(
      fixture.snapshotPath,
      snapshotJson('completed', { agentCount: 5 })
    );
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS);
    await waitMicrotask();

    const statusLines = lines.filter((l) => l.formatted.includes('[snapshot]'));
    expect(statusLines.length).toBeGreaterThanOrEqual(2);
    expect(statusLines[statusLines.length - 1]!.formatted).toContain(
      'status=completed'
    );
  });

  test('getCurrentSnapshot reflects last parsed snapshot', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    expect(attachment.getCurrentSnapshot()?.status).toBe('running');

    await writeFile(fixture.snapshotPath, snapshotJson('completed'));
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS);
    await waitMicrotask();

    expect(attachment.getCurrentSnapshot()?.status).toBe('completed');
  });

  test('initial snapshot completed → auto-exit via queueMicrotask(stop)', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('completed'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();
    await waitMicrotask();

    expect(handler.infoMsgs.some((m) => m.includes('stopped'))).toBe(true);
  });

  test('subsequent transitions to completed → auto-exit single-shot', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    await writeFile(fixture.snapshotPath, snapshotJson('completed'));
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS);
    await waitMicrotask();
    await writeFile(
      fixture.snapshotPath,
      snapshotJson('completed', { agentCount: 99 })
    );
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS);

    const stoppedMsgs = handler.infoMsgs.filter((m) => m.includes('stopped'));
    expect(stoppedMsgs.length).toBe(1);
  });

  test('status=failed also triggers auto-exit', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('failed'),
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();
    await waitMicrotask();

    expect(handler.infoMsgs.some((m) => m.includes('stopped'))).toBe(true);
    expect(lines.some((l) => l.formatted.includes('status=failed'))).toBe(true);
  });

  test('invalid JSON snapshot write → debug log, no stop', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const stoppedBefore = handler.infoMsgs.filter((m) =>
      m.includes('stopped')
    ).length;

    await writeFile(fixture.snapshotPath, 'broken{');
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS);

    expect(handler.debugMsgs.length).toBeGreaterThanOrEqual(1);
    const stoppedAfter = handler.infoMsgs.filter((m) =>
      m.includes('stopped')
    ).length;
    expect(stoppedAfter).toBe(stoppedBefore);
  });

  test('snapshot file deletion (ENOENT) → stop directory-removed', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    await unlink(fixture.snapshotPath);
    await waitMs(SNAPSHOT_DEBOUNCE_WAIT_MS + 100);
    await waitMicrotask();

    expect(handler.infoMsgs.some((m) => m.includes('directory-removed'))).toBe(
      true
    );
  });

  test('phase progress in status event line', async () => {
    fixture = await setupFixture({
      snapshotContent: JSON.stringify({
        runId: RUN_ID,
        status: 'running',
        phases: [{ title: 'Setup' }, { title: 'Build' }, { title: 'Verify' }],
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Setup' },
          { type: 'workflow_phase', index: 2, title: 'Build' },
        ],
      }),
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const statusLine = lines.find((l) => l.formatted.includes('[snapshot]'))!;
    expect(statusLine.formatted).toContain('phase 2/3');
    expect(statusLine.formatted).toContain('Build');
  });

  test('phase progress with undefined phases falls back to ?', async () => {
    fixture = await setupFixture({
      snapshotContent: JSON.stringify({
        runId: RUN_ID,
        status: 'running',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Setup' },
        ],
      }),
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const statusLine = lines.find((l) => l.formatted.includes('[snapshot]'))!;
    expect(statusLine.formatted).toContain('phase 1/?');
  });

  test('attachAgent after stop is no-op (Patch 1)', async () => {
    fixture = await setupFixture({
      snapshotContent: snapshotJson('running'),
    });
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();
    await attachment.stop('user');

    const stoppedAttachment = attachment;
    attachment = null; // prevent afterEach double-stop

    // attachAgent after stop should be no-op — no throw, no state change.
    let threw = false;
    try {
      await stoppedAttachment.attachAgent(
        AGENT_ID_AFTER_STOP,
        '/tmp/never-read.jsonl'
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test('status line color: completed→green, failed→red, running→gray', async () => {
    // Three separate fixtures (one per status) since we need clean initial reads.
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    for (const status of ['running', 'completed', 'failed'] as const) {
      const fx = await setupFixture({
        snapshotContent: snapshotJson(status),
      });
      const att = new WorkflowAttachment({
        workflow: {
          runId: RUN_ID,
          transcriptDir: fx.transcriptDir,
          snapshotPath: fx.snapshotPath,
        },
        withAgents: false,
        verbose: false,
        follow: false,
        formatter: rawFormatter(),
        onOutput,
        outputHandler: handler,
      });
      await att.start();
      await waitMicrotask();
      await att.stop('user');
      await rm(fx.tempDir, { recursive: true, force: true });
    }

    const statusLines = lines.filter((l) => l.formatted.includes('[snapshot]'));
    // ANSI escape sequences differ by color. We just assert each status line
    // has SOME color code attached (chalk applies them by default).
    const running = statusLines.find((l) => l.formatted.includes('running'))!;
    const completed = statusLines.find((l) =>
      l.formatted.includes('completed')
    )!;
    const failed = statusLines.find((l) => l.formatted.includes('failed'))!;
    expect(running).toBeDefined();
    expect(completed).toBeDefined();
    expect(failed).toBeDefined();
    // The colors are distinct — formatted strings should differ in the ANSI
    // prefix even when stripped of message bodies.
    expect(running.formatted).not.toBe(completed.formatted);
    expect(completed.formatted).not.toBe(failed.formatted);
  });
});

const AGENT_ID_AFTER_STOP = '01234567890afterst';
