import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type { ParsedLine, ParserOptions, SessionFile } from '../../core/types.ts';
import { contentToString, formatMultiline, truncateByLines } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';

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

    const latest = files[0];
    if (!latest) return null;

    return {
      path: latest.path,
      mtime: latest.mtime,
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
      const formatted = this.format(data);

      // 空內容不輸出
      if (!formatted) return null;

      return {
        type,
        timestamp,
        raw: data,
        formatted,
      };
    } catch {
      return null;
    }
  }

  private format(data: Record<string, unknown>): string {
    const type = data.type as string;

    switch (type) {
      case 'file-history-snapshot': {
        return '';  // 不顯示 snapshot
      }

      case 'user': {
        const message = data.message as { content: unknown };
        const content = contentToString(message?.content);
        const preview = truncateByLines(content, { verbose: this.verbose });
        return formatMultiline(preview);
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

        // 簡化 model 顯示
        const modelShort = model
          .replace('claude-', '')
          .replace('-20251101', '')
          .replace('-', ' ');

        // 提取文字內容和 tool_use
        const parts: string[] = [];
        for (const part of content) {
          if (part.type === 'text' && part.text) {
            parts.push(truncateByLines(part.text, { verbose: this.verbose }));
          } else if (part.type === 'tool_use' && part.name) {
            parts.push(formatToolUse(part.name, part.input, { verbose: this.verbose }));
          }
        }

        const text = parts.join(' ');
        // 若有 model 資訊，顯示在第一行
        const modelInfo = modelShort ? `(${modelShort})` : '';
        return `${modelInfo}${formatMultiline(text)}`;
      }

      default:
        return '';
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
