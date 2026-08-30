import { describe, test, expect } from 'bun:test';
import { ActivePathFilter } from '../../src/core/active-path-filter.ts';
import type { LineParser } from '../../src/agents/agent.interface.ts';
import type { ParsedLine } from '../../src/core/types.ts';

/** 測試用 inner parser：每個 entry 輸出一筆（id 當 formatted） */
class MockParser implements LineParser {
  parse(line: string): ParsedLine | null {
    try {
      const e = JSON.parse(line);
      return {
        type: 'assistant',
        timestamp: '',
        raw: e,
        formatted: e.id ?? '?',
      };
    } catch {
      return null;
    }
  }
}

/** pi 的 walkParent：entry.parentId */
const walkParent = (entry: unknown): string | null =>
  (entry as { parentId?: string }).parentId ?? null;

describe('ActivePathFilter (SPEC §4.3)', () => {
  test('default live mode passes through without beginHistory (summary path)', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    const line = '{"id": "a"}';
    expect(filter.parse(line)?.formatted).toBe('a');
  });

  test('buffers during history, flush emits active path only', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    // 樹：root(a) → b → c（active）；root(a) → d（死分支）
    filter.parse('{"id": "a", "parentId": null}');
    filter.parse('{"id": "b", "parentId": "a"}');
    filter.parse('{"id": "c", "parentId": "b"}');
    filter.parse('{"id": "d", "parentId": "a"}'); // 死分支（最後 entry 是 c）
    filter.parse('{"id": "c2", "parentId": "c"}'); // 最後 entry → active path 是 a→b→c→c2

    const parts = filter.flushHistory();
    const emitted = parts.map((p) => p.formatted);
    expect(emitted).toEqual(['a', 'b', 'c', 'c2']);
  });

  test('dead branch from /tree edit-and-resend is excluded', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    // 送出後 22 秒內重送改版：b(舊) → b2(新)
    filter.parse('{"id": "a", "parentId": null}');
    filter.parse('{"id": "b", "parentId": "a"}');
    filter.parse('{"id": "b2", "parentId": "a"}'); // 重送 → b 變死分支
    filter.parse('{"id": "c", "parentId": "b2"}');

    const parts = filter.flushHistory();
    const emitted = parts.map((p) => p.formatted);
    expect(emitted).toEqual(['a', 'b2', 'c']);
    expect(emitted).not.toContain('b');
  });

  test('metadata leaf (non-message entry) on active path is included', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    filter.parse('{"id": "a", "parentId": null}');
    filter.parse('{"id": "m", "parentId": "a", "type": "model_change"}'); // metadata leaf
    filter.parse('{"id": "b", "parentId": "m"}');

    const parts = filter.flushHistory();
    const emitted = parts.map((p) => p.formatted);
    expect(emitted).toEqual(['a', 'm', 'b']);
  });

  test('-n truncation: walk stops at buffer edge', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    // 模擬 initialLines 只緩衝最後 3 個 entry
    filter.parse('{"id": "a", "parentId": null}');
    filter.parse('{"id": "b", "parentId": "a"}');
    filter.parse('{"id": "c", "parentId": "b"}');
    // 假設 a 不在 buffer（被 -n 截斷）— 直接構造只有 b,c 的 buffer
    // 重新開始：只餵 b, c
    const filter2 = new ActivePathFilter(new MockParser(), walkParent);
    filter2.beginHistory();
    filter2.parse('{"id": "b", "parentId": "a"}'); // parent a 不在 buffer
    filter2.parse('{"id": "c", "parentId": "b"}');
    const parts = filter2.flushHistory();
    const emitted = parts.map((p) => p.formatted);
    // walk 停在 buffer 邊緣：b 的 parent a 找不到 → 只輸出 b, c
    expect(emitted).toEqual(['b', 'c']);
  });

  test('malformed trailing line is not treated as leaf (valid history preserved)', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    filter.parse('{"id": "a", "parentId": null}');
    filter.parse('{"id": "b", "parentId": "a"}');
    filter.parse('{"id": "c", "parentId": "b"}');
    filter.parse('{"id": "d", "parentId": "c"}');
    // 半寫 malformed 行（JSON.parse 失敗）— 不應被當 leaf
    filter.parse('{"id": "e", "parentId": "d"');

    const parts = filter.flushHistory();
    const emitted = parts.map((p) => p.formatted);
    // walk 從最後一個有效 entry（d）開始，全部有效歷史保留
    expect(emitted).toEqual(['a', 'b', 'c', 'd']);
  });

  test('empty buffer flush returns empty', () => {
    const filter = new ActivePathFilter(new MockParser(), walkParent);
    filter.beginHistory();
    expect(filter.flushHistory()).toEqual([]);
  });

  test('setConversationId passes through to inner parser', () => {
    let received: string | undefined;
    const inner: LineParser = {
      parse: () => null,
      setConversationId: (id) => {
        received = id;
      },
    };
    const filter = new ActivePathFilter(inner, walkParent);
    filter.setConversationId?.('abc');
    expect(received).toBe('abc');
  });
});
