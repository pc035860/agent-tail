import { describe, test, expect, afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { WorkflowAttachment } from '../../src/claude-workflow/watch-builder';
import {
  AGENT_ID_1,
  AGENT_ID_2,
  RUN_ID,
  type Fixture,
  captureOutput,
  createHandler,
  makeStartedJournalLine,
  rawFormatter,
  setupFixture,
} from './_fixtures';

// SPEC §14.7 T18 — journal.jsonl with invalid JSON lines is tolerated by
// JournalLineParser (returns null); WorkflowAttachment continues processing
// the rest of the file without crashing.

describe('journal.jsonl invalid line tolerance (T18)', () => {
  let fixture: Fixture;
  let attachment: WorkflowAttachment | null = null;

  afterEach(async () => {
    await attachment?.stop('user');
    attachment = null;
    if (fixture?.tempDir) {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test('mixed valid + invalid lines yield only valid output', async () => {
    fixture = await setupFixture({
      journalLines: [
        makeStartedJournalLine(AGENT_ID_1),
        'this is not json',
        makeStartedJournalLine(AGENT_ID_2),
        '{broken json',
        JSON.stringify({
          type: 'result',
          key: 'v2:final',
          agentId: AGENT_ID_1,
          result: 'ok',
        }),
      ],
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });

    let threw = false;
    try {
      await attachment.start();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Expect exactly 3 journal output lines (2 started + 1 result),
    // invalid lines silently skipped by JournalLineParser.parse.
    const journalLines = lines.filter(
      (l) =>
        l.formatted.includes('agent') &&
        (l.formatted.includes('started') || l.formatted.includes('result'))
    );
    expect(journalLines.length).toBe(3);
  });
});
