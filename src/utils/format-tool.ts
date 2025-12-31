import { truncate, type TruncateOptions } from './text.ts';

/**
 * 統一的 ToolCall 介面
 * 各 agent 負責把自己的格式轉換成這個介面
 */
export interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
}

export interface FormatToolOptions {
  /** 是否啟用 verbose 模式（不截斷） */
  verbose?: boolean;
}

/**
 * 格式化 tool_use，顯示關鍵參數摘要
 */
export function formatToolUse(
  name: string,
  input?: Record<string, unknown>,
  options: FormatToolOptions = {}
): string {
  const { verbose = false } = options;

  if (!input) return `[TOOL: ${name}]`;

  switch (name) {
    case 'Task': {
      const prompt = input.prompt as string | undefined;
      if (prompt) {
        const summary = truncate(prompt, {
          verbose,
          headLength: 50,
          tailLength: 50,
        });
        return `[TOOL: Task] ${summary}`;
      }
      return `[TOOL: Task]`;
    }

    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      const path = input.path as string | undefined;
      const pathStr = path ? ` in ${path}` : '';
      return `[TOOL: Grep] "${pattern || ''}"${pathStr}`;
    }

    case 'Bash': {
      const command = input.command as string | undefined;
      if (command) {
        const summary = truncate(command, {
          verbose,
          headLength: 80,
          tailLength: 40,
        });
        return `[TOOL: Bash] ${summary}`;
      }
      return `[TOOL: Bash]`;
    }

    case 'Read': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: Read] ${filePath || ''}`;
    }

    case 'Edit': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: Edit] ${filePath || ''}`;
    }

    case 'Write': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: Write] ${filePath || ''}`;
    }

    case 'Glob': {
      const pattern = input.pattern as string | undefined;
      const path = input.path as string | undefined;
      const pathStr = path ? ` in ${path}` : '';
      return `[TOOL: Glob] "${pattern || ''}"${pathStr}`;
    }

    case 'LSP': {
      const operation = input.operation as string | undefined;
      const filePath = input.filePath as string | undefined;
      return `[TOOL: LSP] ${operation || ''} ${filePath || ''}`;
    }

    case 'WebFetch': {
      const url = input.url as string | undefined;
      return `[TOOL: WebFetch] ${url || ''}`;
    }

    case 'WebSearch': {
      const query = input.query as string | undefined;
      return `[TOOL: WebSearch] "${query || ''}"`;
    }

    case 'TodoWrite': {
      return `[TOOL: TodoWrite]`;
    }

    // Codex 工具
    case 'shell':
    case 'shell_command': {
      const command = input.command as string | string[] | undefined;
      // Codex shell command 格式: ['/bin/zsh', '-lc', 'actual command'] 或直接字串
      const cmdStr = Array.isArray(command) ? command.slice(2).join(' ') : command || '';
      if (cmdStr) {
        const summary = truncate(cmdStr, {
          verbose,
          headLength: 80,
          tailLength: 40,
        });
        return `$ ${summary}`;
      }
      return `[TOOL: shell]`;
    }

    // Gemini 工具（snake_case 命名）
    case 'read_file': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: read_file] ${filePath || ''}`;
    }

    case 'edit_file': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: edit_file] ${filePath || ''}`;
    }

    case 'write_file': {
      const filePath = input.file_path as string | undefined;
      return `[TOOL: write_file] ${filePath || ''}`;
    }

    default: {
      // 其他 tool 顯示第一個有意義的參數
      const firstValue = Object.values(input).find(
        (v) => typeof v === 'string' && v.length > 0
      ) as string | undefined;
      if (firstValue) {
        const summary = truncate(firstValue, {
          verbose,
          headLength: 40,
          tailLength: 20,
        });
        return `[TOOL: ${name}] ${summary}`;
      }
      return `[TOOL: ${name}]`;
    }
  }
}
