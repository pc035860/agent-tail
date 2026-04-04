import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CodexAgent } from '../../src/agents/codex/codex-agent';
import type { SessionFinder } from '../../src/agents/agent.interface';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CodexSessionFinder.listSessions', () => {
  let tempDir: string;
  let codexSessionsDir: string;
  let finder: SessionFinder;

  function makeSessionMeta(cwd: string, source: unknown = 'mcp'): string {
    return JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'test-id',
        cwd,
        cli_version: '1.0.0',
        source,
      },
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-list-'));
    codexSessionsDir = join(tempDir, 'codex', 'sessions');
    await mkdir(codexSessionsDir, { recursive: true });

    const agent = new CodexAgent({ verbose: false });
    finder = agent.finder;
    (finder as unknown as { setBaseDir: (dir: string) => void }).setBaseDir(
      codexSessionsDir
    );
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns empty array for empty directory', async () => {
    const result = await finder.listSessions!({});
    expect(result).toEqual([]);
  });

  test('returns only main sessions (excludes subagents)', async () => {
    const dateDir = join(codexSessionsDir, '2026', '04', '04');
    await mkdir(dateDir, { recursive: true });

    // Main session
    const mainPath = join(
      dateDir,
      'rollout-2026-04-04T10-00-019c7a2e-7774-76f0-a293-20ef9753cfd7.jsonl'
    );
    await writeFile(mainPath, makeSessionMeta('/Users/test/myproject') + '\n');

    // Subagent session (should be excluded)
    const subPath = join(
      dateDir,
      'rollout-2026-04-04T10-01-abcdef12-3456-7890-abcd-ef1234567890.jsonl'
    );
    await writeFile(
      subPath,
      makeSessionMeta('/Users/test/myproject', {
        subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } },
      }) + '\n'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.project).toBe('/Users/test/myproject');
  });

  test('sets project from session_meta cwd', async () => {
    const dateDir = join(codexSessionsDir, '2026', '04', '04');
    await mkdir(dateDir, { recursive: true });

    const sessionPath = join(
      dateDir,
      'rollout-2026-04-04T10-00-019c7a2e-7774-76f0-a293-20ef9753cfd7.jsonl'
    );
    await writeFile(
      sessionPath,
      makeSessionMeta('/Users/test/api-server') + '\n'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.project).toBe('/Users/test/api-server');
  });

  test('sorts by mtime descending', async () => {
    const dateDir = join(codexSessionsDir, '2026', '04', '04');
    await mkdir(dateDir, { recursive: true });

    const sessions = [
      {
        name: 'rollout-2026-04-04T08-00-aaaa1111-1111-1111-1111-111111111111.jsonl',
        ago: 3000,
      },
      {
        name: 'rollout-2026-04-04T09-00-bbbb2222-2222-2222-2222-222222222222.jsonl',
        ago: 1000,
      },
    ];

    for (const s of sessions) {
      const p = join(dateDir, s.name);
      await writeFile(p, makeSessionMeta('/Users/test/proj') + '\n');
      const mtime = new Date(Date.now() - s.ago);
      await utimes(p, mtime, mtime);
    }

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(2);
    // Most recent first (bbbb)
    expect(result[0]!.shortId).toContain('bbbb2222');
  });

  test('respects limit parameter', async () => {
    const dateDir = join(codexSessionsDir, '2026', '04', '04');
    await mkdir(dateDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      const hex = (i + 1).toString(16).padStart(4, '0');
      const p = join(
        dateDir,
        `rollout-2026-04-04T1${i}-00-${hex}${hex}-${hex}-${hex}-${hex}-${hex}${hex}${hex}.jsonl`
      );
      await writeFile(p, makeSessionMeta(`/Users/test/proj${i}`) + '\n');
      const mtime = new Date(Date.now() - i * 1000);
      await utimes(p, mtime, mtime);
    }

    const result = await finder.listSessions!({ limit: 2 });

    expect(result).toHaveLength(2);
  });
});
