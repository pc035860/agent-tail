import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForNewSubagents } from '../../src/claude/subagent-detector';

// SPEC §9.4 / T17 — Claude SubagentDetector must NOT pick up workflow
// nested agent transcripts at `subagents/workflows/wf_*/agent-{17hex}.jsonl`.
//
// REGRESSION GUARDS: these tests pass against current production code
// because `Bun.Glob('agent-*.jsonl')` is non-recursive by default. Any
// refactor to a recursive glob, `readdir`, or `**/agent-*.jsonl` must keep
// these green — the P2 plan additionally adds `if (file.includes('/'))`
// defensive guard in scanForNewSubagents for belt-and-braces.

describe('scanForNewSubagents — workflows/ subdirectory exclusion (T17)', () => {
  let tempDir: string;
  let subagentsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'subagent-wf-'));
    subagentsDir = join(tempDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('mixed flat + nested: only flat agentId returned', async () => {
    // Flat subagent (should be picked up)
    await writeFile(join(subagentsDir, 'agent-aaaaaaa.jsonl'), '{}');

    // Workflow-nested subagent (must NOT be picked up)
    const wfDir = join(subagentsDir, 'workflows', 'wf_12345678-abc');
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, 'agent-bbbbbbbbbbbbbbbbb.jsonl'), '{}');

    const result = await scanForNewSubagents(subagentsDir, new Set());
    expect(result).toEqual(['aaaaaaa']);
  });

  test('workflow-only directory: returns empty array', async () => {
    // Only nested workflow agents — no flat siblings
    const wfDir = join(subagentsDir, 'workflows', 'wf_12345678-abc');
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, 'agent-cccccccccccccccc1.jsonl'), '{}');
    await writeFile(join(wfDir, 'agent-dddddddddddddddd2.jsonl'), '{}');

    const result = await scanForNewSubagents(subagentsDir, new Set());
    expect(result).toEqual([]);
  });

  test('knownAgentIds set excludes already-known flat agents', async () => {
    await writeFile(join(subagentsDir, 'agent-aaaaaaa.jsonl'), '{}');
    await writeFile(join(subagentsDir, 'agent-bbbbbbb.jsonl'), '{}');

    const result = await scanForNewSubagents(
      subagentsDir,
      new Set(['aaaaaaa'])
    );
    expect(result).toEqual(['bbbbbbb']);
  });
});
