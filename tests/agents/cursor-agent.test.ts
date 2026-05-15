import { describe, test, expect, beforeEach } from 'bun:test';
import {
  CursorAgent,
  normalizeCursorToolInput,
} from '../../src/agents/cursor/cursor-agent';
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

    test('should emit multi-content array as separate ParsedLine entries (drain)', () => {
      // assistant message 為 stateful multi-emit：caller 需 drain 取多筆 ParsedLine
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First part. ' },
            { type: 'text', text: 'Second part.' },
          ],
        },
      });

      const first = parser.parse(line);
      expect(first).not.toBeNull();
      expect(first!.formatted).toContain('First part.');

      // Drain 第二筆
      const second = parser.parse(line);
      expect(second).not.toBeNull();
      expect(second!.formatted).toContain('Second part.');

      // Drain 完畢
      expect(parser.parse(line)).toBeNull();
    });

    test('should emit text + tool_use as separate ParsedLine entries', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Running command' },
            {
              type: 'tool_use',
              name: 'Shell',
              input: { command: 'ls -la' },
            },
          ],
        },
      });

      const first = parser.parse(line);
      expect(first).not.toBeNull();
      expect(first!.type).toBe('assistant');
      expect(first!.formatted).toContain('Running command');

      const second = parser.parse(line);
      expect(second).not.toBeNull();
      expect(second!.type).toBe('function_call');
      expect(second!.toolName).toBe('Shell');
      expect(second!.formatted).toContain('ls -la');

      expect(parser.parse(line)).toBeNull();
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

    test('should normalize Read input.path → file_path and render filename', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { path: '/Users/me/project/README.md', limit: 80 },
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('function_call');
      expect(result!.toolName).toBe('Read');
      expect(result!.formatted).toContain('/Users/me/project/README.md');
    });

    test('should normalize Glob input keys (glob_pattern → pattern, target_directory → path)', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Glob',
              input: {
                target_directory: '/Users/me/project',
                glob_pattern: '**/*.ts',
              },
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('**/*.ts');
      expect(result!.formatted).toContain('/Users/me/project');
    });

    test('should normalize Write input (path → file_path, contents → content)', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: {
                path: '/Users/me/project/out.json',
                contents: '{}',
              },
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('/Users/me/project/out.json');
    });

    test('should normalize WebSearch input.search_term → query', () => {
      const line = JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'WebSearch',
              input: { search_term: 'best ts patterns', explanation: 'x' },
            },
          ],
        },
      });

      const result = parser.parse(line);
      expect(result).not.toBeNull();
      expect(result!.formatted).toContain('best ts patterns');
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

describe('normalizeCursorToolInput', () => {
  test('returns input unchanged for unknown tool name', () => {
    const input = { path: '/a', whatever: 1 };
    expect(normalizeCursorToolInput('SemanticSearch', input)).toEqual(input);
  });

  test('handles undefined input safely', () => {
    expect(normalizeCursorToolInput('Read', undefined)).toBeUndefined();
  });

  test('remaps Read path → file_path', () => {
    const result = normalizeCursorToolInput('Read', {
      path: '/file.ts',
      limit: 10,
    });
    expect(result).toEqual({ file_path: '/file.ts', limit: 10 });
  });

  test('remaps Write path + contents in one pass', () => {
    const result = normalizeCursorToolInput('Write', {
      path: '/out.json',
      contents: '{}',
    });
    expect(result).toEqual({ file_path: '/out.json', content: '{}' });
  });

  test('remaps Glob glob_pattern + target_directory', () => {
    const result = normalizeCursorToolInput('Glob', {
      target_directory: '/proj',
      glob_pattern: '**/*.ts',
      head_limit: 50,
    });
    expect(result).toEqual({
      path: '/proj',
      pattern: '**/*.ts',
      head_limit: 50,
    });
  });

  test('remaps WebSearch search_term → query', () => {
    const result = normalizeCursorToolInput('WebSearch', {
      search_term: 'foo bar',
      explanation: 'why',
    });
    expect(result).toEqual({ query: 'foo bar', explanation: 'why' });
  });

  test('leaves Grep input untouched (already aligned)', () => {
    const input = { path: '/proj', pattern: 'TODO', glob: '*.ts' };
    expect(normalizeCursorToolInput('Grep', input)).toEqual(input);
  });

  test('handles partial input (missing from-key returns same shape)', () => {
    // Cursor Read 有時只有 path 沒 limit；missing key 不該爆
    const result = normalizeCursorToolInput('Read', { offset: 5 });
    expect(result).toEqual({ offset: 5 });
  });
});
