import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type { ParsedLine, ParserOptions, SessionFile } from '../../core/types.ts';
import { contentToString, formatMultiline, truncate } from '../../utils/text.ts';

/**
 * Claude Code Session Finder
 * 目錄結構: ~/.claude/projects/{encoded-path}/{UUID}.jsonl
 */
class ClaudeSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.claude', 'projects');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const files: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      const filename = file.split('/').pop() || '';

      // 排除 agent-* 開頭的檔案
      if (filename.startsWith('agent-')) continue;

      // 只匹配 UUID 格式的檔案名
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
      if (!uuidPattern.test(filename)) continue;

      // 如果有 project filter，做模糊比對
      if (options.project) {
        const pattern = options.project.toLowerCase();
        // 對路徑做模糊比對（包含專案目錄名稱）
        if (!file.toLowerCase().includes(pattern)) continue;
      }

      try {
        const stats = await stat(file);
        files.push({ path: file, mtime: stats.mtime });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (files.length === 0) return null;

    // 按修改時間排序，取最新的
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return {
      path: files[0].path,
      mtime: files[0].mtime,
      agentType: 'claude',
    };
  }
}

/**
 * Claude Code JSONL 解析器
 */
class ClaudeLineParser implements LineParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

  parse(line: string): ParsedLine | null {
    if (!line.trim()) return null;

    try {
      const data = JSON.parse(line);
      const type = data.type || 'unknown';
      const timestamp = data.timestamp || '';

      return {
        type,
        timestamp,
        raw: data,
        formatted: this.format(data),
      };
    } catch {
      return null;
    }
  }

  private format(data: Record<string, unknown>): string {
    const type = data.type as string;

    switch (type) {
      case 'file-history-snapshot': {
        return '[SNAPSHOT]';
      }

      case 'user': {
        const message = data.message as { content: unknown };
        const content = contentToString(message?.content);
        const preview = truncate(content, { verbose: this.verbose });
        return `[USER]${formatMultiline(preview)}`;
      }

      case 'assistant': {
        const message = data.message as {
          model?: string;
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
        };
        const model = message?.model || '';
        const content = message?.content || [];

        // 提取文字內容和 tool_use
        const parts: string[] = [];
        for (const part of content) {
          if (part.type === 'text' && part.text) {
            parts.push(truncate(part.text, { verbose: this.verbose }));
          } else if (part.type === 'tool_use' && part.name) {
            parts.push(this.formatToolUse(part.name, part.input));
          }
        }

        const text = parts.join(' ');
        const modelShort = model.replace('claude-', '').replace('-20251101', '');
        return `[ASSISTANT${modelShort ? ` (${modelShort})` : ''}]${formatMultiline(text)}`;
      }

      default:
        return `[${type}]`;
    }
  }

  /**
   * 格式化 tool_use，顯示關鍵參數摘要
   */
  private formatToolUse(name: string, input?: Record<string, unknown>): string {
    if (!input) return `[TOOL: ${name}]`;

    switch (name) {
      case 'Task': {
        const prompt = input.prompt as string | undefined;
        if (prompt) {
          const summary = truncate(prompt, {
            verbose: this.verbose,
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
            verbose: this.verbose,
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

      default: {
        // 其他 tool 顯示第一個有意義的參數
        const firstValue = Object.values(input).find(
          (v) => typeof v === 'string' && v.length > 0
        ) as string | undefined;
        if (firstValue) {
          const summary = truncate(firstValue, {
            verbose: this.verbose,
            headLength: 40,
            tailLength: 20,
          });
          return `[TOOL: ${name}] ${summary}`;
        }
        return `[TOOL: ${name}]`;
      }
    }
  }
}

/**
 * Claude Code Agent
 */
export class ClaudeAgent implements Agent {
  readonly type = 'claude' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new ClaudeSessionFinder();
    this.parser = new ClaudeLineParser(options);
  }
}
