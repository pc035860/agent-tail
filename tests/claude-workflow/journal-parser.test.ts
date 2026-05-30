import { describe, test, expect } from 'bun:test';
import {
  JournalLineParser,
  safeStringify,
} from '../../src/claude-workflow/journal-parser.ts';

const VALID_AGENT_ID = 'adca0c33ebe734c2d';
const SHORT_AGENT_ID = VALID_AGENT_ID.slice(0, 7); // 'adca0c3'

function makeStartedLine(agentId = VALID_AGENT_ID): string {
  return JSON.stringify({ type: 'started', key: 'v2:xxx', agentId });
}

function makeResultLine(result: unknown, agentId = VALID_AGENT_ID): string {
  return JSON.stringify({ type: 'result', key: 'v2:xxx', agentId, result });
}

describe('JournalLineParser — started event', () => {
  test('parses started event with shortAgentId in formatted', () => {
    const parser = new JournalLineParser();
    const parsed = parser.parse(makeStartedLine());

    expect(parsed).not.toBeNull();
    expect(parsed!.workflowEvent).toBe('started');
    expect(parsed!.workflowAgentId).toBe(VALID_AGENT_ID);
    expect(parsed!.type).toBe('system');
    expect(parsed!.formatted).toContain(SHORT_AGENT_ID);
    expect(parsed!.formatted).toContain('started');
  });
});

describe('JournalLineParser — result event', () => {
  test('parses result with string body', () => {
    const parser = new JournalLineParser();
    const parsed = parser.parse(makeResultLine('hello world'));

    expect(parsed).not.toBeNull();
    expect(parsed!.workflowEvent).toBe('result');
    expect(parsed!.formatted).toContain(SHORT_AGENT_ID);
    expect(parsed!.formatted).toContain('result: hello world');
  });

  test('parses result with object body (stringified)', () => {
    const parser = new JournalLineParser();
    const parsed = parser.parse(makeResultLine({ foo: 'bar' }));

    expect(parsed).not.toBeNull();
    expect(parsed!.formatted).toContain('result: {"foo":"bar"}');
  });

  test('truncates long result body to ~100 chars', () => {
    const parser = new JournalLineParser();
    const longBody = 'x'.repeat(200);
    const parsed = parser.parse(makeResultLine(longBody));

    expect(parsed).not.toBeNull();
    // Tight bound: header (≈30 chars) + 100-char truncated body + ellipsis.
    // ANSI color codes from chalk add ~10 bytes per color span.
    expect(parsed!.formatted.length).toBeLessThan(180);
    // Match the truncated body shape: 100 'x' chars followed by ellipsis.
    expect(parsed!.formatted).toMatch(/x{100}…/);
  });

  test('result body null does not crash', () => {
    const parser = new JournalLineParser();
    const parsed = parser.parse(makeResultLine(null));

    expect(parsed).not.toBeNull();
    expect(parsed!.formatted).toContain('result: null');
  });

  test('result body number does not crash', () => {
    const parser = new JournalLineParser();
    const parsed = parser.parse(makeResultLine(42));

    expect(parsed).not.toBeNull();
    expect(parsed!.formatted).toContain('result: 42');
  });
});

describe('JournalLineParser — tolerance', () => {
  test('invalid JSON returns null', () => {
    const parser = new JournalLineParser();
    expect(parser.parse('not-json')).toBeNull();
    expect(parser.parse('{broken')).toBeNull();
  });

  test('missing type field returns null', () => {
    const parser = new JournalLineParser();
    expect(
      parser.parse(JSON.stringify({ key: 'v2:x', agentId: VALID_AGENT_ID }))
    ).toBeNull();
  });

  test('unknown type returns null', () => {
    const parser = new JournalLineParser();
    expect(
      parser.parse(
        JSON.stringify({
          type: 'unknown',
          key: 'v2:x',
          agentId: VALID_AGENT_ID,
        })
      )
    ).toBeNull();
  });

  test('missing agentId returns null', () => {
    const parser = new JournalLineParser();
    expect(
      parser.parse(JSON.stringify({ type: 'started', key: 'v2:x' }))
    ).toBeNull();
  });

  test('missing key returns null', () => {
    const parser = new JournalLineParser();
    expect(
      parser.parse(JSON.stringify({ type: 'started', agentId: VALID_AGENT_ID }))
    ).toBeNull();
  });

  test('non-string agentId returns null', () => {
    const parser = new JournalLineParser();
    expect(
      parser.parse(
        JSON.stringify({ type: 'started', key: 'v2:x', agentId: {} })
      )
    ).toBeNull();
  });
});

describe('JournalLineParser — timestamp handling', () => {
  test('history mode uses fileMtime ISO string', () => {
    const mtime = new Date('2026-01-01T00:00:00.000Z');
    const parser = new JournalLineParser({ fileMtime: mtime });
    const parsed = parser.parse(makeStartedLine());

    expect(parsed).not.toBeNull();
    expect(parsed!.timestamp).toBe(mtime.toISOString());
  });

  test('history mode timestamp is stable across multiple parses', () => {
    const mtime = new Date('2026-01-01T00:00:00.000Z');
    const parser = new JournalLineParser({ fileMtime: mtime });

    const timestamps: string[] = [];
    for (let i = 0; i < 5; i++) {
      const parsed = parser.parse(makeStartedLine(VALID_AGENT_ID));
      expect(parsed).not.toBeNull();
      timestamps.push(parsed!.timestamp);
    }

    const allEqual = timestamps.every((t) => t === mtime.toISOString());
    expect(allEqual).toBe(true);
  });

  test('markLiveMode switches to current-time ISO', () => {
    const mtime = new Date('2026-01-01T00:00:00.000Z');
    const parser = new JournalLineParser({ fileMtime: mtime });
    parser.markLiveMode();

    const parsed = parser.parse(makeStartedLine());
    expect(parsed).not.toBeNull();
    expect(parsed!.timestamp).not.toBe(mtime.toISOString());

    // Assert it's a valid ISO timestamp.
    const parsedDate = new Date(parsed!.timestamp);
    expect(Number.isNaN(parsedDate.getTime())).toBe(false);
  });
});

describe('safeStringify helper (exported for testing)', () => {
  test('passes through strings', () => {
    expect(safeStringify('hello')).toBe('hello');
  });

  test('handles null and undefined', () => {
    expect(safeStringify(null)).toBe('null');
    expect(safeStringify(undefined)).toBe('undefined');
  });

  test('JSON.stringify on plain object', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('falls back to [object] when JSON.stringify throws', () => {
    const throwing = {
      get foo(): string {
        throw new Error('boom');
      },
    };
    expect(safeStringify(throwing)).toBe('[object]');
  });
});
