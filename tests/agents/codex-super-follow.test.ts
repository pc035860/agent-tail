import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgent } from '../../src/agents/codex/codex-agent.ts';
import { CodexSessionCache } from '../../src/agents/codex/session-cache.ts';

describe('CodexSessionFinder - super follow', () => {
  let tempDir: string;
  let codexSessionsDir: string;
  let finder: InstanceType<typeof CodexAgent>['finder'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-sf-'));
    codexSessionsDir = join(tempDir, 'codex', 'sessions');
    await mkdir(codexSessionsDir, { recursive: true });

    const agent = new CodexAgent({ verbose: false });
    finder = agent.finder;

    // 使用 setBaseDir 方法覆蓋（會同時更新 cache）
    (finder as unknown as { setBaseDir: (dir: string) => void }).setBaseDir(
      codexSessionsDir
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getProjectInfo', () => {
    test('parses session_meta.cwd from first line', async () => {
      // 建立日期目錄
      const dateDir = join(codexSessionsDir, '2026', '02', '20');
      await mkdir(dateDir, { recursive: true });

      const sessionPath = join(
        dateDir,
        'rollout-2026-02-20T10-00-019c7a2e-7774-76f0-a293-20ef9753cfd7.jsonl'
      );

      // 寫入 session_meta 第一行
      const sessionMeta = JSON.stringify({
        timestamp: '2026-02-20T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019c7a2e-7774-76f0-a293-20ef9753cfd7',
          cwd: '/Users/test/projects/myproject',
          cli_version: '0.104.0',
        },
      });

      await writeFile(sessionPath, sessionMeta + '\n');

      const info = await finder.getProjectInfo!(sessionPath);

      expect(info).not.toBeNull();
      expect(info!.projectDir).toBe('/Users/test/projects/myproject');
      expect(info!.displayName).toBe('/Users/test/projects/myproject');
    });

    test('returns null for file without session_meta', async () => {
      const dateDir = join(codexSessionsDir, '2026', '02', '20');
      await mkdir(dateDir, { recursive: true });

      const sessionPath = join(dateDir, 'rollout-test.jsonl');
      await writeFile(sessionPath, '{"type": "other", "payload": {}}\n');

      const info = await finder.getProjectInfo!(sessionPath);

      expect(info).toBeNull();
    });

    test('returns null for invalid JSON', async () => {
      const dateDir = join(codexSessionsDir, '2026', '02', '20');
      await mkdir(dateDir, { recursive: true });

      const sessionPath = join(dateDir, 'rollout-test.jsonl');
      await writeFile(sessionPath, 'not valid json\n');

      const info = await finder.getProjectInfo!(sessionPath);

      expect(info).toBeNull();
    });
  });
});

describe('CodexSessionCache', () => {
  let tempDir: string;
  let codexSessionsDir: string;
  let cache: CodexSessionCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-cache-'));
    codexSessionsDir = join(tempDir, 'codex', 'sessions');
    await mkdir(codexSessionsDir, { recursive: true });

    cache = new CodexSessionCache(codexSessionsDir);
  });

  afterEach(async () => {
    cache.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('builds cwd index from session_meta', async () => {
    // 建立日期目錄
    const dateDir = join(codexSessionsDir, '2026', '02', '20');
    await mkdir(dateDir, { recursive: true });

    // 建立兩個 session（同一專案）
    const session1 = join(
      dateDir,
      'rollout-2026-02-20T10-00-019c7a2e-1111-1111-1111-111111111111.jsonl'
    );
    const session2 = join(
      dateDir,
      'rollout-2026-02-20T11-00-019c7a2e-2222-2222-2222-222222222222.jsonl'
    );

    const meta1 = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/path/to/project' },
    });
    const meta2 = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/path/to/project' },
    });

    await writeFile(session1, meta1 + '\n');
    await writeFile(session2, meta2 + '\n');

    // 設定不同的 mtime
    await utimes(session1, new Date(1000), new Date(1000));
    await utimes(session2, new Date(2000), new Date(2000));

    const result = await cache.getLatestByCwd('/path/to/project');

    expect(result).not.toBeNull();
    expect(result!.path).toBe(session2); // 較新的
    expect(result!.agentType).toBe('codex');
  });

  test('ignores malformed session_meta', async () => {
    const dateDir = join(codexSessionsDir, '2026', '02', '20');
    await mkdir(dateDir, { recursive: true });

    // 建立損壞的 session
    const badSession = join(
      dateDir,
      'rollout-2026-02-20T10-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );
    // 建立正常的 session
    const goodSession = join(
      dateDir,
      'rollout-2026-02-20T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );

    await writeFile(badSession, 'not valid json\n');
    await writeFile(
      goodSession,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/project' },
      }) + '\n'
    );

    const result = await cache.getLatestByCwd('/path/to/project');

    expect(result).not.toBeNull();
    expect(result!.path).toBe(goodSession);
  });

  test('returns null for unknown cwd', async () => {
    const result = await cache.getLatestByCwd('/nonexistent/path');
    expect(result).toBeNull();
  });

  test('getAllProjects returns all known cwds', async () => {
    const dateDir = join(codexSessionsDir, '2026', '02', '20');
    await mkdir(dateDir, { recursive: true });

    // 建立兩個不同專案的 session
    const session1 = join(
      dateDir,
      'rollout-2026-02-20T10-00-019c7a2e-1111-1111-1111-111111111111.jsonl'
    );
    const session2 = join(
      dateDir,
      'rollout-2026-02-20T11-00-019c7a2e-2222-2222-2222-222222222222.jsonl'
    );

    await writeFile(
      session1,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/project1' },
      }) + '\n'
    );
    await writeFile(
      session2,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/project2' },
      }) + '\n'
    );

    const projects = await cache.getAllProjects();

    expect(projects).toContain('/path/to/project1');
    expect(projects).toContain('/path/to/project2');
  });

  test('refresh detects new sessions after initialization', async () => {
    // 建立今天的日期目錄
    const today = new Date();
    const year = today.getFullYear().toString();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    const todayDir = join(codexSessionsDir, year, month, day);
    await mkdir(todayDir, { recursive: true });

    // 建立初始 session
    const oldSession = join(
      todayDir,
      'rollout-2026-02-20T10-00-019c7a2e-old1-old1-old1-old111111111111.jsonl'
    );
    await writeFile(
      oldSession,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/project' },
      }) + '\n'
    );
    await utimes(oldSession, new Date(1000), new Date(1000));

    // 初始化 cache（會載入舊 session）
    const first = await cache.getLatestByCwd('/path/to/project');
    expect(first).not.toBeNull();
    expect(first!.path).toBe(oldSession);

    // 等待刷新間隔（2 秒 + buffer）
    await new Promise((r) => setTimeout(r, 2100));

    // 新增較新的 session
    const newSession = join(
      todayDir,
      'rollout-2026-02-20T11-00-019c7a2e-new2-new2-new2-new222222222222.jsonl'
    );
    await writeFile(
      newSession,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/project' },
      }) + '\n'
    );
    await utimes(newSession, new Date(2000), new Date(2000));

    // 再次查詢，應該返回新的 session
    const second = await cache.getLatestByCwd('/path/to/project');
    expect(second).not.toBeNull();
    expect(second!.path).toBe(newSession);
  });
});
