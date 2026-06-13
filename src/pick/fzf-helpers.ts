import { dirname, join } from 'node:path';
import type { AgentType } from '../core/types.ts';

/**
 * Check if fzf is available on the system
 */
export function checkFzfAvailable(): boolean {
  return Bun.which('fzf') !== null;
}

/**
 * Resolve the path to agent-tail binary
 */
export function resolveAgentTailPath(): string {
  // Resolve relative to this file's location: src/pick/ -> bin/agent-tail
  const srcDir = dirname(import.meta.dir);
  const projectRoot = dirname(srcDir);
  const binPath = join(projectRoot, 'bin', 'agent-tail');

  return binPath;
}

/**
 * Build fzf command arguments for session browsing
 */
export function buildFzfArgs(config: {
  agentType: AgentType;
  agentTailPath: string;
  project?: string;
  limit?: number;
}): string[] {
  const { agentType, agentTailPath, project, limit } = config;

  // Build the list command for fzf input (used in reload bind)
  const listParts = [agentTailPath, agentType, '--list'];
  if (project) listParts.push('-p', project);
  if (limit) listParts.push('-n', String(limit));
  const listCmd = 'FORCE_COLOR=1 ' + listParts.map((p) => `"${p}"`).join(' ');

  // Preview uses --summary for head+tail view (first 5 + last 15 lines).
  // SPEC §11.4 R4-S3: take col 6 (HIDDEN_FULL_ID) unambiguously rather than
  // the visible short id — workflow rows would otherwise pass the runId
  // through agent-tail's partial-match path differently from main sessions.
  const previewParts = [
    `"${agentTailPath}"`,
    `"${agentType}"`,
    '{6}',
    '--summary',
  ];
  if (project) previewParts.push('-p', `"${project}"`);
  const previewCmd = previewParts.join(' ');

  const args: string[] = [
    '--ansi',
    '--delimiter',
    '\t',
    // SPEC §11.4: show TYPE/ID/TIME/NOTES/TITLE (cols 1..5); col 6 stays
    // hidden and carries the full id for parser / bindings.
    '--with-nth',
    '1..5',
    '--preview',
    previewCmd,
    '--preview-window',
    'right:60%:wrap',
    '--header',
    `Select a ${agentType} session (Ctrl-R: refresh, Ctrl-/: toggle preview, Ctrl-Y: copy id, Enter: tail)`,
    '--prompt',
    'session> ',
    '--bind',
    `ctrl-r:reload(${listCmd})`,
    '--bind',
    'ctrl-/:toggle-preview',
    '--bind',
    'ctrl-d:preview-page-down',
    '--bind',
    'ctrl-u:preview-page-up',
    '--bind',
    'ctrl-y:execute-silent(printf %s {6} | pbcopy)+change-header(✓ Copied session ID: {6})',
  ];

  return args;
}

/**
 * Parse fzf selection output and return the hidden full id (col 6 per
 * SPEC §11.4). Returns null if input is empty or col 6 is missing.
 */
export function parseSelection(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 6) return null;
  const hiddenId = parts[5];
  return hiddenId || null;
}
