import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import { MultiEmitParser } from '../multi-emit-parser.ts';
import {
  contentToString,
  formatMultiline,
  truncateByLines,
} from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';
import {
  readPiCwdFromHead,
  readPiSessionNameFromTail,
} from '../../utils/session-time.ts';

/**
 * cwd → encoded dir name：`/Users/x/code/foo` → `--Users-x-code-foo--`
 *
 * ⚠️ 必須先剝 leading `/`：直接 split 會得到 `---Users-...`（三條 dash），
 * 匹配不到任何真實目錄（v1 踩過）。Trailing-slash 也要剝（`/foo/` → `--foo--`）。
 */
export function encodePiProjectDir(cwd: string): string {
  const stripped = cwd.startsWith('/') ? cwd.slice(1) : cwd;
  const noTrailing = stripped.endsWith('/') ? stripped.slice(0, -1) : stripped;
  return `--${noTrailing.replace(/\//g, '-')}--`;
}

/**
 * pi 樹狀結構的 parentId walk（ActivePathFilter 用）。
 * entry 樹（非訊息樹）：每個 entry 頂層都有 id/parentId。
 */
export function piWalkParent(entry: unknown): string | null {
  return (entry as { parentId?: string }).parentId ?? null;
}

/**
 * Pi Session Finder
 * 目錄結構: ~/.pi/agent/sessions/--<cwd-encoded>--/<ISO-ts>_<uuid>.jsonl
 *
 * - encoded dir name 不可逆（`-` 可能是分隔符或字面連字號）→ 任何需要精確
 *   專案歸屬的查詢（findLatestInProject / findBySessionId 多重匹配）必須用
 *   header cwd 驗證（v2 §4.5 分層語義）。
 * - `-p` 過濾（findLatest / listSessions）走 encoded dir name fuzzy — 成本
 *   考量，可接受誤差。
 */
