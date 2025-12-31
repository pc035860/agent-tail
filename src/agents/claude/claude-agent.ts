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
  /** 追蹤 assistant message 內部的處理進度 */
  private currentMessageState: {
    data: Record<string, unknown>;
    contentParts: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    partIndex: number;
    modelShort: string;
    hasTextBefore: boolean;
  } | null = null;
  /** 追蹤已處理的 line，避免 while 迴圈重複處理 */
  private lastProcessedLine: string | null = null;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

  parse(line: string): ParsedLine | null {
    // 如果正在處理 assistant message 的內部狀態
    if (this.currentMessageState) {
      const result = this.processAssistantPart();
      if (result) return result;
      // 處理完畢，清除狀態並回傳 null
      this.currentMessageState = null;
      return null;
    }

    if (!line.trim()) return null;

    // 避免重複處理同一個 line（非 assistant message 不需要 while 迴圈）
    if (line === this.lastProcessedLine) {
      return null;
    }
    this.lastProcessedLine = line;

    try {
      const data = JSON.parse(line);
      const type = data.type || 'unknown';
      const timestamp = data.timestamp || '';

      // assistant message 需要特殊處理（可能包含多個 tool_use）
      if (type === 'assistant') {
        return this.parseAssistantMessage(data, timestamp);
      }

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

  /**
   * 解析 assistant message，拆分成多個部分
   */
  private parseAssistantMessage(data: Record<string, unknown>, timestamp: string): ParsedLine | null {
    const message = data.message as {
      model?: string;
      content: Array<{
        type: string;
        text?: string;
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

    // 過濾有效的部分（text 或 tool_use）
    const validParts = content.filter(
      (part) => (part.type === 'text' && part.text?.trim()) || (part.type === 'tool_use' && part.name)
    );

    if (validParts.length === 0) return null;

    // 初始化狀態
    this.currentMessageState = {
      data,
      contentParts: validParts,
      partIndex: 0,
      modelShort,
      hasTextBefore: false,
    };

    return this.processAssistantPart();
  }

  /**
   * 處理 assistant message 的下一個部分
   */
  private processAssistantPart(): ParsedLine | null {
    if (!this.currentMessageState) return null;

    const { data, contentParts, partIndex, modelShort, hasTextBefore } = this.currentMessageState;
    if (partIndex >= contentParts.length) return null;

    const part = contentParts[partIndex];
    if (!part) return null;

    this.currentMessageState.partIndex++;
    const timestamp = (data as { timestamp?: string }).timestamp || '';

    if (part.type === 'text' && part.text) {
      this.currentMessageState.hasTextBefore = true;
      const preview = truncateByLines(part.text, { verbose: this.verbose });
      const modelInfo = modelShort && !hasTextBefore ? `(${modelShort})` : '';
      return {
        type: 'assistant',
        timestamp,
        raw: data,
        formatted: `${modelInfo}${formatMultiline(preview)}`,
      };
    }

    if (part.type === 'tool_use' && part.name) {
      return {
        type: 'function_call',
        timestamp,
        raw: part,
        formatted: formatToolUse(part.name, part.input, { verbose: this.verbose }),
        toolName: part.name,
      };
    }

    return null;
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

      // assistant 由 parseAssistantMessage 處理

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
