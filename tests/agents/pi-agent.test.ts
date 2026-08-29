import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  PiLineParser,
  PiSessionFinder,
  encodePiProjectDir,
  extractUuidFromFilename,
} from '../../src/agents/pi/pi-agent';
import { drainParser } from '../../src/utils/parser-drain';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── 測試資料工廠 ───────────────────────────────────────────────

const UUID_A = 'aaaaaaaa-1111-7111-8111-111111111111';
const UUID_B = 'bbbbbbbb-2222-7222-8222-222222222222';

function headerLine(cwd: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: UUID_A,
    timestamp: '2026-08-29T10:00:00.000Z',
    cwd,
  });
}

function userEntry(id: string, parentId: string | null, text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-29T10:00:01.000Z',
    message: { role: 'user', content: text },
  });
}

function assistantBlock(
  id: string,
  parentId: string,
  blocks: unknown[],
  timestamp = '2026-08-29T10:00:02.000Z'
): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp,
    message: {
      role: 'assistant',
      content: blocks,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'stop',
    },
  });
}

function toolResultLine(
  id: string,
  parentId: string,
  toolName: string,
  text: string
): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-29T10:00:03.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName,
      content: [{ type: 'text', text }],
      isError: false,
    },
  });
}

// ─── Parser 測試 ───────────────────────────────────────────────

