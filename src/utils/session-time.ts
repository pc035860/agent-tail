/**
 * Utilities for reading session metadata via tail-read.
 * Reads only the last 8KB to avoid loading entire files into memory.
 */

import { homedir } from 'node:os';

/** Tail-read size in bytes — 8KB covers most last JSONL lines */
const TAIL_READ_SIZE = 8192;

/**
 * Read the `cwd` field from a JSONL session file.
 * Some sessions have 30+ file-history-snapshot lines (60KB+) before the first
 * line with `cwd`. Uses progressive chunk reading: try 16KB first, then 64KB,
 * then 256KB. Most sessions find cwd in the first chunk.
 * Replaces homedir with `~` for display.
 */
export async function readCwdFromHead(
  filePath: string
): Promise<string | null> {
  const CHUNK_SIZES = [16384, 65536, 262144]; // 16KB, 64KB, 256KB

  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    for (const chunkSize of CHUNK_SIZES) {
      if (chunkSize > size * 2 && chunkSize !== CHUNK_SIZES[0]) break;

      const head = file.slice(0, Math.min(size, chunkSize));
      const text = await head.text();
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.cwd && typeof data.cwd === 'string') {
            const home = homedir();
            if (data.cwd.startsWith(home)) {
              return '~' + data.cwd.slice(home.length);
            }
            return data.cwd;
          }
        } catch {
          // Skip malformed JSON (truncated at chunk boundary)
        }
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Read the last custom-title from a Claude JSONL file using tail-read.
 * Only reads the last 8KB instead of the entire file.
 */
export async function readCustomTitleFromTail(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    const start = Math.max(0, size - TAIL_READ_SIZE);
    const tail = file.slice(start, size);
    const text = await tail.text();
    const lines = text.split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]!);
        if (data.type === 'custom-title' && data.customTitle) {
          return data.customTitle as string;
        }
      } catch {
        // Skip malformed JSON
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Read last timestamp from a JSONL file (Claude, Codex).
 * Reads only the last 8KB and scans backward for a line with `timestamp`.
 */
export async function readLastTimestampFromJSONL(
  filePath: string
): Promise<Date | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    const start = Math.max(0, size - TAIL_READ_SIZE);
    const tail = file.slice(start, size);
    const text = await tail.text();
    const lines = text.split('\n').filter(Boolean);

    // Scan from end to find a line with timestamp
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]!);
        if (data.timestamp) {
          const date = new Date(data.timestamp);
          if (!isNaN(date.getTime())) return date;
        }
      } catch {
        // Skip malformed JSON (e.g., partial line from slice boundary)
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Read the first meaningful user prompt from a Claude JSONL session, head-read.
 * Used as a `customTitle` fallback in `--list` so unnamed sessions still convey
 * what was being worked on (e.g. `/eshop-deploy ec-frontend, stag+prod, v1.97.0`,
 * `⏰ samtsan-daily-marketplace`, or the raw first-turn user message).
 *
 * Filtering:
 * - <scheduled-task name="X">  → `⏰ X`
 * - <command-name>/cmd</command-name> with optional <command-args>X</command-args>
 *                              → `/cmd X` (args trimmed to single line)
 * - lines with only XML tags / Caveat: prefix / empty → skipped
 * - assistant tool_use placeholders / tool_result content → skipped
 *
 * Reads progressive chunks (16KB → 64KB → 256KB) because a few Claude sessions
 * have many file-history-snapshot or system-reminder lines before the first
 * real user turn.
 */
export async function readFirstUserPromptFromHead(
  filePath: string,
  maxLength = 80
): Promise<string | null> {
  const CHUNK_SIZES = [16384, 65536, 262144]; // 16KB, 64KB, 256KB
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    for (const chunkSize of CHUNK_SIZES) {
      const head = file.slice(0, Math.min(size, chunkSize));
      const text = await head.text();
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        const extracted = tryExtractUserPrompt(line);
        if (extracted) {
          // Collapse internal whitespace then truncate
          const normalized = extracted.replace(/\s+/g, ' ').trim();
          return normalized.length > maxLength
            ? normalized.slice(0, maxLength - 1) + '…'
            : normalized;
        }
      }
      // 已讀完整檔，下一輪 chunk 不會帶來新內容
      if (chunkSize >= size) break;
    }
  } catch {
    // File read error
  }
  return null;
}

/** Extract a usable prompt string from a single Claude JSONL line, or null. */
function tryExtractUserPrompt(line: string): string | null {
  let data: { type?: string; isMeta?: boolean; message?: unknown };
  try {
    data = JSON.parse(line) as typeof data;
  } catch {
    return null;
  }
  if (data.type !== 'user' || data.isMeta) return null;

  const msg = data.message as { content?: unknown } | undefined;
  const content = msg?.content;

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text'
      ) {
        text = (part as { text?: string }).text ?? '';
        break;
      }
    }
  }
  text = text.trim();
  if (!text) return null;

  // <scheduled-task name="X" ...>  →  ⏰ X
  const sched = text.match(/<scheduled-task[^>]*name="([^"]+)"/);
  if (sched?.[1]) return `⏰ ${sched[1]}`;

  // <command-name>/cmd</command-name> with optional <command-args>
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd?.[1]) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    const argText = args?.[1]?.trim();
    return argText ? `${cmd[1].trim()} ${argText}` : cmd[1].trim();
  }

  if (text.startsWith('Caveat:')) return null;

  // 明確 skip 已知 Claude Code 注入的 internal wrapper（system-reminder、
  // bash-stdout/stderr、local-command-stdout、attached-files 等）。
  // 不能用 generic XML strip — 那會把 reminder 內文當成 prompt 露出。
  if (INTERNAL_WRAPPER_TAG_RE.test(text)) return null;

  // 其他殘留 XML（沒在白名單但也不是已知 wrapper）一律 strip 後返回，
  // 因為這通常是 user prompt 內嵌的標籤（例如 <code>foo</code>）。
  const stripped = text.replace(/<[^>]+>/g, '').trim();
  return stripped || null;
}

/**
 * 已知 Claude Code 注入到 user 訊息中的內部 wrapper tag。
 * 開頭命中任何一個就完全跳過（不嘗試提取內容）。
 */
const INTERNAL_WRAPPER_TAG_RE =
  /^<(system-reminder|bash-(?:stdout|stderr|input)|local-command-(?:stdout|stderr)|command-stdout|command-stderr|stdout|stderr|attached-files|user-prompt-submit-hook)\b/;

/**
 * Read last message timestamp from a Gemini JSON session file.
 * Gemini uses whole-file JSON (not JSONL), so we read the entire file.
 * Session files are typically small.
 */
export async function readLastTimestampFromGeminiJSON(
  filePath: string
): Promise<Date | null> {
  try {
    const text = await Bun.file(filePath).text();
    const data = JSON.parse(text);

    // Gemini JSON structure has messages/events with timestamps
    // Try common structures: messages array, events array
    const items =
      data.messages ?? data.events ?? data.history ?? data.parts ?? [];
    if (!Array.isArray(items)) return null;

    for (let i = items.length - 1; i >= 0; i--) {
      const ts = items[i]?.timestamp ?? items[i]?.createTime;
      if (ts) {
        const date = new Date(ts);
        if (!isNaN(date.getTime())) return date;
      }
    }
  } catch {
    // File read or parse error
  }
  return null;
}
