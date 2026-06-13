import { describe, test, expect } from 'bun:test';
import { resolveExistingParents } from '../../src/claude/subagent-detector';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ============================================================
// Helpers — synthesize Claude session JSONL fixtures
// ============================================================

function buildAgentToolUseLine(opts: {
  toolUseId: string;
  description: string;
  toolName?: 'Agent' | 'Task';
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'fixture',
    message: {
      content: [
        {
          type: 'tool_use',
          name: opts.toolName ?? 'Agent',
          id: opts.toolUseId,
          input: {
            description: opts.description,
            subagent_type: 'general-purpose',
          },
        },
      ],
    },
  });
}

function buildMultipartLine(opts: {
  toolUseIds: string[];
  text?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'fixture',
    message: {
      content: [
        ...(opts.text ? [{ type: 'text', text: opts.text }] : []),
        ...opts.toolUseIds.map((id, i) => ({
          type: 'tool_use',
          name: 'Agent',
          id,
          input: { description: `spawn-${i}` },
        })),
      ],
    },
  });
}

function buildPlainAssistantLine(): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'fixture',
    message: { content: [{ type: 'text', text: 'noise' }] },
  });
}

// ============================================================
// Tests
// ============================================================

describe('resolveExistingParents', () => {
  test('main-spawned subagent → parent = undefined (cleaner [child] label)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-main-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(
      mainPath,
      [
        buildPlainAssistantLine(),
        buildAgentToolUseLine({
          toolUseId: 'toolu_mainSpawn',
          description: 'main spawn',
        }),
      ].join('\n')
    );
    await writeFile(join(subagentsDir, 'agent-aaaaaaa.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-aaaaaaa.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'main spawn',
        toolUseId: 'toolu_mainSpawn',
      })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'aaaaaaa',
    ]);

    expect(parents.get('aaaaaaa')).toBeUndefined();
  });

  test('nested subagent → parent = level-1 agentId ([child◂parent])', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-nested-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    // main spawns level-1
    await writeFile(
      mainPath,
      buildAgentToolUseLine({
        toolUseId: 'toolu_mainSpawn',
        description: 'L1',
      })
    );
    // level-1 spawns level-2 (recorded inside level-1's own jsonl)
    await writeFile(
      join(subagentsDir, 'agent-aaaaaaa.jsonl'),
      buildAgentToolUseLine({
        toolUseId: 'toolu_nestedSpawn',
        description: 'L2',
      })
    );
    await writeFile(
      join(subagentsDir, 'agent-aaaaaaa.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'L1',
        toolUseId: 'toolu_mainSpawn',
      })
    );
    // level-2 with its meta pointing back to the nested spawn id
    await writeFile(join(subagentsDir, 'agent-bbbbbbb.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-bbbbbbb.meta.json'),
      JSON.stringify({
        agentType: 'prompt-reviewer',
        description: 'L2',
        toolUseId: 'toolu_nestedSpawn',
      })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'aaaaaaa',
      'bbbbbbb',
    ]);

    expect(parents.get('aaaaaaa')).toBeUndefined(); // main-spawned
    expect(parents.get('bbbbbbb')).toBe('aaaaaaa'); // nested
  });

  test('missing meta.json → parent = undefined (backward compat)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-nometa-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(mainPath, '');
    await writeFile(join(subagentsDir, 'agent-ccccccc.jsonl'), '');
    // No meta.json on purpose

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'ccccccc',
    ]);

    expect(parents.has('ccccccc')).toBe(true);
    expect(parents.get('ccccccc')).toBeUndefined();
  });

  test('meta.toolUseId not found anywhere → parent = undefined (orphan tolerated)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-orphan-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(mainPath, buildPlainAssistantLine());
    await writeFile(join(subagentsDir, 'agent-ddddddd.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-ddddddd.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'orphan',
        toolUseId: 'toolu_ghost',
      })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'ddddddd',
    ]);

    expect(parents.get('ddddddd')).toBeUndefined();
  });

  test('empty agentIds → empty map (no I/O)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-empty-'));
    const parents = await resolveExistingParents(
      join(tmpDir, 'subagents'),
      join(tmpDir, 'nonexistent-main.jsonl'),
      []
    );
    expect(parents.size).toBe(0);
  });

  // Discriminating: parent IS expected to resolve to a nested agentId.
  // If Task collection failed, parent would be undefined and the assertion
  // would catch it (cf. "main-spawned → undefined" — that case is symmetric
  // with collection failure and can't distinguish them).
  test('legacy Task tool name resolves to nested parent (asserts collection works)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-task-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(mainPath, '');
    // Level-1 spawns level-2 via the LEGACY `Task` tool name
    await writeFile(
      join(subagentsDir, 'agent-ttttttt.jsonl'),
      buildAgentToolUseLine({
        toolUseId: 'toolu_legacyTask',
        description: 'legacy nested',
        toolName: 'Task',
      })
    );
    await writeFile(
      join(subagentsDir, 'agent-ttttttt.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_mainSpawn' })
    );
    await writeFile(join(subagentsDir, 'agent-uuuuuuu.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-uuuuuuu.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_legacyTask' })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'ttttttt',
      'uuuuuuu',
    ]);

    // If Task wasn't collected, parents.get('uuuuuuu') would be undefined.
    expect(parents.get('uuuuuuu')).toBe('ttttttt');
  });

  // Discriminating: multipart spawn occurs inside a parent subagent's JSONL,
  // and the children's expected parent IS that subagent. If multipart parsing
  // dropped the second tool_use, the child would resolve to undefined.
  test('multipart assistant message — both spawns are collected (asserts multipart parse)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-multipart-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(mainPath, '');
    // Level-1's JSONL has a single assistant message with text + 2 tool_uses.
    await writeFile(
      join(subagentsDir, 'agent-mpparen.jsonl'),
      buildMultipartLine({
        toolUseIds: ['toolu_mp1', 'toolu_mp2'],
        text: 'Spawning two children in one turn:',
      })
    );
    await writeFile(
      join(subagentsDir, 'agent-mpparen.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_mainSpawn' })
    );
    await writeFile(join(subagentsDir, 'agent-mpaaaaa.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-mpaaaaa.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_mp1' })
    );
    await writeFile(join(subagentsDir, 'agent-mpbbbbb.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-mpbbbbb.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_mp2' })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      'mpparen',
      'mpaaaaa',
      'mpbbbbb',
    ]);

    expect(parents.get('mpaaaaa')).toBe('mpparen');
    expect(parents.get('mpbbbbb')).toBe('mpparen'); // second tool_use must also be collected
  });

  test('multiple level-2 children sharing a level-1 parent', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cold-attach-multi-'));
    const subagentsDir = join(tmpDir, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const mainPath = join(tmpDir, 'main.jsonl');
    await writeFile(
      mainPath,
      buildAgentToolUseLine({
        toolUseId: 'toolu_mainSpawn',
        description: 'L1',
      })
    );
    // level-1 makes TWO nested spawns
    await writeFile(
      join(subagentsDir, 'agent-1111111.jsonl'),
      [
        buildAgentToolUseLine({
          toolUseId: 'toolu_n1',
          description: 'L2a',
        }),
        buildAgentToolUseLine({
          toolUseId: 'toolu_n2',
          description: 'L2b',
        }),
      ].join('\n')
    );
    await writeFile(
      join(subagentsDir, 'agent-1111111.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_mainSpawn' })
    );

    await writeFile(join(subagentsDir, 'agent-2222222.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-2222222.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_n1' })
    );
    await writeFile(join(subagentsDir, 'agent-3333333.jsonl'), '');
    await writeFile(
      join(subagentsDir, 'agent-3333333.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_n2' })
    );

    const parents = await resolveExistingParents(subagentsDir, mainPath, [
      '1111111',
      '2222222',
      '3333333',
    ]);

    expect(parents.get('1111111')).toBeUndefined(); // main-spawned
    expect(parents.get('2222222')).toBe('1111111');
    expect(parents.get('3333333')).toBe('1111111');
  });
});
