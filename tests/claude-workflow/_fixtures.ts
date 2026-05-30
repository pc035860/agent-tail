// Shared test fixtures for claude-workflow test files.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutputHandler } from '../../src/core/detector-interfaces';
import type { Formatter } from '../../src/formatters/formatter.interface';
import { PrettyFormatter } from '../../src/formatters/pretty-formatter';

export const RUN_ID = 'wf_12345678-abc';
export const AGENT_ID_1 = '01234567890abcde1';
export const AGENT_ID_2 = '01234567890abcde2';

export interface CapturingHandler extends OutputHandler {
  debugMsgs: string[];
  warnMsgs: string[];
  infoMsgs: string[];
  errorMsgs: string[];
}

export function createHandler(): CapturingHandler {
  const debugMsgs: string[] = [];
  const warnMsgs: string[] = [];
  const infoMsgs: string[] = [];
  const errorMsgs: string[] = [];
  return {
    debugMsgs,
    warnMsgs,
    infoMsgs,
    errorMsgs,
    info: (m: string) => infoMsgs.push(m),
    warn: (m: string) => warnMsgs.push(m),
    error: (m: string) => errorMsgs.push(m),
    debug: (m: string) => debugMsgs.push(m),
  };
}

export function captureOutput(): {
  lines: { formatted: string; label: string }[];
  onOutput: (formatted: string, label: string) => void;
} {
  const lines: { formatted: string; label: string }[] = [];
  return {
    lines,
    onOutput: (formatted, label) => lines.push({ formatted, label }),
  };
}

export function rawFormatter(): Formatter {
  return new PrettyFormatter();
}

export interface Fixture {
  tempDir: string;
  workflowDir: string;
  transcriptDir: string;
  journalPath: string;
  snapshotPath: string;
}

export async function setupFixture(
  opts: {
    journalLines?: string[];
    agents?: { agentId: string; lines: string[] }[];
    /** Override snapshot file content (string). When undefined, writes
     *  default `{ runId, status: 'running' }`. */
    snapshotContent?: string;
    /** Skip writing the snapshot file entirely (for ENOENT tests). */
    skipSnapshot?: boolean;
  } = {}
): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), 'wf-fixture-'));
  const sessionDir = join(tempDir, 'session');
  const workflowDir = join(sessionDir, 'workflows');
  const transcriptDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
  await mkdir(workflowDir, { recursive: true });
  await mkdir(transcriptDir, { recursive: true });

  const journalPath = join(transcriptDir, 'journal.jsonl');
  const snapshotPath = join(workflowDir, `${RUN_ID}.json`);

  if (!opts.skipSnapshot) {
    const snapshotContent =
      opts.snapshotContent ??
      JSON.stringify({ runId: RUN_ID, status: 'running' });
    await writeFile(snapshotPath, snapshotContent);
  }

  if (opts.journalLines && opts.journalLines.length > 0) {
    await writeFile(journalPath, opts.journalLines.join('\n') + '\n');
  } else {
    await writeFile(journalPath, '');
  }

  for (const agent of opts.agents ?? []) {
    const path = join(transcriptDir, `agent-${agent.agentId}.jsonl`);
    await writeFile(path, agent.lines.join('\n') + '\n');
  }

  return {
    tempDir,
    workflowDir,
    transcriptDir,
    journalPath,
    snapshotPath,
  };
}

export function makeStartedJournalLine(agentId: string): string {
  return JSON.stringify({
    type: 'started',
    key: 'v2:abc',
    agentId,
  });
}

export function makeAssistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      model: 'claude-sonnet-4-5-20251101',
      content: [{ type: 'text', text }],
    },
  });
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