describe('PiLineParser', () => {
  test('user message（字串 content）→ single emit', () => {
    const parser = new PiLineParser();
    const line = JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-08-29T10:00:01.000Z',
      message: { role: 'user', content: 'hello pi' },
    });

    const parsed = parser.parse(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('user');
    expect(parsed!.timestamp).toBe('2026-08-29T10:00:01.000Z');
    expect(parsed!.formatted).toContain('hello pi');

    // dedup guard：同一行再 parse 不重複發射
    expect(parser.parse(line)).toBeNull();
  });

  test('assistant 多 blocks（text + toolCall + text）→ drain 依序發射 3 筆', () => {
    const parser = new PiLineParser();
    const line = assistantLineWithBlocks();
    const emitted: string[] = [];
    drainParser(parser, line, (p) => emitted.push(`${p.type}:${p.formatted}`));

    expect(emitted.length).toBe(3);
    expect(emitted[0]!.startsWith('assistant:')).toBe(true);
    expect(emitted[1]!.startsWith('function_call:')).toBe(true);
    expect(emitted[2]!.startsWith('assistant:')).toBe(true);
  });

  test("drainArg=''（summary 路徑）也能完整發射 multi-block assistant", () => {
    // formatSummary 用 drainArg: '' 抽乾 — state 存在時必須繼續 emit，
    // 否則多 block 訊息只會出第一個 block（codex review 回歸鎖）
    const parser = new PiLineParser();
    const line = assistantLineWithBlocks();
    const emitted: string[] = [];
    drainParser(parser, line, (p) => emitted.push(p.type), { drainArg: '' });
    expect(emitted).toEqual(['assistant', 'function_call', 'assistant']);
  });

  test('頂層 custom_message entry（v3 持久化格式）→ custom；display=false 跳過', () => {
    const parser = new PiLineParser();
    const cm = JSON.stringify({
      type: 'custom_message',
      id: 'x1',
      parentId: 'a1',
      timestamp: '2026-08-29T10:00:05.000Z',
      customType: 'my-ext',
      content: 'extension output',
      display: true,
    });
    const parsed = parser.parse(cm);
    expect(parsed!.type).toBe('custom');
    expect(parsed!.formatted).toContain('extension output');

    const hidden = JSON.stringify({
      type: 'custom_message',
      id: 'x2',
      parentId: 'a1',
      timestamp: '2026-08-29T10:00:06.000Z',
      customType: 'my-ext',
      content: 'hidden',
      display: false,
    });
    expect(parser.parse(hidden)).toBeNull();
  });

  test('function_call 帶 toolName（供 formatter 顏色判斷）', () => {
    const parser = new PiLineParser();
    const line = assistantLineWithBlocks();
    let fnCall: { toolName?: string } | null = null;
    drainParser(parser, line, (p) => {
      if (p.type === 'function_call') fnCall = p;
    });
    expect(fnCall).not.toBeNull();
    expect(fnCall!.toolName).toBe('read');
  });

  test('drain 完成後再 parse 同一行 → null（不會 re-init 無限迴圈）', () => {
    const parser = new PiLineParser();
    const line = assistantLineWithBlocks();
    // 完整 drain
    let count = 0;
    drainParser(parser, line, () => count++);
    expect(count).toBe(3);
    // drain 完後同一行再呼叫 → null
    expect(parser.parse(line)).toBeNull();
    expect(parser.parse(line)).toBeNull();
  });

  test('toolResult → tool_result；isError 加 [error] 前綴', () => {
    const parser = new PiLineParser();
    const ok = toolResultLine('r1', 'a2', 'bash', 'file contents here');
    const parsed = parser.parse(ok);
    expect(parsed!.type).toBe('tool_result');
    expect(parsed!.formatted).toContain('file contents here');

    const err = JSON.stringify({
      type: 'message',
      id: 'r2',
      parentId: 'a1',
      timestamp: '2026-08-29T10:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      },
    });
    const parsedErr = parser.parse(err);
    expect(parsedErr!.formatted).toContain('[error]');
  });

  test('bashExecution → output 類型，含 command 與 exit code', () => {
    const parser = new PiLineParser();
    const line = JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-08-29T10:00:00.000Z',
      message: {
        role: 'bashExecution',
        command: 'bun test',
        output: '42 pass',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    });
    const parsed = parser.parse(line);
    expect(parsed!.type).toBe('output');
    expect(parsed!.formatted).toContain('$ bun test');
    expect(parsed!.formatted).toContain('(exit 0)');
  });

  test('session_info → custom-title 事件（pi /name 對應 Claude /rename）', () => {
    const parser = new PiLineParser();
    const line = JSON.stringify({
      type: 'session_info',
      id: 's1',
      parentId: 'a1',
      timestamp: '2026-08-29T10:05:00.000Z',
      name: 'Refactor auth module',
    });
    const parsed = parser.parse(line);
    expect(parsed!.type).toBe('custom-title');
    expect(parsed!.isCustomTitle).toBe(true);
    expect(parsed!.customTitleValue).toBe('Refactor auth module');
  });

  test('非 message entries（header / model_change / compaction）→ null', () => {
    const parser = new PiLineParser();
    expect(
      parser.parse(
        '{"type":"session","version":3,"id":"x","cwd":"/tmp","timestamp":"2026-08-29T10:00:00.000Z"}'
      )
    ).toBeNull();
    expect(
      parser.parse(
        '{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-08-29T10:00:00.000Z","provider":"openai","modelId":"gpt-4o"}'
      )
    ).toBeNull();
    expect(
      parser.parse(
        '{"type":"compaction","id":"c1","parentId":"a1","timestamp":"2026-08-29T10:00:00.000Z","summary":"..."}'
      )
    ).toBeNull();
    expect(parser.parse('not json')).toBeNull();
    expect(parser.parse('')).toBeNull();
  });

  test('thinking block 僅在 verbose 模式輸出為 reasoning', () => {
    const line = assistantLineWithBlocks([
      { type: 'thinking', thinking: 'hmm let me think' },
      { type: 'text', text: 'answer' },
    ]);

    const p1 = new PiLineParser({ verbose: false });
    const emitted1: string[] = [];
    drainParser(p1, line, (parsed) => emitted1.push(parsed.type));
    expect(emitted1).toEqual(['assistant']);

    const p2 = new PiLineParser({ verbose: true });
    const emitted2: string[] = [];
    drainParser(p2, line, (parsed) => emitted2.push(parsed.type));
    expect(emitted2).toEqual(['reasoning', 'assistant']);
  });
});

