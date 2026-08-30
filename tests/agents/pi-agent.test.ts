import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  PiSessionFinder,
  PiLineParser,
  encodePiProjectDir,
} from '../../src/agents/pi/pi-agent.ts';
import { ActivePathFilter } from '../../src/core/active-path-filter.ts';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { drainParser } from '../../src/utils/parser-drain.ts';

function sessionHeader(cwd: string, id = 'sess-1'): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-08-30T01:00:00.000Z',
    cwd,
  });
}

function entry(
  type: string,
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type,
    id,
    parentId,
    timestamp: '2026-08-30T01:00:00.000Z',
    ...extra,
  });
}

describe('encodePiProjectDir', () => {
  test('strips leading slash and encodes / as -', () => {
    expect(encodePiProjectDir('/Users/x/code/foo')).toBe(
      '--Users-x-code-foo--'
    );
  });

  test('strips trailing slash', () => {
    expect(encodePiProjectDir('/foo/')).toBe('--foo--');
  });

  test('root path', () => {
    expect(encodePiProjectDir('/')).toBe('----');
  });
});

describe('PiSessionFinder', () => {
  let tempDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-finder-'));
    baseDir = join(tempDir, 'sessions');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(baseDir, '--Users-x-code-foo--'), { recursive: true });
    await mkdir(join(baseDir, '--Users-x-code-bar--'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeSession(
    encodedDir: string,
    filename: string,
    lines: string[]
  ): Promise<string> {
    const path = join(baseDir, encodedDir, filename);
    await writeFile(path, lines.join('\n') + '\n');
    return path;
  }

  test('findLatest returns most recent session', async () => {
    const older = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    const newer = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T02-00-00-000Z_b.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    // 確保 mtime 可區分（同毫秒寫入時 sort 不穩定）
    await utimes(
      older,
      new Date('2026-08-30T01:00:00Z'),
      new Date('2026-08-30T01:00:00Z')
    );
    await utimes(
      newer,
      new Date('2026-08-30T02:00:00Z'),
      new Date('2026-08-30T02:00:00Z')
    );

    const finder = new PiSessionFinder({ baseDir });
    const latest = await finder.findLatest();
    expect(latest?.path).toContain('b.jsonl');
  });

  test('findLatest honors project filter (encoded dir fuzzy)', async () => {
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    await writeSession(
      '--Users-x-code-bar--',
      '2026-08-30T02-00-00-000Z_b.jsonl',
      [sessionHeader('/Users/x/code/bar')]
    );

    const finder = new PiSessionFinder({ baseDir });
    const latest = await finder.findLatest({ project: 'bar' });
    expect(latest?.path).toContain('b.jsonl');
  });

  test('listSessions populates customTitle from session_info name', async () => {
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [
        sessionHeader('/Users/x/code/foo'),
        entry('session_info', 's1', 'a', { name: 'my session' }),
      ]
    );

    const finder = new PiSessionFinder({ baseDir });
    const items = await finder.listSessions();
    expect(items).toHaveLength(1);
    expect(items[0]!.customTitle).toBe('my session');
    expect(items[0]!.shortId).toBe('a');
  });

  test('listSessions sorts by lastActivityTime (not mtime)', async () => {
    // session A：mtime 較新但最後 entry timestamp 較舊
    // session B：mtime 較舊但最後 entry timestamp 較新
    const a = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [
        sessionHeader('/Users/x/code/foo', 'a'),
        entry('message', 'm1', 'a', {
          timestamp: '2026-08-30T01:00:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'old' }],
          },
        }),
      ]
    );
    const b = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T02-00-00-000Z_b.jsonl',
      [
        sessionHeader('/Users/x/code/foo', 'b'),
        entry('message', 'm2', 'b', {
          timestamp: '2026-08-30T03:00:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'new' }],
          },
        }),
      ]
    );
    // A 的 mtime 較新（04:00），B 的 activity 較新（03:00）
    await utimes(
      a,
      new Date('2026-08-30T04:00:00Z'),
      new Date('2026-08-30T04:00:00Z')
    );
    await utimes(
      b,
      new Date('2026-08-30T02:00:00Z'),
      new Date('2026-08-30T02:00:00Z')
    );

    const finder = new PiSessionFinder({ baseDir });
    const items = await finder.listSessions();
    // 依 lastActivityTime 排序：B（03:00）應在 A（01:00）前面
    expect(items[0]!.path).toContain('b.jsonl');
    expect(items[1]!.path).toContain('a.jsonl');
  });

  test('listSessions limit does not exclude activity-newest session (enrich-before-slice)', async () => {
    // 3 個 session：A mtime 最新但 activity 最舊，C mtime 最舊但 activity 最新
    const a = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [
        sessionHeader('/Users/x/code/foo', 'a'),
        entry('message', 'm1', 'a', {
          timestamp: '2026-08-30T01:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'a' }] },
        }),
      ]
    );
    const b = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T02-00-00-000Z_b.jsonl',
      [
        sessionHeader('/Users/x/code/foo', 'b'),
        entry('message', 'm2', 'b', {
          timestamp: '2026-08-30T02:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'b' }] },
        }),
      ]
    );
    const c = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T03-00-00-000Z_c.jsonl',
      [
        sessionHeader('/Users/x/code/foo', 'c'),
        entry('message', 'm3', 'c', {
          timestamp: '2026-08-30T03:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'c' }] },
        }),
      ]
    );
    // mtime：A(05:00) > B(04:00) > C(01:00)；activity：C(03:00) > B(02:00) > A(01:00)
    await utimes(
      a,
      new Date('2026-08-30T05:00:00Z'),
      new Date('2026-08-30T05:00:00Z')
    );
    await utimes(
      b,
      new Date('2026-08-30T04:00:00Z'),
      new Date('2026-08-30T04:00:00Z')
    );
    await utimes(
      c,
      new Date('2026-08-30T01:00:00Z'),
      new Date('2026-08-30T01:00:00Z')
    );

    const finder = new PiSessionFinder({ baseDir });
    const items = await finder.listSessions({ limit: 2 });
    // activity 排序：C, B, A → limit 2 = [C, B]（C 不被 mtime 排名排除）
    expect(items).toHaveLength(2);
    expect(items[0]!.path).toContain('c.jsonl');
    expect(items[1]!.path).toContain('b.jsonl');
  });

  test('findBySessionId matches uuid prefix', async () => {
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_abcdef12.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );

    const finder = new PiSessionFinder({ baseDir });
    const found = await finder.findBySessionId('abcdef');
    expect(found?.path).toContain('abcdef12.jsonl');
  });

  test('findBySessionId disambiguates multiple matches by header cwd (§4.7)', async () => {
    // 兩個 session 的 shortId 前綴相同（碰撞場景）
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_abcdef12.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    await writeSession(
      '--Users-x-code-bar--',
      '2026-08-30T02-00-00-000Z_abcdef34.jsonl',
      [sessionHeader('/Users/x/code/bar')]
    );

    const finder = new PiSessionFinder({ baseDir });
    // 多重匹配 + project filter → header cwd 消歧
    const found = await finder.findBySessionId('abcdef', { project: 'bar' });
    expect(found?.path).toContain('abcdef34.jsonl');
  });

  test('findBySessionId returns null when project filter matches none (§4.7)', async () => {
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_abcdef12.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    await writeSession(
      '--Users-x-code-bar--',
      '2026-08-30T02-00-00-000Z_abcdef34.jsonl',
      [sessionHeader('/Users/x/code/bar')]
    );

    const finder = new PiSessionFinder({ baseDir });
    // 多重匹配 + project 完全不符 → null（-p 過濾不該靜默導向錯誤 session）
    const found = await finder.findBySessionId('abcdef', {
      project: 'no-such',
    });
    expect(found).toBeNull();
  });

  test('getProjectInfo reads authoritative cwd from header', async () => {
    const path = await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );

    const finder = new PiSessionFinder({ baseDir });
    const info = await finder.getProjectInfo(path);
    expect(info?.projectDir).toBe('/Users/x/code/foo');
    expect(info?.displayName).toBe('foo');
  });

  test('findLatestInProject verifies header cwd (collision-safe)', async () => {
    // /foo-bar 與 /foo/bar 都 encode 成 --foo-bar--（碰撞到同一目錄）
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(baseDir, '--foo-bar--'), { recursive: true });
    await writeSession('--foo-bar--', '2026-08-30T01-00-00-000Z_a.jsonl', [
      sessionHeader('/foo-bar'),
    ]);
    await writeSession('--foo-bar--', '2026-08-30T02-00-00-000Z_b.jsonl', [
      sessionHeader('/foo/bar'),
    ]);

    const finder = new PiSessionFinder({ baseDir });
    // 找 cwd = /foo-bar 的最新 session → 只有 a 吻合（b 的 header cwd 是 /foo/bar）
    const found = await finder.findLatestInProject('/foo-bar');
    expect(found?.path).toContain('a.jsonl');
  });
});

