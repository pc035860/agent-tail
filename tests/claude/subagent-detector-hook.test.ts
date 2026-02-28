import { describe, test, expect } from 'bun:test';
import {
  SubagentDetector,
  type OutputHandler,
  type WatcherHandler,
} from '../../src/claude/subagent-detector';
import { join } from 'node:path';
import { mkdtemp, mkdir } from 'node:fs/promises';
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
// Tests
// ============================================================

describe('SubagentDetector onNewSubagent hook', () => {
  test('calls onNewSubagent when new subagent is detected via fallback', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-hook-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const hookCalls: { agentId: string; path: string }[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false, // disable dir watch for unit test
      onNewSubagent: (agentId, subagentPath) => {
        hookCalls.push({ agentId, path: subagentPath });
      },
    });

    // Trigger fallback detection with a valid agentId
    detector.handleFallbackDetection('abc1234def');

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.agentId).toBe('abc1234def');
    expect(hookCalls[0]!.path).toBe(
      join(subagentsDir, 'agent-abc1234def.jsonl')
    );

    detector.stop();
  });

  test('does not call onNewSubagent when enabled is false', () => {
    const hookCalls: { agentId: string; path: string }[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir: '/tmp/nonexistent',
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: false,
      watchDir: false,
      onNewSubagent: (agentId, subagentPath) => {
        hookCalls.push({ agentId, path: subagentPath });
      },
    });

    detector.handleFallbackDetection('abc1234def');

    expect(hookCalls).toHaveLength(0);

    detector.stop();
  });

  test('does not call onNewSubagent for duplicate agentIds', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-hook-dup-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const hookCalls: { agentId: string; path: string }[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
      onNewSubagent: (agentId, subagentPath) => {
        hookCalls.push({ agentId, path: subagentPath });
      },
    });

    detector.handleFallbackDetection('abc1234def');
    detector.handleFallbackDetection('abc1234def'); // duplicate

    expect(hookCalls).toHaveLength(1);

    detector.stop();
  });

  test('works without onNewSubagent callback (optional)', () => {
    const detector = new SubagentDetector(new Set(), {
      subagentsDir: '/tmp/nonexistent',
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
      // no onNewSubagent
    });

    // Should not throw
    expect(() => detector.handleFallbackDetection('abc1234def')).not.toThrow();

    detector.stop();
  });
});