/** 建立含 text + toolCall + text 的 assistant message 行 */
function assistantLineWithBlocks(blocks?: unknown[]): string {
  return JSON.stringify({
    type: 'message',
    id: 'as1',
    parentId: 'a1',
    timestamp: '2026-08-29T10:00:02.000Z',
    message: {
      role: 'assistant',
      content: blocks ?? [
        { type: 'text', text: 'let me check' },
        {
          type: 'toolCall',
          id: 't1',
          name: 'read',
          arguments: { file_path: '/x' },
        },
        { type: 'text', text: 'done reading' },
      ],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      stopReason: 'toolUse',
    },
  });
}

// ─── 樹狀 active-path 過濾（A' 核心）────────────────────────────

describe('PiLineParser history buffering (active-path filter)', () => {
  /**
   * 樹狀 session：
   *   a1(user) → b2(asst) → c3(user，死分支)
   *                └────→ d4(user 重送) → e5(asst，leaf)
   * active path: a1, b2, d4, e5；c3 必須被過濾
   */
  const branchedLines = [
    headerLine('/tmp/proj'),
    userEntry('a1', null, 'first question'),
    assistantBlock('b2', 'a1', [{ type: 'text', text: 'first reply' }]),
    userEntry('c3', 'b2', 'dead branch question'),
    userEntry('d4', 'b2', 'rephrased question'),
    assistantBlock(
      'e5',
      'd4',
      [{ type: 'text', text: 'final answer' }],
      '2026-08-29T10:03:00.000Z'
    ),
  ];

  test('flushHistory 只輸出 active 路徑，死分支被過濾', () => {
    const parser = new PiLineParser();
    parser.beginHistory();
    for (const line of branchedLines) {
      expect(parser.parse(line)).toBeNull(); // 緩衝期間不輸出
    }
    const flushed = parser.flushHistory();

    // a1(user) + b2(asst) + d4(user) + e5(asst) = 4 筆；c3 被過濾
    expect(flushed.length).toBe(4);
    const texts = flushed.map((p) => p.formatted);
    expect(texts.some((t) => t.includes('first question'))).toBe(true);
    expect(texts.some((t) => t.includes('first reply'))).toBe(true);
    expect(texts.some((t) => t.includes('rephrased question'))).toBe(true);
    expect(texts.some((t) => t.includes('final answer'))).toBe(true);
    // 死分支不出現
    expect(texts.some((t) => t.includes('dead branch'))).toBe(false);
  });

  test('flush 後切換為 live 模式：新行直接輸出', () => {
    const parser = new PiLineParser();
    parser.beginHistory();
    for (const line of branchedLines) parser.parse(line);
    parser.flushHistory();

    const liveLine = JSON.stringify({
      type: 'message',
      id: 'f6',
      parentId: 'e5',
      timestamp: '2026-08-29T10:04:00.000Z',
      message: { role: 'user', content: 'live follow-up' },
    });
    const parsed = parser.parse(liveLine);
    expect(parsed).not.toBeNull();
    expect(parsed!.formatted).toContain('live follow-up');
  });

  test('重複 flushHistory 為 no-op', () => {
    const parser = new PiLineParser();
    parser.beginHistory();
    parser.parse(branchedLines[1]!);
    expect(parser.flushHistory().length).toBe(1);
    expect(parser.flushHistory().length).toBe(0);
  });

  test('未呼叫 beginHistory 時為純 live 模式（向後相容）', () => {
    const parser = new PiLineParser();
    const parsed = parser.parse(branchedLines[1]!);
    expect(parsed).not.toBeNull();
  });

  test('-n 截斷的歷史：parent 不在 buffer 時 walk 到 buffer 邊界為止', () => {
    const parser = new PiLineParser();
    parser.beginHistory();
    // 只餵最後兩行（模擬 initialLines 截斷，parent b2 不在 buffer）
    parser.parse(branchedLines[4]!); // d4
    parser.parse(branchedLines[5]!); // e5
    const flushed = parser.flushHistory();
    expect(flushed.length).toBe(2);
  });

  test('leaf 是 session_info（/name）時 walk 正確且輸出 TITL', () => {
    // pi 會把 /name 等 metadata entry append 在檔尾，
    // 它們是 tree 的一部分但不是 message — walk 從它開始
    const parser = new PiLineParser();
    parser.beginHistory();
    parser.parse(branchedLines[1]!); // a1 user
    parser.parse(branchedLines[2]!); // b2 assistant
    parser.parse(
      JSON.stringify({
        type: 'session_info',
        id: 'si1',
        parentId: 'b2',
        timestamp: '2026-08-29T10:00:04.000Z',
        name: 'renamed',
      })
    );
    const flushed = parser.flushHistory();
    // a1(user) + b2(asst) + session_info(TITL) = 3 筆
    expect(flushed.length).toBe(3);
    expect(flushed[2]!.type).toBe('custom-title');
  });

  test('leaf 本身是不產生輸出的 entry（model_change）時 walk 穿過它', () => {
    // model_change 是 leaf（最後一行）但不產生輸出 — walk 從它開始
    // 沿 parentId 走回 root，只輸出路徑上的 message entries
    const parser = new PiLineParser();
    parser.beginHistory();
    parser.parse(branchedLines[1]!); // a1 user
    parser.parse(branchedLines[2]!); // b2 assistant
    parser.parse(
      JSON.stringify({
        type: 'model_change',
        id: 'mc1',
        parentId: 'b2',
        timestamp: '2026-08-29T10:00:03.000Z',
        provider: 'openai',
        modelId: 'gpt-4o',
      })
    );
    const flushed = parser.flushHistory();
    // a1(user) + b2(asst) = 2 筆；model_change leaf 本身不輸出
    expect(flushed.length).toBe(2);
    expect(flushed.every((p) => p.type !== 'custom-title')).toBe(true);
  });
});

