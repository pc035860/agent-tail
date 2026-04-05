import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CursorAgent } from '../../src/agents/cursor/cursor-agent';
import type { SessionFinder } from '../../src/agents/agent.interface';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CursorSessionFinder.listSessions', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cursor-list-'));

    const agent = new CursorAgent({ verbose: false });
    finder = agent.finder;
    (finder as unknown as { setBaseDir: (dir: string) => void }).setBaseDir(
      tempDir
    );
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createCursorSession(
    workspaceSlug: string,
    uuid: string,
    ago: number = 0
  ): Promise<string> {
    const sessionDir = join(tempDir, workspaceSlug, 'agent-transcripts', uuid);
    await mkdir(sessionDir, { recursive: true });
    const filePath = join(sessionDir, `${uuid}.jsonl`);
    await writeFile(filePath, '{}');
    if (ago > 0) {
      const mtime = new Date(Date.now() - ago);
      await utimes(filePath, mtime, mtime);
    }
    return filePath;
  }

  test('returns empty array for empty directory', async () => {
    const result = await finder.listSessions!({});
    expect(result).toEqual([]);
  });

  test('returns sessions sorted by mtime descending', async () => {
    await createCursorSession(
      'my-workspace',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      3000
    );
    await createCursorSession(
      'my-workspace',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      1000
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0]!.shortId).toBe('bbbbbbbb');
    expect(result[1]!.shortId).toBe('aaaaaaaa');
  });

  test('excludes subagent files', async () => {
    const uuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await createCursorSession('my-workspace', uuid);

    // Create a subagent file inside subagents/ dir
    const subagentsDir = join(
      tempDir,
      'my-workspace',
      'agent-transcripts',
      uuid,
      'subagents'
    );
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      join(subagentsDir, 'dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl'),
      '{}'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.shortId).toBe('cccccccc');
  });

  test('sets project from workspace slug', async () => {
    await createCursorSession(
      'cool-project-slug',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.project).toBe('cool-project-slug');
  });

  test('handles multiple workspace slugs', async () => {
    await createCursorSession(
      'workspace-a',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    await createCursorSession(
      'workspace-b',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(2);
  });

  test('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const hex = i.toString(16).repeat(8).slice(0, 8);
      const uuid = `${hex}-${hex.slice(0, 4)}-${hex.slice(0, 4)}-${hex.slice(0, 4)}-${hex}${hex.slice(0, 4)}`;
      await createCursorSession('my-ws', uuid, i * 1000);
    }

    const result = await finder.listSessions!({ limit: 2 });

    expect(result).toHaveLength(2);
  });

  test('respects project filter via slug matching', async () => {
    await createCursorSession(
      'target-project',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );
    await createCursorSession(
      'other-project',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );

    const result = await finder.listSessions!({ project: 'target' });

    expect(result).toHaveLength(1);
    expect(result[0]!.project).toBe('target-project');
  });
});
