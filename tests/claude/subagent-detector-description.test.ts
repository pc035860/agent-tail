import { describe, test, expect } from 'bun:test';
import {
  SubagentDetector,
  type OutputHandler,
  type WatcherHandler,
} from '../../src/claude/subagent-detector';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ============================================================
// Mock Helpers
// ============================================================

function createMockOutputHandler(): OutputHandler {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function createMockWatcherHandler(): WatcherHandler {
  return {
    addFile: async () => {},
  };
}

// ============================================================
// Tests: SubagentDetector description queue
// ============================================================

describe('SubagentDetector description queue', () => {
  test('passes description from queue to onNewSubagent callback (FIFO)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-desc-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // Create agent files
    await writeFile(join(subagentsDir, 'agent-aaaaaaa.jsonl'), '');
    await writeFile(join(subagentsDir, 'agent-bbbbbbb.jsonl'), '');

    const hookCalls: {
      agentId: string;
      path: string;
      description?: string;
    }[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      // watchDir defaults to true — needed for handleEarlyDetection's isWatching guard
      onNewSubagent: (
        agentId: string,
        subagentPath: string,
        description?: string
      ) => {
        hookCalls.push({ agentId, path: subagentPath, description });
      },
    });

    // Start directory watch (sets isWatching=true, required for handleEarlyDetection)
    detector.startDirectoryWatch();

    // Push descriptions before agents are registered
    detector.pushDescription('desc A');
    detector.pushDescription('desc B');

    // Trigger early detection scan which will find the files
    detector.handleEarlyDetection();

    // Wait for the async scan to complete
    await new Promise((r) => setTimeout(r, 500));

    expect(hookCalls).toHaveLength(2);
    // FIFO order: first description goes to first agent
    expect(hookCalls[0]!.description).toBe('desc A');
    expect(hookCalls[1]!.description).toBe('desc B');

    detector.stop();
  });

  test('passes undefined description when queue is empty', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-desc-empty-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(join(subagentsDir, 'agent-ccccccc.jsonl'), '');

    const hookCalls: {
      agentId: string;
      description?: string;
    }[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      onNewSubagent: (agentId: string, _path: string, description?: string) => {
        hookCalls.push({ agentId, description });
      },
    });

    // Start directory watch (sets isWatching=true)
    detector.startDirectoryWatch();

    // No descriptions pushed — queue is empty

    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 500));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.description).toBeUndefined();

    detector.stop();
  });

  test('pushDescription without corresponding agent does not error', () => {
    const detector = new SubagentDetector(new Set(), {
      subagentsDir: '/tmp/nonexistent-desc-test',
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
    });

    // Should not throw even when no agents will be registered
    expect(() => detector.pushDescription('orphan desc')).not.toThrow();

    detector.stop();
  });
});
