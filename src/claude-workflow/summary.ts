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

  // Single stat() handles both existence check and mtime read. ENOENT →
  // friendly placeholder; any other error falls through with mtime=undefined
  // (parser then stamps history events with "now", which is acceptable
  // fallback behavior for the preview surface).
  let fileMtime: Date | undefined;
  try {
    fileMtime = (await stat(journalPath)).mtime;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [chalk.gray('(workflow journal not yet available)')];
    }
    fileMtime = undefined;
  }

  const parser = new JournalLineParser(fileMtime ? { fileMtime } : {});
  return formatSummary(journalPath, parser, formatter, options);
}
