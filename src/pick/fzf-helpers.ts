import type { AgentType } from '../core/types.ts';

/**
 * Check if fzf is available on the system
 */
export function checkFzfAvailable(): boolean {
  // TODO: implement
  return false;
}

/**
 * Build fzf command arguments
 */
export function buildFzfArgs(_config: {
  agentType: AgentType;
  agentTailPath: string;
  project?: string;
  limit?: number;
}): string[] {
  // TODO: implement
  return [];
}

/**
 * Parse fzf selection output
 * @returns shortId if selection made, null if user cancelled
 */
export function parseSelection(_output: string): string | null {
  // TODO: implement
  return null;
}

/**
 * Resolve the path to agent-tail binary
 */
export function resolveAgentTailPath(): string {
  // TODO: implement
  return '';
}
