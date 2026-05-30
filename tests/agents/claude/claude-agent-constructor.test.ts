/**
 * SPEC §20 deferred item C — ClaudeSessionFinder.baseDir constructor injection.
 *
 * Before this change, tests injected baseDir via the cast
 *   (finder as unknown as { baseDir: string }).baseDir = tempDir
 * which left a test-only mutation path on the production class and forced
 * the lazy `workflowFinder` getter to rebuild on baseDir drift. The cleanup
 * here moves baseDir to a constructor option so tests can pass it in and
 * the workflow finder can bind once at construction time.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ClaudeSessionFinder } from '../../../src/agents/claude/claude-agent';
import { ClaudeAgent } from '../../../src/agents/claude/claude-agent';

describe('ClaudeSessionFinder constructor injection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-ctor-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('accepts baseDir via constructor option', () => {
    const finder = new ClaudeSessionFinder({ baseDir: tempDir });
    expect(finder.getBaseDir()).toBe(tempDir);
  });

  test('defaults to ~/.claude/projects when no option given', () => {
    const finder = new ClaudeSessionFinder();
    expect(finder.getBaseDir()).toBe(join(homedir(), '.claude', 'projects'));
  });

  test('defaults when options object omits baseDir', () => {
    const finder = new ClaudeSessionFinder({});
    expect(finder.getBaseDir()).toBe(join(homedir(), '.claude', 'projects'));
  });

  test('listSessions on injected baseDir returns empty for empty tempDir', async () => {
    const finder = new ClaudeSessionFinder({ baseDir: tempDir });
    const result = await finder.listSessions!({});
    expect(result).toEqual([]);
  });
});

describe('ClaudeAgent forwards baseDir to its finder', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-agent-ctor-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('passes baseDir option through to ClaudeSessionFinder', () => {
    const agent = new ClaudeAgent({ verbose: false, baseDir: tempDir });
    const finder = agent.finder as ClaudeSessionFinder;
    expect(finder.getBaseDir()).toBe(tempDir);
  });

  test('existing `new ClaudeAgent({ verbose })` callers keep working', () => {
    const agent = new ClaudeAgent({ verbose: false });
    const finder = agent.finder as ClaudeSessionFinder;
    expect(finder.getBaseDir()).toBe(join(homedir(), '.claude', 'projects'));
  });
});
