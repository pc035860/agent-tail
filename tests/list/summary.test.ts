import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { formatSummary } from '../../src/list/summary';
import type { LineParser } from '../../src/agents/agent.interface';
import type { Formatter } from '../../src/formatters/formatter.interface';
import type { ParsedLine } from '../../src/core/types';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Simple stateless parser: returns once per line, null on second call */
function createSimpleParser(): LineParser {
  let lastLine = '';
  return {
    parse(line: string): ParsedLine | null {
      if (line === lastLine) return null; // Prevent double parse
      lastLine = line;
      try {
        const data = JSON.parse(line);
        return {
          type: data.type ?? 'unknown',
          timestamp: data.timestamp ?? '',
          raw: data,
          formatted: data.text ?? line,
        };
      } catch {
        return null;
      }
    },
  };
}
// Create fresh parser per usage (stateful — tracks last line)

/** Simple formatter: just returns the formatted string */
const simpleFormatter: Formatter = {
  format(parsed: ParsedLine): string {
    return parsed.formatted;
  },
};

function makeLine(text: string, type = 'message'): string {
  return JSON.stringify({ type, text, timestamp: '2026-01-01T00:00:00Z' });
}

describe('formatSummary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'summary-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test('returns all lines when total is within head+tail limit', async () => {
    const filePath = join(tempDir, 'small.jsonl');
    const lines = Array.from({ length: 5 }, (_, i) => makeLine(`line ${i}`));
    await writeFile(filePath, lines.join('\n'));

    const result = await formatSummary(
      filePath,
      createSimpleParser(),
      simpleFormatter,
      {
        headLines: 3,
        tailLines: 3,
      }
    );

    expect(result).toHaveLength(5);
    expect(result[0]).toBe('line 0');
    expect(result[4]).toBe('line 4');
  });

  test('shows head + ... + tail for large files', async () => {
    const filePath = join(tempDir, 'large.jsonl');
    const lines = Array.from({ length: 30 }, (_, i) =>
      makeLine(`line ${i.toString().padStart(2, '0')}`)
    );
    await writeFile(filePath, lines.join('\n'));

    const result = await formatSummary(
      filePath,
      createSimpleParser(),
      simpleFormatter,
      {
        headLines: 3,
        tailLines: 5,
      }
    );

    // Should have: 3 head + 1 separator + 5 tail = 9 lines
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result[0]).toBe('line 00');
    expect(result[1]).toBe('line 01');
    expect(result[2]).toBe('line 02');
    // Find the gap separator (═ double-line style)
    const sepIdx = result.findIndex((l) => l.includes('↕'));
    expect(sepIdx).toBeGreaterThan(0);
    expect(result[sepIdx]).toContain('messages skipped');
    // Last line should be the actual last line
    expect(result[result.length - 1]).toBe('line 29');
  });

  test('returns empty array for empty file', async () => {
    const filePath = join(tempDir, 'empty.jsonl');
    await writeFile(filePath, '');

    const result = await formatSummary(
      filePath,
      createSimpleParser(),
      simpleFormatter
    );
    expect(result).toEqual([]);
  });

  test('uses default head=5 and tail=15', async () => {
    const filePath = join(tempDir, 'default.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => makeLine(`line ${i}`));
    await writeFile(filePath, lines.join('\n'));

    const result = await formatSummary(
      filePath,
      createSimpleParser(),
      simpleFormatter
    );

    // Should have head(5) + separator + tail(15) = 21
    expect(result.length).toBeLessThanOrEqual(22);
    expect(result[0]).toBe('line 0');
    const sepIdx = result.findIndex((l) => l.includes('↕'));
    expect(sepIdx).toBeGreaterThan(0);
  });
});
