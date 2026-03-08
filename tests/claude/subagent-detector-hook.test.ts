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
  test('does NOT call onNewSubagent when subagent is detected via fallback (completed)', async () => {
    // Phase 2.2 fix: Fallback detection 表示 subagent 已完成
    // 不應該開 pane，所以不觸發 onNewSubagent
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-hook-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const newSubagentHookCalls: { agentId: string; path: string }[] = [];
    const doneHookCalls: string[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false, // disable dir watch for unit test
      onNewSubagent: (agentId, subagentPath) => {
        newSubagentHookCalls.push({ agentId, path: subagentPath });
      },
      onSubagentDone: (agentId) => {
        doneHookCalls.push(agentId);
      },
    });

    // Trigger fallback detection with a valid agentId
    detector.handleFallbackDetection('abc1234def');

    // Fallback detection (completed subagent) 不應觸發 onNewSubagent
    expect(newSubagentHookCalls).toHaveLength(0);
    // 但也不應觸發 onSubagentDone，因為沒有開過 pane
    expect(doneHookCalls).toHaveLength(0);

    detector.stop();
  });

  test('calls onSubagentDone when already-monitored subagent completes', async () => {
    // Early detection 先發現 subagent（會觸發 onNewSubagent 開 pane）
    // Fallback detection 再發現完成（會觸發 onSubagentDone 關 pane）
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-hook-done-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const newSubagentHookCalls: { agentId: string; path: string }[] = [];
    const doneHookCalls: string[] = [];
    const panesWithPane = new Set(['abc1234def']); // 模擬這個 agent 有 pane

    const detector = new SubagentDetector(new Set(['abc1234def']), {
      // 已知 agentId（模擬 early detection 已發現）
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
      onNewSubagent: (agentId, subagentPath) => {
        newSubagentHookCalls.push({ agentId, path: subagentPath });
      },
      onSubagentDone: (agentId) => {
        doneHookCalls.push(agentId);
      },
      hasPane: (agentId) => panesWithPane.has(agentId),
    });

    // Trigger fallback detection（模擬 subagent 完成）
    detector.handleFallbackDetection('abc1234def');

    // 已監控的 subagent 完成時，應觸發 onSubagentDone
    expect(doneHookCalls).toHaveLength(1);
    expect(doneHookCalls[0]).toBe('abc1234def');
    // 不應再次觸發 onNewSubagent
    expect(newSubagentHookCalls).toHaveLength(0);

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

  test('does not trigger hooks for duplicate agentIds in fallback', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-hook-dup-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const newSubagentHookCalls: { agentId: string; path: string }[] = [];
    const doneHookCalls: string[] = [];

    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
      onNewSubagent: (agentId, subagentPath) => {
        newSubagentHookCalls.push({ agentId, path: subagentPath });
      },
      onSubagentDone: (agentId) => {
        doneHookCalls.push(agentId);
      },
      hasPane: () => false, // 沒有任何 pane
    });

    // 首次：fallback detection（completed），不觸發任何 hook
    detector.handleFallbackDetection('abc1234def');
    // 二次：重複的 agentId，已是已知且已完成，不觸發任何 hook
    detector.handleFallbackDetection('abc1234def');

    expect(newSubagentHookCalls).toHaveLength(0);
    expect(doneHookCalls).toHaveLength(0);

    detector.stop();
  });

  test('works without callbacks (optional)', () => {
    const detector = new SubagentDetector(new Set(), {
      subagentsDir: '/tmp/nonexistent',
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      watchDir: false,
      // no callbacks
    });

    // Should not throw
    expect(() => detector.handleFallbackDetection('abc1234def')).not.toThrow();

    detector.stop();
  });
});
