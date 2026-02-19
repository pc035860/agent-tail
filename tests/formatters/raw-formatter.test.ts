import { describe, test, expect } from 'bun:test';
import { RawFormatter } from '../../src/formatters/raw-formatter';
import type { ParsedLine } from '../../src/core/types';

describe('RawFormatter', () => {
  const formatter = new RawFormatter();

  // Claude 格式 mock：assistant message
  const claudeMock: ParsedLine = {
    type: 'assistant',
    timestamp: '2025-01-15T10:30:00.000Z',
    raw: {
      type: 'assistant',
      timestamp: '2025-01-15T10:30:00.000Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    },
    formatted: '(sonnet 4) Hello world',
  };

  // Claude function_call mock：tool_use part
  const claudeToolMock: ParsedLine = {
    type: 'function_call',
    timestamp: '2025-01-15T10:30:01.000Z',
    raw: {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/test.ts' },
    },
    formatted: 'Read file_path=/tmp/test.ts',
    toolName: 'Read',
  };

  // Codex 格式 mock：response_item message
  const codexMock: ParsedLine = {
    type: 'assistant',
    timestamp: '2025-01-15T10:30:00.000Z',
    raw: {
      type: 'response_item',
      timestamp: '2025-01-15T10:30:00.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Codex' }],
      },
    },
    formatted: 'Hello from Codex',
  };

  // Gemini 格式 mock：gemini message
  const geminiMock: ParsedLine = {
    type: 'gemini',
    timestamp: '2025-01-15T10:30:00.000Z',
    raw: {
      id: 'msg-001',
      type: 'gemini',
      content: 'Hello from Gemini',
      timestamp: '2025-01-15T10:30:00.000Z',
      toolCalls: [{ name: 'shell', args: { command: 'ls' }, status: 'ok' }],
    },
    formatted: 'Hello from Gemini',
  };

  // 含 undefined 欄位的 mock（測試 JSON.stringify 處理 undefined）
  const mockWithOptionalFields: ParsedLine = {
    type: 'assistant',
    timestamp: '2025-01-15T10:30:00.000Z',
    raw: { type: 'assistant', message: null },
    formatted: '',
    toolName: undefined,
    sourceLabel: undefined,
  };

  const allMocks = [
    { name: 'Claude assistant', mock: claudeMock },
    { name: 'Claude tool_use', mock: claudeToolMock },
    { name: 'Codex', mock: codexMock },
    { name: 'Gemini', mock: geminiMock },
    { name: 'optional fields', mock: mockWithOptionalFields },
  ];

  test('輸出為 valid JSON', () => {
    for (const { mock } of allMocks) {
      const output = formatter.format(mock);
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });

  test('輸出內容與 parsed.raw 一致', () => {
    for (const { mock } of allMocks) {
      const output = formatter.format(mock);
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(mock.raw);
    }
  });

  test('Claude assistant 格式 mock 包含正確結構', () => {
    const output = formatter.format(claudeMock);
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('assistant');
    expect(parsed.timestamp).toBe('2025-01-15T10:30:00.000Z');
    expect(parsed.message).toBeDefined();
    expect(parsed.message.model).toBe('claude-sonnet-4-20250514');
  });

  test('Claude tool_use 格式 mock 包含正確結構', () => {
    const output = formatter.format(claudeToolMock);
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('tool_use');
    expect(parsed.name).toBe('Read');
    expect(parsed.input).toEqual({ file_path: '/tmp/test.ts' });
  });

  test('Codex 格式 mock 包含正確結構', () => {
    const output = formatter.format(codexMock);
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('response_item');
    expect(parsed.payload.type).toBe('message');
    expect(parsed.payload.role).toBe('assistant');
  });

  test('Gemini 格式 mock 包含正確結構', () => {
    const output = formatter.format(geminiMock);
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('gemini');
    expect(parsed.content).toBe('Hello from Gemini');
    expect(parsed.toolCalls).toBeArrayOfSize(1);
  });

  test('null 值能正確序列化', () => {
    const output = formatter.format(mockWithOptionalFields);
    const parsed = JSON.parse(output);
    expect(parsed.message).toBeNull();
  });

  test('巢狀物件能正確序列化', () => {
    const deepMock: ParsedLine = {
      type: 'assistant',
      timestamp: '',
      raw: {
        level1: {
          level2: {
            level3: { value: 'deep' },
          },
        },
      },
      formatted: '',
    };
    const output = formatter.format(deepMock);
    const parsed = JSON.parse(output);
    expect(parsed.level1.level2.level3.value).toBe('deep');
  });

  test('空物件能正確序列化', () => {
    const emptyMock: ParsedLine = {
      type: 'unknown',
      timestamp: '',
      raw: {},
      formatted: '',
    };
    const output = formatter.format(emptyMock);
    expect(output).toBe('{}');
  });

  test('陣列 raw 能正確序列化', () => {
    const arrayMock: ParsedLine = {
      type: 'unknown',
      timestamp: '',
      raw: [1, 'two', { three: 3 }],
      formatted: '',
    };
    const output = formatter.format(arrayMock);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([1, 'two', { three: 3 }]);
  });
});
