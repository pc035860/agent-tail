import { describe, test, expect } from 'bun:test';
import {
  truncate,
  truncateByLines,
  contentToString,
  formatMultiline,
} from '../../src/utils/text';

describe('truncate', () => {
  test('returns short text unchanged', () => {
    const text = 'Hello, world!';
    expect(truncate(text)).toBe(text);
  });

  test('truncates long text with head...tail format', () => {
    const text = 'a'.repeat(300);
    const result = truncate(text);

    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('...');
    expect(result.startsWith('a'.repeat(100))).toBe(true);
    expect(result.endsWith('a'.repeat(100))).toBe(true);
  });

  test('respects custom headLength and tailLength', () => {
    const text = 'a'.repeat(100);
    const result = truncate(text, { headLength: 10, tailLength: 10 });

    expect(result).toBe('a'.repeat(10) + '...' + 'a'.repeat(10));
  });

  test('does not truncate in verbose mode', () => {
    const text = 'a'.repeat(500);
    const result = truncate(text, { verbose: true });

    expect(result).toBe(text);
  });

  test('handles threshold edge case', () => {
    // threshold = headLength(100) + tailLength(100) + 10 = 210
    const exactThreshold = 'a'.repeat(210);
    expect(truncate(exactThreshold)).toBe(exactThreshold);

    const overThreshold = 'a'.repeat(211);
    expect(truncate(overThreshold)).toContain('...');
  });
});

describe('truncateByLines', () => {
  test('returns text with few lines unchanged', () => {
    const text = 'line1\nline2\nline3';
    expect(truncateByLines(text)).toBe(text);
  });

  test('returns text at threshold unchanged', () => {
    // threshold = headLines(10) + tailLines(10) + 2 = 22
    const lines = Array.from({ length: 22 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    expect(truncateByLines(text)).toBe(text);
  });

  test('truncates long text preserving head and tail lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const result = truncateByLines(text);

    // 30 lines - 10 head - 10 tail = 10 omitted
    expect(result).toContain('line 1');
    expect(result).toContain('line 10');
    expect(result).toContain('... (10 lines omitted) ...');
    expect(result).toContain('line 21');
    expect(result).toContain('line 30');
    expect(result).not.toContain('line 11');
    expect(result).not.toContain('line 20');
  });

  test('does not truncate in verbose mode', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    expect(truncateByLines(text, { verbose: true })).toBe(text);
  });

  test('respects custom headLines and tailLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const result = truncateByLines(text, { headLines: 3, tailLines: 3 });

    // 20 lines - 3 head - 3 tail = 14 omitted
    expect(result).toContain('line 1');
    expect(result).toContain('line 3');
    expect(result).toContain('... (14 lines omitted) ...');
    expect(result).toContain('line 18');
    expect(result).toContain('line 20');
    expect(result).not.toContain('line 4');
    expect(result).not.toContain('line 17');
  });
});

describe('contentToString', () => {
  test('returns string as-is', () => {
    expect(contentToString('hello')).toBe('hello');
  });

  test('returns empty string for null/undefined', () => {
    expect(contentToString(null)).toBe('');
    expect(contentToString(undefined)).toBe('');
  });

  test('extracts text from { type: "text", text: "..." }', () => {
    expect(contentToString({ type: 'text', text: 'hello' })).toBe('hello');
  });

  test('extracts content from { content: "..." }', () => {
    expect(contentToString({ content: 'hello' })).toBe('hello');
  });

  test('handles array of strings', () => {
    expect(contentToString(['hello', 'world'])).toBe('hello world');
  });

  test('handles array of text objects', () => {
    const arr = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    expect(contentToString(arr)).toBe('hello world');
  });

  test('handles array with tool_result objects', () => {
    const arr = [{ type: 'tool_result', content: 'result data' }];
    expect(contentToString(arr)).toBe('result data');
  });

  test('handles array with mixed types', () => {
    const arr = [
      'plain text',
      { type: 'text', text: 'object text' },
      { type: 'image' }, // should become [image]
    ];
    expect(contentToString(arr)).toBe('plain text object text [image]');
  });

  test('stringifies unknown objects', () => {
    const obj = { foo: 'bar' };
    expect(contentToString(obj)).toBe(JSON.stringify(obj));
  });
});

describe('formatMultiline', () => {
  test('prefixes single line with space', () => {
    expect(formatMultiline('hello')).toBe(' hello');
  });

  test('indents multiline content', () => {
    const content = 'line1\nline2\nline3';
    const result = formatMultiline(content);

    expect(result).toBe('\n    line1\n    line2\n    line3');
  });

  test('uses custom indent', () => {
    const content = 'line1\nline2';
    const result = formatMultiline(content, '  ');

    expect(result).toBe('\n  line1\n  line2');
  });

  test('handles empty lines in multiline', () => {
    const content = 'line1\n\nline3';
    const result = formatMultiline(content);

    expect(result).toBe('\n    line1\n    \n    line3');
  });
});
