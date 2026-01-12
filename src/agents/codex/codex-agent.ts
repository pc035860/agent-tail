import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  SessionFile,
} from '../../core/types.ts';
import { truncateByLines, formatMultiline } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';

/**
 * Codex Session Finder
 * 目錄結構: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
class CodexSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.codex', 'sessions');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const files: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      // 只匹配 rollout-*.jsonl
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      // 如果有 project filter，做模糊比對（對 Codex 來說是日期過濾）
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
      agentType: 'codex',
    };
  }

  /**
   * 依 session ID 查找 session 檔案
   * 檔名格式：rollout-{timestamp}-{sessionId}.jsonl
   * 支援匹配：session ID（ULID）、時間戳
   */
  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const candidates: { path: string; mtime: Date; priority: number }[] = [];

    // UUID 格式的正規表達式（用於提取 session ID）
    const ulidPattern =
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      // project filter
      if (options.project) {
        const pattern = options.project.toLowerCase();
        if (!file.toLowerCase().includes(pattern)) continue;
      }

      // 從檔名提取 session ID（ULID 部分）
      const ulidMatch = filename.match(ulidPattern);
      const extractedSessionId = ulidMatch?.[1] || '';

      // 提取時間戳部分（rollout- 和 session ID 之間的部分）
      // rollout-2025-11-03T20-42-15-019a49bd-...
      const withoutPrefix = filename.replace(/^rollout-/, '');
      const timestampPart = extractedSessionId
        ? withoutPrefix.replace(`-${extractedSessionId}.jsonl`, '')
        : '';

      // 計算匹配優先級
      let priority = 0;
      const searchTerm = sessionId.toLowerCase();

      // 1. 對 session ID 進行匹配
      if (extractedSessionId) {
        const normalizedId = extractedSessionId.toLowerCase();
        if (normalizedId === searchTerm) {
          priority = 6; // 精確匹配 session ID
        } else if (normalizedId.startsWith(searchTerm)) {
          priority = 5; // 前綴匹配 session ID
        } else if (normalizedId.includes(searchTerm)) {
          priority = 4; // 包含匹配 session ID
        }
      }

      // 2. 對時間戳進行匹配（如果 session ID 沒有匹配到）
      if (priority === 0 && timestampPart) {
        const normalizedTimestamp = timestampPart.toLowerCase();
        if (normalizedTimestamp === searchTerm) {
          priority = 3; // 精確匹配時間戳
        } else if (normalizedTimestamp.startsWith(searchTerm)) {
          priority = 2; // 前綴匹配時間戳
        } else if (normalizedTimestamp.includes(searchTerm)) {
          priority = 1; // 包含匹配時間戳
        }
      }

      if (priority === 0) continue;

      try {
        const stats = await stat(file);
        candidates.push({ path: file, mtime: stats.mtime, priority });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (candidates.length === 0) return null;

    // 排序：優先級降序 > mtime 降序
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.mtime.getTime() - a.mtime.getTime();
    });

    const best = candidates[0];
    if (!best) return null;

    return {
      path: best.path,
      mtime: best.mtime,
      agentType: 'codex',
    };
  }
}

/**
 * Codex JSONL 解析器
 */
