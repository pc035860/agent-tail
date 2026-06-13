import { describe, test, expect } from 'bun:test';
import {
  extractFullId,
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

describe('extractFullId', () => {
  test('handles Claude/Cursor UUID format', () => {
    const id = extractFullId('/x/y/abc12345-1234-1234-1234-123456789abc.jsonl');
    expect(id).toBe('abc12345-1234-1234-1234-123456789abc');
  });

  test('handles Codex rollout filename', () => {
    const id = extractFullId(
      '/x/y/rollout-2025-01-01T00-00-00-019cc375-5af5-7ed1-9ff8-8a5757d815d1.jsonl'
    );
    expect(id).toBe('019cc375-5af5-7ed1-9ff8-8a5757d815d1');
  });

  test('handles Gemini session filename', () => {
    const id = extractFullId('/x/y/session-1700000000000-abc12345.json');
    expect(id).toBe('abc12345');
  });

  test('falls back to filename stem when no match', () => {
    const id = extractFullId('/x/y/unexpected-name.jsonl');
    expect(id).toBe('unexpected-name');
  });
});

/**
 * SPEC §11.3 / §11.4 — 6-column TYPE/NOTES contract
 *
 * Columns (tab-separated):
 *   0  TYPE   'sess' | 'wf'
 *   1  ID     short identifier (shortId for main, short runId for workflow)
 *   2  TIME   relative time string
 *   3  NOTES  main: project ?? '' ; workflow: '{status} · in session {uuid8}'
 *   4  TITLE  customTitle | dim('› ' + autoTitle) | dim('—')
 *   5  HID    hidden full id (UUID for main, full runId for workflow)
 *
 * NOTES (bounded) precedes TITLE (unbounded) intentionally — see SPEC §11.3.
 * fzf shows cols 1..5; col 6 is hidden and used by parseSelection / ctrl-y.
 */
describe('formatSessionList (SPEC §11.3 + §11.4 6-col contract)', () => {
  test('returns empty array for empty input', () => {
    const result = formatSessionList([], { color: false });
    expect(result).toEqual([]);
  });

  test('main session: TYPE=sess, columns aligned to SPEC §11.3', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
      mtime: new Date(Date.now() - 3 * 60 * 1000),
      customTitle: 'My session',
    });
    const result = formatSessionList([item], { color: false });
    expect(result).toHaveLength(1);

    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('sess');
    expect(parts[1]).toBe('abc12345');
    expect(parts[2]).toBe('3m ago');
    // Column order swapped: NOTES (col 3) before TITLE (col 4) — project paths
    // are bounded, titles aren't, so swap keeps variable-length data on right.
    expect(parts[3]).toBe('my-project');
    expect(parts[4]).toBe('My session');
    expect(parts[5]).toBe('abc12345-1234-1234-1234-123456789abc');
  });

  test('main session without custom title or auto title: TITLE renders dim em-dash', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
    });
    // color=false (plain) → raw '—'
    const plain = formatSessionList([item], { color: false });
    expect(plain[0]!.split('\t')[4]).toBe('—');
  });

  test('main session with autoTitle but no customTitle: TITLE prefixed "› "', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
    });
    item.autoTitle = '/eshop-deploy ec-frontend, stag+prod';
    const plain = formatSessionList([item], { color: false });
    expect(plain[0]!.split('\t')[4]).toBe(
      '› /eshop-deploy ec-frontend, stag+prod'
    );
  });

  test('customTitle wins over autoTitle (autoTitle ignored)', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
      customTitle: 'real user-set title',
    });
    item.autoTitle = 'fallback derived';
    const plain = formatSessionList([item], { color: false });
    expect(plain[0]!.split('\t')[4]).toBe('real user-set title');
  });

  test('main session without project: NOTES is empty string (tabs preserved)', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'gemini',
      path: '/tmp/session-20250101-abc12345.json',
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('sess');
    expect(parts[3]).toBe(''); // NOTES is now col 3
    expect(parts[5]).toBe('abc12345');
  });

  test('workflow row: TYPE=wf, NOTES="{status} · in session {uuid8}", HID=runId', () => {
    const item = makeItem({
      shortId: 'wf_abcd1234-37e',
      agentType: 'claude',
      logType: 'workflow',
      workflowRunId: 'wf_abcd1234-37e',
      workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
      workflowStatus: 'completed',
      customTitle: 'wf:briefshare-impl',
      path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_abcd1234-37e.json',
      mtime: new Date(Date.now() - 7 * 60 * 1000),
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('wf');
    expect(parts[1]).toBe('wf_abcd1234-37e');
    expect(parts[2]).toBe('7m ago');
    expect(parts[3]).toBe('completed · in session 5fe53568'); // NOTES col 3
    expect(parts[4]).toBe('wf:briefshare-impl'); // TITLE col 4
    expect(parts[5]).toBe('wf_abcd1234-37e');
  });

  test('workflow row without status: NOTES is "in session {uuid8}"', () => {
    const item = makeItem({
      shortId: 'wf_xxxxxxxx-yyy',
      agentType: 'claude',
      logType: 'workflow',
      workflowRunId: 'wf_xxxxxxxx-yyy',
      workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
      customTitle: 'wf:test',
      path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_xxxxxxxx-yyy.json',
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts[3]).toBe('in session 5fe53568'); // NOTES col 3
  });

  test('all rows have exactly 6 tab-separated columns', () => {
    const items: SessionListItem[] = [
      makeItem({ shortId: 'aaa11111', agentType: 'claude', project: 'proj1' }),
      makeItem({ shortId: 'bbb22222', agentType: 'codex', project: 'proj2' }),
      makeItem({
        shortId: 'wf_ccc33333-zzz',
        agentType: 'claude',
        logType: 'workflow',
        workflowRunId: 'wf_ccc33333-zzz',
        workflowSessionUuid: 'aaaa1111-bbbb-2222-cccc-333344445555',
        workflowStatus: 'running',
        customTitle: 'wf:proj3',
        path: '/x/y/aaaa1111-bbbb-2222-cccc-333344445555/workflows/wf_ccc33333-zzz.json',
      }),
    ];
    const result = formatSessionList(items, { color: false });
    expect(result).toHaveLength(3);
    for (const line of result) {
      expect(line.split('\t')).toHaveLength(6);
    }
  });

  test('plain text output has no ANSI escape codes', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
    });
    const result = formatSessionList([item], { color: false });
    expect(result[0]).not.toContain('\x1b[');
  });

  test('color output contains ANSI escape codes (TYPE column colored)', () => {
    const item = makeItem({
      shortId: 'abc12345',
      agentType: 'claude',
      project: 'my-project',
      path: '/tmp/abc12345-1234-1234-1234-123456789abc.jsonl',
    });
    const result = formatSessionList([item], { color: true });
    expect(result[0]).toContain('\x1b[');
  });
});
