import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSessionFinder } from '../../../src/agents/claude/workflow-agent';

// Fixture layout mirrors actual Claude Code workflow log structure:
//   {tempDir}/{encoded-cwd}/{session-uuid}/workflows/wf_*.json
//   {tempDir}/{encoded-cwd}/{session-uuid}.jsonl  (main session, for getProjectInfo cwd)

const RUN_ID_1 = 'wf_aaaaaaaa-bbb';
const RUN_ID_2 = 'wf_cccccccc-ddd';
const SESSION_UUID_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_UUID_2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ENCODED_DIR_1 = '-Users-x-code-foo';
const ENCODED_DIR_2 = '-Users-x-code-bar';

async function writeSnapshot(
  baseDir: string,
  encodedDir: string,
  sessionUuid: string,
  runId: string,
  body: Record<string, unknown>,
  ageMs = 0
): Promise<string> {
  const workflowsDir = join(baseDir, encodedDir, sessionUuid, 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  const path = join(workflowsDir, `${runId}.json`);
  await writeFile(path, JSON.stringify(body));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    await utimes(path, t, t);
  }
  return path;
}

async function writeMainSession(
  baseDir: string,
  encodedDir: string,
  sessionUuid: string,
  cwd?: string
): Promise<string> {
  const projectDir = join(baseDir, encodedDir);
  await mkdir(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionUuid}.jsonl`);
  const line = cwd ? JSON.stringify({ type: 'progress', cwd }) : '{}';
  await writeFile(path, line);
  return path;
}

describe('WorkflowSessionFinder', () => {
  let tempDir: string;
  let finder: WorkflowSessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wf-finder-'));
    finder = new WorkflowSessionFinder(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('findLatest', () => {
    test('returns null when no workflows exist', async () => {
      const result = await finder.findLatest({});
      expect(result).toBeNull();
    });

    test('returns most recent across all projects when no filter', async () => {
      await writeSnapshot(
        tempDir,
        ENCODED_DIR_1,
        SESSION_UUID_1,
        RUN_ID_1,
        { runId: RUN_ID_1, status: 'completed' },
        5000
      );
      await writeSnapshot(
        tempDir,
        ENCODED_DIR_2,
        SESSION_UUID_2,
        RUN_ID_2,
        { runId: RUN_ID_2, status: 'running' },
        1000
      );

      const result = await finder.findLatest({});
      expect(result).not.toBeNull();
      expect(result!.path).toContain(RUN_ID_2);
    });

    test('honors project fuzzy filter', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'completed',
      });
      await writeSnapshot(tempDir, ENCODED_DIR_2, SESSION_UUID_2, RUN_ID_2, {
        runId: RUN_ID_2,
        status: 'running',
      });

      const result = await finder.findLatest({ project: 'code-foo' });
      expect(result).not.toBeNull();
      expect(result!.path).toContain(RUN_ID_1);
    });

    test('project filter with no matches returns null', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'running',
      });
      const result = await finder.findLatest({ project: 'totally-other' });
      expect(result).toBeNull();
    });
  });

  describe('findBySessionId', () => {
    beforeEach(async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'completed',
        workflowName: 'demo',
      });
    });

    test('exact runId match returns snapshot', async () => {
      const result = await finder.findBySessionId(RUN_ID_1, {});
      expect(result).not.toBeNull();
      expect(result!.path).toContain(RUN_ID_1);
    });

    test('prefix runId match returns snapshot', async () => {
      const result = await finder.findBySessionId('wf_aaaaaaaa', {});
      expect(result).not.toBeNull();
      expect(result!.path).toContain(RUN_ID_1);
    });

    test('non-matching id returns null', async () => {
      const result = await finder.findBySessionId('wf_NONEXISTENT', {});
      expect(result).toBeNull();
    });

    test('returns SessionFile with customTitle starting with "wf:"', async () => {
      const result = await finder.findBySessionId(RUN_ID_1, {});
      expect(result).not.toBeNull();
      expect(result!.customTitle).toBeDefined();
      expect(result!.customTitle!.startsWith('wf:')).toBe(true);
    });

    test('project filter mismatch returns null', async () => {
      const result = await finder.findBySessionId(RUN_ID_1, {
        project: 'totally-other',
      });
      expect(result).toBeNull();
    });
  });

  describe('findLatestInProject', () => {
    test('scans only matching project', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'running',
      });
      await writeSnapshot(tempDir, ENCODED_DIR_2, SESSION_UUID_2, RUN_ID_2, {
        runId: RUN_ID_2,
        status: 'completed',
      });

      const result = await finder.findLatestInProject(ENCODED_DIR_1);
      expect(result).not.toBeNull();
      expect(result!.path).toContain(RUN_ID_1);
    });

    test('no matching project returns null', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'running',
      });
      const result = await finder.findLatestInProject('-no-such-project');
      expect(result).toBeNull();
    });
  });

  describe('listSessions', () => {
    test('returns workflow items with logType and metadata', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'completed',
        workflowName: 'demo',
      });

      const result = await finder.listSessions({});
      expect(result).toHaveLength(1);
      const item = result[0]!;
      expect(item.logType).toBe('workflow');
      expect(item.workflowRunId).toBe(RUN_ID_1);
      expect(item.workflowSessionUuid).toBe(SESSION_UUID_1);
      expect(item.workflowStatus).toBe('completed');
      expect(item.customTitle).toBe('wf:demo');
      expect(item.shortId).toBe(RUN_ID_1);
    });

    test('fuzzy filters by project', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'completed',
      });
      await writeSnapshot(tempDir, ENCODED_DIR_2, SESSION_UUID_2, RUN_ID_2, {
        runId: RUN_ID_2,
        status: 'running',
      });

      const result = await finder.listSessions({ project: 'code-foo' });
      expect(result).toHaveLength(1);
      expect(result[0]!.workflowRunId).toBe(RUN_ID_1);
    });

    test('honors limit', async () => {
      for (let i = 0; i < 5; i++) {
        const hex = `${i}${i}${i}${i}${i}${i}${i}${i}`;
        const runId = `wf_${hex}-${i}${i}${i}`;
        const sessionUuid = `${hex}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
        await writeSnapshot(
          tempDir,
          `-Users-x-code-${i}`,
          sessionUuid,
          runId,
          { runId, status: 'running' },
          i * 1000
        );
      }

      const result = await finder.listSessions({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    test('snapshot with invalid JSON still listed with fallback customTitle', async () => {
      const path = join(
        tempDir,
        ENCODED_DIR_1,
        SESSION_UUID_1,
        'workflows',
        `${RUN_ID_1}.json`
      );
      await mkdir(join(tempDir, ENCODED_DIR_1, SESSION_UUID_1, 'workflows'), {
        recursive: true,
      });
      await writeFile(path, 'broken{');

      const result = await finder.listSessions({});
      expect(result).toHaveLength(1);
      expect(result[0]!.customTitle).toBe(`wf:${RUN_ID_1}`);
      expect(result[0]!.workflowStatus).toBeUndefined();
    });

    test('snapshot without workflowName falls back to runId in customTitle', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'completed',
        // no workflowName
      });

      const result = await finder.listSessions({});
      expect(result).toHaveLength(1);
      expect(result[0]!.customTitle).toBe(`wf:${RUN_ID_1}`);
    });

    test('project field uses encoded dir name', async () => {
      await writeSnapshot(tempDir, ENCODED_DIR_1, SESSION_UUID_1, RUN_ID_1, {
        runId: RUN_ID_1,
        status: 'running',
      });
      const result = await finder.listSessions({});
      expect(result).toHaveLength(1);
      expect(result[0]!.project).toBe(ENCODED_DIR_1);
    });
  });

  describe('getProjectInfo', () => {
    test('returns absolute projectDir + displayName when main session exists', async () => {
      const snapshotPath = await writeSnapshot(
        tempDir,
        ENCODED_DIR_1,
        SESSION_UUID_1,
        RUN_ID_1,
        { runId: RUN_ID_1, status: 'running' }
      );
      await writeMainSession(
        tempDir,
        ENCODED_DIR_1,
        SESSION_UUID_1,
        '/opt/test-workspace/foo'
      );

      const info = await finder.getProjectInfo(snapshotPath);
      expect(info).not.toBeNull();
      expect(info!.projectDir).toBe(join(tempDir, ENCODED_DIR_1));
      expect(info!.displayName).toBe('/opt/test-workspace/foo');
    });

    test('returns projectDir only when main session missing', async () => {
      const snapshotPath = await writeSnapshot(
        tempDir,
        ENCODED_DIR_1,
        SESSION_UUID_1,
        RUN_ID_1,
        { runId: RUN_ID_1, status: 'running' }
      );

      const info = await finder.getProjectInfo(snapshotPath);
      expect(info).not.toBeNull();
      expect(info!.projectDir).toBe(join(tempDir, ENCODED_DIR_1));
      expect(info!.displayName).toBeUndefined();
    });

    test('returns null when path has no projects/ segment', async () => {
      const info = await finder.getProjectInfo('/tmp/not-a-claude-path.json');
      expect(info).toBeNull();
    });
  });

  describe('getBaseDir', () => {
    test('reflects injected baseDir', () => {
      expect(finder.getBaseDir()).toBe(tempDir);
    });
  });
});
