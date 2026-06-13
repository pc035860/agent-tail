import { describe, test, expect } from 'bun:test';
import {
  stripAnsi,
  visibleWidth,
  padVisibleEnd,
  truncateVisible,
} from '../../src/utils/visible-width';

describe('stripAnsi', () => {
  test('removes SGR escape sequences', () => {
    expect(stripAnsi('\x1b[2m›\x1b[0m hi')).toBe('› hi');
  });
  test('passes plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

describe('visibleWidth', () => {
  test('ASCII: 1 cell per char', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('')).toBe(0);
  });

  test('ignores ANSI color codes', () => {
    expect(visibleWidth('\x1b[2m›\x1b[0m hi')).toBe(4); // ›=1, space=1, h=1, i=1
  });

  test('CJK characters are 2 cells', () => {
    // 中文 = 2, 中文字 = 2+2+2 = 6
    expect(visibleWidth('中文')).toBe(4);
    expect(visibleWidth('中文字')).toBe(6);
  });

  test('mixed ASCII + CJK', () => {
    // hi=2, space=1, 中文=4 → 7
    expect(visibleWidth('hi 中文')).toBe(7);
  });

  test('handles surrogate-pair emoji as wide', () => {
    expect(visibleWidth('🎉')).toBe(2);
  });

  test('ellipsis character is 1 cell', () => {
    expect(visibleWidth('…')).toBe(1);
  });
});

describe('padVisibleEnd', () => {
  test('pads short ASCII to target width', () => {
    expect(padVisibleEnd('abc', 6)).toBe('abc   ');
  });

  test('returns unchanged when at or past target', () => {
    expect(padVisibleEnd('abcdef', 6)).toBe('abcdef');
    expect(padVisibleEnd('abcdefgh', 6)).toBe('abcdefgh');
  });

  test('accounts for CJK width', () => {
    // 中文=4 cells → pad to 8 needs 4 spaces
    expect(padVisibleEnd('中文', 8)).toBe('中文    ');
  });

  test('accounts for ANSI escapes (no over-pad)', () => {
    const dim = '\x1b[2mabc\x1b[0m';
    const padded = padVisibleEnd(dim, 6);
    // 3 visible cells + 3 spaces = 6 visible cells, regardless of ANSI bytes
    expect(visibleWidth(padded)).toBe(6);
  });
});

describe('truncateVisible', () => {
  test('returns plain text unchanged when within budget', () => {
    expect(truncateVisible('abc', 10)).toBe('abc');
  });

  test('truncates overlong ASCII with ellipsis', () => {
    expect(truncateVisible('abcdefghij', 5)).toBe('abcd…');
  });

  test('truncates CJK preserving full code points', () => {
    // 中文字串 = 4 chars × 2 cells = 8; max 5 → fits 中文 + …  (2+2+1=5)
    expect(truncateVisible('中文字串', 5)).toBe('中文…');
  });

  test('strips ANSI before truncating (color in input dropped)', () => {
    expect(truncateVisible('\x1b[2mabcdefghij\x1b[0m', 5)).toBe('abcd…');
  });

  test('zero budget after ellipsis still returns ellipsis-only', () => {
    expect(truncateVisible('abcd', 1)).toBe('…');
  });
});
