import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  extractCodexSubagentIds,
  buildCodexSubagentFiles,
  createCodexOnLineHandler,
  extractUUIDFromPath,
  readLastCodexAssistantMessage,
} from '../../src/codex/watch-builder';
import {
  type CodexSubagentDetector,
  makeCodexAgentLabel,
} from '../../src/codex/subagent-detector';
import {
  MAIN_LABEL,
  extractAgentIdFromLabel,
} from '../../src/core/detector-interfaces';
import { CodexAgent } from '../../src/agents/codex/codex-agent';

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
  resumeCalls: string[];
} {
  const spawnCalls: { callId: string; agentType: string; message: string }[] =
    [];
  const outputCalls: {
    callId: string;
    output: { agent_id: string; nickname?: string };
  }[] = [];
  const doneCalls: string[] = [];
  const resumeCalls: string[] = [];

  return {
    spawnCalls,
    outputCalls,
    doneCalls,
    resumeCalls,
    handleSpawnAgent: (callId: string, agentType: string, message: string) =>
      spawnCalls.push({ callId, agentType, message }),
    handleSpawnAgentOutput: (
      callId: string,
      output: { agent_id: string; nickname?: string }
    ) => outputCalls.push({ callId, output }),
    handleSubagentDone: (agentId: string) => doneCalls.push(agentId),
    // RED: handleSubagentResume not yet on CodexSubagentDetector
    handleSubagentResume: (agentId: string) => resumeCalls.push(agentId),
    stop: () => {},
  } as unknown as CodexSubagentDetector & {
    spawnCalls: typeof spawnCalls;
    outputCalls: typeof outputCalls;
    doneCalls: typeof doneCalls;
    resumeCalls: typeof resumeCalls;
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

    handler(line, '[019cc375-8a57]');

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

  // ============================================================
  // Phase 2 RED Tests: resume_agent + send_input pre-filter
  // ============================================================

  const VALID_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';

  test('resume_agent 行 → 呼叫 detector.handleSubagentResume（Phase 2 RED）', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'resume_agent',
        call_id: 'c-resume-1',
        arguments: JSON.stringify({ agent_id: VALID_UUID }),
      },
    });

    handler(line, MAIN_LABEL);

    // RED: createCodexOnLineHandler doesn't call handleSubagentResume yet
    expect(detector.resumeCalls).toHaveLength(1);
    expect(detector.resumeCalls[0]).toBe(VALID_UUID);
  });

  test('send_input 行 → 呼叫 detector.handleSubagentResume（Phase 2 RED）', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'send_input',
        call_id: 'c-send-1',
        arguments: JSON.stringify({
          agent_id: VALID_UUID,
          message: 'continue',
        }),
      },
    });

    handler(line, MAIN_LABEL);

    // RED: createCodexOnLineHandler doesn't call handleSubagentResume yet
    expect(detector.resumeCalls).toHaveLength(1);
    expect(detector.resumeCalls[0]).toBe(VALID_UUID);
  });

  test('resume_agent 行 on non-MAIN label → 不呼叫 handleSubagentResume', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'resume_agent',
        call_id: 'c-resume-1',
        arguments: JSON.stringify({ agent_id: VALID_UUID }),
      },
    });

    handler(line, '[019cc375-8a57]');

    expect(detector.resumeCalls).toHaveLength(0);
  });

  test('resume_agent 行含無效 agent_id → handleSubagentResume 被呼叫但 isValidCodexAgentId 過濾', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'resume_agent',
        call_id: 'c-resume-1',
        // 無效的 agent_id（非 UUID 格式）
        arguments: JSON.stringify({ agent_id: 'not-a-valid-uuid' }),
      },
    });

    handler(line, MAIN_LABEL);

    // handleSubagentResume is called with the invalid ID
    // but isValidCodexAgentId inside the real detector would filter it out
    // In mock, we just verify the call is made
    expect(detector.resumeCalls).toHaveLength(1);
    expect(detector.resumeCalls[0]).toBe('not-a-valid-uuid');
  });
});

// ============================================================
// Phase 2 RED Tests: readLastCodexAssistantMessage
// ============================================================