describe('PiLineParser', () => {
  function parseAll(lines: string[], verbose = false): string[] {
    const parser = new PiLineParser({ verbose });
    const out: string[] = [];
    for (const line of lines) {
      drainParser(parser, line, (p) => out.push(`${p.type}:${p.formatted}`));
    }
    return out;
  }

  test('session header is skipped', () => {
    const out = parseAll([sessionHeader('/Users/x')]);
    expect(out).toEqual([]);
  });

  test('model_change / thinking_level_change are skipped', () => {
    const out = parseAll([
      entry('model_change', 'm1', null, { modelId: 'x' }),
      entry('thinking_level_change', 't1', 'm1', { thinkingLevel: 'low' }),
    ]);
    expect(out).toEqual([]);
  });

  test('user message emits USER', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
    ]);
    expect(out).toEqual(['user: hello']);
  });

  test('assistant multi-emit: thinking (verbose) + text + toolCall', () => {
    const out = parseAll(
      [
        entry('message', 'a', null, {
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'hi there' },
              {
                type: 'toolCall',
                id: 't1',
                name: 'bash',
                arguments: { command: 'ls' },
              },
            ],
          },
        }),
      ],
      true
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('reasoning: hmm');
    expect(out[1]).toBe('assistant: hi there');
    expect(out[2]).toContain('function_call:');
    expect(out[2]).toContain('bash');
  });

  test('thinking is hidden in default (non-verbose) mode', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'hi there' },
          ],
        },
      }),
    ]);
    expect(out).toEqual(['assistant: hi there']);
  });

  test('toolResult emits tool_result', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'file1' }],
        },
      }),
    ]);
    expect(out).toEqual(['tool_result: file1']);
  });

  test('toolResult marks isError', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        },
      }),
    ]);
    expect(out).toEqual(['tool_result: [error] boom']);
  });

  test('toolResult with empty content but isError still emits [error]', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'bash',
          content: [],
          isError: true,
        },
      }),
    ]);
    expect(out).toEqual(['tool_result: [error] ']);
  });

  test('bashExecution emits output (OUT) from v3 command/output/exitCode', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'bashExecution',
          command: 'ls',
          output: 'file1',
          exitCode: 0,
        },
      }),
    ]);
    expect(out).toEqual(['output: file1']);
  });

  test('bashExecution marks non-zero exit code', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'bashExecution',
          command: 'ls',
          output: 'boom',
          exitCode: 2,
        },
      }),
    ]);
    expect(out).toEqual(['output: boom [exit 2]']);
  });

  test('bashExecution falls back to command when output empty', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'bashExecution',
          command: 'ls',
          output: '',
          exitCode: 0,
        },
      }),
    ]);
    expect(out).toEqual(['output: ls']);
  });

  test('custom role emits custom, skipped when message.display=false', () => {
    const shown = parseAll([
      entry('message', 'a', null, {
        message: { role: 'custom', content: [{ type: 'text', text: 'note' }] },
      }),
    ]);
    expect(shown).toEqual(['custom: note']);

    const hidden = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'custom',
          content: [{ type: 'text', text: 'note' }],
          display: false,
        },
      }),
    ]);
    expect(hidden).toEqual([]);
  });

  test('session_info emits custom-title (TITL)', () => {
    const out = parseAll([
      entry('session_info', 's1', null, { name: 'my session' }),
    ]);
    expect(out).toEqual(['custom-title:Session renamed: "my session"']);
  });

  test('custom_message emits custom, skipped when display=false', () => {
    const shown = parseAll([
      entry('custom_message', 'c1', null, {
        content: '### [agent] completed',
        display: true,
      }),
    ]);
    expect(shown).toEqual(['custom: ### [agent] completed']);

    const hidden = parseAll([
      entry('custom_message', 'c2', null, {
        content: 'hidden',
        display: false,
      }),
    ]);
    expect(hidden).toEqual([]);
  });

  test('custom_message truncates long content in non-verbose mode', () => {
    const longText = Array.from({ length: 30 }, (_, i) => `line${i}`).join(
      '\n'
    );
    const out = parseAll([
      entry('custom_message', 'c1', null, {
        content: longText,
        display: true,
      }),
    ]);
    // 預設模式截斷（不輸出全部 30 行）
    expect(out).toHaveLength(1);
    expect(out[0]!.split('\n').length).toBeLessThan(30);
  });
});

