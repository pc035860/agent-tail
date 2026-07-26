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

  test('listAllSessions syncs sessions outside today (not only maybeRefresh)', async () => {
    const oldDateDir = join(codexSessionsDir, '2026', '01', '15');
    await mkdir(oldDateDir, { recursive: true });

    const firstPath = join(
      oldDateDir,
      'rollout-2026-01-15T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    await writeFile(
      firstPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/listed' },
      }) + '\n'
    );
    await utimes(firstPath, new Date(1000), new Date(1000));

    // Cold init builds cache with the first session
    const initial = await cache.listAllSessions();
    expect(initial).toHaveLength(1);
    expect(initial[0]!.path).toBe(firstPath);

    // Add another session in a non-today directory after cache is warm
    const secondPath = join(
      oldDateDir,
      'rollout-2026-01-15T11-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/listed' },
      }) + '\n'
    );
    await utimes(secondPath, new Date(5000), new Date(5000));

    const synced = await cache.listAllSessions();
    expect(synced).toHaveLength(2);
    expect(synced.map((s) => s.path)).toContain(secondPath);
    expect(synced.map((s) => s.path)).toContain(firstPath);
  });

  test('listAllSessions refreshes mtime for already-cached paths', async () => {
    const dateDir = join(codexSessionsDir, '2026', '01', '20');
    await mkdir(dateDir, { recursive: true });

    const pathA = join(
      dateDir,
      'rollout-2026-01-20T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    const pathB = join(
      dateDir,
      'rollout-2026-01-20T11-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );

    await writeFile(
      pathA,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/mtime' },
      }) + '\n'
    );
    await writeFile(
      pathB,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/mtime' },
      }) + '\n'
    );
    await utimes(pathA, new Date(1000), new Date(1000));
    await utimes(pathB, new Date(2000), new Date(2000));

    const first = await cache.listAllSessions();
    expect(first[0]!.path).toBe(pathB);

    // Existing path A becomes newer — sync must re-stat, not keep stale mtime
    await utimes(pathA, new Date(9000), new Date(9000));
    const second = await cache.listAllSessions();
    expect(second[0]!.path).toBe(pathA);
    expect(second[0]!.mtime).toBe(9000);
  });

  test('listAllSessions prunes deleted session paths', async () => {
    const dateDir = join(codexSessionsDir, '2026', '01', '21');
    await mkdir(dateDir, { recursive: true });

    const keepPath = join(
      dateDir,
      'rollout-2026-01-21T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    const dropPath = join(
      dateDir,
      'rollout-2026-01-21T11-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );

    await writeFile(
      keepPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/prune' },
      }) + '\n'
    );
    await writeFile(
      dropPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/prune' },
      }) + '\n'
    );

    expect(await cache.listAllSessions()).toHaveLength(2);

    const { unlink, readFile } = await import('node:fs/promises');
    await unlink(dropPath);

    const after = await cache.listAllSessions();
    expect(after).toHaveLength(1);
    expect(after[0]!.path).toBe(keepPath);

    // Disk cache must persist the prune for a fresh instance
    const diskPath = join(tempDir, 'codex', '.agent-tail-cache.json');
    const disk = JSON.parse(await readFile(diskPath, 'utf-8')) as {
      sessions: { path: string }[];
    };
    expect(disk.sessions).toHaveLength(1);
    expect(disk.sessions[0]!.path).toBe(keepPath);

    cache.clear();
    const reloaded = new CodexSessionCache(codexSessionsDir);
    const fromDisk = await reloaded.listAllSessions();
    expect(fromDisk).toHaveLength(1);
    expect(fromDisk[0]!.path).toBe(keepPath);
  });

  test('readMainSessionMeta only needs the first line (ignores huge body)', async () => {
    const { readMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');
    const dateDir = join(codexSessionsDir, '2026', '03', '01');
    await mkdir(dateDir, { recursive: true });
    const path = join(
      dateDir,
      'rollout-2026-03-01T10-00-019c7a2e-cccc-cccc-cccc-cccccccccccc.jsonl'
    );
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/path/to/huge', source: 'mcp' },
    });
    // Multi-MB body must not prevent meta parsing
    const hugeLine = JSON.stringify({
      type: 'response_item',
      payload: { text: 'x'.repeat(100_000) },
    });
    await writeFile(path, meta + '\n' + hugeLine + '\n');

    const result = await readMainSessionMeta(path);
    expect(result).toEqual({ cwd: '/path/to/huge' });
  });

  test('readMainSessionMeta handles first line longer than 8KB via progressive read', async () => {
    const { readMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');
    const dateDir = join(codexSessionsDir, '2026', '03', '02');
    await mkdir(dateDir, { recursive: true });
    const path = join(
      dateDir,
      'rollout-2026-03-02T10-00-019c7a2e-dddd-dddd-dddd-dddddddddddd.jsonl'
    );
    // Legitimate (if unusual) session_meta whose JSON exceeds the first 8KB chunk
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd: '/path/to/long-meta',
        source: 'mcp',
        padding: 'y'.repeat(10_000),
      },
    });
    expect(meta.length).toBeGreaterThan(8192);
    await writeFile(path, meta + '\n{"type":"other"}\n');

    const result = await readMainSessionMeta(path);
    expect(result).toEqual({ cwd: '/path/to/long-meta' });
  });

  test('readMainSessionMeta handles first line longer than 256KB', async () => {
    const { readMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');
    const dateDir = join(codexSessionsDir, '2026', '03', '03');
    await mkdir(dateDir, { recursive: true });
    const path = join(
      dateDir,
      'rollout-2026-03-03T10-00-019c7a2e-eeee-eeee-eeee-eeeeeeeeeeee.jsonl'
    );
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: {
        cwd: '/path/to/huge-meta',
        source: 'mcp',
        padding: 'z'.repeat(270_000),
      },
    });
    expect(meta.length).toBeGreaterThan(262144);
    await writeFile(path, meta + '\n');

    const result = await readMainSessionMeta(path);
    expect(result).toEqual({ cwd: '/path/to/huge-meta' });
  });

  test('listAllSessions syncs after init via other API (getAllProjects)', async () => {
    const dateDir = join(codexSessionsDir, '2026', '01', '22');
    await mkdir(dateDir, { recursive: true });

    const firstPath = join(
      dateDir,
      'rollout-2026-01-22T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    await writeFile(
      firstPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/other-init' },
      }) + '\n'
    );

    // Cold init through a non-list API
    const projects = await cache.getAllProjects();
    expect(projects).toContain('/path/to/other-init');

    // New non-today session after other-API init must still appear on first list
    const secondPath = join(
      dateDir,
      'rollout-2026-01-22T11-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/other-init' },
      }) + '\n'
    );

    const listed = await cache.listAllSessions();
    expect(listed.map((s) => s.path)).toContain(secondPath);
  });

  test('persists rejected subagent paths across cache reload', async () => {
    const dateDir = join(codexSessionsDir, '2026', '01', '23');
    await mkdir(dateDir, { recursive: true });

    const mainPath = join(
      dateDir,
      'rollout-2026-01-23T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    const subPath = join(
      dateDir,
      'rollout-2026-01-23T11-00-019c7a2e-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'
    );

    await writeFile(
      mainPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/neg', source: 'mcp' },
      }) + '\n'
    );
    await writeFile(
      subPath,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/path/to/neg',
          source: {
            subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } },
          },
        },
      }) + '\n'
    );

    expect(await cache.listAllSessions()).toHaveLength(1);

    const { readFile } = await import('node:fs/promises');
    const diskPath = join(tempDir, 'codex', '.agent-tail-cache.json');
    const disk = JSON.parse(await readFile(diskPath, 'utf-8')) as {
      version: number;
      rejected: { path: string; mtime: number }[];
    };
    expect(disk.version).toBe(3);
    expect(disk.rejected.some((r) => r.path === subPath)).toBe(true);

    cache.clear();
    const reloaded = new CodexSessionCache(codexSessionsDir);
    const listed = await reloaded.listAllSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.path).toBe(mainPath);
  });

  test('readMainSessionMeta returns null when no newline within 1MB cap', async () => {
    const { readMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');
    const dateDir = join(codexSessionsDir, '2026', '03', '04');
    await mkdir(dateDir, { recursive: true });
    const path = join(
      dateDir,
      'rollout-2026-03-04T10-00-019c7a2e-ffff-ffff-ffff-ffffffffffff.jsonl'
    );
    // No newline at all; body exceeds META_HEAD_MAX_SIZE
    await writeFile(path, 'x'.repeat(1024 * 1024 + 64));

    expect(await readMainSessionMeta(path)).toBeNull();
  });

  test('classifyMainSessionMeta distinguishes unavailable from not_main', async () => {
    const { classifyMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');

    const missing = await classifyMainSessionMeta(
      join(
        codexSessionsDir,
        '2026',
        '99',
        '99',
        'rollout-missing-never-created.jsonl'
      )
    );
    expect(missing).toEqual({ status: 'unavailable' });

    const dateDir = join(codexSessionsDir, '2026', '03', '05');
    await mkdir(dateDir, { recursive: true });
    const subPath = join(
      dateDir,
      'rollout-2026-03-05T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    await writeFile(
      subPath,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/path/to/x',
          source: { subagent: { thread_spawn: { depth: 1 } } },
        },
      }) + '\n'
    );
    expect(await classifyMainSessionMeta(subPath)).toEqual({
      status: 'not_main',
    });
  });

  test('unavailable main file is not stuck in negative cache after recovery', async () => {
    const { chmod } = await import('node:fs/promises');
    const { classifyMainSessionMeta } =
      await import('../../src/agents/codex/session-cache.ts');
    const dateDir = join(codexSessionsDir, '2026', '01', '24');
    await mkdir(dateDir, { recursive: true });
    const mainPath = join(
      dateDir,
      'rollout-2026-01-24T10-00-019c7a2e-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'
    );
    await writeFile(
      mainPath,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/path/to/recover', source: 'mcp' },
      }) + '\n'
    );

    await chmod(mainPath, 0o000);
    const whileDenied = await classifyMainSessionMeta(mainPath);
    await chmod(mainPath, 0o644);

    // On some OS/owner setups chmod 000 still allows read — only assert when denied
    if (whileDenied.status === 'unavailable') {
      // First list while we simulate prior unavailable: should find session after recovery
      const listed = await cache.listAllSessions();
      expect(listed.map((s) => s.path)).toContain(mainPath);
      // And must not have been persisted as rejected
      const { readFile } = await import('node:fs/promises');
      const disk = JSON.parse(
        await readFile(
          join(tempDir, 'codex', '.agent-tail-cache.json'),
          'utf-8'
        )
      ) as { rejected: { path: string }[] };
      expect(disk.rejected.some((r) => r.path === mainPath)).toBe(false);
    } else {
      // Platform could not deny owner read — still ensure normal list works
      const listed = await cache.listAllSessions();
      expect(listed.map((s) => s.path)).toContain(mainPath);
    }
  });
});
