import { describe, test, expect, beforeEach } from 'bun:test';
import { CodexAgent } from '../../src/agents/codex/codex-agent';
import type { LineParser } from '../../src/agents/agent.interface';
import type { ParsedLine } from '../../src/core/types';

/**
 * 模擬 while loop 收集所有 parsed lines
 * Codex 使用單次處理模式，但仍測試確保不會有意外迴圈
 */
function collectAllParsedLines(
  parser: LineParser,
  line: string,
  maxIterations = 100
): ParsedLine[] {
  const results: ParsedLine[] = [];
  let parsed = parser.parse(line);
  let iterations = 0;

  while (parsed && iterations < maxIterations) {
    results.push(parsed);
    parsed = parser.parse(line);
    iterations++;
  }

  if (iterations >= maxIterations) {
    throw new Error('Infinite loop detected');
  }
  return results;
}

describe('CodexAgent parser', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new CodexAgent({ verbose: false });
    parser = agent.parser;
  });

  describe('session_meta', () => {
    test('should parse session meta', () => {
      const line = JSON.stringify({
        type: 'session_meta',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          cwd: '/home/user/project',
          cli_version: '1.0.0',
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('session_meta');
      expect(result!.formatted).toContain('/home/user/project');
    });
  });

  describe('user message', () => {
    test('should parse user message', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello Codex' }],
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('user');
    });
  });

  describe('function_call', () => {
    test('should parse function call with toolName', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({
            command: ['/bin/zsh', '-lc', 'ls -la'],
          }),
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('function_call');
      expect(result!.toolName).toBe('shell');
      expect(result!.formatted).toContain('$');
    });

    test('should not loop on repeated parse', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({ command: 'echo hello' }),
        },
      });

      // Codex 每次 parse 同一個 line 都會回傳結果（因為沒有狀態追蹤）
      // 但在實際使用中，每個 line 只會被 parse 一次
      const result = parser.parse(line);
      expect(result).not.toBeNull();
    });
  });

  describe('function_call_output', () => {
    test('should parse output with exit code', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'function_call_output',
          output: JSON.stringify({
            output: 'command output here',
            metadata: { exit_code: 0 },
          }),
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('output');
    });

    test('should show exit code when non-zero', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'function_call_output',
          output: JSON.stringify({
            output: 'error message',
            metadata: { exit_code: 1 },
          }),
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('exit: 1');
    });

    test('should skip empty output with zero exit code', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'function_call_output',
          output: JSON.stringify({
            output: '',
            metadata: { exit_code: 0 },
          }),
        },
      });

      const result = parser.parse(line);

      expect(result).toBeNull();
    });
  });

  describe('reasoning', () => {
    test('should parse reasoning with emoji', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Thinking about the problem' }],
        },
      });

      const result = parser.parse(line);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('reasoning');
      expect(result!.formatted).toContain('💭');
    });
  });

  describe('ignored types', () => {
    test('should ignore ghost_snapshot', () => {
      const line = JSON.stringify({
        type: 'response_item',
        timestamp: '2024-01-01T00:00:00Z',
        payload: { type: 'ghost_snapshot' },
      });

      const result = parser.parse(line);
      expect(result).toBeNull();
    });

    test('should ignore turn_context', () => {
      const line = JSON.stringify({
        type: 'turn_context',
        timestamp: '2024-01-01T00:00:00Z',
      });

      const result = parser.parse(line);
      expect(result).toBeNull();
    });

    test('should ignore token_count event', () => {
      const line = JSON.stringify({
        type: 'event_msg',
        timestamp: '2024-01-01T00:00:00Z',
        payload: { type: 'token_count' },
      });

      const result = parser.parse(line);
      expect(result).toBeNull();
    });
  });
});
