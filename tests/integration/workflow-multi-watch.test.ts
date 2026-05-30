import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowAttachment,
  makeWorkflowAgentLabel,
  makeWorkflowJournalLabel,
} from '../../src/claude-workflow/watch-builder';
import type { OutputHandler } from '../../src/core/detector-interfaces';
import { PrettyFormatter } from '../../src/formatters/pretty-formatter';

// End-to-end integration: WorkflowAttachment drives FileWatcher +
// JournalLineParser + ClaudeLineParser on a realistic fixture. Skips the
// startClaudeWorkflowMultiWatch dispatcher (which would touch process.exit)
// and drives WorkflowAttachment directly.

const RUN_ID = 'wf_12345678-abc';
const AGENT_ID_1 = '01234567890abcde1';
const AGENT_ID_2 = '01234567890abcde2';

function silentHandler(): OutputHandler {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

async function setupRealisticFixture(): Promise<{
  tempDir: string;
  transcriptDir: string;
  snapshotPath: string;
  journalPath: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), 'wf-integration-'));
  const sessionDir = join(tempDir, 'session');
  const workflowsDir = join(sessionDir, 'workflows');
  const transcriptDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
  await mkdir(workflowsDir, { recursive: true });
  await mkdir(transcriptDir, { recursive: true });

  const snapshotPath = join(workflowsDir, `${RUN_ID}.json`);
  await writeFile(
    snapshotPath,
    JSON.stringify({
      runId: RUN_ID,
      workflowName: 'integration-demo',
      status: 'running',
    })
  );

  const journalPath = join(transcriptDir, 'journal.jsonl');
  await writeFile(
    journalPath,
    [
      JSON.stringify({
        type: 'started',
        key: 'v2:abc',
        agentId: AGENT_ID_1,
      }),
      JSON.stringify({
        type: 'started',
        key: 'v2:def',
        agentId: AGENT_ID_2,
      }),
    ].join('\n') + '\n'
  );

  await writeFile(
    join(transcriptDir, `agent-${AGENT_ID_1}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-5-20251101',
        content: [{ type: 'text', text: 'hello from agent 1' }],
      },
    }) + '\n'
  );

  await writeFile(
    join(transcriptDir, `agent-${AGENT_ID_2}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-5-20251101',
        content: [{ type: 'text', text: 'hello from agent 2' }],
      },
    }) + '\n'
  );

  return { tempDir, transcriptDir, snapshotPath, journalPath };
}

describe('Integration — WorkflowAttachment end-to-end', () => {
  let tempDir: string | null = null;
  let attachment: WorkflowAttachment | null = null;

  afterEach(async () => {
    await attachment?.stop('user');
    attachment = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('full fixture (journal + 2 agents) yields 3 distinct labels', async () => {
    const fx = await setupRealisticFixture();
    tempDir = fx.tempDir;

    const lines: { formatted: string; label: string }[] = [];
    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fx.transcriptDir,
        snapshotPath: fx.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: new PrettyFormatter(),
      onOutput: (formatted, label) => lines.push({ formatted, label }),
      outputHandler: silentHandler(),
    });

    await attachment.start();

    const labels = new Set(lines.map((l) => l.label));
    expect(labels.has(makeWorkflowJournalLabel(RUN_ID))).toBe(true);
    expect(labels.has(makeWorkflowAgentLabel(AGENT_ID_1))).toBe(true);
    expect(labels.has(makeWorkflowAgentLabel(AGENT_ID_2))).toBe(true);

    // At least one line per source
    expect(
      lines.some((l) => l.label === makeWorkflowJournalLabel(RUN_ID))
    ).toBe(true);
    expect(
      lines.some((l) => l.label === makeWorkflowAgentLabel(AGENT_ID_1))
    ).toBe(true);
    expect(
      lines.some((l) => l.label === makeWorkflowAgentLabel(AGENT_ID_2))
    ).toBe(true);
  });

  test('withAgents: false → only journal labels appear', async () => {
    const fx = await setupRealisticFixture();
    tempDir = fx.tempDir;

    const lines: { formatted: string; label: string }[] = [];
    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fx.transcriptDir,
        snapshotPath: fx.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: new PrettyFormatter(),
      onOutput: (formatted, label) => lines.push({ formatted, label }),
      outputHandler: silentHandler(),
    });

    await attachment.start();

    const labels = new Set(lines.map((l) => l.label));
    expect(labels.has(makeWorkflowJournalLabel(RUN_ID))).toBe(true);
    expect(labels.has(makeWorkflowAgentLabel(AGENT_ID_1))).toBe(false);
    expect(labels.has(makeWorkflowAgentLabel(AGENT_ID_2))).toBe(false);
  });
});
