// Phase 1 stub — implementation pending; intentionally returns wrong values so tests RED.

export function getClaudeProjectsRoot(): string {
  return '';
}

export function getWorkflowsDir(_sessionDir: string): string {
  return '';
}

export function getWorkflowSubagentsDir(_sessionDir: string): string {
  return '';
}

export function getWorkflowRunDir(_sessionDir: string, _runId: string): string {
  return '';
}

export function getWorkflowSnapshotPath(
  _sessionDir: string,
  _runId: string
): string {
  return '';
}

export function getWorkflowJournalPath(
  _sessionDir: string,
  _runId: string
): string {
  return '';
}

export function getWorkflowAgentPath(
  _sessionDir: string,
  _runId: string,
  _agentId: string
): string {
  return '';
}

export function cwdToClaudeProjectFilter(_cwd: string): string {
  return '';
}

export function isValidWorkflowRunId(_s: string): boolean {
  return false;
}

export function isValidWorkflowAgentId(_s: string): boolean {
  return false;
}

export function parseWorkflowSnapshotFilename(
  _filename: string
): string | null {
  return null;
}

export function parseWorkflowAgentFilename(_filename: string): string | null {
  return null;
}
