import { describe, test, expect, beforeEach } from 'bun:test';
import { GeminiAgent } from '../../src/agents/gemini/gemini-agent';
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

describe('GeminiAgent parser', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new GeminiAgent({ verbose: false });
    parser = agent.parser;
  });

  describe('user message', () => {
    test('should parse user message and terminate', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Hello Gemini',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('user');
    });
  });

  describe('gemini message with content only', () => {
    test('should parse content and terminate', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            content: 'Hello from Gemini',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('gemini');
    });
  });

  describe('gemini message with single toolCall', () => {
    test('should parse toolCall with toolName and terminate', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            content: '',
            timestamp: '2024-01-01T00:00:00Z',
            toolCalls: [
              { name: 'run_shell_command', args: { command: 'ls -la' } },
            ],
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('run_shell_command');
    });
  });

  describe('gemini message with multiple toolCalls', () => {
    test('should parse each toolCall and terminate correctly', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            content: '',
            timestamp: '2024-01-01T00:00:00Z',
            toolCalls: [
              { name: 'run_shell_command', args: { command: 'ls' } },
              { name: 'read_file', args: { file_path: '/tmp/test' } },
            ],
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('run_shell_command');
      expect(results[1]!.type).toBe('function_call');
      expect(results[1]!.toolName).toBe('read_file');
    });
  });

  describe('gemini message with toolCalls and content', () => {
    test('should parse toolCalls first then content', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            content: 'Here is the result',
            timestamp: '2024-01-01T00:00:00Z',
            toolCalls: [
              { name: 'run_shell_command', args: { command: 'cat file.txt' } },
            ],
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('run_shell_command');
      expect(results[1]!.type).toBe('gemini');
    });
  });

  describe('gemini message with error status', () => {
    test('should show error emoji for failed toolCall', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'gemini',
            content: '',
            timestamp: '2024-01-01T00:00:00Z',
            toolCalls: [
              {
                name: 'run_shell_command',
                args: { command: 'fail' },
                status: 'error',
              },
            ],
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(1);
      expect(results[0]!.formatted).toContain('❌');
    });
  });

  describe('multiple messages in session', () => {
    test('should parse all messages in order', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'user',
            content: 'Hello',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            id: 'msg-2',
            type: 'gemini',
            content: 'Hi there!',
            timestamp: '2024-01-01T00:00:01Z',
          },
          {
            id: 'msg-3',
            type: 'user',
            content: 'Run a command',
            timestamp: '2024-01-01T00:00:02Z',
          },
          {
            id: 'msg-4',
            type: 'gemini',
            content: '',
            timestamp: '2024-01-01T00:00:03Z',
            toolCalls: [
              { name: 'run_shell_command', args: { command: 'echo hi' } },
            ],
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(4);
      expect(results[0]!.type).toBe('user');
      expect(results[1]!.type).toBe('gemini');
      expect(results[2]!.type).toBe('user');
      expect(results[3]!.type).toBe('function_call');
    });
  });

  describe('empty messages', () => {
    test('should skip empty user message', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [
          {
            id: 'msg-1',
            type: 'user',
            content: '',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            id: 'msg-2',
            type: 'user',
            content: 'Real message',
            timestamp: '2024-01-01T00:00:01Z',
          },
        ],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(1);
      expect(results[0]!.formatted).toContain('Real message');
    });
  });

  describe('session with no messages', () => {
    test('should return empty results', () => {
      const session = JSON.stringify({
        sessionId: 'test-session',
        messages: [],
      });

      const results = collectAllParsedLines(parser, session);

      expect(results).toHaveLength(0);
    });
  });
});