class CodexLineParser implements LineParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

  parse(line: string): ParsedLine | null {
    if (!line.trim()) return null;

    try {
      const data = JSON.parse(line);
      const timestamp = data.timestamp || '';
      const formatted = this.format(data);

      // 空內容不輸出
      if (!formatted) return null;

      // 決定顯示類型
      const type = this.getDisplayType(data);

      // 取得 tool name（僅 function_call 類型）
      const toolName = this.getToolName(data);

      return {
        type,
        timestamp,
        raw: data,
        formatted,
        ...(toolName && { toolName }),
      };
    } catch {
      return null;
    }
  }

  /**
   * 取得 tool 名稱（僅 function_call 類型）
   */
  private getToolName(data: Record<string, unknown>): string | undefined {
    const type = data.type as string;
    if (type !== 'response_item') return undefined;

    const payload = data.payload as Record<string, unknown>;
    if (payload.type !== 'function_call') return undefined;

    return payload.name as string | undefined;
  }

  /**
   * 根據資料內容決定顯示類型
   */
  private getDisplayType(data: Record<string, unknown>): string {
    const type = data.type as string;

    if (type === 'session_meta') return 'session_meta';

    if (type === 'response_item') {
      const payload = data.payload as Record<string, unknown>;
      const subType = payload.type as string;

      if (subType === 'message') {
        const role = payload.role as string;
        return role || 'message';
      }
      if (subType === 'function_call') return 'function_call';
      if (subType === 'function_call_output') return 'output';
      if (subType === 'reasoning') return 'reasoning';
    }

    return type || 'unknown';
  }

  private format(data: Record<string, unknown>): string {
    const type = data.type as string;

    switch (type) {
      case 'session_meta': {
        const payload = data.payload as Record<string, unknown>;
        return `Session: ${payload.cwd || 'unknown'} (v${payload.cli_version || '?'})`;
      }

      case 'response_item': {
        const payload = data.payload as Record<string, unknown>;
        const subType = payload.type as string;

        switch (subType) {
          case 'message': {
            const _role = payload.role as string;
            const content = payload.content as Array<{
              type: string;
              text?: string;
            }>;
            const text =
              content?.find(
                (c) => c.type === 'input_text' || c.type === 'output_text'
              )?.text || '';
            if (!text.trim()) return '';
            const preview = truncateByLines(text, { verbose: this.verbose });
            // 不再重複顯示 role，由 pretty-formatter 處理
            return formatMultiline(preview);
          }

          case 'function_call': {
            const name = payload.name as string;
            const argsStr = payload.arguments as string;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(argsStr);
            } catch {
              /* ignore */
            }
            return formatToolUse(name, args, { verbose: this.verbose });
          }

          case 'function_call_output': {
            const outputStr = payload.output as string;
            let output: { output?: string; metadata?: { exit_code?: number } } =
              {};
            try {
              output = JSON.parse(outputStr);
            } catch {
              /* ignore */
            }
            const exitCode = output.metadata?.exit_code;
            const content = output.output || '';
            // 沒內容且 exit code 正常就不顯示
            if (!content && (exitCode === undefined || exitCode === 0))
              return '';
            const exitInfo =
              exitCode !== undefined && exitCode !== 0
                ? ` (exit: ${exitCode})`
                : '';
            if (!content) return `[OUTPUT${exitInfo}]`;
            const preview = truncateByLines(content, { verbose: this.verbose });
            return `${exitInfo ? `[exit: ${exitCode}]` : ''}${formatMultiline(preview)}`;
          }

          case 'reasoning': {
            const summary = payload.summary as
              | Array<{ type: string; text?: string }>
              | undefined;
            const text =
              summary?.find((s) => s.type === 'summary_text')?.text || '';
            if (!text) return '';
            const preview = truncateByLines(text, { verbose: this.verbose });
            return preview;
          }

          // 忽略的子類型
          case 'ghost_snapshot':
            return '';

          default:
            return '';
        }
      }

      case 'event_msg': {
        const payload = data.payload as Record<string, unknown>;
        const eventType = payload.type as string;

        switch (eventType) {
          case 'token_count': {
            // 略過 token 統計，太 noisy
            return '';
          }

          case 'agent_reasoning': {
            // 與 response_item.reasoning 重複，略過
            return '';
          }

          // 略過其他事件
          default:
            return '';
        }
      }

      // 略過 turn_context
      case 'turn_context':
        return '';

      default:
        return '';
    }
  }
}

/**
 * Codex Agent
 */
export class CodexAgent implements Agent {
  readonly type = 'codex' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new CodexSessionFinder();
    this.parser = new CodexLineParser(options);
  }
}
