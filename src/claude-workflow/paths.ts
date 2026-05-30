import { homedir } from 'node:os';
import { join } from 'node:path';

// SPEC §3.1 file layout:
//   ~/.claude/projects/{enc-cwd}/{session-uuid}/
//     ├── workflows/{wf_*}.json                         ← snapshot
//     └── subagents/workflows/{wf_*}/journal.jsonl      ← event stream
//                                  /agent-{17hex}.jsonl ← per-subagent transcript
//
// Path helpers stay pure — no I/O, no ID validation. Callers validate IDs via
// the isValid* helpers below before consuming results from filesystem scans.

const WORKFLOW_RUN_ID_REGEX = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/;
const WORKFLOW_AGENT_ID_REGEX = /^[0-9a-f]{17}$/;
const WORKFLOW_SNAPSHOT_FILENAME_REGEX = /^(wf_[0-9a-f]{8}-[0-9a-f]{3})\.json$/;
const WORKFLOW_AGENT_FILENAME_REGEX = /^agent-([0-9a-f]{17})\.jsonl$/;

export function getClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function getWorkflowsDir(sessionDir: string): string {
  return join(sessionDir, 'workflows');
}

export function getWorkflowSubagentsDir(sessionDir: string): string {
  return join(sessionDir, 'subagents', 'workflows');
}

export function getWorkflowRunDir(sessionDir: string, runId: string): string {
  return join(getWorkflowSubagentsDir(sessionDir), runId);
}

export function getWorkflowSnapshotPath(
  sessionDir: string,
  runId: string
): string {
  return join(getWorkflowsDir(sessionDir), `${runId}.json`);
}

export function getWorkflowJournalPath(
  sessionDir: string,
  runId: string
): string {
  return join(getWorkflowRunDir(sessionDir, runId), 'journal.jsonl');
}

export function getWorkflowAgentPath(
  sessionDir: string,
  runId: string,
  agentId: string
): string {
  return join(getWorkflowRunDir(sessionDir, runId), `agent-${agentId}.jsonl`);
}

// SPEC §11.2 R4-B1 — `/Users/x/code/foo` → `-Users-x-code-foo`.
// Sole runtime caller is the P3 dispatcher handling `--workflow` without
// runId; converts cwd into a fuzzy filter that matches Claude project dir
// names via `path.includes(filter)`.
export function cwdToClaudeProjectFilter(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

export function isValidWorkflowRunId(s: string): boolean {
  return WORKFLOW_RUN_ID_REGEX.test(s);
}

export function isValidWorkflowAgentId(s: string): boolean {
  return WORKFLOW_AGENT_ID_REGEX.test(s);
}

export function parseWorkflowSnapshotFilename(filename: string): string | null {
  const match = filename.match(WORKFLOW_SNAPSHOT_FILENAME_REGEX);
  return match ? match[1]! : null;
}

export function parseWorkflowAgentFilename(filename: string): string | null {
  const match = filename.match(WORKFLOW_AGENT_FILENAME_REGEX);
  return match ? match[1]! : null;
}

/**
 * Derive sessionDir + transcriptDir from a workflow snapshot path.
 * Used by both startClaudeWorkflowMultiWatch and
 * startClaudeWorkflowInteractiveWatch in src/index.ts.
 * Returns null when the path doesn't fit the expected
 * `{sessionDir}/workflows/wf_*.json` shape.
 */
export function deriveWorkflowDirs(
  snapshotPath: string,
  runId: string
): { sessionDir: string; transcriptDir: string } | null {
  const parts = snapshotPath.split('/');
  const wfIdx = parts.indexOf('workflows');
  if (wfIdx < 0) return null;
  const sessionDir = parts.slice(0, wfIdx).join('/');
  return {
    sessionDir,
    transcriptDir: `${sessionDir}/subagents/workflows/${runId}`,
  };
}

/** Session-id form (no brackets) for workflow journal. P6/P7 tabs + pane key. */
export function makeWorkflowJournalSessionId(runId: string): string {
  return `wf:${runId}:journal`;
}
