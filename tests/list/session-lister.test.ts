import { describe, test, expect } from 'bun:test';
import {
  formatRelativeTime,
  formatSessionList,
} from '../../src/list/session-lister';
import type { SessionListItem } from '../../src/core/types';

function makeItem(
  overrides: Partial<SessionListItem> & { shortId: string }
): SessionListItem {
  return {
    path: '/tmp/test.jsonl',
    mtime: new Date(),
    agentType: 'claude',
    ...overrides,
  };
}

describe('formatRelativeTime', () => {
  test('returns "just now" for current time', () => {
    const result = formatRelativeTime(new Date());
    expect(result).toBe('just now');
  });

  test('returns "3m ago" for 3 minutes ago', () => {
    const date = new Date(Date.now() - 3 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('3m ago');
  });

  test('returns "1m ago" at exactly 60 seconds', () => {
    const date = new Date(Date.now() - 60 * 1000);
    expect(formatRelativeTime(date)).toBe('1m ago');
  });

  test('returns "2h ago" for 2 hours ago', () => {
    const date = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('2h ago');
  });

  test('returns "1h ago" at exactly 3600 seconds', () => {
    const date = new Date(Date.now() - 3600 * 1000);
    expect(formatRelativeTime(date)).toBe('1h ago');
  });

  test('returns "1d ago" for 1 day ago', () => {
    const date = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('1d ago');
  });

  test('returns "30d ago" for 30 days ago', () => {
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('30d ago');
  });

  test('returns "just now" for future dates', () => {
    const date = new Date(Date.now() + 60 * 1000);
    expect(formatRelativeTime(date)).toBe('just now');
  });

  test('returns seconds for less than 60 seconds', () => {
    const date = new Date(Date.now() - 30 * 1000);
    expect(formatRelativeTime(date)).toBe('30s ago');
  });
});

describe('formatSessionList', () => {
  test('returns empty array for empty input', () => {
    const result = formatSessionList([], { color: false });
    expect(result).toEqual([]);
  });

  test('formats single item as tab-separated line', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      mtime: new Date(Date.now() - 3 * 60 * 1000),
    });
    const result = formatSessionList([item], { color: false });
    expect(result).toHaveLength(1);

    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('abc12345');
    expect(parts[1]).toBe('3m ago');
    expect(parts[2]).toBe('claude');
    expect(parts[3]).toBe('my-project');
  });

  test('outputs empty string for undefined project (tab still present)', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'gemini',
    });
    const result = formatSessionList([item], { color: false });
    expect(result).toHaveLength(1);

    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe('');
  });

  test('formats multiple items', () => {
    const items = [
      makeItem({ shortId: 'aaa11111', agentType: 'claude', project: 'proj1' }),
      makeItem({ shortId: 'bbb22222', agentType: 'codex', project: 'proj2' }),
      makeItem({ shortId: 'ccc33333', agentType: 'cursor', project: 'proj3' }),
    ];
    const result = formatSessionList(items, { color: false });
    expect(result).toHaveLength(3);
  });

  test('plain text output has no ANSI escape codes', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
    });
    const result = formatSessionList([item], { color: false });
    // ANSI escape codes start with \x1b[
    expect(result[0]).not.toContain('\x1b[');
  });

  test('color output contains ANSI escape codes', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
    });
    const result = formatSessionList([item], { color: true });
    // ANSI escape codes should be present
    expect(result[0]).toContain('\x1b[');
  });
});
