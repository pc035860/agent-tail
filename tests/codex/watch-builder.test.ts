import { describe, test, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  extractCodexSubagentIds,
  buildCodexSubagentFiles,
  createCodexOnLineHandler,
  extractUUIDFromPath,
} from '../../src/codex/watch-builder';
import type { CodexSubagentDetector } from '../../src/codex/subagent-detector';
import { MAIN_LABEL } from '../../src/core/detector-interfaces';

// ============================================================
// Mock CodexSubagentDetector
// ============================================================

function createMockDetector(): CodexSubagentDetector & {
  spawnCalls: { callId: string; agentType: string; message: string }[];
  outputCalls: {
    callId: string;
    output: { agent_id: string; nickname?: string };
  }[];
  doneCalls: string[];
} {
  const spawnCalls: { callId: string; agentType: string; message: string }[] =
    [];
  const outputCalls: {
    callId: string;
    output: { agent_id: string; nickname?: string };
  }[] = [];
  const doneCalls: string[] = [];

  return {
    spawnCalls,
    outputCalls,
    doneCalls,
    handleSpawnAgent: (callId: string, agentType: string, message: string) =>
      spawnCalls.push({ callId, agentType, message }),
    handleSpawnAgentOutput: (
      callId: string,
      output: { agent_id: string; nickname?: string }
    ) => outputCalls.push({ callId, output }),
    handleSubagentDone: (agentId: string) => doneCalls.push(agentId),
    stop: () => {},
  } as unknown as CodexSubagentDetector & {
    spawnCalls: typeof spawnCalls;
    outputCalls: typeof outputCalls;
    doneCalls: typeof doneCalls;
  };
}

const VALID_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
const VALID_UUID_2 = '019dd000-aaaa-7ed1-9ff8-8a5757d815d1';

// ============================================================
// extractUUIDFromPath
// ============================================================

describe('extractUUIDFromPath', () => {
  test('TC11: 從 rollout-*.jsonl 路徑提取 UUID', () => {
    const path = `/path/rollout-2026-03-06T22-02-54-${VALID_UUID}.jsonl`;
    expect(extractUUIDFromPath(path)).toBe(VALID_UUID);
  });

  test('TC11: 無 UUID 的路徑回傳空字串', () => {
    expect(extractUUIDFromPath('/path/rollout-without-uuid.jsonl')).toBe('');
  });

  test('完整路徑也能提取', () => {
    const path = `/home/user/.codex/sessions/2026/03/06/rollout-ts-${VALID_UUID}.jsonl`;
    expect(extractUUIDFromPath(path)).toBe(VALID_UUID);
  });
});

// ============================================================
// extractCodexSubagentIds
// ============================================================

describe('extractCodexSubagentIds', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-tail-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  test('TC10: 從 JSONL 提取有效的 UUID agent_id', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: {} }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ agent_id: VALID_UUID, nickname: 'K' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c2',
          output: JSON.stringify({ agent_id: VALID_UUID_2 }),
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join('\n') + '\n');

    const ids = await extractCodexSubagentIds(sessionFile);
    expect(ids).toContain(VALID_UUID);
    expect(ids).toContain(VALID_UUID_2);
    expect(ids).toHaveLength(2);
  });

  test('TC10: 去重（同一 agent_id 出現多次）', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ agent_id: VALID_UUID }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c2',
          output: JSON.stringify({ agent_id: VALID_UUID }),
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join('\n') + '\n');

    const ids = await extractCodexSubagentIds(sessionFile);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(VALID_UUID);
  });

  test('TC10b: 過濾無效 UUID（非 UUID 格式的 agent_id 被忽略）', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ agent_id: 'not-a-valid-uuid' }),
        },
      }),
    ];
    writeFileSync(sessionFile, lines.join('\n') + '\n');

    const ids = await extractCodexSubagentIds(sessionFile);
    expect(ids).toHaveLength(0);
  });

  test('不存在的檔案回傳空陣列', async () => {
    const ids = await extractCodexSubagentIds(
      '/nonexistent/path/session.jsonl'
    );
    expect(ids).toHaveLength(0);
  });
});

