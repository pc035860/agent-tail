import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { AgyAgent } from '../../src/agents/agy/agy-agent';
import { drainParser } from '../../src/utils/parser-drain';
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { ParsedLine } from '../../src/core/types';

describe('AgyAgent', () => {
  const tmpDir = join(__dirname, 'tmp-agy-test');
  const baseDir = join(tmpDir, 'conversations');
  const tmpHistory = join(tmpDir, 'history.jsonl');
  const tmpCache = join(tmpDir, 'last_conversations.json');
  const sessionUuid = '483ea588-af5e-48c1-96bd-18151eb12c5c';
  const sessionFile = join(baseDir, `${sessionUuid}.db`);
  const transcriptPath = join(
    tmpDir,
    'brain',
    sessionUuid,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  const customPaths = {
    baseDir,
    historyPath: tmpHistory,
    cachePath: tmpCache,
  };

  beforeEach(() => {
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      for (const f of [tmpHistory, tmpCache, sessionFile, transcriptPath]) {
        if (existsSync(f)) unlinkSync(f);
      }
      // 由內而外移除空目錄（bun-types 的 rmdirSync 只接受單一參數）
      const logsDir = join(
        tmpDir,
        'brain',
        sessionUuid,
        '.system_generated',
        'logs'
      );
      const sysgenDir = join(tmpDir, 'brain', sessionUuid, '.system_generated');
      const uuidDir = join(tmpDir, 'brain', sessionUuid);
      const brainDir = join(tmpDir, 'brain');
      for (const d of [
        logsDir,
        sysgenDir,
        uuidDir,
        brainDir,
        baseDir,
        tmpDir,
      ]) {
        if (existsSync(d)) rmdirSync(d);
      }
    } catch {
      // ignore
    }
  });

  test('AgySessionFinder lists sessions and resolves brain transcript as tail path', async () => {
    // 建立臨時歷史日誌（conversationId -> workspace 映射來源之一）
    const historyLine = JSON.stringify({
      display: 'Hello Antigravity',
      timestamp: 1779344903839,
      workspace: '/Users/pc035860/code/agent-tail',
      conversationId: sessionUuid,
    });
    writeFileSync(tmpHistory, historyLine + '\n');

    // 建立臨時 cache 檔案
    const cacheData = {
      '/Users/pc035860/code/agent-tail': sessionUuid,
    };
    writeFileSync(tmpCache, JSON.stringify(cacheData));

    // 建立 session 檔（.db SQLite）與 brain transcript（可讀 JSONL）
    writeFileSync(sessionFile, '');
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'USER_INPUT', content: 'hi' }) + '\n'
    );

    const agent = new AgyAgent({ verbose: false }, customPaths);

    // 全域列表
    const list = await agent.finder.listSessions({});
    expect(list).toHaveLength(1);
    expect(list[0]!.shortId).toBe(sessionUuid.slice(0, 8));
    expect(list[0]!.project).toBe('agent-tail');
    // tail 目標應為 brain transcript，而非 binary .db
    expect(list[0]!.path).toBe(transcriptPath);

    // --project 路徑片段匹配
    const listFiltered = await agent.finder.listSessions({
      project: 'code/agent',
    });
    expect(listFiltered).toHaveLength(1);

    // findLatestInProject
    const latest = await agent.finder.findLatestInProject(
      '/Users/pc035860/code/agent-tail'
    );
    expect(latest).not.toBeNull();
    expect(latest?.path).toBe(transcriptPath);

    // getProjectInfo 接受 transcript 路徑
    const projectInfo = await agent.finder.getProjectInfo(transcriptPath);
    expect(projectInfo).not.toBeNull();
    expect(projectInfo?.displayName).toBe('agent-tail');
  });

  test('AgySessionFinder excludes sessions without a brain transcript', async () => {
    writeFileSync(tmpCache, JSON.stringify({}));
    writeFileSync(sessionFile, '');
    // 不建立 transcript → 空 session，應被排除（避免 tail 卡死在 binary .db）

    const agent = new AgyAgent({ verbose: false }, customPaths);
    const list = await agent.finder.listSessions({});
    expect(list).toHaveLength(0);
  });

  test('AgySessionFinder dedups .pb and .db with same uuid', async () => {
    writeFileSync(tmpCache, JSON.stringify({}));
    writeFileSync(sessionFile, '');
    writeFileSync(sessionFile.replace('.db', '.pb'), '');
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, 'x\n');

    const agent = new AgyAgent({ verbose: false }, customPaths);
    const list = await agent.finder.listSessions({});
    expect(list).toHaveLength(1);

    unlinkSync(sessionFile.replace('.db', '.pb'));
  });

  test('AgyLineParser parses transcript lines with correct semantics', () => {
    const agent = new AgyAgent({ verbose: false }, customPaths);
    const parser = agent.parser;
    // MultiEmitParser drain 契約：每個 line 都要用 drainParser 完整消化
    const drain = (line: string): ParsedLine[] => {
      const out: ParsedLine[] = [];
      drainParser(parser, line, (p) => out.push(p));
      return out;
    };

    // USER_INPUT → user
    const user = drain(
      JSON.stringify({
        type: 'USER_INPUT',
        created_at: '2026-09-03T04:29:36Z',
        content: 'hello',
      })
    );
    expect(user).toHaveLength(1);
    expect(user[0]?.type).toBe('user');
    expect(user[0]?.formatted).toContain('hello');

    // GENERIC → output（tool 執行輸出，不是 assistant 發言）
    const gen = drain(
      JSON.stringify({
        type: 'GENERIC',
        created_at: '2026-09-03T04:29:36Z',
        content: 'Created At: ...\nFile Path: ...',
      })
    );
    expect(gen).toHaveLength(1);
    expect(gen[0]?.type).toBe('output');

    // PLANNER_RESPONSE content → assistant（真正的模型回覆）
    const asst = drain(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-03T04:29:36Z',
        content: 'I will check the code',
      })
    );
    expect(asst).toHaveLength(1);
    expect(asst[0]?.type).toBe('assistant');
    expect(asst[0]?.formatted).toContain('I will check');

    // PLANNER_RESPONSE with tool_calls → function_call（multi-emit，drain）
    const emitted = drain(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-03T04:29:36Z',
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: '"/a/b.py"' } },
          { name: 'grep_search', args: { Pattern: '"foo"' } },
        ],
      })
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.type).toBe('function_call');
    expect(emitted[0]?.toolName).toBe('view_file');
    expect(emitted[1]?.type).toBe('function_call');
    expect(emitted[1]?.toolName).toBe('grep_search');

    // 舊格式 VIEW_FILE → output
    const out = drain(
      JSON.stringify({
        type: 'VIEW_FILE',
        created_at: '2026-09-03T04:29:36Z',
        content: 'File: x',
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('output');

    // SYSTEM_MESSAGE → 跳過
    expect(
      drain(JSON.stringify({ type: 'SYSTEM_MESSAGE', content: 'notice' }))
    ).toHaveLength(0);

    // 相同 line 去重
    const dupLine = JSON.stringify({
      type: 'GENERIC',
      content: 'dup',
    });
    expect(drain(dupLine)).toHaveLength(1);
    expect(drain(dupLine)).toHaveLength(0);
  });

  test('AgyLineParser emits thinking alongside tool_calls/content in verbose mode', () => {
    const verbose = new AgyAgent({ verbose: true }, customPaths);
    const emitted: ParsedLine[] = [];
    drainParser(
      verbose.parser,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-03T04:29:36Z',
        thinking: 'thinking...',
        tool_calls: [{ name: 'view_file', args: {} }],
      }),
      (p) => emitted.push(p)
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.type).toBe('reasoning');
    expect(emitted[1]?.type).toBe('function_call');

    const nonVerbose = new AgyAgent({ verbose: false }, customPaths);
    const emitted2: ParsedLine[] = [];
    drainParser(
      nonVerbose.parser,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        thinking: 'thinking...',
        content: 'reply',
      }),
      (p) => emitted2.push(p)
    );
    expect(emitted2).toHaveLength(1);
    expect(emitted2[0]?.type).toBe('assistant');
  });

  test('AgyLineParser drains large transcript without truncation', () => {
    const agent = new AgyAgent({ verbose: false }, customPaths);
    const parser = agent.parser;
    const emitted: string[] = [];
    for (let i = 0; i < 120; i++) {
      drainParser(
        parser,
        JSON.stringify({
          type: 'GENERIC',
          created_at: '2026-09-03T04:29:36Z',
          content: `Prompt number ${i}`,
        }),
        (p) => emitted.push(p.formatted)
      );
    }
    expect(emitted).toHaveLength(120);
    expect(emitted[0]).toContain('Prompt number 0');
    expect(emitted[119]).toContain('Prompt number 119');
  });
});
