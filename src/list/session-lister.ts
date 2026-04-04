import { Chalk } from 'chalk';
import type { AgentType, SessionListItem } from '../core/types.ts';

/** Chalk instance with forced color (level 1 = basic ANSI) for --list output */
const colorChalk = new Chalk({ level: 1 });

/**
 * Format a Date as relative time string (e.g., "3m ago", "1h ago")
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 1000) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

const AGENT_COLORS: Record<AgentType, (s: string) => string> = {
  claude: (s) => colorChalk.magenta(s),
  codex: (s) => colorChalk.green(s),
  gemini: (s) => colorChalk.blue(s),
  cursor: (s) => colorChalk.yellow(s),
};

/**
 * Format a list of sessions as tab-separated lines
 */
export function formatSessionList(
  items: SessionListItem[],
  options: { color: boolean }
): string[] {
  return items.map((item) => {
    const agentStr = options.color
      ? AGENT_COLORS[item.agentType](item.agentType)
      : item.agentType;

    const columns = [
      item.shortId,
      formatRelativeTime(item.lastActivityTime ?? item.mtime),
      agentStr,
      item.project ?? '',
    ];
    // Append custom title as 5th column when present
    if (item.customTitle) columns.push(`"${item.customTitle}"`);

    return columns.join('\t');
  });
}
