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
  readLastAssistantMessage,
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
  pushDescriptionCalls: string[];
  agentProgressCalls: string[];
} {
  const detector = {
    earlyDetectionCalls: 0,
    fallbackDetectionCalls: [] as string[],
    pushDescriptionCalls: [] as string[],
    agentProgressCalls: [] as string[],
    handleEarlyDetection() {
      detector.earlyDetectionCalls++;
    },
    handleFallbackDetection(agentId: string) {
      detector.fallbackDetectionCalls.push(agentId);
    },
    pushDescription(description: string) {
      detector.pushDescriptionCalls.push(description);
    },
    handleAgentProgress(agentId: string) {
      detector.agentProgressCalls.push(agentId);
    },
    getKnownAgentIds: () => new Set<string>(),
    isKnownAgent: () => false,
    startDirectoryWatch: () => {},
    stop: () => {},
  };
  return detector as unknown as SubagentDetector & {
    earlyDetectionCalls: number;
    fallbackDetectionCalls: string[];
    pushDescriptionCalls: string[];
    agentProgressCalls: string[];
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

  test('label [MAIN] with isTaskToolUse and taskDescription pushes description before early detection', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      type: 'function_call',
      isTaskToolUse: true,
      taskDescription: 'explore codebase',
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

    expect(detector.pushDescriptionCalls).toHaveLength(1);
    expect(detector.pushDescriptionCalls[0]).toBe('explore codebase');
    expect(detector.earlyDetectionCalls).toBe(1);
  });

  test('label [MAIN] with isTaskToolUse but no taskDescription does not push description', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      type: 'function_call',
      isTaskToolUse: true,
      // no taskDescription
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

    expect(detector.pushDescriptionCalls).toHaveLength(0);
    // Early detection should still fire
    expect(detector.earlyDetectionCalls).toBe(1);
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

  test('label [MAIN] with agent_progress triggers handleAgentProgress', () => {
    const detector = createMockDetector();
    const mockParser: LineParser = {
      parse: () => null, // progress 不產生 parsed output
    };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[MAIN]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    const progressLine = JSON.stringify({
      type: 'progress',
      data: { type: 'agent_progress', agentId: 'acfe87919d57b2295' },
    });
    handler(progressLine, '[MAIN]');

    expect(detector.agentProgressCalls).toContain('acfe87919d57b2295');
  });

  test('non-[MAIN] label with agent_progress does NOT trigger handleAgentProgress', () => {
    const detector = createMockDetector();
    const mockParser: LineParser = { parse: () => null };

    const config: OnLineHandlerConfig = {
      parsers: new Map([['[abc1234]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    const progressLine = JSON.stringify({
      type: 'progress',
      data: { type: 'agent_progress', agentId: 'xyz789' },
    });
    handler(progressLine, '[abc1234]');

    expect(detector.agentProgressCalls).toHaveLength(0);
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
      findLatestInProject: async () => null,
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
      findLatestInProject: async () => null,
    });

    controller.start();
    // 立即 stop
    controller.stop();

    // 等待足夠時間確認不再輪詢或切換
    await new Promise((r) => setTimeout(r, SUPER_FOLLOW_POLL_MS * 3));

    expect(switchCalled).toBe(false);
  });
});

// ============================================================
// Tests: readLastAssistantMessage
// ============================================================

// Helper: 建立 Claude 格式的 JSONL 行
function makeAssistantLine(
  text: string,
  timestamp = '2025-01-01T00:00:00Z'
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text }],
    },
  });
}

function makeToolResultLine(
  agentId: string,
  timestamp = '2025-01-01T00:00:00Z'
): string {
  return JSON.stringify({
    type: 'tool_result',
    timestamp,
    toolUseResult: { agentId, status: 'completed', totalDurationMs: 5000 },
  });
}

function makeUserLine(timestamp = '2025-01-01T00:00:00Z'): string {
  return JSON.stringify({
    type: 'user',
    timestamp,
    message: { content: 'hello' },
  });
}

describe('readLastAssistantMessage', () => {
  test('returns parsed parts for last assistant message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-test.jsonl');

    try {
      const content = [
        makeUserLine(),
        makeAssistantLine('first response'),
        makeUserLine(),
        makeAssistantLine('final report'),
      ].join('\n');
      await writeFile(filePath, content);

      const parts = await readLastAssistantMessage(filePath, false);

      expect(parts.length).toBeGreaterThan(0);
      expect(parts[0]!.type).toBe('assistant');
      expect(parts[0]!.formatted).toContain('final report');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns empty array for empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-empty.jsonl');

    try {
      await writeFile(filePath, '');
      const parts = await readLastAssistantMessage(filePath, false);
      expect(parts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns empty array for non-existent file', async () => {
    const parts = await readLastAssistantMessage(
      '/tmp/nonexistent-agent-tail-test.jsonl',
      false
    );
    expect(parts).toEqual([]);
  });

  test('returns empty array when no assistant message exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-noasst.jsonl');

    try {
      const content = [makeUserLine(), makeToolResultLine('abc1234')].join(
        '\n'
      );
      await writeFile(filePath, content);

      const parts = await readLastAssistantMessage(filePath, false);
      expect(parts).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('skips invalid JSON lines and finds assistant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-invalid.jsonl');

    try {
      const content = [
        makeAssistantLine('the report'),
        'not valid json {{{',
        '}{broken',
      ].join('\n');
      await writeFile(filePath, content);

      const parts = await readLastAssistantMessage(filePath, false);

      expect(parts.length).toBeGreaterThan(0);
      expect(parts[0]!.type).toBe('assistant');
      expect(parts[0]!.formatted).toContain('the report');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('finds assistant even when last line is not assistant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-mixed.jsonl');

    try {
      const content = [
        makeUserLine(),
        makeAssistantLine('my final answer'),
        makeToolResultLine('xyz789'),
      ].join('\n');
      await writeFile(filePath, content);

      const parts = await readLastAssistantMessage(filePath, false);

      expect(parts.length).toBeGreaterThan(0);
      expect(parts[0]!.formatted).toContain('my final answer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('handles multi-part assistant message (text + tool_use)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-rlam-'));
    const filePath = join(dir, 'agent-multipart.jsonl');

    try {
      const multiPartLine = JSON.stringify({
        type: 'assistant',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Here is the result' },
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/tmp/test.ts', content: 'code' },
            },
          ],
        },
      });
      await writeFile(filePath, multiPartLine);

      const parts = await readLastAssistantMessage(filePath, false);

      expect(parts.length).toBe(2);
      expect(parts[0]!.type).toBe('assistant');
      expect(parts[0]!.formatted).toContain('Here is the result');
      expect(parts[1]!.type).toBe('function_call');
      expect(parts[1]!.toolName).toBe('Write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
