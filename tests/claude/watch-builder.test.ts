import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LineParser } from '../../src/agents/agent.interface';
import type { Formatter } from '../../src/formatters/formatter.interface';
import type { ParsedLine } from '../../src/core/types';
import type { SubagentDetector } from '../../src/claude/subagent-detector';
import {
  buildSubagentFiles,
  createOnLineHandler,
  createSuperFollowController,
  SUPER_FOLLOW_POLL_MS,
  type OnLineHandlerConfig,
} from '../../src/claude/watch-builder';

// ============================================================
// Mock Helpers
// ============================================================

function createMockParsedLine(overrides: Partial<ParsedLine> = {}): ParsedLine {
  return {
    type: 'assistant',
    timestamp: '2025-01-01T00:00:00Z',
    raw: {},
    formatted: 'test output',
    ...overrides,
  };
}

function createMockFormatter(): Formatter {
  return {
    format: (parsed: ParsedLine) => parsed.formatted,
  };
}

function createMockDetector(): SubagentDetector & {
  earlyDetectionCalls: number;
  fallbackDetectionCalls: string[];
} {
  const detector = {
    earlyDetectionCalls: 0,
    fallbackDetectionCalls: [] as string[],
    handleEarlyDetection() {
      detector.earlyDetectionCalls++;
    },
    handleFallbackDetection(agentId: string) {
      detector.fallbackDetectionCalls.push(agentId);
    },
    getKnownAgentIds: () => new Set<string>(),
    isKnownAgent: () => false,
    startDirectoryWatch: () => {},
    stop: () => {},
  };
  return detector as unknown as SubagentDetector & {
    earlyDetectionCalls: number;
    fallbackDetectionCalls: string[];
  };
}

// ============================================================
// Tests: buildSubagentFiles
// ============================================================

describe('buildSubagentFiles', () => {
  test('returns files sorted by birthtime ascending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-wb-'));

    try {
      const subagentsDir = join(dir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      // 建立兩個 subagent 檔案，間隔寫入以確保 birthtime 不同
      const file1 = join(subagentsDir, 'agent-aaaaaaa.jsonl');
      const file2 = join(subagentsDir, 'agent-bbbbbbb.jsonl');

      await writeFile(file1, '');
      // 小延遲確保 birthtime 不同
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(file2, '');

      const ids = new Set(['aaaaaaa', 'bbbbbbb']);
      const result = await buildSubagentFiles(subagentsDir, ids);

      expect(result).toHaveLength(2);
      expect(result[0]!.agentId).toBe('aaaaaaa');
      expect(result[1]!.agentId).toBe('bbbbbbb');
      // 確認升序
      expect(result[0]!.birthtime.getTime()).toBeLessThanOrEqual(
        result[1]!.birthtime.getTime()
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns empty array for empty initialAgentIds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-wb-'));

    try {
      const subagentsDir = join(dir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      const result = await buildSubagentFiles(subagentsDir, new Set());
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('filters out non-existent agentId files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-wb-'));

    try {
      const subagentsDir = join(dir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      // 只建立一個檔案
      await writeFile(join(subagentsDir, 'agent-aaaaaaa.jsonl'), '');

      // 傳入兩個 ID，其中 bbbbbbb 不存在
      const ids = new Set(['aaaaaaa', 'bbbbbbb']);
      const result = await buildSubagentFiles(subagentsDir, ids);

      expect(result).toHaveLength(1);
      expect(result[0]!.agentId).toBe('aaaaaaa');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Tests: createOnLineHandler
// ============================================================

describe('createOnLineHandler', () => {
  test('valid line triggers onOutput with formatted string', () => {
    const outputs: { formatted: string; label: string }[] = [];
    const parsed = createMockParsedLine({ formatted: 'hello world' });

    // ClaudeAgent parser 需要真實 JSON line
    // 我們用 mock parser 直接控制行為
    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return (_line: string) => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector: createMockDetector(),
      onOutput: (formatted, label) => outputs.push({ formatted, label }),
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{"type":"assistant"}', '[MAIN]');

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.formatted).toBe('hello world');
    expect(outputs[0]!.label).toBe('[MAIN]');
  });

  test('label [MAIN] with isTaskToolUse triggers handleEarlyDetection', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      type: 'function_call',
      isTaskToolUse: true,
    });

    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{"type":"assistant"}', '[MAIN]');

    expect(detector.earlyDetectionCalls).toBe(1);
  });

  test('label [MAIN] with toolUseResult.agentId (no commandName) triggers handleFallbackDetection', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      raw: { toolUseResult: { agentId: 'abc1234' } },
    });

    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[MAIN]');

    expect(detector.fallbackDetectionCalls).toContain('abc1234');
  });

  test('forked slash command (commandName present) does NOT trigger fallback', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      raw: {
        toolUseResult: { agentId: 'abc1234', commandName: '/some-command' },
      },
    });

    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[MAIN]');

    expect(detector.fallbackDetectionCalls).toHaveLength(0);
  });

  test('forked slash command (status=forked) does NOT trigger fallback', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      raw: { toolUseResult: { agentId: 'abc1234', status: 'forked' } },
    });

    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[MAIN]');

    expect(detector.fallbackDetectionCalls).toHaveLength(0);
  });

  test('non-[MAIN] label does NOT trigger any detection', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      isTaskToolUse: true,
      raw: { toolUseResult: { agentId: 'abc1234' } },
    });

    const mockParser: LineParser = {
      parse: (() => {
        let called = false;
        return () => {
          if (!called) {
            called = true;
            return parsed;
          }
          return null;
        };
      })(),
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[abc1234]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[abc1234]');

    expect(detector.earlyDetectionCalls).toBe(0);
    expect(detector.fallbackDetectionCalls).toHaveLength(0);
  });

  test('creates new parser for unknown label', () => {
    const outputs: string[] = [];
    const config: OnLineHandlerConfig = {
      parsers: new Map(), // empty - no pre-existing parsers
      formatter: createMockFormatter(),
      detector: createMockDetector(),
      onOutput: (formatted) => outputs.push(formatted),
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    // 使用真實的 Claude JSON line（user type）
    handler(
      JSON.stringify({
        type: 'user',
        timestamp: '2025-01-01',
        message: { content: 'hello' },
      }),
      '[NEW]'
    );

    // Parser 應被自動建立
    expect(config.parsers.has('[NEW]')).toBe(true);
  });
});

// ============================================================
// Tests: createSuperFollowController
// ============================================================

describe('createSuperFollowController', () => {
  test('autoSwitch=false: start() does not poll', async () => {
    let pollCount = 0;

    const controller = createSuperFollowController({
      projectDir: '/fake/dir',
      getCurrentPath: () => '/fake/path',
      onSwitch: async () => {
        pollCount++;
      },
      autoSwitch: false,
    });

    controller.start();

    // 等待一段時間確認沒有輪詢
    await new Promise((r) => setTimeout(r, SUPER_FOLLOW_POLL_MS * 3));
    controller.stop();

    expect(pollCount).toBe(0);
  });

  test('stop() clears all timers and prevents further polling', async () => {
    let switchCalled = false;

    const controller = createSuperFollowController({
      projectDir: '/fake/dir',
      getCurrentPath: () => '/fake/path',
      onSwitch: async () => {
        switchCalled = true;
      },
      autoSwitch: true,
    });

    controller.start();
    // 立即 stop
    controller.stop();

    // 等待足夠時間確認不再輪詢或切換
    await new Promise((r) => setTimeout(r, SUPER_FOLLOW_POLL_MS * 3));

    expect(switchCalled).toBe(false);
  });
});