export class PiSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor(paths?: { baseDir?: string }) {
    this.baseDir =
      paths?.baseDir ?? join(homedir(), '.pi', 'agent', 'sessions');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private async _collectSessions(
    options: { project?: string } = {}
  ): Promise<SessionListItem[]> {
    const glob = new Glob('*/*.jsonl');
    const files: SessionListItem[] = [];

    try {
      for await (const file of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        const filename = basename(file);
        // <ISO-ts>_<uuid>.jsonl
        const uuid =
          filename
            .replace(/\.jsonl$/, '')
            .split('_')
            .pop() ?? '';
        const project = basename(dirname(file)); // encoded dir name

        if (options.project) {
          const pattern = options.project.toLowerCase();
          const matchProject = project.toLowerCase().includes(pattern);
          const matchUuid = uuid.toLowerCase().includes(pattern);
          if (!matchProject && !matchUuid) continue;
        }

        try {
          const stats = await stat(file);
          files.push({
            path: file,
            mtime: stats.mtime,
            agentType: 'pi',
            shortId: uuid.slice(0, 8),
            project,
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
  }

  async findLatest(
    options: { project?: string } = {}
  ): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    if (files.length === 0) return null;
    return {
      path: files[0]!.path,
      mtime: files[0]!.mtime,
      agentType: 'pi',
    };
  }

  async listSessions(
    options: { project?: string; limit?: number } = {}
  ): Promise<SessionListItem[]> {
    const files = await this._collectSessions(options);
    const sliced = files.slice(0, options.limit ?? 20);
    // enrich：session_info.name → customTitle（tail-read）
    return Promise.all(
      sliced.map(async (f) => {
        const customTitle = await readPiSessionNameFromTail(f.path);
        return customTitle ? { ...f, customTitle } : f;
      })
    );
  }

  async findBySessionId(
    sessionId: string,
    options: { project?: string } = {}
  ): Promise<SessionFile | null> {
    const files = await this._collectSessions();
    const search = sessionId.toLowerCase();
    const uuidOf = (f: SessionListItem): string =>
      basename(f.path)
        .replace(/\.jsonl$/, '')
        .split('_')
        .pop()!
        .toLowerCase();

    // 精確 > 前綴 > 包含 > 全路徑
    let matches = files.filter((f) => uuidOf(f) === search);
    if (matches.length === 0) {
      matches = files.filter((f) => uuidOf(f).startsWith(search));
    }
    if (matches.length === 0) {
      matches = files.filter((f) => uuidOf(f).includes(search));
    }
    if (matches.length === 0) {
      matches = files.filter((f) => f.path.toLowerCase().includes(search));
    }
    if (matches.length === 0) return null;

    // §4.7：多重匹配 + project filter → header cwd 消歧（成本只在多重匹配時發生）
    if (options.project && matches.length > 1) {
      const pattern = options.project.toLowerCase();
      const cwdMatches: SessionListItem[] = [];
      for (const f of matches) {
        const cwd = await readPiCwdFromHead(f.path);
        if (cwd && cwd.toLowerCase().includes(pattern)) {
          cwdMatches.push(f);
        }
      }
      if (cwdMatches.length > 0) matches = cwdMatches;
    }

    const found = matches[0]!;
    return { path: found.path, mtime: found.mtime, agentType: 'pi' };
  }

  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const cwd = await readPiCwdFromHead(sessionPath);
    if (!cwd) return null;
    return { projectDir: cwd, displayName: basename(cwd) };
  }

  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const files = await this._collectSessions();
    // mtime 降序 + 第一個 header cwd 吻合即返回（碰撞安全）
    for (const f of files) {
      const cwd = await readPiCwdFromHead(f.path);
      if (cwd === projectDir) {
        return { path: f.path, mtime: f.mtime, agentType: 'pi' };
      }
    }
    return null;
  }
}

/** 把 pi message content（block 陣列）攤平成文字 */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>;
          if (typeof o.text === 'string') return o.text;
          if (typeof o.thinking === 'string') return o.thinking;
          if (typeof o.content === 'string') return o.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return contentToString(content);
}

/**
 * Pi JSONL v3 parser（v2 MultiEmitParserBase 的純映射函數）。
 *
 * entry 類型（v2 §2.2）：
 * - `session` header：跳過（readPiCwdFromHead 讀第一行取權威 cwd）
 * - `message`：role user / assistant / toolResult / bashExecution / custom
 * - `session_info`：`name`（pi 的 /name）→ custom-title（TITL）
 * - `custom_message`：extension 注入（頂層 entry），display !== false 時輸出
 * - `model_change` / `thinking_level_change` / `compaction` /
 *   `branch_summary` / `label` / `custom`：metadata，跳過（參與樹狀鏈但不輸出）
 *
 * 樹狀 active-path replay 由 ActivePathFilter decorator 處理（v2 §4.3），
 * 本 parser 只看行序列，不碰 FileWatcher 時序。
 */
export class PiLineParser extends MultiEmitParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    super();
    this.verbose = options.verbose;
  }

  protected toParts(entry: unknown): ParsedLine[] {
    const data = entry as Record<string, unknown>;
    const type = (data.type as string) ?? '';
    const timestamp = (data.timestamp as string) ?? '';

    switch (type) {
      case 'session':
        // header — 跳過
        return [];

      case 'session_info': {
        // /name → custom-title（TITL）
        const name = data.name as string;
        if (!name) return [];
        return [
          {
            type: 'custom-title',
            timestamp,
            raw: data,
            formatted: `Session renamed: "${name}"`,
            isCustomTitle: true,
            customTitleValue: name,
          },
        ];
      }

      case 'message':
        return this.parseMessage(data, timestamp);

      case 'custom_message': {
        // extension 注入訊息（頂層 entry）
        if (data.display === false) return [];
        const text = blocksToText(data.content);
        if (!text.trim()) return [];
        return [
          {
            type: 'custom',
            timestamp,
            raw: data,
            formatted: formatMultiline(text),
          },
        ];
      }

      default:
        // model_change / thinking_level_change / compaction /
        // branch_summary / label / custom — metadata，跳過
        return [];
    }
  }

  private parseMessage(
    data: Record<string, unknown>,
    timestamp: string
  ): ParsedLine[] {
    const message = data.message as { role?: string; content?: unknown };
    const role = message?.role;
    const content = message?.content;

    switch (role) {
      case 'user': {
        const text = blocksToText(content);
        if (!text.trim()) return [];
        return [
          {
            type: 'user',
            timestamp,
            raw: data,
            formatted: formatMultiline(
              truncateByLines(text, { verbose: this.verbose })
            ),
          },
        ];
      }

      case 'assistant':
        return this.parseAssistantBlocks(data, timestamp, content);

      case 'toolResult': {
        const text = blocksToText(content);
        if (!text.trim()) return [];
        return [
          {
            type: 'tool_result',
            timestamp,
            raw: data,
            formatted: formatMultiline(
              truncateByLines(text, { verbose: this.verbose })
            ),
          },
        ];
      }

      case 'bashExecution': {
        // OUT（type: 'output'）
        const text = blocksToText(content);
        if (!text.trim()) return [];
        return [
          {
            type: 'output',
            timestamp,
            raw: data,
            formatted: formatMultiline(
              truncateByLines(text, { verbose: this.verbose })
            ),
          },
        ];
      }

      case 'custom': {
        // CUST（display: false 時跳過）
        if (data.display === false) return [];
        const text = blocksToText(content);
        if (!text.trim()) return [];
        return [
          {
            type: 'custom',
            timestamp,
            raw: data,
            formatted: formatMultiline(
              truncateByLines(text, { verbose: this.verbose })
            ),
          },
        ];
      }

      default:
        return [];
    }
  }

  /**
   * assistant message.content 是 block 陣列：text / thinking / toolCall。
   * 一行可拆多筆 ParsedLine（multi-emit）。
   */
  private parseAssistantBlocks(
    data: Record<string, unknown>,
    timestamp: string,
    content: unknown
  ): ParsedLine[] {
    const blocks = Array.isArray(content) ? content : [];
    const parts: ParsedLine[] = [];

    for (const block of blocks) {
      const b = block as Record<string, unknown> | undefined;
      if (!b || typeof b !== 'object') continue;
      const blockType = (b.type as string) ?? '';

      if (blockType === 'text' && typeof b.text === 'string' && b.text.trim()) {
        parts.push({
          type: 'assistant',
          timestamp,
          raw: data,
          formatted: formatMultiline(
            truncateByLines(b.text, { verbose: this.verbose })
          ),
        });
      } else if (
        blockType === 'thinking' &&
        typeof b.thinking === 'string' &&
        b.thinking.trim()
      ) {
        parts.push({
          type: 'reasoning',
          timestamp,
          raw: data,
          formatted: formatMultiline(
            truncateByLines(b.thinking, { verbose: this.verbose })
          ),
        });
      } else if (blockType === 'toolCall' && typeof b.name === 'string') {
        parts.push({
          type: 'function_call',
          timestamp,
          raw: block,
          formatted: formatToolUse(
            b.name,
            b.arguments as Record<string, unknown> | undefined,
            { verbose: this.verbose }
          ),
          toolName: b.name,
        });
      }
    }
    return parts;
  }
}

/**
 * Pi Agent
 */
export class PiAgent implements Agent {
  readonly type = 'pi' as const;
  readonly finder: PiSessionFinder;
  readonly parser: PiLineParser;

  constructor(
    options: ParserOptions = { verbose: false },
    paths?: { baseDir?: string }
  ) {
    this.finder = new PiSessionFinder(paths);
    this.parser = new PiLineParser(options);
  }
}
