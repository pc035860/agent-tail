import { Chalk } from 'chalk';
import type { AgentType, SessionListItem } from '../core/types.ts';

/** Chalk instance with forced color (level 1 = basic ANSI) for --list output */
const colorChalk = new Chalk({ level: 1 });

const UUID_REGEX =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const HEX8_TRAIL_REGEX = /([0-9a-f]{8})$/i;

/**
 * 從 session 檔案路徑提取完整 session ID。
 * - Claude / Cursor: `{UUID}.jsonl` → UUID
 * - Codex: `rollout-{ts}-{UUID}.jsonl` → UUID
 * - Gemini: `session-{ts}-{hex8}.json` → hex8
 * - Fallback: basename 去副檔名
 */
export function extractFullId(path: string): string {
  const basename = path.split('/').pop() ?? '';
  const stem = basename.replace(/\.(jsonl|json)$/i, '');
  const uuidMatch = UUID_REGEX.exec(stem);
  if (uuidMatch) return uuidMatch[1]!;
  const hex8Match = HEX8_TRAIL_REGEX.exec(stem);
  if (hex8Match) return hex8Match[1]!;
  return stem;
}

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
      extractFullId(item.path),
      formatRelativeTime(item.lastActivityTime ?? item.mtime),
      agentStr,
      item.project ?? '',
      item.customTitle ? `"${item.customTitle}"` : '',
    ];

    return columns.join('\t');
  });
}
