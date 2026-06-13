import { Chalk } from 'chalk';
import type { SessionListItem } from '../core/types.ts';
import { padVisibleEnd, truncateVisible } from '../utils/visible-width.ts';

/** Chalk instance with forced color (level 1 = basic ANSI) for --list output */
const colorChalk = new Chalk({ level: 1 });

/**
 * Fixed visible widths for the visible columns. Goal: every row writes the
 * same number of visible cells into cols 0..3, so `\t` between them always
 * expands to the same terminal tab stop (multiples of 8) and TITLE (col 4)
 * starts at a fixed cell across rows.
 *
 * Without this, e.g. `3m ago` and `just now` (both ≤ 8 cells) end at different
 * cells; the inter-column tab then lands at a different stop and TITLE wanders
 * 8 cells row-to-row. Tab stop after a `\t` is `ceil((cursor+1)/8)*8` —
 * strictly the next multiple of 8 — so widths chosen as:
 *   - TYPE  width 4  → 'sess' fits exactly, 'wf  ' pads to 4; tab → cell 8
 *   - ID    width 15 → workflow runId `wf_8hex-3hex` worst case; tab → cell 24
 *   - TIME  width 8  → 'just now' fits exactly; tab → cell 40
 *   - NOTES width 36 → tab → cell 80; TITLE always begins at cell 80
 */
const TYPE_COLUMN_WIDTH = 4;
const ID_COLUMN_WIDTH = 15;
const TIME_COLUMN_WIDTH = 8;
const NOTES_COLUMN_WIDTH = 36;

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
  const stem = basename.replace(/\.(jsonl|json|pb)$/i, '');
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

/**
 * SPEC §11.3 NOTES column.
 *   - workflow: '{status} · in session {uuid8}' (status segment omitted when absent)
 *   - main:     project ?? ''
 */
function formatNotes(item: SessionListItem): string {
  if (item.logType === 'workflow') {
    const uuid8 = item.workflowSessionUuid?.slice(0, 8) ?? '';
    const inSession = uuid8 ? `in session ${uuid8}` : '';
    if (item.workflowStatus) {
      return inSession
        ? `${item.workflowStatus} · ${inSession}`
        : item.workflowStatus;
    }
    return inSession;
  }
  return item.project ?? '';
}

/**
 * SPEC §11.4 col 6 — hidden full id used by fzf preview / ctrl-y / parseSelection.
 *   - workflow: full runId
 *   - main:     extractFullId(path)
 */
function hiddenFullId(item: SessionListItem): string {
  if (item.logType === 'workflow' && item.workflowRunId) {
    return item.workflowRunId;
  }
  return extractFullId(item.path);
}

/**
 * Strip tab / newline / carriage return from a visible column. Output is
 * tab-delimited (SPEC §11.4) and consumed by fzf — a stray `\t` inside
 * customTitle or project would push the hidden id out of col 6, breaking
 * preview / ctrl-y / Enter routing. `\n` / `\r` would split rows.
 */
function sanitizeColumn(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ');
}

/**
 * Render the TITLE column with explicit visual distinction:
 *   - customTitle (user-set / `/rename`): plain text — full visual weight
 *   - autoTitle (derived from first user prompt): `› TEXT` dimmed — subtle signal
 *     that this is a derived hint, not authoritative
 *   - neither: dim em-dash `—`
 */
function formatTitleColumn(item: SessionListItem, color: boolean): string {
  if (item.customTitle) {
    return sanitizeColumn(item.customTitle);
  }
  if (item.autoTitle) {
    const text = sanitizeColumn(`› ${item.autoTitle}`);
    return color ? colorChalk.dim(text) : text;
  }
  return color ? colorChalk.dim('—') : '—';
}

/**
 * Format a list of sessions as tab-separated lines per SPEC §11.3 / §11.4.
 *
 * Columns (tab-separated):
 *   0 TYPE    'sess' | 'wf'  (cyan / magenta when color=true)
 *   1 ID      short identifier
 *   2 TIME    relative time
 *   3 NOTES   see {@link formatNotes} — project path (main) or workflow status
 *   4 TITLE   customTitle | dim('› ' + autoTitle) | dim('—')
 *   5 HID     hidden full id (see {@link hiddenFullId}); fzf --with-nth 1..5 hides it
 *
 * Column order rationale: project paths are bounded (~10-50 chars, mostly
 * `~/code/foo` or `~/git/foo` shape), while titles can range from `/clear`
 * (6 chars) to long bilingual prompts (80+). Putting the bounded column
 * first keeps the variable-length TITLE on the right edge where wrapping is
 * visually acceptable.
 */
export function formatSessionList(
  items: SessionListItem[],
  options: { color: boolean }
): string[] {
  return items.map((item) => {
    const isWorkflow = item.logType === 'workflow';
    const typeRaw = isWorkflow ? 'wf' : 'sess';
    const typeStr = options.color
      ? isWorkflow
        ? colorChalk.magenta(typeRaw)
        : colorChalk.cyan(typeRaw)
      : typeRaw;

    // Visible columns are sanitized: user-controlled customTitle and
    // path-derived project may contain tab / newline, which would corrupt
    // the 6-col tab-delimited contract consumed by fzf.
    // TYPE / ID / TIME / NOTES are all padded to fixed visible widths so the
    // TITLE column aligns vertically across rows (see *_COLUMN_WIDTH consts).
    const idRaw = sanitizeColumn(item.shortId);
    const timeRaw = formatRelativeTime(item.lastActivityTime ?? item.mtime);
    const notesRaw = sanitizeColumn(formatNotes(item));
    const columns = [
      padVisibleEnd(typeStr, TYPE_COLUMN_WIDTH),
      padVisibleEnd(truncateVisible(idRaw, ID_COLUMN_WIDTH), ID_COLUMN_WIDTH),
      padVisibleEnd(
        truncateVisible(timeRaw, TIME_COLUMN_WIDTH),
        TIME_COLUMN_WIDTH
      ),
      padVisibleEnd(
        truncateVisible(notesRaw, NOTES_COLUMN_WIDTH),
        NOTES_COLUMN_WIDTH
      ),
      formatTitleColumn(item, options.color),
      hiddenFullId(item),
    ];

    return columns.join('\t');
  });
}