// ─── Finder 測試 ───────────────────────────────────────────────

describe('PiSessionFinder', () => {
  const tmpDir = join(__dirname, 'tmp-pi-test');
  const projDir = join(tmpDir, '--tmp-pi-proj--');
  const otherDir = join(tmpDir, '--tmp-other-proj--');
  const fileA = join(projDir, `2026-08-29T10-00-00-000Z_${UUID_A}.jsonl`);
  const fileB = join(otherDir, `2026-08-29T11-00-00-000Z_${UUID_B}.jsonl`);

  beforeEach(() => {
    mkdirSync(projDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      fileA,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: UUID_A,
          timestamp: '2026-08-29T10:00:00.000Z',
          cwd: '/tmp/pi-proj',
        }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-08-29T10:00:05.000Z',
          message: { role: 'user', content: 'question A' },
        }),
      ].join('\n') + '\n'
    );
    writeFileSync(
      fileB,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: UUID_B,
          timestamp: '2026-08-29T11:00:00.000Z',
          cwd: '/tmp/other-proj',
        }),
        JSON.stringify({
          type: 'session_info',
          id: 'n1',
          parentId: 'm9',
          timestamp: '2026-08-29T11:00:10.000Z',
          name: 'Named session',
        }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          parentId: null,
          timestamp: '2026-08-29T11:00:15.000Z',
          message: { role: 'user', content: 'question B' },
        }),
      ].join('\n') + '\n'
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findLatest 回傳 mtime 最新的 session', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const latest = await finder.findLatest({});
    expect(latest).not.toBeNull();
    expect(latest!.path).toBe(fileB);
    expect(latest!.agentType).toBe('pi');
  });

  test('project 過濾（fuzzy match 目錄名）', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const latest = await finder.findLatest({ project: 'pi-proj' });
    expect(latest!.path).toBe(fileA);

    const none = await finder.findLatest({ project: 'no-such-project' });
    expect(none).toBeNull();
  });

  test('listSessions enrich lastActivityTime 與 session name', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const items = await finder.listSessions({ limit: 10 });
    expect(items.length).toBe(2);

    const b = items.find((i) => i.path === fileB)!;
    expect(b.customTitle).toBe('Named session');
    expect(b.lastActivityTime).toBeInstanceOf(Date);
    expect(b.lastActivityTime!.toISOString()).toBe('2026-08-29T11:00:15.000Z');
    expect(b.shortId).toBe(UUID_B.slice(0, 8));
    expect(b.project).toBe('tmp-other-proj');
  });

  test('findBySessionId 支援 8 碼前綴 partial match', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const found = await finder.findBySessionId(UUID_B.slice(0, 8));
    expect(found).not.toBeNull();
    expect(found!.path).toBe(fileB);
  });

  test('getProjectInfo 讀 header cwd', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const info = await finder.getProjectInfo(fileA);
    expect(info).not.toBeNull();
    expect(info!.projectDir).toBe('/tmp/pi-proj');
  });

  test('findLatestInProject 依編碼目錄找最新', async () => {
    const finder = new PiSessionFinder({ baseDir: tmpDir });
    const found = await finder.findLatestInProject('/tmp/pi-proj');
    expect(found).not.toBeNull();
    expect(found!.path).toBe(fileA);
  });

  test('findLatestInProject 用 header cwd 嚴格過濾 encoded 目錄碰撞', async () => {
    // /tmp/collide-wrong 與 /tmp/collide/wrong 都編碼為 --tmp-collide-wrong--；
    // 錯的專案 session mtime 較新，也不能選它（codex review 回歸鎖）
    const collideDir = join(tmpDir, '--tmp-collide-wrong--');
    mkdirSync(collideDir, { recursive: true });
    const wrongFile = join(
      collideDir,
      `2026-08-29T12-00-00-000Z_${UUID_A}.jsonl`
    );
    const rightFile = join(
      collideDir,
      `2026-08-29T11-00-00-000Z_${UUID_B}.jsonl`
    );
    writeFileSync(
      wrongFile,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: UUID_A,
        timestamp: '2026-08-29T12:00:00.000Z',
        cwd: '/tmp/collide/wrong',
      }) + '\n'
    );
    writeFileSync(
      rightFile,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: UUID_B,
        timestamp: '2026-08-29T11:00:00.000Z',
        cwd: '/tmp/collide-wrong',
      }) + '\n'
    );
    try {
      const finder = new PiSessionFinder({ baseDir: tmpDir });
      // mtime 較新的 wrongFile 屬於 /tmp/collide/wrong，不可選
      const right = await finder.findLatestInProject('/tmp/collide-wrong');
      expect(right).not.toBeNull();
      expect(right!.path).toBe(rightFile);
      // 反向：查碰撞的另一個專案只回傳它的 session
      const wrong = await finder.findLatestInProject('/tmp/collide/wrong');
      expect(wrong).not.toBeNull();
      expect(wrong!.path).toBe(wrongFile);
      // 沒有任何候選吻合 → null（寧可不切換）
      const none = await finder.findLatestInProject('/tmp/collide-other');
      expect(none).toBeNull();
    } finally {
      rmSync(collideDir, { recursive: true, force: true });
    }
  });

  test('encodePiProjectDir 編碼規則', () => {
    expect(encodePiProjectDir('/Users/x/code/foo')).toBe(
      '--Users-x-code-foo--'
    );
    expect(encodePiProjectDir('/Users/x/code/foo/')).toBe(
      '--Users-x-code-foo--'
    );
  });

  test('extractUuidFromFilename', () => {
    expect(
      extractUuidFromFilename(`2026-08-29T10-00-00-000Z_${UUID_A}.jsonl`)
    ).toBe(UUID_A);
  });
});
