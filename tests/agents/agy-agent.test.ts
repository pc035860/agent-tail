import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { AgyAgent } from '../../src/agents/agy/agy-agent';
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

  test('AgySessionFinder lists and filters sessions', async () => {
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

    const agent = new AgyAgent();
    // 修改 finder 中的路徑
    (agent.finder as any).baseDir = tmpDir;
    (agent.finder as any).historyPath = tmpHistory;
    (agent.finder as any).cachePath = tmpCache;

    const list = await agent.finder.listSessions({});
    expect(list).toHaveLength(1);
    expect(list[0]!.shortId).toBe(sessionUuid.slice(0, 8));
    expect(list[0]!.project).toBe('agent-tail');

    const projectInfo = await agent.finder.getProjectInfo(sessionFile);
    expect(projectInfo).not.toBeNull();
    expect(projectInfo?.displayName).toBe('agent-tail');
  });

  test('AgyLineParser parses and drains new history logs', () => {
    // 建立臨時歷史日誌
    const historyData = [
      {
        display: 'First prompt',
        timestamp: 1000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
      {
        display: 'Second prompt',
        timestamp: 2000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: sessionUuid,
      },
      {
        display: 'Other session prompt',
        timestamp: 3000,
        workspace: '/Users/pc035860/code/agent-tail',
        conversationId: 'different-uuid',
      },
    ];

    writeFileSync(
      tmpHistory,
      historyData.map((d) => JSON.stringify(d)).join('\n') + '\n'
    );

    const agent = new AgyAgent();
    // 修改 parser 中的路徑
    (agent.parser as any).historyPath = tmpHistory;
    agent.parser.setConversationId(sessionUuid);

    // 第一次調用 parse，應該載入並輸出第一筆
    const parsed1 = agent.parser.parse('dummy-line');
    expect(parsed1).not.toBeNull();
    expect(parsed1?.formatted).toContain('First prompt');

    // 第二次調用 parse (像 drainParser)，輸出第二筆
    const parsed2 = agent.parser.parse('dummy-line');
    expect(parsed2).not.toBeNull();
    expect(parsed2?.formatted).toContain('Second prompt');

    // 第三次調用 parse，已經空了，應該為 null (忽略 different-uuid)
    const parsed3 = agent.parser.parse('dummy-line');
    expect(parsed3).toBeNull();
  });
});
