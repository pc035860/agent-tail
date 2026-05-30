import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgent } from '../../../src/agents/claude/claude-agent';
import type { SessionFinder } from '../../../src/agents/agent.interface';
import type { ClaudeSessionResult, SessionFile } from '../../../src/core/types';

function makeFinder(baseDir: string): SessionFinder {
  return new ClaudeAgent({ verbose: false, baseDir }).finder;
}

async function writeMainSession(
  baseDir: string,
  encodedDir: string,
  sessionUuid: string,
  opts: { cwd?: string; customTitle?: string; lastTimestamp?: string } = {},
  mtimeMs?: number
): Promise<string> {
  const projectDir = join(baseDir, encodedDir);
  await mkdir(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionUuid}.jsonl`);
  const lines: string[] = [];
  if (opts.cwd) {
    lines.push(JSON.stringify({ type: 'progress', cwd: opts.cwd }));
  }
  if (opts.customTitle) {
    lines.push(
      JSON.stringify({ type: 'custom-title', customTitle: opts.customTitle })
    );
  }
  if (opts.lastTimestamp) {
    lines.push(JSON.stringify({ type: 'user', timestamp: opts.lastTimestamp }));
  }
  if (lines.length === 0) lines.push('{}');
  await writeFile(path, lines.join('\n'));
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    await utimes(path, t, t);
  }
  return path;
}

async function writeWorkflowSnapshot(
  baseDir: string,
  encodedDir: string,
  sessionUuid: string,
  runId: string,
  body: Record<string, unknown>,
  mtimeMs?: number
): Promise<string> {
  const dir = join(baseDir, encodedDir, sessionUuid, 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  await writeFile(path, JSON.stringify(body));
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    await utimes(path, t, t);
  }
  return path;
}

function isSessionFile(
  result: SessionFile | ClaudeSessionResult | null
): result is SessionFile {
  return !!result && 'path' in result;
}

describe('ClaudeSessionFinder.listSessions merge (main + workflow)', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-merge-'));
    finder = makeFinder(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('merged result includes both main session and workflow entries', async () => {
    const ENC = '-Users-x-code-foo';
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await writeMainSession(tempDir, ENC, UUID, {}, 1_000_000_000);
    await writeWorkflowSnapshot(
      tempDir,
      ENC,
      UUID,
      'wf_12345678-abc',
      { runId: 'wf_12345678-abc', status: 'completed', workflowName: 'demo' },
      2_000_000_000
    );

    const result = await finder.listSessions!({});
    expect(result).toHaveLength(2);
    const workflow = result.find((r) => r.logType === 'workflow');
    const main = result.find((r) => r.logType !== 'workflow');
    expect(workflow).toBeDefined();
    expect(main).toBeDefined();
    expect(workflow!.workflowRunId).toBe('wf_12345678-abc');
  });

  test('sorted by activity time descending (newer workflow first)', async () => {
    const ENC = '-Users-x-code-foo';
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await writeMainSession(tempDir, ENC, UUID, {}, 1_000_000_000);
    await writeWorkflowSnapshot(
      tempDir,
      ENC,
      UUID,
      'wf_12345678-abc',
      { runId: 'wf_12345678-abc', status: 'running' },
      2_000_000_000
    );

    const result = await finder.listSessions!({});
    expect(result[0]!.logType).toBe('workflow');
  });

  test('project fuzzy filter applies to both main and workflow', async () => {
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await writeMainSession(tempDir, '-Users-x-code-foo', UUID);
    await writeMainSession(
      tempDir,
      '-Users-x-code-bar',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
    await writeWorkflowSnapshot(
      tempDir,
      '-Users-x-code-foo',
      UUID,
      'wf_12345678-abc',
      { runId: 'wf_12345678-abc', status: 'running' }
    );
    await writeWorkflowSnapshot(
      tempDir,
      '-Users-x-code-bar',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'wf_99999999-bbb',
      { runId: 'wf_99999999-bbb', status: 'running' }
    );

    const result = await finder.listSessions!({ project: 'code-foo' });
    expect(result).toHaveLength(2);
    for (const item of result) {
      expect(item.path.toLowerCase()).toContain('code-foo');
    }
  });

  test('limit slices merged result', async () => {
    const ENC = '-Users-x-code-foo';
    // 3 mains, 3 workflows
    for (let i = 0; i < 3; i++) {
      const hex = `${i}${i}${i}${i}${i}${i}${i}${i}`;
      const uuid = `${hex}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
      await writeMainSession(tempDir, ENC, uuid, {}, 1_000_000_000 + i);
      await writeWorkflowSnapshot(
        tempDir,
        ENC,
        uuid,
        `wf_${hex}-${i}${i}${i}`,
        { runId: `wf_${hex}-${i}${i}${i}`, status: 'running' },
        2_000_000_000 + i
      );
    }

    const result = await finder.listSessions!({ limit: 4 });
    expect(result).toHaveLength(4);
  });

  test('activity-time bubble-up preserved: stale-mtime/fresh-activity main survives slice', async () => {
    const ENC = '-Users-x-code-foo';
    // 5 main sessions:
    //   4 with recent mtime, no inner activity → fall back to mtime
    //   1 with VERY OLD mtime but RECENT internal lastActivityTime
    const recentMtime = 5_000_000_000;
    const staleMtime = 1_000_000_000;
    // 100 years from now — guaranteed to beat any mtime regardless of when
    // this test runs. Self-documenting alternative to a hard-coded year.
    const futureTimestamp = new Date(
      Date.now() + 100 * 365 * 24 * 3600 * 1000
    ).toISOString();

    for (let i = 0; i < 4; i++) {
      const hex = `${i}${i}${i}${i}${i}${i}${i}${i}`;
      const uuid = `${hex}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
      await writeMainSession(tempDir, ENC, uuid, {}, recentMtime - i * 100);
    }

    const HERO_UUID = '99999999-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await writeMainSession(
      tempDir,
      ENC,
      HERO_UUID,
      { lastTimestamp: futureTimestamp },
      staleMtime
    );

    const result = await finder.listSessions!({ limit: 3 });
    const heroFound = result.some((r) => r.path.includes(HERO_UUID));
    expect(heroFound).toBe(true);
  });
});

describe('ClaudeSessionFinder.findBySessionId workflow dispatch', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-dispatch-'));
    finder = makeFinder(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('wf_-prefixed id returns workflow SessionFile with customTitle wf:*', async () => {
    const RUN_ID = 'wf_12345678-abc';
    await writeWorkflowSnapshot(
      tempDir,
      '-Users-x-code-foo',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      RUN_ID,
      { runId: RUN_ID, status: 'running', workflowName: 'demo' }
    );

    const result = await finder.findBySessionId!(RUN_ID, {});
    expect(result).not.toBeNull();
    expect(isSessionFile(result)).toBe(true);
    if (isSessionFile(result)) {
      expect(result.path).toContain(RUN_ID);
      expect(result.customTitle).toBeDefined();
      expect(result.customTitle!.startsWith('wf:')).toBe(true);
    }
  });

  test('wf_-prefixed id with no match returns null (does NOT fall through to main UUID logic)', async () => {
    // Write a main session that would NOT match a wf_ prefix but proves
    // dispatch short-circuits before main lookup.
    await writeMainSession(
      tempDir,
      '-Users-x-code-foo',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    );

    const result = await finder.findBySessionId!('wf_DOES_NOT_EXIST', {});
    expect(result).toBeNull();
  });

  test('non-wf_ id still works for main UUID', async () => {
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await writeMainSession(tempDir, '-Users-x-code-foo', UUID);

    const result = await finder.findBySessionId!(UUID, {});
    expect(result).not.toBeNull();
    expect(isSessionFile(result)).toBe(true);
    if (isSessionFile(result)) {
      expect(result.path).toContain(UUID);
    }
  });
});

describe('ClaudeSessionFinder.getProjectInfo', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-projinfo-'));
    finder = makeFinder(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns absolute projectDir + decoded cwd as displayName', async () => {
    const ENC = '-Users-x-code-foo';
    const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const path = await writeMainSession(tempDir, ENC, UUID, {
      cwd: '/opt/test-workspace/foo',
    });

    const info = await finder.getProjectInfo!(path);
    expect(info).not.toBeNull();
    expect(info!.projectDir).toBe(join(tempDir, ENC));
    expect(info!.displayName).toBe('/opt/test-workspace/foo');
  });

  test('returns null when path has no projects/ segment', async () => {
    const info = await finder.getProjectInfo!('/tmp/not-a-claude-path.jsonl');
    expect(info).toBeNull();
  });
});

describe('ClaudeSessionFinder.findLatestInProject', () => {
  let tempDir: string;
  let finder: SessionFinder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-findlatest-'));
    finder = makeFinder(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('returns latest session in matching project (encoded dir name)', async () => {
    const ENC = '-Users-x-code-foo';
    await writeMainSession(
      tempDir,
      ENC,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      {},
      1_000_000_000
    );
    await writeMainSession(
      tempDir,
      ENC,
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      {},
      2_000_000_000
    );
    await writeMainSession(
      tempDir,
      '-Users-x-code-bar',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      {},
      3_000_000_000
    );

    const result = await finder.findLatestInProject!(ENC);
    expect(result).not.toBeNull();
    expect(result!.path).toContain('bbbbbbbb');
  });

  test('returns null when project has no sessions', async () => {
    const result = await finder.findLatestInProject!('-nonexistent-project');
    expect(result).toBeNull();
  });
});
