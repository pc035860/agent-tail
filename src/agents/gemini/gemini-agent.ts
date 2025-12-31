import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type { ParsedLine, SessionFile } from '../../core/types.ts';

/**
 * Gemini CLI Session Finder
 * 目錄結構: ~/.gemini/tmp/<project_hash>/chats/session-*.json
 */
class GeminiSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.gemini', 'tmp');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const glob = new Glob('*/chats/session-*.json');
    const files: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      // 如果有 project filter，做模糊比對（對路徑）
      if (options.project) {
        const pattern = options.project.toLowerCase();
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
      agentType: 'gemini',
    };
  }
}

/**
 * Gemini CLI JSON 解析器
 * 注意：Gemini 使用完整 JSON 檔案（非 JSONL），需要追蹤已處理的 messages
 */
class GeminiLineParser implements LineParser {
  private processedMessageIds = new Set<string>();

  parse(line: string): ParsedLine | null {
    if (!line.trim()) return null;

    try {
      // 嘗試解析為完整 JSON（整個 session 檔案內容）
      const data = JSON.parse(line);

      // 如果是完整的 session JSON（有 messages 陣列）
      if (data.messages && Array.isArray(data.messages)) {
        return this.parseSessionJson(data);
      }

      // 否則當作單行 JSON 處理
      return this.parseSingleMessage(data);
    } catch {
      return null;
    }
  }

  /**
   * 解析完整 session JSON，只回傳新的 messages
   */
  private parseSessionJson(session: {
    sessionId?: string;
    messages: Array<{
      id: string;
      type: string;
      content: string;
      timestamp: string;
      tokens?: Record<string, number>;
      toolCalls?: unknown[];
    }>;
  }): ParsedLine | null {
    const messages = session.messages || [];

    // 找到新的 messages（尚未處理過的）
    const newMessages = messages.filter((m) => !this.processedMessageIds.has(m.id));

    if (newMessages.length === 0) return null;

    // 標記這些 messages 為已處理
    for (const msg of newMessages) {
      this.processedMessageIds.add(msg.id);
    }

    // 組合所有新 messages 的輸出
    const formattedParts = newMessages.map((msg) => this.formatMessage(msg));

    // 回傳第一個新 message 的資訊，formatted 包含所有新 messages
    const firstNew = newMessages[0];
    if (!firstNew) return null;

    return {
      type: firstNew.type,
      timestamp: firstNew.timestamp,
      raw: newMessages.length === 1 ? firstNew : newMessages,
      formatted: formattedParts.join('\n'),
    };
  }

  /**
   * 解析單一 message
   */
  private parseSingleMessage(data: Record<string, unknown>): ParsedLine | null {
    const type = (data.type as string) || 'unknown';
    const timestamp = (data.timestamp as string) || '';

    return {
      type,
      timestamp,
      raw: data,
      formatted: this.formatMessage(data as {
        type: string;
        content: string;
        tokens?: Record<string, number>;
        toolCalls?: unknown[];
      }),
    };
  }

  /**
   * 格式化單一 message
   */
  private formatMessage(msg: {
    type: string;
    content: string;
    tokens?: Record<string, number>;
    toolCalls?: unknown[];
  }): string {
    const type = msg.type || 'unknown';
    const content = msg.content || '';
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;

    switch (type) {
      case 'user':
        return `[USER] ${preview}`;

      case 'gemini': {
        const tokens = msg.tokens;
        const tokenInfo = tokens ? ` (${tokens.total || 0} tokens)` : '';
        const toolCalls = msg.toolCalls;
        const toolInfo =
          toolCalls && toolCalls.length > 0 ? ` [${toolCalls.length} tool calls]` : '';
        return `[GEMINI${tokenInfo}${toolInfo}] ${preview}`;
      }

      default:
        return `[${type.toUpperCase()}] ${preview}`;
    }
  }
}

/**
 * Gemini CLI Agent
 */
export class GeminiAgent implements Agent {
  readonly type = 'gemini' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor() {
    this.finder = new GeminiSessionFinder();
    this.parser = new GeminiLineParser();
  }
}
