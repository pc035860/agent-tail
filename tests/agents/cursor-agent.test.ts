import { describe, test, expect, beforeEach } from 'bun:test';
import { CursorAgent } from '../../src/agents/cursor/cursor-agent';
import type { LineParser } from '../../src/agents/agent.interface';

describe('CursorAgent', () => {
  test('should have correct type', () => {
    const agent = new CursorAgent();
    expect(agent.type).toBe('cursor');
  });

  test('should have finder and parser', () => {
    const agent = new CursorAgent();
    expect(agent.finder).toBeDefined();
    expect(agent.parser).toBeDefined();
  });
});

describe('CursorLineParser', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new CursorAgent({ verbose: false });
    parser = agent.parser;
  });

  describe('user messages', () => {
    test('should parse basic user message', () => {
      const line = JSON.stringify({
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Hello Cursor' }],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('user');
      expect(result!.formatted).toContain('Hello Cursor');
      expect(result!.timestamp).toBe('');
    });

    test('should strip <user_query> tags', () => {
      const line = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<user_query>\nHello from query\n</user_query>',
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('Hello from query');
      expect(result!.formatted).not.toContain('<user_query>');
      expect(result!.formatted).not.toContain('</user_query>');
    });

    test('should strip <attached_files> blocks from user messages', () => {
      const line = JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<attached_files>\n<code_selection path="test.ts" lines="1-5">\nconst x = 1;\n</code_selection>\n</attached_files>\n<user_query>\nFix the bug\n</user_query>',
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('Fix the bug');
      expect(result!.formatted).not.toContain('<attached_files>');
      expect(result!.formatted).not.toContain('code_selection');
      expect(result!.formatted).not.toContain('<user_query>');
      expect(result!.formatted).not.toContain('</user_query>');
    });
  });

  describe('assistant messages', () => {
    test('should parse basic assistant message', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Here is the solution' }],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('assistant');
      expect(result!.formatted).toContain('Here is the solution');
    });

    test('should handle multi-content array', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First part. ' },
            { type: 'text', text: 'Second part.' },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('First part.');
      expect(result!.formatted).toContain('Second part.');
    });
  });

  describe('edge cases', () => {
    test('should return null for empty line', () => {
      expect(parser.parse('')).toBeNull();
      expect(parser.parse('   ')).toBeNull();
    });

    test('should return null for invalid JSON', () => {
      expect(parser.parse('not json')).toBeNull();
    });

    test('should return null for missing role', () => {
      const line = JSON.stringify({
        message: { content: [{ type: 'text', text: 'no role' }] },
      });
      expect(parser.parse(line)).toBeNull();
    });

    test('should return null for empty content', () => {
      const line = JSON.stringify({
        role: 'user',
        message: { content: [] },
      });
      expect(parser.parse(line)).toBeNull();
    });

    test('should return null for whitespace-only content', () => {
      const line = JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '   ' }] },
      });
      expect(parser.parse(line)).toBeNull();
    });

    test('should return null when only user_query tags with whitespace', () => {
      const line = JSON.stringify({
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<user_query>\n  \n</user_query>' }],
        },
      });
      expect(parser.parse(line)).toBeNull();
    });
  });

  describe('verbose mode', () => {
    test('should not truncate in verbose mode', () => {
      const verboseAgent = new CursorAgent({ verbose: true });
      const verboseParser = verboseAgent.parser;

      const longText = 'Line\n'.repeat(50);
      const line = JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      });

      const result = verboseParser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).not.toContain('omitted');
    });

    test('should truncate long content in non-verbose mode', () => {
      const longText = 'Line\n'.repeat(50);
      const line = JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('omitted');
    });
  });

  describe('non-text content types', () => {
    test('should handle content with non-text type items via contentToString', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [{ type: 'tool_result', content: 'Tool output here' }],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('Tool output here');
    });

    test('should handle content with unknown type items', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [{ type: 'image', url: 'http://example.com/img.png' }],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      // contentToString falls back to [type] for unknown types
      expect(result!.formatted).toContain('[image]');
    });
  });
});
