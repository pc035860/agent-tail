import { describe, test, expect, beforeEach } from 'bun:test';
import { ClaudeAgent } from '../../src/agents/claude/claude-agent';
import type { LineParser } from '../../src/agents/agent.interface';
import type { ParsedLine } from '../../src/core/types';

/**
 * 模擬 while loop 收集所有 parsed lines
 * 如果超過 maxIterations 表示有無限迴圈
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

describe('ClaudeAgent parser', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new ClaudeAgent({ verbose: false });
    parser = agent.parser;
  });

  describe('user message', () => {
    test('should parse once and terminate (no infinite loop)', () => {
      const line = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'Hello world' },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('user');
    });

    test('should return null on second parse of same line', () => {
      const line = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'Hello world' },
      });

      const first = parser.parse(line);
      const second = parser.parse(line);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('assistant message with single text', () => {
    test('should parse once and terminate', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'Hello from Claude' }],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('assistant');
    });
  });

  describe('assistant message with single tool_use', () => {
    test('should parse once and terminate', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('Bash');
    });
  });

  describe('assistant message with multiple tool_use', () => {
    test('should parse each tool_use and terminate correctly', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/tmp/test' },
            },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('Bash');
      expect(results[1]!.type).toBe('function_call');
      expect(results[1]!.toolName).toBe('Read');
    });
  });

  describe('assistant message with mixed content', () => {
    test('should parse text and tool_use separately', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Let me check that for you' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'cat file.txt' },
            },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'error' } },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(3);
      expect(results[0]!.type).toBe('assistant');
      expect(results[1]!.type).toBe('function_call');
      expect(results[1]!.toolName).toBe('Bash');
      expect(results[2]!.type).toBe('function_call');
      expect(results[2]!.toolName).toBe('Grep');
    });
  });

  describe('assistant message with empty content', () => {
    test('should return null and not loop', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(0);
    });
  });

  describe('file-history-snapshot', () => {
    test('should be ignored and not loop', () => {
      const line = JSON.stringify({
        type: 'file-history-snapshot',
        timestamp: '2024-01-01T00:00:00Z',
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(0);
    });
  });

  describe('toolUseResult (subagent completion)', () => {
    test('should parse toolUseResult with agentId', () => {
      const line = JSON.stringify({
        uuid: 'f32695c5-7183-412e-857c-fdb946d2a0af',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          agentId: 'a0627b6',
          totalDurationMs: 36628,
          totalTokens: 42215,
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('tool_result');
      expect(results[0]!.formatted).toContain('completed');
      expect(results[0]!.formatted).toContain('agent:a0627b6');
      expect(results[0]!.formatted).toContain('36.6s');
      expect(results[0]!.formatted).toContain('42215 tokens');
    });

    test('should parse toolUseResult without agentId', () => {
      const line = JSON.stringify({
        uuid: 'test-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          totalDurationMs: 1000,
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('tool_result');
      expect(results[0]!.formatted).toContain('completed');
      expect(results[0]!.formatted).not.toContain('agent:');
    });

    test('should not loop on toolUseResult', () => {
      const line = JSON.stringify({
        uuid: 'test-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          agentId: 'abc123',
        },
      });

      // Should not throw infinite loop error
      const results = collectAllParsedLines(parser, line);
      expect(results).toHaveLength(1);
    });
  });

  describe('multiple different lines', () => {
    test('should handle different lines correctly', () => {
      const line1 = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'First message' },
      });
      const line2 = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:01Z',
        message: { content: 'Second message' },
      });

      const results1 = collectAllParsedLines(parser, line1);
      const results2 = collectAllParsedLines(parser, line2);

      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(1);
    });
  });
});
