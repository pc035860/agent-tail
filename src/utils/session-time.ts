/**
 * Utilities for reading session metadata via tail-read.
 * Reads only the last 8KB to avoid loading entire files into memory.
 */

import { homedir } from 'node:os';

/** Tail-read size in bytes — 8KB covers most last JSONL lines */
const TAIL_READ_SIZE = 8192;

/**
 * Decode Claude's encoded project path to a human-readable path.
 * Claude encodes `/Users/foo/code/bar` as `-Users-foo-code-bar`.
 * We decode it back and replace homedir with `~`.
 */
export function decodeClaudeProjectPath(encoded: string): string {
  // Encoded format: leading `-` = `/`, internal `-` = `/`
  // But this is lossy — we can't distinguish `-` that was `/` from literal `-`.
  // Best effort: replace leading `-` with `/`, then all `-` with `/`
  const decoded = encoded.replace(/^-/, '/').replace(/-/g, '/');
  const home = homedir();
  if (decoded.startsWith(home)) {
    return '~' + decoded.slice(home.length);
  }
  return decoded;
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
