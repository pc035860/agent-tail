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

  test('considers subagent mtime when main session is older', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      // Session A: main=1000, subagent=3000
      const sessionAId = '11111111-1111-1111-1111-111111111111';
      const sessionA = join(dir, `${sessionAId}.jsonl`);
      const sessionASubagentsDir = join(dir, sessionAId, 'subagents');

      // Session B: main=2000, no subagent
      const sessionBId = '22222222-2222-2222-2222-222222222222';
      const sessionB = join(dir, `${sessionBId}.jsonl`);

      // Create session A with older main but newer subagent
      await writeFile(sessionA, '');
      await mkdir(sessionASubagentsDir, { recursive: true });
      const subagentFile = join(sessionASubagentsDir, 'agent-abc1234.jsonl');
      await writeFile(subagentFile, '');

      // Create session B with newer main but no subagent
      await writeFile(sessionB, '');

      // Set mtimes
      await utimes(sessionA, new Date(1000), new Date(1000));
      await utimes(subagentFile, new Date(3000), new Date(3000));
      await utimes(sessionB, new Date(2000), new Date(2000));

      // Session A should win because activityTime=3000 > 2000
      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(sessionA);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses main mtime when no subagents exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const session = join(dir, `${sessionId}.jsonl`);

      await writeFile(session, '');
      await utimes(session, new Date(1000), new Date(1000));

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(session);
      expect(latest?.mtime.getTime()).toBe(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('handles multiple subagents and picks max mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const session = join(dir, `${sessionId}.jsonl`);
      const subagentsDir = join(dir, sessionId, 'subagents');

      await writeFile(session, '');
      await mkdir(subagentsDir, { recursive: true });

      const subagent1 = join(subagentsDir, 'agent-aaa1111.jsonl');
      const subagent2 = join(subagentsDir, 'agent-bbb2222.jsonl');
      const subagent3 = join(subagentsDir, 'agent-ccc3333.jsonl');

      await writeFile(subagent1, '');
      await writeFile(subagent2, '');
      await writeFile(subagent3, '');

      // Set mtimes: main=1000, subagent1=2000, subagent2=5000, subagent3=3000
      await utimes(session, new Date(1000), new Date(1000));
      await utimes(subagent1, new Date(2000), new Date(2000));
      await utimes(subagent2, new Date(5000), new Date(5000));
      await utimes(subagent3, new Date(3000), new Date(3000));

      // Create another session with main=4000 (should lose to subagent2's 5000)
      const session2Id = '22222222-2222-2222-2222-222222222222';
      const session2 = join(dir, `${session2Id}.jsonl`);
      await writeFile(session2, '');
      await utimes(session2, new Date(4000), new Date(4000));

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(session);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('handles empty subagents directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const session = join(dir, `${sessionId}.jsonl`);
      const subagentsDir = join(dir, sessionId, 'subagents');

      await writeFile(session, '');
      await mkdir(subagentsDir, { recursive: true });
      await utimes(session, new Date(1000), new Date(1000));

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(session);
      expect(latest?.mtime.getTime()).toBe(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('gracefully handles missing subagents directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      const sessionId = '11111111-1111-1111-1111-111111111111';
      const session = join(dir, `${sessionId}.jsonl`);
      const sessionDir = join(dir, sessionId);

      await writeFile(session, '');
      // Create session directory but NOT subagents subdirectory
      await mkdir(sessionDir, { recursive: true });
      await utimes(session, new Date(1000), new Date(1000));

      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(session);
      expect(latest?.mtime.getTime()).toBe(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses main mtime when subagent mtime is older', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));

    try {
      // Session A: main=3000, subagent=1000 (subagent is older)
      const sessionAId = '11111111-1111-1111-1111-111111111111';
      const sessionA = join(dir, `${sessionAId}.jsonl`);
      const sessionASubagentsDir = join(dir, sessionAId, 'subagents');

      // Session B: main=2000, no subagent
      const sessionBId = '22222222-2222-2222-2222-222222222222';
      const sessionB = join(dir, `${sessionBId}.jsonl`);

      // Create session A with newer main but older subagent
      await writeFile(sessionA, '');
      await mkdir(sessionASubagentsDir, { recursive: true });
      const subagentFile = join(sessionASubagentsDir, 'agent-abc1234.jsonl');
      await writeFile(subagentFile, '');

      // Create session B
      await writeFile(sessionB, '');

      // Set mtimes: A main=3000, A subagent=1000, B main=2000
      await utimes(sessionA, new Date(3000), new Date(3000));
      await utimes(subagentFile, new Date(1000), new Date(1000));
      await utimes(sessionB, new Date(2000), new Date(2000));

      // Session A should win because activityTime=max(3000,1000)=3000 > 2000
      const latest = await findLatestMainSessionInProject(dir);
      expect(latest?.path).toBe(sessionA);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
