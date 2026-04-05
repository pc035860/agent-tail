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

  // Preview uses --summary for head+tail view (first 5 + last 15 lines)
  const previewParts = [
    `"${agentTailPath}"`,
    `"${agentType}"`,
    '{1}',
    '--summary',
  ];
  if (project) previewParts.push('-p', `"${project}"`);
  const previewCmd = previewParts.join(' ');

  const args: string[] = [
    '--ansi',
    '--delimiter',
    '\t',
    '--with-nth',
    '2..',
    '--preview',
    previewCmd,
    '--preview-window',
    'right:60%:wrap',
    '--header',
    `Select a ${agentType} session (Ctrl-R: refresh, Ctrl-/: toggle preview, Enter: tail)`,
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
  ];

  return args;
}

/**
 * Parse fzf selection output
 * @returns shortId if selection made, null if user cancelled
 */
export function parseSelection(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  // First field is shortId (tab-separated)
  const shortId = trimmed.split('\t')[0];
  return shortId || null;
}
