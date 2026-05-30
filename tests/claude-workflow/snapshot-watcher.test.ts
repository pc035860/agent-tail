import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotWatcher } from '../../src/claude-workflow/snapshot-watcher.ts';
import type { WorkflowSnapshot } from '../../src/claude-workflow/types.ts';

// Tunable for CI flake — generous slack vs the documented debounce.
// SPEC §8.2 default is 50ms; tests use 10ms for speed. If CI flakes,
// raise the multiplier (e.g., `* 6 + 200`).
const DEBOUNCE_MS = 10;

function waitDebounce(): Promise<void> {
  return new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3 + 50));
}

function makeSnapshot(
  overrides: Partial<WorkflowSnapshot> = {}
): WorkflowSnapshot {
  return {
    runId: 'wf_aaaaaaaa-bbb',
    status: 'running',
    ...overrides,
  };
}

describe('SnapshotWatcher', () => {
  let tempDir: string;
  let snapshotPath: string;
  let watcher: SnapshotWatcher | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'snapshot-watcher-test-'));
    snapshotPath = join(tempDir, 'wf_aaaaaaaa-bbb.json');
  });

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  test('start() reads existing file and calls onChange once', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
    });
    await watcher.start();

    expect(received).toHaveLength(1);
    expect(received[0]!.runId).toBe('wf_aaaaaaaa-bbb');
    expect(received[0]!.status).toBe('running');
  });

  test('subsequent write triggers onChange after debounce', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    await writeFile(
      snapshotPath,
      JSON.stringify(makeSnapshot({ status: 'completed' }))
    );
    await waitDebounce();

    expect(received).toHaveLength(2);
    expect(received[1]!.status).toBe('completed');
  });

  test('identical content writes are deduped', async () => {
    const content = JSON.stringify(makeSnapshot());
    await writeFile(snapshotPath, content);
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    // Re-write same content
    await writeFile(snapshotPath, content);
    await waitDebounce();

    expect(received).toHaveLength(1);
  });

  test('invalid JSON triggers onError, not onChange', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];
    const errors: Error[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
      onError: (e) => errors.push(e),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    await writeFile(snapshotPath, 'not json {{{');
    await waitDebounce();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(1); // unchanged
  });

  test('recovery: valid write after invalid still triggers onChange', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];
    const errors: Error[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
      onError: (e) => errors.push(e),
    });
    await watcher.start();

    // Corrupt
    await writeFile(snapshotPath, 'broken{');
    await waitDebounce();

    // Recover with new valid content
    await writeFile(
      snapshotPath,
      JSON.stringify(makeSnapshot({ status: 'failed' }))
    );
    await waitDebounce();

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[received.length - 1]!.status).toBe('failed');
  });

  test('stop() is idempotent', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: () => {},
    });
    await watcher.start();

    expect(() => watcher!.stop()).not.toThrow();
    expect(() => watcher!.stop()).not.toThrow();
  });

  test('stop() before debounce fires cancels pending onChange', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: 100,
      onChange: (s) => received.push(s),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    // Trigger a change then stop immediately
    await writeFile(
      snapshotPath,
      JSON.stringify(makeSnapshot({ status: 'completed' }))
    );
    watcher.stop();

    await new Promise((r) => setTimeout(r, 200));

    // Only the initial read; the second onChange was cancelled by stop().
    expect(received).toHaveLength(1);
  });

  test('start() on missing path calls onError, does not throw', async () => {
    const errors: Error[] = [];
    watcher = new SnapshotWatcher({
      path: join(tempDir, 'nope.json'),
      debounceMs: DEBOUNCE_MS,
      onChange: () => {},
      onError: (e) => errors.push(e),
    });

    let threw = false;
    try {
      await watcher.start();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('missing onError + invalid JSON does not crash', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: (s) => received.push(s),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    await writeFile(snapshotPath, 'corrupt {');
    await waitDebounce();

    // No crash; onChange not called again.
    expect(received).toHaveLength(1);
  });

  test('onChange throwing does not crash the watcher', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const errors: Error[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      debounceMs: DEBOUNCE_MS,
      onChange: () => {
        throw new Error('boom');
      },
      onError: (e) => errors.push(e),
    });
    await watcher.start();
    // Let any pending error notifications from the initial read settle.
    await waitDebounce();

    // start() itself caught the throw; onError surfaced it.
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Next write still triggers reload — onError fires again.
    await writeFile(
      snapshotPath,
      JSON.stringify(makeSnapshot({ status: 'completed' }))
    );
    await waitDebounce();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test('default debounceMs (SPEC §8.2 — 50ms) when omitted from config', async () => {
    await writeFile(snapshotPath, JSON.stringify(makeSnapshot()));
    const received: WorkflowSnapshot[] = [];

    watcher = new SnapshotWatcher({
      path: snapshotPath,
      // No debounceMs — should fall back to SPEC §8.2 default (50ms).
      onChange: (s) => received.push(s),
    });
    await watcher.start();
    expect(received).toHaveLength(1);

    await writeFile(
      snapshotPath,
      JSON.stringify(makeSnapshot({ status: 'completed' }))
    );
    // Slack of 50ms * 3 + 50 = 200ms.
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(2);
    expect(received[1]!.status).toBe('completed');
  });
});
