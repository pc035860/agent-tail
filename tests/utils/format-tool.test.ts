import { describe, test, expect } from 'bun:test';
import { formatToolUse } from '../../src/utils/format-tool';

describe('formatToolUse', () => {
  describe('without input', () => {
    test('returns basic format when no input provided', () => {
      expect(formatToolUse('SomeTool')).toBe('[TOOL: SomeTool]');
      expect(formatToolUse('Read', undefined)).toBe('[TOOL: Read]');
    });
  });

  describe('Task tool', () => {
    test('shows truncated prompt', () => {
      const result = formatToolUse('Task', { prompt: 'Search for files' });
      expect(result).toBe('[TOOL: Task] Search for files');
    });

    test('truncates long prompt', () => {
      const longPrompt = 'a'.repeat(200);
      const result = formatToolUse('Task', { prompt: longPrompt });

      expect(result).toContain('[TOOL: Task]');
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(longPrompt.length + 20);
    });

    test('does not truncate in verbose mode', () => {
      const longPrompt = 'a'.repeat(200);
      const result = formatToolUse('Task', { prompt: longPrompt }, { verbose: true });

      expect(result).toBe(`[TOOL: Task] ${longPrompt}`);
    });

    test('handles missing prompt', () => {
      expect(formatToolUse('Task', {})).toBe('[TOOL: Task]');
    });
  });

  describe('Grep tool', () => {
    test('shows pattern', () => {
      const result = formatToolUse('Grep', { pattern: 'TODO' });
      expect(result).toBe('[TOOL: Grep] "TODO"');
    });

    test('shows pattern with path', () => {
      const result = formatToolUse('Grep', { pattern: 'TODO', path: 'src/' });
      expect(result).toBe('[TOOL: Grep] "TODO" in src/');
    });

    test('handles empty pattern', () => {
      const result = formatToolUse('Grep', {});
      expect(result).toBe('[TOOL: Grep] ""');
    });
  });

  describe('Bash tool', () => {
    test('shows command', () => {
      const result = formatToolUse('Bash', { command: 'ls -la' });
      expect(result).toBe('[TOOL: Bash] ls -la');
    });

    test('truncates long command', () => {
      const longCommand = 'echo ' + 'a'.repeat(200);
      const result = formatToolUse('Bash', { command: longCommand });

      expect(result).toContain('[TOOL: Bash]');
      expect(result).toContain('...');
    });

    test('handles missing command', () => {
      expect(formatToolUse('Bash', {})).toBe('[TOOL: Bash]');
    });
  });

  describe('file operation tools', () => {
    test('Read shows file path', () => {
      const result = formatToolUse('Read', { file_path: '/src/index.ts' });
      expect(result).toBe('[TOOL: Read] /src/index.ts');
    });

    test('Edit shows file path', () => {
      const result = formatToolUse('Edit', { file_path: '/src/utils.ts' });
      expect(result).toBe('[TOOL: Edit] /src/utils.ts');
    });

    test('Write shows file path', () => {
      const result = formatToolUse('Write', { file_path: '/src/new.ts' });
      expect(result).toBe('[TOOL: Write] /src/new.ts');
    });

    test('handles missing file path', () => {
      expect(formatToolUse('Read', {})).toBe('[TOOL: Read] ');
      expect(formatToolUse('Edit', {})).toBe('[TOOL: Edit] ');
      expect(formatToolUse('Write', {})).toBe('[TOOL: Write] ');
    });
  });

  describe('Glob tool', () => {
    test('shows pattern', () => {
      const result = formatToolUse('Glob', { pattern: '**/*.ts' });
      expect(result).toBe('[TOOL: Glob] "**/*.ts"');
    });

    test('shows pattern with path', () => {
      const result = formatToolUse('Glob', { pattern: '*.ts', path: 'src/' });
      expect(result).toBe('[TOOL: Glob] "*.ts" in src/');
    });
  });

  describe('LSP tool', () => {
    test('shows operation and file path', () => {
      const result = formatToolUse('LSP', {
        operation: 'goToDefinition',
        filePath: '/src/index.ts',
      });
      expect(result).toBe('[TOOL: LSP] goToDefinition /src/index.ts');
    });

    test('handles missing values', () => {
      expect(formatToolUse('LSP', {})).toBe('[TOOL: LSP]  ');
    });
  });

  describe('web tools', () => {
    test('WebFetch shows URL', () => {
      const result = formatToolUse('WebFetch', { url: 'https://example.com' });
      expect(result).toBe('[TOOL: WebFetch] https://example.com');
    });

    test('WebSearch shows query', () => {
      const result = formatToolUse('WebSearch', { query: 'bun test framework' });
      expect(result).toBe('[TOOL: WebSearch] "bun test framework"');
    });
  });

  describe('TodoWrite tool', () => {
    test('returns simple format', () => {
      expect(formatToolUse('TodoWrite', { todos: [] })).toBe('[TOOL: TodoWrite]');
    });
  });

  describe('unknown tools', () => {
    test('shows first string value', () => {
      const result = formatToolUse('CustomTool', { param: 'value', other: 123 });
      expect(result).toBe('[TOOL: CustomTool] value');
    });

    test('truncates long first value', () => {
      const longValue = 'x'.repeat(100);
      const result = formatToolUse('CustomTool', { param: longValue });

      expect(result).toContain('[TOOL: CustomTool]');
      expect(result).toContain('...');
    });

    test('handles no string values', () => {
      const result = formatToolUse('CustomTool', { num: 123, bool: true });
      expect(result).toBe('[TOOL: CustomTool]');
    });

    test('handles empty string values', () => {
      const result = formatToolUse('CustomTool', { param: '' });
      expect(result).toBe('[TOOL: CustomTool]');
    });
  });

  describe('Codex tools', () => {
    describe('shell tool', () => {
      test('shows command from array format', () => {
        const result = formatToolUse('shell', {
          command: ['/bin/zsh', '-lc', 'git status --short'],
        });
        expect(result).toBe('$ git status --short');
      });

      test('shows command from string', () => {
        const result = formatToolUse('shell', { command: 'ls -la' });
        expect(result).toBe('$ ls -la');
      });

      test('truncates long command', () => {
        const longCmd = 'echo ' + 'a'.repeat(200);
        const result = formatToolUse('shell', { command: longCmd });
        expect(result).toContain('$');
        expect(result).toContain('...');
      });

      test('does not truncate in verbose mode', () => {
        const longCmd = 'echo ' + 'a'.repeat(200);
        const result = formatToolUse('shell', { command: longCmd }, { verbose: true });
        expect(result).toBe(`$ ${longCmd}`);
      });

      test('handles missing command', () => {
        expect(formatToolUse('shell', {})).toBe('[TOOL: shell]');
      });

      test('handles empty array', () => {
        expect(formatToolUse('shell', { command: [] })).toBe('[TOOL: shell]');
      });
    });
  });

  describe('Gemini tools (snake_case)', () => {
    test('read_file shows path', () => {
      const result = formatToolUse('read_file', { file_path: 'src/index.ts' });
      expect(result).toBe('[TOOL: read_file] src/index.ts');
    });

    test('edit_file shows path', () => {
      const result = formatToolUse('edit_file', { file_path: 'src/utils.ts' });
      expect(result).toBe('[TOOL: edit_file] src/utils.ts');
    });

    test('write_file shows path', () => {
      const result = formatToolUse('write_file', { file_path: 'src/new.ts' });
      expect(result).toBe('[TOOL: write_file] src/new.ts');
    });

    test('handles missing file path', () => {
      expect(formatToolUse('read_file', {})).toBe('[TOOL: read_file] ');
      expect(formatToolUse('edit_file', {})).toBe('[TOOL: edit_file] ');
      expect(formatToolUse('write_file', {})).toBe('[TOOL: write_file] ');
    });
  });
});
