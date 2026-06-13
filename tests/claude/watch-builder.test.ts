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
  parseQueueOperationCompletion,
  readLastAssistantMessage,
  SUPER_FOLLOW_POLL_MS,
  type OnLineHandlerConfig,
} from '../../src/claude/watch-builder';
import { SubagentDetector as RealSubagentDetector } from '../../src/claude/subagent-detector';
import {
  MAIN_LABEL,
  makeAgentLabel,
  extractAgentIdFromLabel,
} from '../../src/core/detector-interfaces';

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
  recordSpawnCalls: Array<{ toolUseId: string; parentSource: string }>;
} {
  const detector = {
    earlyDetectionCalls: 0,
    fallbackDetectionCalls: [] as string[],
    pushDescriptionCalls: [] as string[],
    agentProgressCalls: [] as string[],
    recordSpawnCalls: [] as Array<{ toolUseId: string; parentSource: string }>,
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
    recordSpawn(toolUseId: string, parentSource: string) {
      detector.recordSpawnCalls.push({ toolUseId, parentSource });
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
    recordSpawnCalls: Array<{ toolUseId: string; parentSource: string }>;
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

  test('shouldOutput：suppressed agentId 不輸出', () => {
    const suppressedForPane = new Set(['abc1234']);
    const pm = { hasPaneForAgent: (_id: string) => false };

    const shouldOutput = (label: string) => {
      if (label === MAIN_LABEL) return true;
      const agentId = extractAgentIdFromLabel(label);
      if (suppressedForPane.has(agentId)) return false;
      return !pm.hasPaneForAgent(agentId);
    };

    expect(shouldOutput(MAIN_LABEL)).toBe(true);
    expect(shouldOutput(makeAgentLabel('abc1234'))).toBe(false);
  });

  test('shouldOutput：有 pane 的 agentId 不輸出（不在 suppress set）', () => {
    const suppressedForPane = new Set<string>();
    const pm = { hasPaneForAgent: (id: string) => id === 'abc1234' };

    const shouldOutput = (label: string) => {
      if (label === MAIN_LABEL) return true;
      const agentId = extractAgentIdFromLabel(label);
      if (suppressedForPane.has(agentId)) return false;
      return !pm.hasPaneForAgent(agentId);
    };

    expect(shouldOutput(makeAgentLabel('abc1234'))).toBe(false);
  });

  test('shouldOutput：無 pane 且未 suppress 的 agentId 正常輸出', () => {
    const suppressedForPane = new Set<string>();
    const pm = { hasPaneForAgent: (_id: string) => false };

    const shouldOutput = (label: string) => {
      if (label === MAIN_LABEL) return true;
      const agentId = extractAgentIdFromLabel(label);
      if (suppressedForPane.has(agentId)) return false;
      return !pm.hasPaneForAgent(agentId);
    };

    expect(shouldOutput(makeAgentLabel('newagent'))).toBe(true);
  });

  test('shouldOutput：clear 後重填，舊 suppress 消除、新 suppress 生效', () => {
    const suppressedForPane = new Set(['old-agent']);
    const pm = { hasPaneForAgent: (_id: string) => false };

    const shouldOutput = (label: string) => {
      if (label === MAIN_LABEL) return true;
      const agentId = extractAgentIdFromLabel(label);
      if (suppressedForPane.has(agentId)) return false;
      return !pm.hasPaneForAgent(agentId);
    };

    // 模擬 switchToSession：clear + 重填
    suppressedForPane.clear();
    suppressedForPane.add('new-agent');

    expect(shouldOutput(makeAgentLabel('old-agent'))).toBe(true); // 舊的已清除
    expect(shouldOutput(makeAgentLabel('new-agent'))).toBe(false); // 新的被抑制
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

  test('non-[MAIN] label does NOT trigger earlyDetection / pushDescription / fallbackDetection', () => {
    // earlyDetection / pushDescription are MAIN-only by design.
    // Fallback detection (toolUseResult.agentId) is also MAIN-only — nested
    // completion does NOT show up in parent subagent's JSONL; it's emitted as
    // queue-operation/task-notification in MAIN. See `queue-operation` handler
    // below for nested completion routing.
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      isTaskToolUse: true,
      taskDescription: 'should not push',
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
    expect(detector.pushDescriptionCalls).toHaveLength(0);
  });

  // Phase 4: nested subagent completion is reported only in MAIN's
  // queue-operation lines (the parent subagent's JSONL doesn't carry the
  // task-notification). Parsing the embedded XML and routing through
  // handleFallbackDetection drives markSessionDone (✓ tick) + onSubagentDone
  // (close nested pane).
  test('[MAIN] queue-operation with task-notification status=completed → fallbackDetection(taskId)', () => {
    const detector = createMockDetector();
    const config: OnLineHandlerConfig = {
      parsers: new Map(),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };
    const handler = createOnLineHandler(config);

    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        '<task-notification>\n<task-id>aacdade58f602a790</task-id>\n<tool-use-id>toolu_xyz</tool-use-id>\n<status>completed</status>\n</task-notification>',
    });
    handler(line, '[MAIN]');

    expect(detector.fallbackDetectionCalls).toEqual(['aacdade58f602a790']);
  });

  test('[MAIN] queue-operation with non-terminal status (running) → no fallbackDetection', () => {
    const detector = createMockDetector();
    const config: OnLineHandlerConfig = {
      parsers: new Map(),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };
    const handler = createOnLineHandler(config);

    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        '<task-notification>\n<task-id>aacdade58f602a790</task-id>\n<status>running</status>\n</task-notification>',
    });
    handler(line, '[MAIN]');

    expect(detector.fallbackDetectionCalls).toHaveLength(0);
  });

  // Helper-level tests — covers regex/JSON edge cases without going through
  // the full createOnLineHandler pipeline.
  describe('parseQueueOperationCompletion (helper)', () => {
    test('happy path: returns task-id', () => {
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification>\n<task-id>aacd1234567890ab</task-id>\n<status>completed</status>\n</task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBe('aacd1234567890ab');
    });

    test('status=running → null', () => {
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>x</task-id><status>running</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBeNull();
    });

    test('status=failed → returns task-id (terminal status set)', () => {
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>aacd1234567890ab</task-id><status>failed</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBe('aacd1234567890ab');
    });

    test('status=killed → returns task-id (subagent stopped mid-run)', () => {
      // 實測來自 ~/.claude/projects/: 「killed」是使用者中斷 subagent 後寫的
      // status；要關 pane / 打 ✓ tick，與 completed 同等對待。
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>a929dfe4d66679248</task-id><status>killed</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBe('a929dfe4d66679248');
    });

    test('unknown status → null (only listed terminal statuses)', () => {
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>x</task-id><status>somethingelse</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBeNull();
    });

    // 鎖死 status name 沒有 alias — Claude Code 實測只用 completed/failed/killed，
    // 不用 cancelled/canceled/stopped/aborted。若上游某天新增任一 alias，這幾條
    // 會在 review 時觸發討論（而不是悄悄掉進「未知 status → null」分支）。
    test.each(['cancelled', 'canceled', 'stopped', 'aborted'])(
      'status=%s → null (not a known terminal status name)',
      (status) => {
        const line = JSON.stringify({
          type: 'queue-operation',
          content: `<task-notification><task-id>aacd1234567890ab</task-id><status>${status}</status></task-notification>`,
        });
        expect(parseQueueOperationCompletion(line)).toBeNull();
      }
    );

    test('missing <status> tag → null', () => {
      // prefilter 過後 type 與 content 都對，但 content 缺 <status>
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>aacd1234567890ab</task-id></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBeNull();
    });

    test('wrong top-level type → null', () => {
      const line = JSON.stringify({
        type: 'user',
        content:
          '<task-notification><task-id>x</task-id><status>completed</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBeNull();
    });

    test('missing <task-id> → null', () => {
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><status>completed</status></task-notification>',
      });
      expect(parseQueueOperationCompletion(line)).toBeNull();
    });

    test('non-JSON line → null', () => {
      expect(parseQueueOperationCompletion('not json at all')).toBeNull();
    });

    test('prefilter rejects unrelated lines fast (no JSON parse)', () => {
      // Line lacks both prefilter substrings — must short-circuit to null.
      expect(parseQueueOperationCompletion('{"type":"assistant"}')).toBeNull();
    });
  });

  // Integration: real SubagentDetector — drive a queue-operation completion
  // event and verify ✓ tick + onSubagentDone (pane close) end-to-end.
  test('queue-operation drives markSessionDone + onSubagentDone via real detector', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'wb-qo-int-'));
    try {
      const subagentsDir = join(tmpDir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      // Track session lifecycle and pane events
      const sessionDoneCalls: string[] = [];
      const subagentDoneCalls: string[] = [];

      const detector = new RealSubagentDetector(
        new Set(['aacdade1']), // nested already known (cold attach scenario)
        {
          subagentsDir,
          output: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
          },
          watcher: { addFile: async () => {} },
          enabled: true,
          watchDir: false,
          session: {
            addSession: () => {},
            markSessionDone: (id: string) => {
              sessionDoneCalls.push(id);
            },
            updateUI: () => {},
          },
          // hasPane returns true → triggers onSubagentDone
          hasPane: () => true,
          onSubagentDone: (id: string) => {
            subagentDoneCalls.push(id);
          },
        }
      );

      const config: OnLineHandlerConfig = {
        parsers: new Map(),
        formatter: createMockFormatter(),
        detector,
        onOutput: () => {},
        verbose: false,
      };
      const handler = createOnLineHandler(config);

      const completionLine = JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>aacdade1</task-id>\n<status>completed</status>\n</task-notification>',
      });

      handler(completionLine, '[MAIN]');

      expect(sessionDoneCalls).toContain('aacdade1');
      expect(subagentDoneCalls).toContain('aacdade1');

      detector.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Integration: terminal status 'killed' / 'failed' 也要關 pane + 打 ✓ tick。
  // 實測 Claude Code 對被使用者中斷的 subagent 寫 status=killed；對 subagent
  // 內部錯誤寫 status=failed。兩者都是終止訊號，與 completed 同等對待。
  test('queue-operation killed/failed also drives markSessionDone + onSubagentDone', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'wb-qo-terminal-'));
    try {
      const subagentsDir = join(tmpDir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      const sessionDoneCalls: string[] = [];
      const subagentDoneCalls: string[] = [];

      const detector = new RealSubagentDetector(
        new Set(['aa11bb22', 'cc33dd44']),
        {
          subagentsDir,
          output: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
          },
          watcher: { addFile: async () => {} },
          enabled: true,
          watchDir: false,
          session: {
            addSession: () => {},
            markSessionDone: (id: string) => {
              sessionDoneCalls.push(id);
            },
            updateUI: () => {},
          },
          hasPane: () => true,
          onSubagentDone: (id: string) => {
            subagentDoneCalls.push(id);
          },
        }
      );

      const config: OnLineHandlerConfig = {
        parsers: new Map(),
        formatter: createMockFormatter(),
        detector,
        onOutput: () => {},
        verbose: false,
      };
      const handler = createOnLineHandler(config);

      const killedLine = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>aa11bb22</task-id><status>killed</status></task-notification>',
      });
      const failedLine = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>cc33dd44</task-id><status>failed</status></task-notification>',
      });

      handler(killedLine, '[MAIN]');
      handler(failedLine, '[MAIN]');

      expect(sessionDoneCalls).toContain('aa11bb22');
      expect(sessionDoneCalls).toContain('cc33dd44');
      expect(subagentDoneCalls).toContain('aa11bb22');
      expect(subagentDoneCalls).toContain('cc33dd44');

      detector.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // task-notification 也用於 background bash 任務（非 subagent），task-id 含非 hex
  // 字元。handleFallbackDetection 的 isValidAgentId guard 必須擋掉，避免錯誤
  // markSessionDone 一個不存在的 agentId。
  test('queue-operation with non-hex task-id (background bash) is ignored', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'wb-qo-bg-'));
    try {
      const subagentsDir = join(tmpDir, 'subagents');
      await mkdir(subagentsDir, { recursive: true });

      const sessionDoneCalls: string[] = [];
      const detector = new RealSubagentDetector(new Set(), {
        subagentsDir,
        output: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        watcher: { addFile: async () => {} },
        enabled: true,
        watchDir: false,
        session: {
          addSession: () => {},
          markSessionDone: (id: string) => {
            sessionDoneCalls.push(id);
          },
          updateUI: () => {},
        },
        hasPane: () => false,
      });

      const config: OnLineHandlerConfig = {
        parsers: new Map(),
        formatter: createMockFormatter(),
        detector,
        onOutput: () => {},
        verbose: false,
      };
      const handler = createOnLineHandler(config);

      // 實測來自 ~/.claude/projects/: background bash 失敗時 task-id 含 j/v/n 等非 hex
      const line = JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification><task-id>bjvbn9m0c</task-id><status>failed</status></task-notification>',
      });
      handler(line, '[MAIN]');

      expect(sessionDoneCalls).toHaveLength(0);
      detector.stop();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('non-[MAIN] queue-operation does NOT trigger fallbackDetection (defensive)', () => {
    const detector = createMockDetector();
    const config: OnLineHandlerConfig = {
      parsers: new Map(),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };
    const handler = createOnLineHandler(config);

    const line = JSON.stringify({
      type: 'queue-operation',
      content:
        '<task-notification><task-id>xxxxxxx</task-id><status>completed</status></task-notification>',
    });
    handler(line, '[someagent]');

    expect(detector.fallbackDetectionCalls).toHaveLength(0);
  });

  // Phase 2: recordSpawn is the only detector hook called from non-MAIN labels.
  // It records the spawn relationship so nested subagent registrations can
  // reverse-look-up their parent via meta.json.toolUseId.
  test('non-[MAIN] label with taskToolUseId calls recordSpawn with parent agentId', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      isTaskToolUse: true,
      taskToolUseId: 'toolu_nestedSpawn',
      raw: {},
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
      parsers: new Map([['[ace4e3f]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: () => {},
      verbose: false,
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[ace4e3f]');

    expect(detector.recordSpawnCalls).toHaveLength(1);
    expect(detector.recordSpawnCalls[0]!.toolUseId).toBe('toolu_nestedSpawn');
    // parent is the calling agentId (extracted from label), NOT MAIN
    expect(detector.recordSpawnCalls[0]!.parentSource).toBe('ace4e3f');
  });

  // Regression: shouldOutput 抑制不能跳過 recordSpawn — 否則 --pane 模式下
  // 被抑制的 parent subagent 的 Agent tool_use 不會進 spawnRegistry，
  // nested child 拿不到 parent label
  test('shouldOutput suppression does NOT skip recordSpawn (metadata always fires)', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      isTaskToolUse: true,
      taskToolUseId: 'toolu_suppressedParent',
      raw: {},
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

    const outputs: string[] = [];
    const config: OnLineHandlerConfig = {
      parsers: new Map([['[ace4e3f]', mockParser]]),
      formatter: createMockFormatter(),
      detector,
      onOutput: (formatted) => outputs.push(formatted),
      verbose: false,
      shouldOutput: (label) => label === '[MAIN]', // 抑制非 MAIN
    };

    const handler = createOnLineHandler(config);
    handler('{}', '[ace4e3f]');

    // 輸出被抑制
    expect(outputs).toHaveLength(0);
    // 但 metadata 偵測仍然觸發
    expect(detector.recordSpawnCalls).toHaveLength(1);
    expect(detector.recordSpawnCalls[0]!.toolUseId).toBe(
      'toolu_suppressedParent'
    );
    expect(detector.recordSpawnCalls[0]!.parentSource).toBe('ace4e3f');
  });

  test('[MAIN] label with taskToolUseId calls recordSpawn with MAIN sentinel', () => {
    const detector = createMockDetector();
    const parsed = createMockParsedLine({
      isTaskToolUse: true,
      taskToolUseId: 'toolu_mainSpawn',
      taskDescription: 'main spawn',
      raw: {},
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

    expect(detector.recordSpawnCalls).toHaveLength(1);
    expect(detector.recordSpawnCalls[0]!.parentSource).toBe('MAIN');
    // Main label also still pushes description + early detection
    expect(detector.pushDescriptionCalls).toEqual(['main spawn']);
    expect(detector.earlyDetectionCalls).toBe(1);
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
