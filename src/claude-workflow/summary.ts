/**
 * Workflow `--summary` output (powers `agent-pick` fzf preview for `wf_*` rows
 * and `agent-tail claude wf_* --summary`).
 *
 * Resolves the workflow snapshot path → matching `journal.jsonl` path, then
 * delegates to `formatSummary` with a `JournalLineParser`. A snapshot is a
 * single JSON object (not JSONL), so summarizing it directly with a JSONL
 * parser produced empty output before this branch existed.
 */
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import chalk from 'chalk';
import type { Formatter } from '../formatters/formatter.interface.ts';
import { formatSummary } from '../list/summary.ts';
import { JournalLineParser } from './journal-parser.ts';
import {
  deriveWorkflowDirs,
  getWorkflowJournalPath,
  parseWorkflowSnapshotFilename,
} from './paths.ts';

export interface FormatWorkflowSummaryOptions {
  headLines?: number;
  tailLines?: number;
}

export async function formatWorkflowSummary(
  snapshotPath: string,
  formatter: Formatter,
  options: FormatWorkflowSummaryOptions = {}
): Promise<string[]> {
  const runId = parseWorkflowSnapshotFilename(basename(snapshotPath));
  if (!runId) return [];

  const dirs = deriveWorkflowDirs(snapshotPath, runId);
  if (!dirs) return [];

  const journalPath = getWorkflowJournalPath(dirs.sessionDir, runId);
  if (!(await Bun.file(journalPath).exists())) {
    return [chalk.gray('(workflow journal not yet available)')];
  }

  // Use journal mtime as the history timestamp so historic events get a
  // stable timestamp instead of "now" for every line. Falls back silently
  // if stat fails for any reason.
  let fileMtime: Date | undefined;
  try {
    const st = await stat(journalPath);
    fileMtime = st.mtime;
  } catch {
    fileMtime = undefined;
  }

  const parser = new JournalLineParser(fileMtime ? { fileMtime } : {});
  return formatSummary(journalPath, parser, formatter, options);
}
