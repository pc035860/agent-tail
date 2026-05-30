/**
 * SPEC §11.4 — workflow summary for `agent-tail claude wf_* --summary`
 * and `agent-pick` fzf preview.
 *
 * `formatWorkflowSummary(snapshotPath, formatter, options)` derives the
 * journal.jsonl path from the workflow snapshot path, parses events with
 * `JournalLineParser`, and returns formatted head + tail lines.
 *
 * Missing journal → returns a graceful placeholder line, not empty output.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatWorkflowSummary } from '../../src/claude-workflow/summary';
import { PrettyFormatter } from '../../src/formatters/pretty-formatter';

const RUN_ID = 'wf_abcd1234-37e';
const ENC_DIR = '-Users-test-project';
const SESSION_UUID = 'aaaa1111-bbbb-2222-cccc-333344445555';

interface Fixture {
  baseDir: string;
  snapshotPath: string;
  transcriptDir: string;
  journalPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const baseDir = await mkdtemp(join(tmpdir(), 'wf-summary-'));

  // Snapshot lives at {base}/{encDir}/{UUID}/workflows/{runId}.json
  const sessionDir = join(baseDir, ENC_DIR, SESSION_UUID);
  const workflowsDir = join(sessionDir, 'workflows');
  await mkdir(workflowsDir, { recursive: true });
  const snapshotPath = join(workflowsDir, `${RUN_ID}.json`);
  await writeFile(snapshotPath, JSON.stringify({ status: 'completed' }));

  // Transcript dir is {sessionDir}/subagents/workflows/{runId}/
  const transcriptDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
  await mkdir(transcriptDir, { recursive: true });
  const journalPath = join(transcriptDir, 'journal.jsonl');

  return { baseDir, snapshotPath, transcriptDir, journalPath };
}

function makeJournalLine(
  type: 'started' | 'result',
  agentId: string,
  index: number
): string {
  const event =
    type === 'started'
      ? { type, key: `agent.${index}.started`, agentId }
      : {
          type,
          key: `agent.${index}.result`,
          agentId,
          result: `result body ${index}`,
        };
  return JSON.stringify(event);
}

describe('formatWorkflowSummary', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    await rm(fx.baseDir, { recursive: true, force: true });
  });

  test('returns parsed journal events for a populated journal', async () => {
    const lines = [
      makeJournalLine('started', 'aaaaaaa1111111', 1),
      makeJournalLine('result', 'aaaaaaa1111111', 1),
      makeJournalLine('started', 'bbbbbbb2222222', 2),
      makeJournalLine('result', 'bbbbbbb2222222', 2),
    ];
    await writeFile(fx.journalPath, lines.join('\n') + '\n');

    const formatter = new PrettyFormatter();
    const result = await formatWorkflowSummary(fx.snapshotPath, formatter, {
      headLines: 2,
      tailLines: 2,
    });

    expect(result.length).toBeGreaterThan(0);
    // At least one parsed event should mention an agent short id (first 7 hex)
    const joined = result.join('\n');
    expect(joined).toContain('aaaaaaa');
  });

  test('emits head + tail with gap separator when journal exceeds head+tail', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(
        makeJournalLine('started', `agent${i.toString().padStart(7, '0')}`, i)
      );
      lines.push(
        makeJournalLine('result', `agent${i.toString().padStart(7, '0')}`, i)
      );
    }
    await writeFile(fx.journalPath, lines.join('\n') + '\n');

    const formatter = new PrettyFormatter();
    const result = await formatWorkflowSummary(fx.snapshotPath, formatter, {
      headLines: 3,
      tailLines: 5,
    });

    // formatSummary inserts a gap separator string between head and tail.
    const hasGap = result.some(
      (l) => l.includes('messages skipped') || l.includes('↕')
    );
    expect(hasGap).toBe(true);
  });

  test('missing journal returns a friendly placeholder, not empty', async () => {
    // Don't write a journal — it's missing.
    const formatter = new PrettyFormatter();
    const result = await formatWorkflowSummary(fx.snapshotPath, formatter, {});

    expect(result.length).toBe(1);
    expect(result[0]?.toLowerCase()).toMatch(/journal|not.*available/);
  });

  test('malformed snapshot path returns empty (defensive)', async () => {
    const formatter = new PrettyFormatter();
    const result = await formatWorkflowSummary(
      '/not/a/valid/workflow/path/foo.json',
      formatter,
      {}
    );
    expect(result).toEqual([]);
  });
});
