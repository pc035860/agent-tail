import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, utimes, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestMainSessionInProject } from '../../src/claude/auto-switch';

describe('findLatestMainSessionInProject', () => {
  test('returns latest UUID.jsonl in project dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const older = join(dir, '11111111-1111-1111-1111-111111111111.jsonl');
      const newer = join(dir, '22222222-2222-2222-2222-222222222222.jsonl');

      await writeFile(older, '');
      await writeFile(newer, '');

      await utimes(older, new Date(1000), new Date(1000));
      await utimes(newer, new Date(2000), new Date(2000));

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(newer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('ignores non-UUID and agent-* files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const agentFile = join(dir, 'agent-abc1234.jsonl');
      const invalidFile = join(dir, 'not-a-uuid.jsonl');
      const subagentsDir = join(dir, 'subagents');

      await writeFile(agentFile, '');
      await writeFile(invalidFile, '');
      await mkdir(subagentsDir);
      await writeFile(join(subagentsDir, 'agent-deadbee.jsonl'), '');

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