// ============================================================
// buildCodexSubagentFiles
// ============================================================

describe('buildCodexSubagentFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-tail-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  test('找到對應的 subagent 檔案', async () => {
    const filename = `rollout-2026-03-06T22-02-54-${VALID_UUID}.jsonl`;
    writeFileSync(join(tmpDir, filename), '{}');

    const files = await buildCodexSubagentFiles(tmpDir, [VALID_UUID]);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toContain(VALID_UUID);
  });

  test('TC10c: 檔案不存在時回傳空陣列', async () => {
    const files = await buildCodexSubagentFiles(tmpDir, [
      '019cc375-9999-7ed1-9ff8-8a5757d815d1',
    ]);
    expect(files).toHaveLength(0);
  });

  test('空 agentIds 回傳空陣列', async () => {
    const files = await buildCodexSubagentFiles(tmpDir, []);
    expect(files).toHaveLength(0);
  });
});

// ============================================================
// createCodexOnLineHandler
// ============================================================

describe('createCodexOnLineHandler', () => {
  let detector: ReturnType<typeof createMockDetector>;
  let handler: (line: string, label: string) => void;

  beforeEach(() => {
    detector = createMockDetector();
    handler = createCodexOnLineHandler(detector);
  });

  test('TC6: 解析 spawn_agent function_call 事件', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'c-123',
        arguments: JSON.stringify({
          agent_type: 'software-engineer',
          message: 'do task',
        }),
      },
    });

    handler(line, MAIN_LABEL);

    expect(detector.spawnCalls).toHaveLength(1);
    expect(detector.spawnCalls[0]).toEqual({
      callId: 'c-123',
      agentType: 'software-engineer',
      message: 'do task',
    });
  });

  test('TC7: 解析 function_call_output 事件（含 agent_id）', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c-123',
        output: JSON.stringify({ agent_id: VALID_UUID, nickname: 'Kant' }),
      },
    });

    handler(line, MAIN_LABEL);

    expect(detector.outputCalls).toHaveLength(1);
    expect(detector.outputCalls[0]).toEqual({
      callId: 'c-123',
      output: { agent_id: VALID_UUID, nickname: 'Kant' },
    });
  });

  test('TC7: function_call_output 無 agent_id 時不呼叫 handleSpawnAgentOutput', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c-123',
        output: JSON.stringify({ result: 'some other output' }),
      },
    });

    handler(line, MAIN_LABEL);
    expect(detector.outputCalls).toHaveLength(0);
  });

  test('TC8: 解析 subagent_notification（completed 狀態）', () => {
    const notification = JSON.stringify({
      agent_id: VALID_UUID,
      status: { completed: '2026-03-06T22:10:00Z' },
    });
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<subagent_notification>${notification}</subagent_notification>`,
          },
        ],
      },
    });

    handler(line, MAIN_LABEL);

    expect(detector.doneCalls).toHaveLength(1);
    expect(detector.doneCalls[0]).toBe(VALID_UUID);
  });

  test('TC9: 非 MAIN_LABEL 的行被完全忽略', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'c-123',
        arguments: JSON.stringify({ agent_type: 'engineer', message: 'task' }),
      },
    });

    handler(line, '[019cc375-5af5]');

    expect(detector.spawnCalls).toHaveLength(0);
    expect(detector.outputCalls).toHaveLength(0);
    expect(detector.doneCalls).toHaveLength(0);
  });

  test('損壞的 JSON 不拋出（靜默忽略）', () => {
    expect(() =>
      handler('{"spawn_agent": invalid json', MAIN_LABEL)
    ).not.toThrow();
  });

  test('普通 message 行（不含 spawn_agent）被忽略', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!' }],
      },
    });

    handler(line, MAIN_LABEL);

    expect(detector.spawnCalls).toHaveLength(0);
    expect(detector.outputCalls).toHaveLength(0);
    expect(detector.doneCalls).toHaveLength(0);
  });
});