describe('Pi tree active-path replay (ActivePathFilter + PiLineParser)', () => {
  test('replay emits only active path, excluding dead branches', () => {
    const parser = new PiLineParser({ verbose: false });
    const filter = new ActivePathFilter(
      parser,
      (e) => (e as { parentId?: string }).parentId ?? null
    );
    filter.beginHistory();

    const lines = [
      sessionHeader('/Users/x', 'sess-1'),
      entry('message', 'a', null, {
        message: { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      }),
      entry('message', 'b', 'a', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ans1' }],
        },
      }),
      // /tree 重送：b2 取代 b → b 變死分支
      entry('message', 'b2', 'a', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ans1v2' }],
        },
      }),
      entry('message', 'c', 'b2', {
        message: { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      }),
    ];
    for (const line of lines) {
      filter.parse(line);
    }

    const parts = filter.flushHistory();
    const formatted = parts.map((p) => p.formatted);
    // active path: a → b2 → c（b 被排除）
    expect(formatted).toEqual([' q1', ' ans1v2', ' q2']);
    expect(formatted).not.toContain(' ans1');

    // flush 後 live 模式：新行直接透傳
    const live = filter.parse(
      entry('message', 'd', 'c', {
        message: { role: 'user', content: [{ type: 'text', text: 'q3' }] },
      })
    );
    expect(live?.formatted).toBe(' q3');
  });
});
