import { describe, test, expect } from 'bun:test';
import { truncate, contentToString, formatMultiline } from '../../src/utils/text';

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
