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
    // 兩個 encoded dir 不同但 header cwd 都指向 foo（碰撞）
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(baseDir, '--Users-x-code-foo-bar--'), { recursive: true });
    await writeSession(
      '--Users-x-code-foo--',
      '2026-08-30T01-00-00-000Z_a.jsonl',
      [sessionHeader('/Users/x/code/foo')]
    );
    await writeSession(
      '--Users-x-code-foo-bar--',
      '2026-08-30T02-00-00-000Z_b.jsonl',
      [sessionHeader('/Users/x/code/foo/bar')]
    );

    const finder = new PiSessionFinder({ baseDir });
    // 找 cwd = /Users/x/code/foo 的最新 session → 只有 a 吻合
    const found = await finder.findLatestInProject('/Users/x/code/foo');
    expect(found?.path).toContain('a.jsonl');
  });
});

describe('PiLineParser', () => {
  function parseAll(lines: string[]): string[] {
    const parser = new PiLineParser({ verbose: false });
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

  test('assistant multi-emit: thinking + text + toolCall', () => {
    const out = parseAll([
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
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('reasoning: hmm');
    expect(out[1]).toBe('assistant: hi there');
    expect(out[2]).toContain('function_call:');
    expect(out[2]).toContain('bash');
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

  test('bashExecution emits output (OUT)', () => {
    const out = parseAll([
      entry('message', 'a', null, {
        message: {
          role: 'bashExecution',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ]);
    expect(out).toEqual(['output: done']);
  });

  test('custom role emits custom, skipped when display=false', () => {
    const shown = parseAll([
      entry('message', 'a', null, {
        message: { role: 'custom', content: [{ type: 'text', text: 'note' }] },
      }),
    ]);
    expect(shown).toEqual(['custom: note']);

    const hidden = parseAll([
      entry('message', 'a', null, {
        display: false,
        message: { role: 'custom', content: [{ type: 'text', text: 'note' }] },
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
