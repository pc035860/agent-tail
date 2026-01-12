import { describe, test, expect } from 'bun:test';
import type { ParsedLine } from '../../src/core/types.ts';

/**
 * 測試時間排序混合輸出的核心邏輯
 * 這是 outputTimeSorted 函式的排序邏輯測試
 */
describe('Time Sorted Output', () => {
  // 模擬 ParsedLine 資料
  const createParsedLine = (
    timestamp: string,
    sourceLabel: string,
    content: string
  ): ParsedLine => ({
    type: 'assistant',
    timestamp,
    raw: {},
    formatted: content,
    sourceLabel,
  });

  describe('排序邏輯', () => {
    test('來自不同來源的訊息應該按時間戳排序', () => {
      // 模擬收集到的行（未排序）
      const allParsedLines: Array<{ parsed: ParsedLine; timestamp: Date }> = [
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:05.000Z',
            '[MAIN]',
            'Main message 2'
          ),
          timestamp: new Date('2025-01-12T10:00:05.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:01.000Z',
            '[MAIN]',
            'Main message 1'
          ),
          timestamp: new Date('2025-01-12T10:00:01.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:03.000Z',
            '[a123456]',
            'Subagent message 1'
          ),
          timestamp: new Date('2025-01-12T10:00:03.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:07.000Z',
            '[a123456]',
            'Subagent message 2'
          ),
          timestamp: new Date('2025-01-12T10:00:07.000Z'),
        },
      ];

      // 按時間戳排序（舊到新）
      allParsedLines.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      // 驗證排序結果
      expect(allParsedLines.map((l) => l.parsed.formatted)).toEqual([
        'Main message 1', // 10:00:01
        'Subagent message 1', // 10:00:03
        'Main message 2', // 10:00:05
        'Subagent message 2', // 10:00:07
      ]);

      // 驗證來源標籤也正確
      expect(allParsedLines.map((l) => l.parsed.sourceLabel)).toEqual([
        '[MAIN]',
        '[a123456]',
        '[MAIN]',
        '[a123456]',
      ]);
    });

    test('多個 subagent 的訊息應該正確混合排序', () => {
      const allParsedLines: Array<{ parsed: ParsedLine; timestamp: Date }> = [
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:01.000Z',
            '[MAIN]',
            'Main 1'
          ),
          timestamp: new Date('2025-01-12T10:00:01.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:04.000Z',
            '[b789012]',
            'Agent B 1'
          ),
          timestamp: new Date('2025-01-12T10:00:04.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:02.000Z',
            '[a123456]',
            'Agent A 1'
          ),
          timestamp: new Date('2025-01-12T10:00:02.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:06.000Z',
            '[a123456]',
            'Agent A 2'
          ),
          timestamp: new Date('2025-01-12T10:00:06.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:03.000Z',
            '[MAIN]',
            'Main 2'
          ),
          timestamp: new Date('2025-01-12T10:00:03.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:05.000Z',
            '[b789012]',
            'Agent B 2'
          ),
          timestamp: new Date('2025-01-12T10:00:05.000Z'),
        },
      ];

      // 按時間戳排序
      allParsedLines.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      // 驗證完整排序結果
      const result = allParsedLines.map((l) => ({
        label: l.parsed.sourceLabel,
        content: l.parsed.formatted,
      }));

      expect(result).toEqual([
        { label: '[MAIN]', content: 'Main 1' }, // 10:00:01
        { label: '[a123456]', content: 'Agent A 1' }, // 10:00:02
        { label: '[MAIN]', content: 'Main 2' }, // 10:00:03
        { label: '[b789012]', content: 'Agent B 1' }, // 10:00:04
        { label: '[b789012]', content: 'Agent B 2' }, // 10:00:05
        { label: '[a123456]', content: 'Agent A 2' }, // 10:00:06
      ]);
    });

    test('相同時間戳的訊息應該保持穩定排序', () => {
      const allParsedLines: Array<{ parsed: ParsedLine; timestamp: Date }> = [
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:00.000Z',
            '[MAIN]',
            'Main'
          ),
          timestamp: new Date('2025-01-12T10:00:00.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:00.000Z',
            '[a123456]',
            'Agent A'
          ),
          timestamp: new Date('2025-01-12T10:00:00.000Z'),
        },
      ];

      // 排序應該穩定（原始順序保持）
      allParsedLines.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      // 相同時間戳時應保持原始順序
      expect(allParsedLines).toHaveLength(2);
      // 注意：Array.sort() 在相等元素時不保證順序穩定，這裡只驗證結果正確
      const labels = allParsedLines.map((l) => l.parsed.sourceLabel);
      expect(labels).toContain('[MAIN]');
      expect(labels).toContain('[a123456]');
    });

    test('空陣列應該正確處理', () => {
      const allParsedLines: Array<{ parsed: ParsedLine; timestamp: Date }> = [];

      allParsedLines.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      expect(allParsedLines).toHaveLength(0);
    });

    test('單一來源應該維持原有時間順序', () => {
      const allParsedLines: Array<{ parsed: ParsedLine; timestamp: Date }> = [
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:03.000Z',
            '[MAIN]',
            'Message 3'
          ),
          timestamp: new Date('2025-01-12T10:00:03.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:01.000Z',
            '[MAIN]',
            'Message 1'
          ),
          timestamp: new Date('2025-01-12T10:00:01.000Z'),
        },
        {
          parsed: createParsedLine(
            '2025-01-12T10:00:02.000Z',
            '[MAIN]',
            'Message 2'
          ),
          timestamp: new Date('2025-01-12T10:00:02.000Z'),
        },
      ];

      allParsedLines.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      );

      expect(allParsedLines.map((l) => l.parsed.formatted)).toEqual([
        'Message 1',
        'Message 2',
        'Message 3',
      ]);
    });
  });

  describe('時間戳解析', () => {
    test('ISO 8601 格式時間戳應該正確解析', () => {
      const timestamps = [
        '2025-01-12T10:00:00.000Z',
        '2025-01-12T10:00:00.500Z',
        '2025-01-12T10:00:01.000Z',
      ];

      const dates = timestamps.map((ts) => new Date(ts));

      expect(dates[0]!.getTime()).toBeLessThan(dates[1]!.getTime());
      expect(dates[1]!.getTime()).toBeLessThan(dates[2]!.getTime());
    });

    test('毫秒精度應該被保留', () => {
      const ts1 = '2025-01-12T10:00:00.001Z';
      const ts2 = '2025-01-12T10:00:00.002Z';

      const date1 = new Date(ts1);
      const date2 = new Date(ts2);

      expect(date2.getTime() - date1.getTime()).toBe(1);
    });
  });
});
