import { describe, test, expect } from 'bun:test';
import { MultiEmitParser } from '../../src/agents/multi-emit-parser.ts';
import type { ParsedLine } from '../../src/core/types.ts';
import { drainParser } from '../../src/utils/parser-drain.ts';

/** 測試用子類別：一個 entry → 依 content 長度拆成 N 筆 ParsedLine */
class MockMultiParser extends MultiEmitParser {
  protected toParts(entry: unknown): ParsedLine[] {
    const data = entry as { content?: string };
    const text = data.content ?? '';
    if (!text) return [];
    // 每個字元一筆（模擬 multi-emit）
    return text.split('').map((ch) => ({
      type: 'assistant',
      timestamp: '',
      raw: data,
      formatted: ch,
    }));
  }
}

describe('MultiEmitParserBase (SPEC §4.2)', () => {
  test('single-part entry emits once then null', () => {
    const p = new MockMultiParser();
    const line = '{"content": "a"}';
    expect(p.parse(line)?.formatted).toBe('a');
    expect(p.parse(line)).toBeNull();
  });

  test('multi-part entry drains all parts then null', () => {
    const p = new MockMultiParser();
    const line = '{"content": "abc"}';
    const parts: string[] = [];
    let parsed = p.parse(line);
    while (parsed) {
      parts.push(parsed.formatted);
      parsed = p.parse(line);
    }
    expect(parts).toEqual(['a', 'b', 'c']);
  });

  test('drainArg="" still drains (state takes priority over empty line)', () => {
    const p = new MockMultiParser();
    const line = '{"content": "abc"}';
    const parts: string[] = [];
    let parsed = p.parse(line);
    while (parsed) {
      parts.push(parsed.formatted);
      parsed = p.parse(''); // drainArg='' — summary path
    }
    expect(parts).toEqual(['a', 'b', 'c']);
  });

  test('dedup guard survives drain completion (no re-init loop)', () => {
    const p = new MockMultiParser();
    const line = '{"content": "abc"}';
    // drain 完成
    let parsed = p.parse(line);
    while (parsed) parsed = p.parse(line);
    // caller 再用同一行呼叫 → guard 擋住，不會 re-init 重發第一個 part
    expect(p.parse(line)).toBeNull();
    expect(p.parse(line)).toBeNull();
  });

  test('drainParser integration: multi-part entry drains end-to-end', () => {
    const p = new MockMultiParser();
    const line = '{"content": "abcd"}';
    const parts: string[] = [];
    drainParser(p, line, (parsed) => parts.push(parsed.formatted));
    expect(parts).toEqual(['a', 'b', 'c', 'd']);
  });

  test('drainParser with drainArg="" works for stateless-style callers', () => {
    const p = new MockMultiParser();
    const line = '{"content": "abc"}';
    const parts: string[] = [];
    drainParser(p, line, (parsed) => parts.push(parsed.formatted), {
      drainArg: '',
    });
    expect(parts).toEqual(['a', 'b', 'c']);
  });

  test('empty line returns null', () => {
    const p = new MockMultiParser();
    expect(p.parse('')).toBeNull();
    expect(p.parse('   ')).toBeNull();
  });

  test('invalid JSON returns null', () => {
    const p = new MockMultiParser();
    expect(p.parse('not json')).toBeNull();
  });

  test('toParts returning [] returns null (no state set)', () => {
    const p = new MockMultiParser();
    expect(p.parse('{"content": ""}')).toBeNull();
    // 沒有 state 殘留：下一行正常處理
    expect(p.parse('{"content": "x"}')?.formatted).toBe('x');
  });

  test('toParts throwing is caught (malformed entry → null)', () => {
    class ThrowingParser extends MultiEmitParser {
      protected toParts(): ParsedLine[] {
        throw new Error('boom');
      }
    }
    const p = new ThrowingParser();
    expect(p.parse('{"a": 1}')).toBeNull();
  });

  test('state is cleared after drain but lastProcessedLine retained', () => {
    const p = new MockMultiParser();
    const line = '{"content": "ab"}';
    let parsed = p.parse(line);
    while (parsed) parsed = p.parse(line);
    // 同 line 被 guard 擋住
    expect(p.parse(line)).toBeNull();
    // 不同 line 正常處理
    expect(p.parse('{"content": "z"}')?.formatted).toBe('z');
  });
});
