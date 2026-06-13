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
    // All visible columns (0..3) are right-padded to fixed visible widths so
    // every row writes the same cell count and tabs land at predictable stops
    // — trim trailing spaces for the equality check.
    expect(parts[0]!.trimEnd()).toBe('sess');
    expect(parts[1]!.trimEnd()).toBe('abc12345');
    expect(parts[2]!.trimEnd()).toBe('3m ago');
    expect(parts[3]!.trimEnd()).toBe('my-project');
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
    expect(parts[3]!.trimEnd()).toBe(''); // NOTES (col 3) empty, padded to fixed width
    expect(parts[5]).toBe('abc12345');
  });

  test('workflow row: TYPE=wf, NOTES="{status} · in session {uuid8}", TITLE=dim(› name), HID=runId', () => {
    const item = makeItem({
      shortId: 'wf_abcd1234-37e',
      agentType: 'claude',
      logType: 'workflow',
      workflowRunId: 'wf_abcd1234-37e',
      workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
      workflowStatus: 'completed',
      // workflow name 是 derived → autoTitle，formatTitleColumn 用 '› TEXT'
      // 前綴（dim 在 color=true 時）區分使用者 /rename 設定的 customTitle。
      autoTitle: 'briefshare-impl',
      path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_abcd1234-37e.json',
      mtime: new Date(Date.now() - 7 * 60 * 1000),
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts).toHaveLength(6);
    // Visible cols 0..3 are all padded — trimEnd for comparison.
    expect(parts[0]!.trimEnd()).toBe('wf');
    expect(parts[1]!.trimEnd()).toBe('wf_abcd1234-37e');
    expect(parts[2]!.trimEnd()).toBe('7m ago');
    expect(parts[3]!.trimEnd()).toBe('completed · in session 5fe53568'); // NOTES col 3 (padded)
    expect(parts[4]).toBe('› briefshare-impl'); // TITLE col 4 — autoTitle prefix
    expect(parts[5]).toBe('wf_abcd1234-37e');
  });

  test('workflow row without status: NOTES is "in session {uuid8}"', () => {
    const item = makeItem({
      shortId: 'wf_xxxxxxxx-yyy',
      agentType: 'claude',
      logType: 'workflow',
      workflowRunId: 'wf_xxxxxxxx-yyy',
      workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
      autoTitle: 'test',
      path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_xxxxxxxx-yyy.json',
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts[3]!.trimEnd()).toBe('in session 5fe53568'); // NOTES col 3 (padded)
  });

  // Lock 「workflow row without autoTitle」走 em-dash 分支（STATUS Next #3
  // 的 fallback case：snapshot 缺 workflowName 或讀檔失敗時）。
  test('workflow row without autoTitle/customTitle → TITLE is em-dash', () => {
    const item = makeItem({
      shortId: 'wf_noname12-345',
      agentType: 'claude',
      logType: 'workflow',
      workflowRunId: 'wf_noname12-345',
      workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
      path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_noname12-345.json',
    });
    const result = formatSessionList([item], { color: false });
    const parts = result[0]!.split('\t');
    expect(parts[4]).toBe('—');
  });

  // Codex regression: previous fix padded only NOTES, leaving TYPE / ID / TIME
  // free-floating. `3m ago` (6 cells) and `just now` (8 cells) ended at
  // different cells, and the inter-column tab landed at different stops,
  // shifting TITLE 8 cells row-to-row. This test simulates tab expansion to
  // assert TITLE starts at the same terminal cell for varied input shapes.
  test('TITLE start cell is identical across rows with mixed TYPE/ID/TIME widths', async () => {
    const { visibleWidth } = await import('../../src/utils/visible-width');
    // tab moves cursor to next multiple of 8 STRICTLY GREATER THAN cursor
    const expandTab = (cursor: number): number =>
      Math.ceil((cursor + 1) / 8) * 8;

    const titleStartCell = (row: string): number => {
      const parts = row.split('\t');
      let cell = 0;
      for (let i = 0; i < 4; i++) {
        cell += visibleWidth(parts[i] ?? '');
        cell = expandTab(cell);
      }
      return cell;
    };

    const items: SessionListItem[] = [
      makeItem({
        // main sess + 'just now' (8 cells) + short project
        shortId: 'aaa11111',
        agentType: 'claude',
        project: '~/code/x',
        path: '/tmp/a.jsonl',
        mtime: new Date(),
        customTitle: 't',
      }),
      makeItem({
        // main sess + '3m ago' (6 cells) + medium project
        shortId: 'bbb22222',
        agentType: 'claude',
        project: '~/git/some-thing',
        path: '/tmp/b.jsonl',
        mtime: new Date(Date.now() - 3 * 60 * 1000),
        customTitle: 't',
      }),
      makeItem({
        // workflow (TYPE 'wf' is 2 cells, ID 15 cells) + workflow NOTES
        shortId: 'wf_abcd1234-37e',
        agentType: 'claude',
        logType: 'workflow',
        workflowRunId: 'wf_abcd1234-37e',
        workflowSessionUuid: '5fe53568-abcd-1234-abcd-1234567890ab',
        workflowStatus: 'completed',
        customTitle: 'wf:t',
        path: '/tmp/proj/abc12345-1234-1234-1234-123456789abc/workflows/wf_abcd1234-37e.json',
        mtime: new Date(Date.now() - 7 * 60 * 1000),
      }),
    ];
    const out = formatSessionList(items, { color: false });
    const starts = out.map(titleStartCell);
    // All rows must land TITLE at the same terminal cell — otherwise visual
    // alignment is broken regardless of the 6-col contract.
    expect(starts[1]).toBe(starts[0]!);
    expect(starts[2]).toBe(starts[0]!);
    // Concrete fixed cell value: TYPE(4) -tab→ 8, ID(15) -tab→ 24,
    // TIME(8) -tab→ 40, NOTES(36) -tab→ 80
    expect(starts[0]).toBe(80);
  });

  // ANSI must survive column padding: `padVisibleEnd` is visible-width-aware
  // but the underlying string keeps the SGR escapes. Codex flagged this as a
  // worth-locking-down corner of the implementation.
  test('color=true preserves ANSI on TYPE column after padding', () => {
    const item = makeItem({
      shortId: 'aaa11111',
      agentType: 'claude',
      project: '~/x',
      path: '/tmp/a.jsonl',
      customTitle: 't',
    });
    const out = formatSessionList([item], { color: true });
    const typeCol = out[0]!.split('\t')[0]!;
    // SGR escape sequence intro \x1b[ must remain
    // eslint-disable-next-line no-control-regex
    expect(typeCol).toMatch(/\x1b\[/);
    expect(typeCol).toContain('sess');
  });

  test('NOTES column is padded to fixed width (36 cells) so TITLE aligns', () => {
    const short = makeItem({
      shortId: 'aaa11111',
      agentType: 'claude',
      project: '~/code/x',
      path: '/tmp/a.jsonl',
      customTitle: 'short',
    });
    const long = makeItem({
      shortId: 'bbb22222',
      agentType: 'claude',
      project: '~/git/super-long-project-path-12345',
      path: '/tmp/b.jsonl',
      customTitle: 'long',
    });
    const out = formatSessionList([short, long], { color: false });
    const shortNotes = out[0]!.split('\t')[3]!;
    const longNotes = out[1]!.split('\t')[3]!;
    // Both NOTES cells render at the same visible width (raw .length is
    // safe here because ASCII-only project paths use 1 cell per char).
    expect(shortNotes.length).toBe(longNotes.length);
    expect(shortNotes.length).toBe(36);
  });

  test('overlong NOTES is truncated with ellipsis and still padded to fixed width', () => {
    const item = makeItem({
      shortId: 'ccc33333',
      agentType: 'claude',
      project: '~/git/claude-agent-ga-analyzer/apps/backend/subdir',
      path: '/tmp/c.jsonl',
      customTitle: 't',
    });
    const out = formatSessionList([item], { color: false });
    const notes = out[0]!.split('\t')[3]!;
    expect(notes.length).toBe(36); // padded back to width even after truncate
    expect(notes.trimEnd().endsWith('…')).toBe(true);
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
