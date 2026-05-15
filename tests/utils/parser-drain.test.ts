import { describe, test, expect } from 'bun:test';
import { drainParser } from '../../src/utils/parser-drain';
import type { LineParser } from '../../src/agents/agent.interface';
import type { ParsedLine } from '../../src/core/types';

function makeParsed(formatted: string): ParsedLine {
  return { type: 'test', timestamp: '', raw: null, formatted };
}

/**
 * Stateful parser that emits `parts` from the input line, then null.
 * Mirrors the Cursor/Claude shape: first parse(line) returns first part;
 * subsequent parse(anyArg) returns the rest until drained.
 */
function statefulParser(parts: string[]): LineParser {
  let buffered: string[] | null = null;
  return {
    parse(line: string): ParsedLine | null {
      if (buffered === null) {
        if (!line) return null; // empty trigger never starts a new drain
        buffered = [...parts];
      }
      const next = buffered.shift();
      if (next === undefined) {
        buffered = null;
        return null;
      }
      return makeParsed(next);
    },
  };
}

/**
 * Stateless parser that returns the same ParsedLine on every call with the same
 * line, mimicking Codex/Gemini. Empty string returns null immediately.
 */
function statelessParser(): LineParser {
  return {
    parse(line: string): ParsedLine | null {
      if (!line) return null;
      return makeParsed(line);
    },
  };
}

describe('drainParser', () => {
  test('default drainArg (line): drains a stateful parser end-to-end', () => {
    const collected: string[] = [];
    drainParser(statefulParser(['a', 'b', 'c']), 'L', (p) =>
      collected.push(p.formatted)
    );
    expect(collected).toEqual(['a', 'b', 'c']);
  });

  test("drainArg: '' lets stateless parsers terminate after one emit", () => {
    const collected: string[] = [];
    // Without drainArg: '' a stateless parser would re-emit forever (up to guard).
    drainParser(
      statelessParser(),
      'same-line',
      (p) => collected.push(p.formatted),
      { drainArg: '' }
    );
    expect(collected).toEqual(['same-line']);
  });

  test('default drainArg with stateless parser hits the guard (still bounded)', () => {
    const collected: string[] = [];
    drainParser(statelessParser(), 'same-line', (p) =>
      collected.push(p.formatted)
    );
    // Guard caps the runaway: 100 iterations, not infinite
    expect(collected.length).toBe(100);
  });

  test('guard cutoff applies when a stateful parser emits more than 100 parts', () => {
    const parts = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const collected: string[] = [];
    drainParser(statefulParser(parts), 'L', (p) => collected.push(p.formatted));
    expect(collected.length).toBe(100);
    expect(collected[0]).toBe('p0');
    expect(collected[99]).toBe('p99');
  });

  test('parser returning null on first call: onEach is not invoked', () => {
    const collected: string[] = [];
    const nullParser: LineParser = { parse: () => null };
    drainParser(nullParser, 'L', (p) => collected.push(p.formatted));
    expect(collected).toEqual([]);
  });
});