describe('readLastCodexAssistantMessage (Phase 2 RED)', () => {
  let tempDir: string;
  let parser: ReturnType<typeof createMockParser>;

  function createMockParser() {
    const agent = new CodexAgent({ verbose: false });
    return agent.parser;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-last-msg-'));
    parser = createMockParser();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeAssistantLine(text: string): string {
    return JSON.stringify({
      type: 'response_item',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    });
  }

  function makeUserLine(text: string): string {
    return JSON.stringify({
      type: 'response_item',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  test('含 assistant 訊息的 JSONL → 回傳最後一條 assistant 行', async () => {
    const filePath = join(tempDir, 'subagent.jsonl');
    await writeFile(
      filePath,
      [
        makeUserLine('請幫我做這個'),
        makeAssistantLine('第一個回應'),
        makeUserLine('繼續'),
        makeAssistantLine('最後的回應'), // ← 應回傳這條
      ].join('\n') + '\n'
    );

    // RED: readLastCodexAssistantMessage doesn't exist yet
    const result = await readLastCodexAssistantMessage(filePath, parser);

    expect(result).toHaveLength(1);
    expect(result[0]!.formatted).toContain('最後的回應');
  });

  test('無 assistant 訊息的 JSONL → 回傳空陣列', async () => {
    const filePath = join(tempDir, 'subagent.jsonl');
    await writeFile(
      filePath,
      [makeUserLine('user msg 1'), makeUserLine('user msg 2')].join('\n') + '\n'
    );

    // RED: readLastCodexAssistantMessage doesn't exist yet
    const result = await readLastCodexAssistantMessage(filePath, parser);

    expect(result).toHaveLength(0);
  });

  test('空檔案 → 回傳空陣列', async () => {
    const filePath = join(tempDir, 'empty.jsonl');
    await writeFile(filePath, '');

    // RED: readLastCodexAssistantMessage doesn't exist yet
    const result = await readLastCodexAssistantMessage(filePath, parser);

    expect(result).toHaveLength(0);
  });

  test('檔案不存在 → 回傳空陣列（不拋出例外）', async () => {
    const filePath = join(tempDir, 'nonexistent.jsonl');

    // RED: readLastCodexAssistantMessage doesn't exist yet
    const result = await readLastCodexAssistantMessage(filePath, parser);

    expect(result).toHaveLength(0);
  });
});

// ============================================================
// Tests: shouldOutput with suppressedForPane (Codex shortId mapping)
// ============================================================

describe('shouldOutput with suppressedForPane (Codex shortId mapping)', () => {
  const FULL_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
  // parts[0] + parts[4].slice(0,4) = '019cc375' + '8a57'
  const SHORT_ID = '019cc375-8a57';

  function makeCodexShouldOutput(
    pm: { hasPaneForAgent: (id: string) => boolean },
    suppressedForPane: Set<string>,
    shortIdToFullId: Map<string, string>
  ) {
    return (label: string) => {
      if (label === MAIN_LABEL) return true;
      const shortId = extractAgentIdFromLabel(label);
      const fullId = shortIdToFullId.get(shortId) ?? shortId;
      if (suppressedForPane.has(fullId)) return false;
      return !pm.hasPaneForAgent(fullId);
    };
  }

  test('main label 永遠輸出', () => {
    const fn = makeCodexShouldOutput(
      { hasPaneForAgent: () => true },
      new Set([FULL_UUID]),
      new Map([[SHORT_ID, FULL_UUID]])
    );
    expect(fn(MAIN_LABEL)).toBe(true);
  });

  test('Codex shortId 映射正確抑制 existing subagent', () => {
    const shortIdToFullId = new Map([[SHORT_ID, FULL_UUID]]);
    const suppressed = new Set([FULL_UUID]);

    const fn = makeCodexShouldOutput(
      { hasPaneForAgent: () => false },
      suppressed,
      shortIdToFullId
    );
    expect(fn(makeCodexAgentLabel(FULL_UUID))).toBe(false);
  });

  test('新 subagent 不在 suppress set 中，正常輸出', () => {
    const shortIdToFullId = new Map<string, string>();
    const suppressed = new Set<string>();

    const fn = makeCodexShouldOutput(
      { hasPaneForAgent: () => false },
      suppressed,
      shortIdToFullId
    );
    expect(fn(makeCodexAgentLabel(FULL_UUID))).toBe(true);
  });

  test('有 pane 的 subagent 不輸出（不在 suppress set）', () => {
    const shortIdToFullId = new Map([[SHORT_ID, FULL_UUID]]);
    const suppressed = new Set<string>();

    const fn = makeCodexShouldOutput(
      { hasPaneForAgent: (id) => id === FULL_UUID },
      suppressed,
      shortIdToFullId
    );
    expect(fn(makeCodexAgentLabel(FULL_UUID))).toBe(false);
  });

  test('clear 後重填 suppressedForPane，新 session 的舊 subagent 被清除', () => {
    const UUID_OLD = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
    const UUID_NEW = '019dd000-aaaa-7ed1-9ff8-8a5757d815d2';
    const SHORT_NEW = '019dd000-8a57';
    const shortIdToFullId = new Map([
      [SHORT_ID, UUID_OLD],
      [SHORT_NEW, UUID_NEW],
    ]);
    const suppressed = new Set([UUID_OLD]);

    // 模擬 switchToSession：clear + 重填
    suppressed.clear();
    suppressed.add(UUID_NEW);

    const fn = makeCodexShouldOutput(
      { hasPaneForAgent: () => false },
      suppressed,
      shortIdToFullId
    );
    expect(fn(makeCodexAgentLabel(UUID_OLD))).toBe(true); // 舊的已清除
    expect(fn(makeCodexAgentLabel(UUID_NEW))).toBe(false); // 新的被抑制
  });
});
