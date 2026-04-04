import chalk from 'chalk';
import type { LineParser } from '../agents/agent.interface.ts';
import type { Formatter } from '../formatters/formatter.interface.ts';
import type { ParsedLine } from '../core/types.ts';

/**
 * Build the summary gap separator.
 * Uses ═ double-line + ↕ to visually distinguish from agent-tail's
 * content-level truncation (`... (N lines omitted) ...` in yellow).
 */
function formatGapSeparator(skipped: number): string[] {
  const msg =
    skipped > 0 ? ` ↕ ${skipped} messages skipped ` : ' ↕ messages skipped ';
  const lineLen = Math.max(0, 40 - msg.length);
  const half = Math.floor(lineLen / 2);
  const line = '═'.repeat(half);
  const separator = chalk.dim(`${line}${msg}${line}`);
  return ['', '', separator, '', ''];
}

/** Default number of head lines to show */
const DEFAULT_HEAD_LINES = 5;
/** Default number of tail lines to show */
const DEFAULT_TAIL_LINES = 15;

/**
 * Read head + tail lines from a JSONL session file and format them.
 * Reads only the necessary portions of the file for efficiency.
 *
 * For JSONL files: reads first 16KB for head, last 16KB for tail.
 * For JSON files (Gemini): reads entire file (typically small).
 */
export async function formatSummary(
  filePath: string,
  parser: LineParser,
  formatter: Formatter,
  options: {
    headLines?: number;
    tailLines?: number;
    jsonMode?: boolean;
  } = {}
): Promise<string[]> {
  const headCount = options.headLines ?? DEFAULT_HEAD_LINES;
  const tailCount = options.tailLines ?? DEFAULT_TAIL_LINES;

  if (options.jsonMode) {
    return formatSummaryFromJSON(
      filePath,
      parser,
      formatter,
      headCount,
      tailCount
    );
  }
  return formatSummaryFromJSONL(
    filePath,
    parser,
    formatter,
    headCount,
    tailCount
  );
}

/**
 * Parse lines through parser, collecting formatted output.
 * Handles stateful parsers (Claude) by draining with while loop.
 */
function parseAndFormat(
  lines: string[],
  parser: LineParser,
  formatter: Formatter
): string[] {
  const output: string[] = [];
  for (const line of lines) {
    let parsed: ParsedLine | null = parser.parse(line);
    let guard = 0;
    while (parsed && guard < 100) {
      const formatted = formatter.format(parsed);
      if (formatted) output.push(formatted);
      parsed = parser.parse(line);
      guard++;
    }
  }
  return output;
}

/** JSONL summary: read head and tail portions of the file */
async function formatSummaryFromJSONL(
  filePath: string,
  parser: LineParser,
  formatter: Formatter,
  headCount: number,
  tailCount: number
): Promise<string[]> {
  const CHUNK_SIZE = 16384; // 16KB
  const file = Bun.file(filePath);
  const size = file.size;
  if (size === 0) return [];

  // Small files: single read, parse everything
  if (size <= CHUNK_SIZE * 2) {
    const fullText = await file.text();
    const allLines = fullText.split('\n').filter(Boolean);
    const totalParsed = parseAndFormat(allLines, parser, formatter);

    if (totalParsed.length <= headCount + tailCount) {
      return totalParsed;
    }

    const head = totalParsed.slice(0, headCount);
    const tail = totalParsed.slice(-tailCount);
    const skipped = totalParsed.length - headCount - tailCount;
    return [...head, ...formatGapSeparator(skipped), ...tail];
  }

  // Large file: read head and tail chunks in parallel
  const [headText, tailText] = await Promise.all([
    file.slice(0, CHUNK_SIZE).text(),
    file.slice(Math.max(0, size - CHUNK_SIZE), size).text(),
  ]);
  const headLines = headText.split('\n').filter(Boolean);
  const allTailLines = tailText.split('\n').filter(Boolean);

  const headParsed = parseAndFormat(
    headLines.slice(0, headCount * 3),
    parser,
    formatter
  ).slice(0, headCount);

  // Tail uses same parser — Claude parser state may leak from head parse,
  // but for summary display this is acceptable (tail lines are self-contained)
  const tailParsed = parseAndFormat(
    allTailLines.slice(-(tailCount * 3)),
    parser,
    formatter
  ).slice(-tailCount);

  if (headParsed.length === 0 && tailParsed.length === 0) return [];

  return [...headParsed, ...formatGapSeparator(0), ...tailParsed];
}

/** JSON summary (Gemini): read entire file, parse all messages */
async function formatSummaryFromJSON(
  filePath: string,
  parser: LineParser,
  formatter: Formatter,
  headCount: number,
  tailCount: number
): Promise<string[]> {
  const text = await Bun.file(filePath).text();
  const parsed = parseAndFormat([text], parser, formatter);

  if (parsed.length <= headCount + tailCount) {
    return parsed;
  }

  const head = parsed.slice(0, headCount);
  const tail = parsed.slice(-tailCount);
  const skipped = parsed.length - headCount - tailCount;
  return [...head, ...formatGapSeparator(skipped), ...tail];
}
