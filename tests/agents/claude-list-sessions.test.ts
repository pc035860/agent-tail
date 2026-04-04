import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeAgent } from '../../src/agents/claude/claude-agent';
import type { SessionFinder } from '../../src/agents/agent.interface';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ClaudeSessionFinder.listSessions', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-list-'));
    const agent = new ClaudeAgent({ verbose: false });
    finder = agent.finder;
    (finder as unknown as { baseDir: string }).baseDir = tempDir;
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

  test('returns sessions sorted by mtime descending', async () => {
    const projectDir = join(tempDir, 'project1');
    await mkdir(projectDir, { recursive: true });

    // Create 3 session files with different mtimes
    const files = [
      { name: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl', ago: 3000 },
      { name: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl', ago: 1000 },
      { name: 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl', ago: 2000 },
    ];

    for (const f of files) {
      const filePath = join(projectDir, f.name);
      await writeFile(filePath, '{}');
      const mtime = new Date(Date.now() - f.ago);
      await utimes(filePath, mtime, mtime);
    }

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(3);
    // Most recent first
    expect(result[0]!.shortId).toBe('bbbbbbbb');
    expect(result[1]!.shortId).toBe('cccccccc');
    expect(result[2]!.shortId).toBe('aaaaaaaa');
  });

  test('excludes subagent files (agent-* prefix)', async () => {
    const projectDir = join(tempDir, 'project1');
    const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const sessionDir = join(projectDir, sessionId);
    const subagentsDir = join(sessionDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // Main session file
    await writeFile(join(projectDir, `${sessionId}.jsonl`), '{}');
    // Subagent file (should be excluded)
    await writeFile(join(subagentsDir, 'agent-a0627b6.jsonl'), '{}');

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.shortId).toBe('dddddddd');
  });

  test('sets correct shortId from UUID filename', async () => {
    const projectDir = join(tempDir, 'project1');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'abcdef12-3456-7890-abcd-ef1234567890.jsonl'),
      '{}'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.shortId).toBe('abcdef12');
  });

  test('decodes project path from directory name', async () => {
    const projectDir = join(tempDir, '-Users-test-code-my-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl'),
      '{}'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    // Decoded from encoded path: `-Users-test-code-my-project` → `/Users/test/code/my/project`
    // (lossy decode — dashes become slashes)
    expect(result[0]!.project).toContain('/');
    expect(result[0]!.project).not.toStartWith('-');
  });

  test('populates customTitle from session content via tail-read', async () => {
    const projectDir = join(tempDir, 'project1');
    await mkdir(projectDir, { recursive: true });
    const content = JSON.stringify({
      type: 'custom-title',
      customTitle: 'My Title',
      sessionId: 'test',
    });
    await writeFile(
      join(projectDir, 'ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'),
      content
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.customTitle).toBe('My Title');
  });

  test('respects project filter', async () => {
    const project1 = join(tempDir, 'myproject');
    const project2 = join(tempDir, 'otherproject');
    await mkdir(project1, { recursive: true });
    await mkdir(project2, { recursive: true });

    await writeFile(
      join(project1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      '{}'
    );
    await writeFile(
      join(project2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
      '{}'
    );

    const result = await finder.listSessions!({ project: 'myproject' });

    expect(result).toHaveLength(1);
    expect(result[0]!.shortId).toBe('aaaaaaaa');
  });

  test('respects limit parameter', async () => {
    const projectDir = join(tempDir, 'project1');
    await mkdir(projectDir, { recursive: true });

    const uuids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      '55555555-5555-5555-5555-555555555555',
    ];

    for (let i = 0; i < uuids.length; i++) {
      const filePath = join(projectDir, `${uuids[i]}.jsonl`);
      await writeFile(filePath, '{}');
      const mtime = new Date(Date.now() - i * 1000);
      await utimes(filePath, mtime, mtime);
    }

    const result = await finder.listSessions!({ limit: 2 });

    expect(result).toHaveLength(2);
  });
});
