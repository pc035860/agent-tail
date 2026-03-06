import { describe, test, expect, beforeEach } from 'bun:test';
import {
  isValidCodexAgentId,
  makeCodexAgentLabel,
  CodexSubagentDetector,
  type CodexSubagentDetectorConfig,
} from '../../src/codex/subagent-detector';
import type {
  OutputHandler,
  WatcherHandler,
} from '../../src/core/detector-interfaces';
import type { WatchedFile } from '../../src/core/multi-file-watcher';

// ============================================================
// Mock Helpers
// ============================================================

function createMockOutput(): OutputHandler & {
  calls: { level: string; message: string }[];
} {
  const calls: { level: string; message: string }[] = [];
  return {
    calls,
    info: (message: string) => calls.push({ level: 'info', message }),
    warn: (message: string) => calls.push({ level: 'warn', message }),
    error: (message: string) => calls.push({ level: 'error', message }),
    debug: (message: string) => calls.push({ level: 'debug', message }),
  };
}

function createMockWatcher(): WatcherHandler & { addedFiles: WatchedFile[] } {
  const addedFiles: WatchedFile[] = [];
  return {
    addedFiles,
    addFile: async (file: WatchedFile) => {
      addedFiles.push(file);
    },
  };
}

const VALID_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
const VALID_UUID_2 = '019cc376-aaaa-7ed1-9ff8-bb1234567890';

describe('isValidCodexAgentId', () => {
  test('接受正確的 UUID v7 格式', () => {
    expect(isValidCodexAgentId(VALID_UUID)).toBe(true);
  });

  test('接受大寫 UUID', () => {
    expect(isValidCodexAgentId('019CC375-5AF5-7ED1-9FF8-8A5757D815D1')).toBe(
      true
    );
  });

  test('拒絕非 UUID 字串', () => {
    expect(isValidCodexAgentId('not-a-uuid')).toBe(false);
  });

  test('拒絕 Claude hex 格式（7-40 hex）', () => {
    expect(isValidCodexAgentId('abc1234')).toBe(false);
  });

  test('拒絕空字串', () => {
    expect(isValidCodexAgentId('')).toBe(false);
  });

  test('拒絕少一段的 UUID', () => {
    expect(isValidCodexAgentId('019cc375-5af5-7ed1-9ff8')).toBe(false);
  });
});

describe('makeCodexAgentLabel', () => {
  test('取 UUID 時間戳段 + node 段前 4 碼建立標籤', () => {
    // VALID_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1'
    // parts[0]='019cc375', parts[4]='8a5757d815d1' → shortId='019cc375-8a57'
    expect(makeCodexAgentLabel(VALID_UUID)).toBe('[019cc375-8a57]');
  });

  test('不同 UUID 產生不同標籤', () => {
    const label1 = makeCodexAgentLabel(VALID_UUID);
    const label2 = makeCodexAgentLabel(VALID_UUID_2);
    expect(label1).not.toBe(label2);
  });
});

describe('CodexSubagentDetector', () => {
  let output: ReturnType<typeof createMockOutput>;
  let watcher: ReturnType<typeof createMockWatcher>;
  let onNewSubagentCalls: string[];
  let onSubagentDoneCalls: string[];
  let config: CodexSubagentDetectorConfig;
  let detector: CodexSubagentDetector;

  beforeEach(() => {
    output = createMockOutput();
    watcher = createMockWatcher();
    onNewSubagentCalls = [];
    onSubagentDoneCalls = [];
    config = {
      sessionDateDir: '/tmp/codex/2026/03/06',
      output,
      watcher,
      enabled: true,
      onNewSubagent: (agentId) => onNewSubagentCalls.push(agentId),
      onSubagentDone: (agentId) => onSubagentDoneCalls.push(agentId),
    };
    detector = new CodexSubagentDetector([], config);
  });

  describe('handleSpawnAgent', () => {
    test('TC3: 記錄 pending spawn（不呼叫 output.error）', () => {
      detector.handleSpawnAgent('call-1', 'software-engineer', 'Do task X');
      const errors = output.calls.filter((c) => c.level === 'error');
      expect(errors).toHaveLength(0);
    });

    test('disabled 時忽略 spawn_agent', () => {
      const disabledDetector = new CodexSubagentDetector([], {
        ...config,
        enabled: false,
      });
      disabledDetector.handleSpawnAgent('call-1', 'engineer', 'task');
      // stop() 應不拋出（沒有 TTL timer 需要清除）
      expect(() => disabledDetector.stop()).not.toThrow();
    });
  });

  describe('handleSpawnAgentOutput', () => {
    test('TC4: 無效 UUID 被拒絕（warn 並不呼叫 onNewSubagent）', () => {
      detector.handleSpawnAgent('call-1', 'engineer', 'task');
      detector.handleSpawnAgentOutput('call-1', { agent_id: 'not-valid-uuid' });

      const warns = output.calls.filter((c) => c.level === 'warn');
      expect(warns.length).toBeGreaterThan(0);
      expect(onNewSubagentCalls).toHaveLength(0);
    });

    test('不匹配的 callId 被忽略', () => {
      detector.handleSpawnAgent('call-1', 'engineer', 'task');
      detector.handleSpawnAgentOutput('unknown-call', { agent_id: VALID_UUID });
      // debug 或 warn 可能被呼叫，但 onNewSubagent 不應被呼叫
      expect(onNewSubagentCalls).toHaveLength(0);
    });
  });

  describe('handleSubagentDone', () => {
    test('TC5: 觸發 onSubagentDone 回呼', () => {
      detector.handleSubagentDone(VALID_UUID);
      expect(onSubagentDoneCalls).toEqual([VALID_UUID]);
    });

    test('呼叫兩次觸發兩次', () => {
      detector.handleSubagentDone(VALID_UUID);
      detector.handleSubagentDone(VALID_UUID_2);
      expect(onSubagentDoneCalls).toHaveLength(2);
    });
  });

  describe('stop', () => {
    test('TC5c: stop() 不拋出（即使有未完成的 TTL timers）', () => {
      detector.handleSpawnAgent('call-1', 'e1', 'task1');
      detector.handleSpawnAgent('call-2', 'e2', 'task2');
      expect(() => detector.stop()).not.toThrow();
    });

    test('stop() 後可以再次 stop() 而不拋出', () => {
      detector.stop();
      expect(() => detector.stop()).not.toThrow();
    });
  });
});
