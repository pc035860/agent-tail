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
import { join } from 'node:path';

describe('AgyAgent', () => {
  const tmpDir = join(__dirname, 'tmp-agy-test');
  const tmpHistory = join(tmpDir, 'history.jsonl');
  const tmpCache = join(tmpDir, 'last_conversations.json');
  const sessionUuid = '483ea588-af5e-48c1-96bd-18151eb12c5c';
  const sessionFile = join(tmpDir, `${sessionUuid}.pb`);
  const customPaths = {
    baseDir: tmpDir,
    historyPath: tmpHistory,
    cachePath: tmpCache,
  };

  beforeEach(() => {
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      if (existsSync(tmpHistory)) unlinkSync(tmpHistory);
      if (existsSync(tmpCache)) unlinkSync(tmpCache);
      if (existsSync(sessionFile)) unlinkSync(sessionFile);
      if (existsSync(tmpDir)) rmdirSync(tmpDir);
    } catch {
      // ignore
    }
  });

  test('AgySessionFinder lists and filters sessions (clean path injection and full-path project filtering)', async () => {
    // 建立臨時歷史日誌
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

    // 建立一個空的 .pb
    writeFileSync(sessionFile, '');

    // 使用優雅的路徑注入，不需使用 as any 進行私有屬性篡改！
    const agent = new AgyAgent({ verbose: false }, customPaths);

    // 測試全域列表
    const list = await agent.finder.listSessions({});
    expect(list).toHaveLength(1);
    expect(list[0]!.shortId).toBe(sessionUuid.slice(0, 8));
    expect(list[0]!.project).toBe('agent-tail');

    // 測試 --project 支援路徑片段匹配 (如 "code/agent")
    const listFiltered = await agent.finder.listSessions({
      project: 'code/agent',
    });
    expect(listFiltered).toHaveLength(1);

    // 測試 findLatestInProject (重用 mapping 載入優化)
    const latest = await agent.finder.findLatestInProject(
      '/Users/pc035860/code/agent-tail'
    );
    expect(latest).not.toBeNull();
    expect(latest?.path).toContain(sessionUuid);

    const projectInfo = await agent.finder.getProjectInfo(sessionFile);
    expect(projectInfo).not.toBeNull();
    expect(projectInfo?.displayName).toBe('agent-tail');
  });

  test('AgyLineParser parses and drains new history logs with exact line deduplication', () => {
    // 建立臨時歷史日誌，包含重複的時間戳但不同的 display
    const historyData = [
      {
        display: 'First prompt',
        timestamp: 1000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
      {
        display: 'Second prompt with SAME timestamp',
        timestamp: 1000, // 故意製造 timestamp 相同
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
      {
        display: 'Duplicate check for exact same line',
        timestamp: 2000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
      {
        display: 'Duplicate check for exact same line', // 故意製造完全重複行
        timestamp: 2000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
    ];

    writeFileSync(
      tmpHistory,
      historyData.map((d) => JSON.stringify(d)).join('\n') + '\n'
    );

    const agent = new AgyAgent({ verbose: false }, customPaths);
    agent.parser.setConversationId(sessionUuid);

    // 第一次呼叫，輸出第一筆
    const parsed1 = agent.parser.parse('dummy-line');
    expect(parsed1).not.toBeNull();
    expect(parsed1?.formatted).toContain('First prompt');

    // 第二次呼叫，即使 timestamp 與上一筆完全相同，但因為 display 不同 (無損去重)，依舊能精確讀出！
    const parsed2 = agent.parser.parse('dummy-line');
    expect(parsed2).not.toBeNull();
    expect(parsed2?.formatted).toContain('Second prompt with SAME timestamp');

    // 第三次呼叫，輸出 Duplicate 訊息
    const parsed3 = agent.parser.parse('dummy-line');
    expect(parsed3).not.toBeNull();
    expect(parsed3?.formatted).toContain('Duplicate check for exact same line');

    // 第四次呼叫，因為是完全重複的行，會被精確去重過濾，直接回傳 null (空了)
    const parsed4 = agent.parser.parse('dummy-line');
    expect(parsed4).toBeNull();
  });

  test('AgyLineParser supports extremely large session history (> 100 entries) without being truncated', () => {
    // 建立 120 筆對話歷史
    const historyData = [];
    for (let i = 0; i < 120; i++) {
      historyData.push({
        display: `Prompt number ${i}`,
        timestamp: 1000 + i,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      });
    }

    writeFileSync(
      tmpHistory,
      historyData.map((d) => JSON.stringify(d)).join('\n') + '\n'
    );

    const agent = new AgyAgent({ verbose: false }, customPaths);
    agent.parser.setConversationId(sessionUuid);

    // 使用真實的 drainParser，模擬 tail / summary 行為
    const emittedLines: string[] = [];
    drainParser(agent.parser, 'dummy-line', (parsed) => {
      emittedLines.push(parsed.formatted);
    });

    // 確保 120 筆完全載入，徹底解決 100 筆被 DRAIN_GUARD_MAX 截斷的重大漏洞！
    expect(emittedLines).toHaveLength(120);
    expect(emittedLines[0]).toContain('Prompt number 0');
    expect(emittedLines[119]).toContain('Prompt number 119');
  });
});
