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

  test('fallback completed path consumes description to prevent queue drift', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-desc-drift-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // Agent B will be discovered via early detection after A completes via fallback
    await writeFile(join(subagentsDir, 'agent-bbbbbbb.jsonl'), '');

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

    detector.startDirectoryWatch();

    // Push two descriptions: "desc A" for agent A, "desc B" for agent B
    detector.pushDescription('desc A');
    detector.pushDescription('desc B');

    // Agent A completes via fallback (no early detection, no pane opened)
    // This should consume "desc A" from the queue
    detector.handleFallbackDetection('aaaaaaa');

    // Agent B is discovered via early detection (should get "desc B", not "desc A")
    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 500));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.agentId).toBe('bbbbbbb');
    expect(hookCalls[0]!.description).toBe('desc B');

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

  test('falls back to meta.json description when FIFO is empty (nested subagent)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-meta-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // Nested subagent: jsonl + meta.json present, but no FIFO description
    // (because the Agent tool_use lives in a parent subagent JSONL, not main)
    await writeFile(join(subagentsDir, 'agent-eeeeeee.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-eeeeeee.meta.json'),
      JSON.stringify({
        agentType: 'prompt-reviewer',
        description: 'Review nested change',
        toolUseId: 'toolu_nestedSpawn',
      })
    );

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

    detector.startDirectoryWatch();

    // No pushDescription — nested case: description comes from meta.json
    detector.handleEarlyDetection();
    // Wait for async meta.json read + onNewSubagent invocation
    await new Promise((r) => setTimeout(r, 800));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.agentId).toBe('eeeeeee');
    expect(hookCalls[0]!.description).toBe('Review nested change');

    detector.stop();
  });

  // meta.json is the canonical source — claude code always writes it.
  // FIFO is a side channel that can carry stale historical entries (Task pushed
  // for a subagent that already existed at attach time, so registerNewAgent
  // skipped and the description sat in the queue). Trusting FIFO over meta.json
  // would misroute that stale description to the next nested subagent and skip
  // parent lookup.
  test('meta.json description wins over FIFO when both are present', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-meta-prio-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(join(subagentsDir, 'agent-fffffff.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-fffffff.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'meta description',
        toolUseId: 'toolu_mainSpawn',
      })
    );

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

    detector.startDirectoryWatch();
    detector.pushDescription('fifo description');
    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 800));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.description).toBe('meta description');

    detector.stop();
  });

  // FIFO is the fallback when meta.json is missing or has no description
  test('FIFO description used when meta.json is missing', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-fifo-fb-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // jsonl only, no meta.json
    await writeFile(join(subagentsDir, 'agent-7777777.jsonl'), '');

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

    detector.startDirectoryWatch();
    detector.pushDescription('fifo description');
    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 800));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.description).toBe('fifo description');

    detector.stop();
  });

  test('Phase 2: meta.json toolUseId + recordSpawn → addSession AND watcher.addFile both use [child◂parent] label', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-parent-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // Nested subagent (level-2): spawned by parent agent ace4e3f
    await writeFile(join(subagentsDir, 'agent-ad29fb7.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-ad29fb7.meta.json'),
      JSON.stringify({
        agentType: 'prompt-reviewer',
        description: 'nested review',
        toolUseId: 'toolu_nestedSpawn',
      })
    );

    const sessionEvents: Array<{ agentId: string; label: string }> = [];
    const watcherEvents: Array<{ path: string; label: string }> = [];
    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: {
        addFile: async (file) => {
          watcherEvents.push({ path: file.path, label: file.label });
        },
      },
      enabled: true,
      session: {
        addSession: (agentId: string, label: string) => {
          sessionEvents.push({ agentId, label });
        },
      },
      onNewSubagent: () => {},
    });

    detector.startDirectoryWatch();
    // Parent ace4e3f's JSONL spawned the nested subagent via this toolUseId
    detector.recordSpawn('toolu_nestedSpawn', 'ace4e3f');

    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 800));

    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.agentId).toBe('ad29fb7');
    expect(sessionEvents[0]!.label).toBe('[ad29fb7◂ace4e3f]');

    // watcher.addFile 也應收到 parent-aware label —— 否則 file watcher 的輸出
    // 路由與 session label 不一致，會破壞下游 parser map 與 shouldOutput 對照。
    expect(watcherEvents).toHaveLength(1);
    expect(watcherEvents[0]!.label).toBe('[ad29fb7◂ace4e3f]');

    detector.stop();
  });

  test('Phase 2 race: recordSpawn fires AFTER nested file detected → retry resolves parent label', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-race-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(join(subagentsDir, 'agent-ad29fb7.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-ad29fb7.meta.json'),
      JSON.stringify({
        agentType: 'prompt-reviewer',
        description: 'late parent',
        toolUseId: 'toolu_lateSpawn',
      })
    );

    const sessionEvents: Array<{ agentId: string; label: string }> = [];
    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      session: {
        addSession: (agentId: string, label: string) => {
          sessionEvents.push({ agentId, label });
        },
      },
      onNewSubagent: () => {},
    });

    detector.startDirectoryWatch();

    // 立刻觸發 detection（registry 尚未有 toolUseId）
    detector.handleEarlyDetection();

    // 60ms 後 parent JSONL 那行才被解析 → recordSpawn 到（仍在 retry window 內）
    setTimeout(() => {
      detector.recordSpawn('toolu_lateSpawn', 'ace4e3f');
    }, 60);

    // retry window 上限 ~150ms + meta retry，總共給 1.2s slack
    await new Promise((r) => setTimeout(r, 1200));

    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.label).toBe('[ad29fb7◂ace4e3f]');

    detector.stop();
  });

  test('Phase 2: MAIN parent via recordSpawn → addSession uses plain [child] label', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-mainparent-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(join(subagentsDir, 'agent-ace4e3f.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-ace4e3f.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'main spawn',
        toolUseId: 'toolu_mainSpawn',
      })
    );

    const sessionEvents: Array<{ agentId: string; label: string }> = [];
    const detector = new SubagentDetector(new Set(), {
      subagentsDir,
      output: createMockOutputHandler(),
      watcher: createMockWatcherHandler(),
      enabled: true,
      session: {
        addSession: (agentId: string, label: string) => {
          sessionEvents.push({ agentId, label });
        },
      },
      onNewSubagent: () => {},
    });

    detector.startDirectoryWatch();
    detector.recordSpawn('toolu_mainSpawn', 'MAIN');

    detector.handleEarlyDetection();
    await new Promise((r) => setTimeout(r, 800));

    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]!.label).toBe('[ace4e3f]');

    detector.stop();
  });

  test('no description when both FIFO and meta.json are empty', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'subagent-meta-none-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    await writeFile(join(subagentsDir, 'agent-9999999.jsonl'), '');
    // No meta.json on purpose

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

    detector.startDirectoryWatch();
    detector.handleEarlyDetection();
    // Read retries up to 5 * 50ms = 250ms, give it slack
    await new Promise((r) => setTimeout(r, 800));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.description).toBeUndefined();

    detector.stop();
  });
});
