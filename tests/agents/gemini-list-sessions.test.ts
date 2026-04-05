import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GeminiAgent } from '../../src/agents/gemini/gemini-agent';
import type { SessionFinder } from '../../src/agents/agent.interface';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GeminiSessionFinder.listSessions', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-list-'));

    const agent = new GeminiAgent({ verbose: false });
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
    const projDir = join(tempDir, 'myproj', 'chats');
    await mkdir(projDir, { recursive: true });

    const files = [
      { name: 'session-1700000000-aabbccdd.json', ago: 3000 },
      { name: 'session-1700000001-eeff0011.json', ago: 1000 },
    ];

    for (const f of files) {
      const p = join(projDir, f.name);
      await writeFile(p, '{}');
      const mtime = new Date(Date.now() - f.ago);
      await utimes(p, mtime, mtime);
    }

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0]!.shortId).toBe('eeff0011');
    expect(result[1]!.shortId).toBe('aabbccdd');
  });

  test('extracts shortId from 8-hex suffix in filename', async () => {
    const projDir = join(tempDir, 'testproj', 'chats');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session-1700000000-deadbeef.json'), '{}');

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.shortId).toBe('deadbeef');
  });

  test('sets project from directory basename', async () => {
    const projDir = join(tempDir, 'my-ml-pipeline', 'chats');
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, 'session-1700000000-abcd1234.json'), '{}');

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(1);
    expect(result[0]!.project).toBe('my-ml-pipeline');
  });

  test('handles multiple project directories', async () => {
    const proj1 = join(tempDir, 'proj1', 'chats');
    const proj2 = join(tempDir, 'proj2', 'chats');
    await mkdir(proj1, { recursive: true });
    await mkdir(proj2, { recursive: true });

    await writeFile(join(proj1, 'session-1700000000-aaaa1111.json'), '{}');
    await writeFile(join(proj2, 'session-1700000001-bbbb2222.json'), '{}');

    const result = await finder.listSessions!({});

    expect(result).toHaveLength(2);
  });

  test('respects limit parameter', async () => {
    const projDir = join(tempDir, 'proj', 'chats');
    await mkdir(projDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      const hex = i.toString(16).repeat(8).slice(0, 8);
      const p = join(projDir, `session-170000000${i}-${hex}.json`);
      await writeFile(p, '{}');
      const mtime = new Date(Date.now() - i * 1000);
      await utimes(p, mtime, mtime);
    }

    const result = await finder.listSessions!({ limit: 3 });

    expect(result).toHaveLength(3);
  });
});
