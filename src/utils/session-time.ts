/**
 * Utilities for reading session metadata via tail-read.
 * Reads only the last 8KB to avoid loading entire files into memory.
 */

import { homedir } from 'node:os';

/** Tail-read size in bytes — 8KB covers most last JSONL lines */
const TAIL_READ_SIZE = 8192;

/** Head-read size in bytes — 16KB covers first few JSONL lines (some can be >5KB with large prompts) */
const HEAD_READ_SIZE = 16384;

/**
 * Read the `cwd` field from the first few lines of a JSONL session file.
 * Claude sessions have `cwd` in early lines (usually line 1 or 2).
 * Replaces homedir with `~` for display.
 */
export async function readCwdFromHead(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;

    const head = file.slice(0, Math.min(size, HEAD_READ_SIZE));
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
        // Skip malformed JSON
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
