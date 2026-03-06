import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// ============================================================
// Phase 2 RED Tests: onSubagentEnter + handleSubagentResume + getAgentPath
// ============================================================

describe('CodexSubagentDetector - resume (Phase 2)', () => {
  let tempDir: string;
  let output: ReturnType<typeof createMockOutput>;
  let watcher: ReturnType<typeof createMockWatcher>;
  let onNewSubagentCalls: {
    agentId: string;
    path: string;
    description?: string;
  }[];
  let onSubagentEnterCalls: { agentId: string; path: string }[];

  const SUBAGENT_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
  const SUBAGENT_FILENAME = `rollout-2026-03-07T00-00-01-${SUBAGENT_UUID}.jsonl`;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-test-'));
    output = createMockOutput();
    watcher = createMockWatcher();
    onNewSubagentCalls = [];
    onSubagentEnterCalls = [];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // handleSubagentResume method existence
  // ------------------------------------------------------------------

  test('handleSubagentResume method should be defined', () => {
    // RED: method doesn't exist in CodexSubagentDetector yet
    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
    });
    expect(
      typeof (det as unknown as Record<string, unknown>)['handleSubagentResume']
    ).toBe('function');
  });

  // ------------------------------------------------------------------
  // handleSubagentResume: unknown agentId → no trigger
  // ------------------------------------------------------------------

  test('handleSubagentResume: 未知 agentId → 不觸發 onSubagentEnter', () => {
    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
      // RED: onSubagentEnter doesn't exist in config type yet
      ...({
        onSubagentEnter: (agentId: string, path: string) =>
          onSubagentEnterCalls.push({ agentId, path }),
      } as object),
    } as CodexSubagentDetectorConfig);

    // RED: handleSubagentResume doesn't exist
    (
      det as unknown as { handleSubagentResume: (id: string) => void }
    ).handleSubagentResume(SUBAGENT_UUID);

    expect(onSubagentEnterCalls).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // handleSubagentResume: enabled=false → no trigger
  // ------------------------------------------------------------------

  test('handleSubagentResume: enabled=false → 不觸發', () => {
    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: false,
      ...({
        onSubagentEnter: (agentId: string, path: string) =>
          onSubagentEnterCalls.push({ agentId, path }),
      } as object),
    } as CodexSubagentDetectorConfig);

    (
      det as unknown as { handleSubagentResume: (id: string) => void }
    ).handleSubagentResume(SUBAGENT_UUID);

    expect(onSubagentEnterCalls).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // handleSubagentResume: known agentId → triggers onSubagentEnter
  // ------------------------------------------------------------------

  test('handleSubagentResume: 已知 agentId → 觸發 onSubagentEnter 帶正確 path', async () => {
    // 建立 subagent 檔案
    const subagentFile = join(tempDir, SUBAGENT_FILENAME);
    await writeFile(subagentFile, '{"type":"session_meta"}\n');

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
      onNewSubagent: (agentId, path, description) =>
        onNewSubagentCalls.push({ agentId, path, description }),
      ...({
        onSubagentEnter: (agentId: string, path: string) =>
          onSubagentEnterCalls.push({ agentId, path }),
      } as object),
    } as CodexSubagentDetectorConfig);

    // Register agentId via spawn → resolve cycle
    det.handleSpawnAgent('call-1', 'software-engineer', 'Do the task');
    det.handleSpawnAgentOutput('call-1', { agent_id: SUBAGENT_UUID });

    // Wait for _resolveSubagent to complete (file exists → fast)
    await new Promise((resolve) => setTimeout(resolve, 300));

    // onNewSubagent should have been called → agentId is now registered
    expect(onNewSubagentCalls.length).toBeGreaterThan(0);

    // RED: handleSubagentResume doesn't exist
    (
      det as unknown as { handleSubagentResume: (id: string) => void }
    ).handleSubagentResume(SUBAGENT_UUID);

    expect(onSubagentEnterCalls).toHaveLength(1);
    expect(onSubagentEnterCalls[0]!.agentId).toBe(SUBAGENT_UUID);
    expect(onSubagentEnterCalls[0]!.path).toBe(subagentFile);
  });

  // ------------------------------------------------------------------
  // getAgentPath
  // ------------------------------------------------------------------

  test('getAgentPath: 已知 agentId → 回傳正確路徑', async () => {
    const subagentFile = join(tempDir, SUBAGENT_FILENAME);
    await writeFile(subagentFile, '{"type":"session_meta"}\n');

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
    });

    det.handleSpawnAgent('call-1', 'software-engineer', 'task');
    det.handleSpawnAgentOutput('call-1', { agent_id: SUBAGENT_UUID });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // RED: getAgentPath doesn't exist
    const path = (
      det as unknown as { getAgentPath: (id: string) => string | undefined }
    ).getAgentPath(SUBAGENT_UUID);
    expect(path).toBe(subagentFile);
  });

  test('getAgentPath: 未知 agentId → 回傳 undefined', () => {
    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
    });

    // RED: getAgentPath doesn't exist
    const path = (
      det as unknown as { getAgentPath: (id: string) => string | undefined }
    ).getAgentPath(SUBAGENT_UUID);
    expect(path).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // stop() 清理 registeredAgentIds / registeredAgentPaths
  // ------------------------------------------------------------------

  test('stop() 清理後 getAgentPath 回傳 undefined', async () => {
    const subagentFile = join(tempDir, SUBAGENT_FILENAME);
    await writeFile(subagentFile, '{"type":"session_meta"}\n');

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
    });

    det.handleSpawnAgent('call-1', 'software-engineer', 'task');
    det.handleSpawnAgentOutput('call-1', { agent_id: SUBAGENT_UUID });
    await new Promise((resolve) => setTimeout(resolve, 300));

    det.stop();

    // RED: getAgentPath doesn't exist; after stop, should return undefined
    const path = (
      det as unknown as { getAgentPath: (id: string) => string | undefined }
    ).getAgentPath(SUBAGENT_UUID);
    expect(path).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // onNewSubagent description passthrough
  // ------------------------------------------------------------------

  test('onNewSubagent: 傳遞 description（agentType + message 前 50 碼）', async () => {
    const subagentFile = join(tempDir, SUBAGENT_FILENAME);
    await writeFile(subagentFile, '{"type":"session_meta"}\n');

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
      onNewSubagent: (agentId, path, description) =>
        onNewSubagentCalls.push({ agentId, path, description }),
    });

    det.handleSpawnAgent(
      'call-1',
      'software-engineer',
      'Do the task carefully'
    );
    det.handleSpawnAgentOutput('call-1', { agent_id: SUBAGENT_UUID });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(onNewSubagentCalls).toHaveLength(1);
    // RED: current _resolveSubagent doesn't pass description
    expect(onNewSubagentCalls[0]!.description).toBeDefined();
    expect(onNewSubagentCalls[0]!.description).toContain('software-engineer');
  });

  // ------------------------------------------------------------------
  // registerExistingAgent（Review: 預填既有路徑）
  // ------------------------------------------------------------------

  test('registerExistingAgent: 預填路徑後 getAgentPath 能取得路徑', () => {
    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
    });

    det.registerExistingAgent(SUBAGENT_UUID, '/some/path/file.jsonl');
    expect(det.getAgentPath(SUBAGENT_UUID)).toBe('/some/path/file.jsonl');
  });

  test('registerExistingAgent: 預填路徑後 handleSubagentResume 能觸發 onSubagentEnter', () => {
    const enterCalls: { agentId: string; path: string }[] = [];

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
      onSubagentEnter: (agentId, path) => enterCalls.push({ agentId, path }),
    });

    det.registerExistingAgent(SUBAGENT_UUID, '/some/path/file.jsonl');
    det.handleSubagentResume(SUBAGENT_UUID);

    expect(enterCalls).toHaveLength(1);
    expect(enterCalls[0]!.agentId).toBe(SUBAGENT_UUID);
    expect(enterCalls[0]!.path).toBe('/some/path/file.jsonl');
  });

  // ------------------------------------------------------------------
  // stopped guard：stop() 後 in-flight _resolveSubagent 應被捨棄
  // ------------------------------------------------------------------

  test('stop() 後 in-flight _resolveSubagent 不觸發 onNewSubagent', async () => {
    const subagentFile = join(tempDir, SUBAGENT_FILENAME);
    await writeFile(subagentFile, '{"type":"session_meta"}\n');

    const det = new CodexSubagentDetector([], {
      sessionDateDir: tempDir,
      output,
      watcher,
      enabled: true,
      onNewSubagent: (agentId, path, description) =>
        onNewSubagentCalls.push({ agentId, path, description }),
    });

    det.handleSpawnAgent('call-stop', 'software-engineer', 'task');
    det.handleSpawnAgentOutput('call-stop', { agent_id: SUBAGENT_UUID });
    // stop() 立即呼叫（in-flight 尚未完成）
    det.stop();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // onNewSubagent 不應被觸發（stopped guard 攔截）
    expect(onNewSubagentCalls).toHaveLength(0);
  });
});
