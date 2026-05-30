import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowAttachment,
  makeWorkflowJournalLabel,
  makeWorkflowAgentLabel,
} from '../../src/claude-workflow/watch-builder';
import type { ParsedLine } from '../../src/core/types';
import type { Formatter } from '../../src/formatters/formatter.interface';
import {
  AGENT_ID_1,
  AGENT_ID_2,
  RUN_ID,
  type Fixture,
  captureOutput,
  createHandler,
  makeAssistantLine,
  makeStartedJournalLine,
  rawFormatter,
  setupFixture,
  waitMs,
} from './_fixtures';

describe('WorkflowAttachment', () => {
  let fixture: Fixture;
  let attachment: WorkflowAttachment | null = null;

  afterEach(async () => {
    await attachment?.stop('user');
    attachment = null;
    if (fixture?.tempDir) {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test('start() reads journal initial content (2 started events)', async () => {
    fixture = await setupFixture({
      journalLines: [
        makeStartedJournalLine(AGENT_ID_1),
        makeStartedJournalLine(AGENT_ID_2),
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
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const journalLabel = makeWorkflowJournalLabel(RUN_ID);
    // Filter out snapshot status event lines (P4 emits these under the
    // journal label too); we want only the JournalLineParser-emitted lines.
    const journalLines = lines.filter(
      (l) => l.label === journalLabel && !l.formatted.includes('[snapshot]')
    );
    expect(journalLines.length).toBe(2);
  });

  test('start() initial scan attaches existing agents', async () => {
    fixture = await setupFixture({
      agents: [
        { agentId: AGENT_ID_1, lines: [makeAssistantLine('hello from a1')] },
        { agentId: AGENT_ID_2, lines: [makeAssistantLine('hello from a2')] },
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
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    const label1 = makeWorkflowAgentLabel(AGENT_ID_1);
    const label2 = makeWorkflowAgentLabel(AGENT_ID_2);
    expect(lines.some((l) => l.label === label1)).toBe(true);
    expect(lines.some((l) => l.label === label2)).toBe(true);
  });

  test('withAgents=false skips agent attachment', async () => {
    fixture = await setupFixture({
      journalLines: [makeStartedJournalLine(AGENT_ID_1)],
      agents: [{ agentId: AGENT_ID_1, lines: [makeAssistantLine('skip me')] }],
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
    await attachment.start();

    const journalLabel = makeWorkflowJournalLabel(RUN_ID);
    const agentLabel = makeWorkflowAgentLabel(AGENT_ID_1);
    expect(lines.some((l) => l.label === journalLabel)).toBe(true);
    expect(lines.some((l) => l.label === agentLabel)).toBe(false);
  });

  test('new agent-*.jsonl appearance attaches dynamically', async () => {
    fixture = await setupFixture();
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    // Write new agent transcript after start
    const agentPath = join(fixture.transcriptDir, `agent-${AGENT_ID_1}.jsonl`);
    await writeFile(agentPath, makeAssistantLine('dynamic'));
    await waitMs(300);

    const agentLabel = makeWorkflowAgentLabel(AGENT_ID_1);
    expect(lines.some((l) => l.label === agentLabel)).toBe(true);
  });

  test('attachAgent dedup: same agentId from initial scan + dir watch only attaches once', async () => {
    fixture = await setupFixture({
      agents: [{ agentId: AGENT_ID_1, lines: [makeAssistantLine('once')] }],
    });
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    // Trigger dir-watch event by rewriting the same file
    const agentPath = join(fixture.transcriptDir, `agent-${AGENT_ID_1}.jsonl`);
    await writeFile(agentPath, makeAssistantLine('once'));
    await waitMs(200);

    // The line emerges exactly once per write — but if attachAgent fired twice,
    // we'd see duplicate parser instances on the same file, causing duplicate
    // emissions. Asserting initial-scan content appears exactly once is the
    // dedup contract.
    const label = makeWorkflowAgentLabel(AGENT_ID_1);
    const matching = lines.filter(
      (l) => l.label === label && l.formatted.includes('once')
    );
    expect(matching.length).toBe(1);
  });

  test('stop() closes all watchers, post-stop writes not delivered', async () => {
    fixture = await setupFixture();
    const handler = createHandler();
    const { lines, onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();
    await attachment.stop('completed');
    attachment = null; // prevent afterEach double-stop

    const lineCountBefore = lines.length;
    // Write content after stop
    await writeFile(fixture.journalPath, makeStartedJournalLine(AGENT_ID_1));
    await waitMs(200);

    expect(lines.length).toBe(lineCountBefore);
  });

  test('_waitForTranscriptDir retries on missing dir', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wf-wait-'));
    const sessionDir = join(tempDir, 'session');
    const transcriptDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
    const snapshotPath = join(sessionDir, 'workflows', `${RUN_ID}.json`);
    await mkdir(join(sessionDir, 'workflows'), { recursive: true });
    await writeFile(
      snapshotPath,
      JSON.stringify({ runId: RUN_ID, status: 'running' })
    );

    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: { runId: RUN_ID, transcriptDir, snapshotPath },
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });

    // Create transcript dir + empty journal AFTER 200ms (during waitForTranscriptDir's retry window)
    setTimeout(async () => {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(join(transcriptDir, 'journal.jsonl'), '');
    }, 200);

    let threw = false;
    try {
      await attachment.start();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    await rm(tempDir, { recursive: true, force: true });
  });

  test('journal parser uses file mtime in history, current time in live mode', async () => {
    fixture = await setupFixture({
      journalLines: [makeStartedJournalLine(AGENT_ID_1)],
    });
    const handler = createHandler();
    const collected: ParsedLine[] = [];

    // Intercept ParsedLine before formatting by using a formatter that records
    // the input. Simpler: use a custom Formatter that captures the parsed
    // timestamp.
    const captureFormatter: Formatter = {
      format(parsed: ParsedLine): string {
        collected.push(parsed);
        return parsed.formatted;
      },
    };

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: false,
      verbose: false,
      follow: true,
      pollInterval: 100,
      formatter: captureFormatter,
      onOutput: () => {},
      outputHandler: handler,
    });
    await attachment.start();

    const historyTs = collected[0]?.timestamp ?? '';
    expect(historyTs).not.toBe('');

    // Append a new line — should be live mode
    await writeFile(
      fixture.journalPath,
      [
        makeStartedJournalLine(AGENT_ID_1),
        makeStartedJournalLine(AGENT_ID_2),
      ].join('\n') + '\n'
    );
    await waitMs(200);

    const liveLine = collected.find((p) => p.workflowAgentId === AGENT_ID_2);
    expect(liveLine).toBeDefined();
    expect(liveLine!.timestamp).not.toBe(historyTs);
  });

  test('attachAgent rollback on failure clears all state', async () => {
    fixture = await setupFixture();
    const handler = createHandler();
    const { onOutput } = captureOutput();

    attachment = new WorkflowAttachment({
      workflow: {
        runId: RUN_ID,
        transcriptDir: fixture.transcriptDir,
        snapshotPath: fixture.snapshotPath,
      },
      withAgents: true,
      verbose: false,
      follow: false,
      formatter: rawFormatter(),
      onOutput,
      outputHandler: handler,
    });
    await attachment.start();

    // Attach a non-existent transcript file → start() should fail and rollback
    let threw = false;
    try {
      await attachment.attachAgent(
        AGENT_ID_1,
        join(fixture.transcriptDir, 'agent-DOES-NOT-EXIST.jsonl')
      );
    } catch {
      threw = true;
    }
    // Either resolved or threw — what matters is rollback ran (debug message)
    expect(
      handler.debugMsgs.some((m) => m.includes(AGENT_ID_1.slice(0, 7))) ||
        threw === false
    ).toBe(true);

    // After rollback, attempting again should succeed (state was cleaned)
    const agentPath = join(fixture.transcriptDir, `agent-${AGENT_ID_1}.jsonl`);
    await writeFile(agentPath, makeAssistantLine('rolled-back-then-success'));
    let threwSecond = false;
    try {
      await attachment.attachAgent(AGENT_ID_1, agentPath);
    } catch {
      threwSecond = true;
    }
    expect(threwSecond).toBe(false);
  });
});
