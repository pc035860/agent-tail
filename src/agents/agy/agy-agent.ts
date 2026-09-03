import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
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
import { formatMultiline } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';

const CONVERSATION_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 從 session 檔（.pb/.db）或 brain transcript 路徑抽出 conversationId（UUID） */
function extractConversationId(path: string): string {
  // transcript: .../brain/{uuid}/.system_generated/logs/transcript.jsonl
  const brainMatch = path.match(
    new RegExp(`brain[\\/\\\\](${CONVERSATION_ID_RE.source})[\\/\\\\]`)
  );
  if (brainMatch) return brainMatch[1]!;
  // session 檔: .../conversations/{uuid}.pb|.db
  const fileMatch = path.match(
    new RegExp(`(${CONVERSATION_ID_RE.source})\\.(?:db|pb)$`)
  );
  if (fileMatch) return fileMatch[1]!;
  return basename(path).replace(/\.(?:db|pb)$/, '');
}

/** antigravity-cli 的 brain transcript 路徑（可讀 JSONL，tail 目標） */
function transcriptPathFor(baseDir: string, uuid: string): string {
  return join(
    baseDir,
    '..',
    'brain',
    uuid,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
}

/**
 * transcript 存在時回傳其路徑與 mtime；不存在回傳 null。
 *
 * 只收有 transcript 的 session：antigravity-cli 在第一次對話前不會建立
 * transcript（只有 binary .db），而 FileWatcher 無法以 JSONL 模式 tail 二進位
 * .db（會卡死在 SQLite 雜訊且永不切換到後續出現的 transcript）。無 transcript
 * = 空 session，對 agent-tail 而言沒有可顯示內容，直接排除。
 */
async function resolveTailPath(
  baseDir: string,
  uuid: string
): Promise<{ path: string; mtime: Date } | null> {
  const transcriptPath = transcriptPathFor(baseDir, uuid);
  try {
    const s = await stat(transcriptPath);
    if (s.isFile()) return { path: transcriptPath, mtime: s.mtime };
  } catch {
    // 沒有 transcript
  }
  return null;
}

export class AgySessionFinder implements SessionFinder {
  private baseDir: string;
  private historyPath: string;
  private cachePath: string;

  constructor(paths?: {
    baseDir?: string;
    historyPath?: string;
    cachePath?: string;
  }) {
    this.baseDir =
      paths?.baseDir ??
      join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
    this.historyPath =
      paths?.historyPath ??
      join(homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
    this.cachePath =
      paths?.cachePath ??
      join(
        homedir(),
        '.gemini',
        'antigravity-cli',
        'cache',
        'last_conversations.json'
      );
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * 載入 history.jsonl 與 last_conversations.json 以建立 conversationId -> workspace 的映射
   */
  private async loadWorkspaceMappings(): Promise<Map<string, string>> {
    const idToWorkspace = new Map<string, string>();
    try {
      const historyFile = Bun.file(this.historyPath);
      if (await historyFile.exists()) {
        const historyText = await historyFile.text();
        for (const line of historyText.trim().split('\n')) {
          if (!line) continue;
          try {
            const data = JSON.parse(line);
            if (data.conversationId && data.workspace) {
              idToWorkspace.set(data.conversationId, data.workspace);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      const cacheFile = Bun.file(this.cachePath);
      if (await cacheFile.exists()) {
        const cacheText = await cacheFile.text();
        const cacheData = JSON.parse(cacheText);
        for (const [workspace, id] of Object.entries(cacheData)) {
          if (typeof id === 'string') {
            idToWorkspace.set(id, workspace);
          }
        }
      }
    } catch {
      // ignore
    }

    return idToWorkspace;
  }

  // 掃描 conversations/*.{pb,db}（antigravity-cli 從 .pb protobuf 改為 .db SQLite，
  // 但 studio 仍保留舊 .pb session），tail 目標只收有 brain transcript 的 session
  private async _collectSessions(
    options: { project?: string },
    idToWorkspace?: Map<string, string>
  ): Promise<SessionListItem[]> {
    const glob = new Glob('*.{pb,db}');
    const files: SessionListItem[] = [];
    const seenUuids = new Set<string>();

    const mappings = idToWorkspace ?? (await this.loadWorkspaceMappings());

    try {
      for await (const file of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        const filename = basename(file);
        const uuid = filename.replace(/\.(?:db|pb)$/, '');
        // 同一 session 同時存在 .pb 與 .db 時去重
        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);

        const workspace = mappings.get(uuid);
        const project = workspace ? basename(workspace) : undefined;

        if (options.project) {
          const pattern = options.project.toLowerCase();
          const matchProject = project?.toLowerCase().includes(pattern);
          const matchWorkspace = workspace?.toLowerCase().includes(pattern);
          const matchUuid = uuid.toLowerCase().includes(pattern);
          if (!matchProject && !matchWorkspace && !matchUuid) {
            continue;
          }
        }

        try {
          // 無 transcript 的 session（空 session）直接排除
          const tail = await resolveTailPath(this.baseDir, uuid);
          if (!tail) continue;
          files.push({
            path: tail.path,
            mtime: tail.mtime,
            agentType: 'agy',
            shortId: uuid.slice(0, 8),
            project: project || 'unknown',
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

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    if (files.length === 0) return null;
    return {
      path: files[0]!.path,
      mtime: files[0]!.mtime,
      agentType: 'agy',
    };
  }

  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    const files = await this._collectSessions(options);
    return files.slice(0, options.limit ?? 20);
  }

  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    const search = sessionId.toLowerCase();

    // 只比對 UUID（前綴或完整），不比對整條路徑——
    // 否則 "brain"/"logs"/"transcript" 等路徑關鍵字會誤傷
    const found = files.find((f) => {
      const uuid = extractConversationId(f.path).toLowerCase();
      return uuid === search || uuid.startsWith(search);
    });
    if (!found) return null;
    return {
      path: found.path,
      mtime: found.mtime,
      agentType: 'agy',
    };
  }

  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const uuid = extractConversationId(sessionPath);
    const idToWorkspace = await this.loadWorkspaceMappings();
    const workspace = idToWorkspace.get(uuid);
    if (workspace) {
      return { projectDir: workspace, displayName: basename(workspace) };
    }
    return null;
  }

  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const idToWorkspace = await this.loadWorkspaceMappings();
    const files = await this._collectSessions({}, idToWorkspace);
    // 找出 workspace 吻合的最新的會話（防止多個同名 workspace 誤判）
    const found = files.find((f) => {
      const uuid = extractConversationId(f.path);
      return idToWorkspace.get(uuid) === projectDir;
    });
    if (!found) return null;
    return {
      path: found.path,
      mtime: found.mtime,
      agentType: 'agy',
    };
  }
}

/**
 * 解析 antigravity-cli 的 brain transcript（JSONL）。
 *
 * 語意（對照實際 transcript 驗證）：
 * - USER_INPUT → user 訊息
 * - PLANNER_RESPONSE → 模型規劃/回覆；thinking（reasoning，僅 verbose）與
 *   tool_calls（function_call）與 content（assistant）可並存，依序全部輸出
 * - GENERIC（新格式）+ VIEW_FILE/RUN_COMMAND/GREP_SEARCH/LIST_DIRECTORY/
 *   CODE_ACTION/ERROR_MESSAGE（舊 .pb 格式）→ tool 執行輸出（output）
 * - SYSTEM_MESSAGE / CHECKPOINT / CONVERSATION_HISTORY / INVOKE_SUBAGENT → 跳過
 */
export class AgyLineParser extends MultiEmitParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    super();
    this.verbose = options.verbose;
  }

  protected toParts(entry: unknown): ParsedLine[] {
    const data = entry as Record<string, unknown>;
    if (!data || typeof data !== 'object') return [];

    const type = typeof data.type === 'string' ? data.type : '';
    const content = typeof data.content === 'string' ? data.content : '';
    let timestamp = new Date().toISOString();
    if (typeof data.created_at === 'string') {
      const d = new Date(data.created_at);
      if (!Number.isNaN(d.getTime())) timestamp = d.toISOString();
    }

    const parts: ParsedLine[] = [];

    switch (type) {
      case 'USER_INPUT':
        if (content) {
          parts.push({
            type: 'user',
            timestamp,
            raw: data,
            formatted: formatMultiline(content),
          });
        }
        break;

      case 'PLANNER_RESPONSE': {
        // thinking 與 tool_calls/content 可並存：依序 emit reasoning → function_call → assistant
        if (
          this.verbose &&
          typeof data.thinking === 'string' &&
          data.thinking.trim()
        ) {
          parts.push({
            type: 'reasoning',
            timestamp,
            raw: data,
            formatted: formatMultiline(data.thinking),
          });
        }
        if (Array.isArray(data.tool_calls)) {
          for (const tc of data.tool_calls as {
            name?: string;
            args?: Record<string, unknown>;
          }[]) {
            parts.push({
              type: 'function_call',
              timestamp,
              raw: data,
              toolName: tc.name,
              formatted: formatToolUse(tc.name || 'tool', tc.args),
            });
          }
        }
        if (content) {
          parts.push({
            type: 'assistant',
            timestamp,
            raw: data,
            formatted: formatMultiline(content),
          });
        }
        break;
      }

      // tool 執行輸出（新格式 GENERIC + 舊格式 VIEW_FILE 等）
      case 'GENERIC':
      case 'VIEW_FILE':
      case 'RUN_COMMAND':
      case 'GREP_SEARCH':
      case 'LIST_DIRECTORY':
      case 'CODE_ACTION':
      case 'ERROR_MESSAGE':
        if (content) {
          parts.push({
            type: 'output',
            timestamp,
            raw: data,
            formatted: formatMultiline(content),
          });
        }
        break;

      default:
        // SYSTEM_MESSAGE / CHECKPOINT / CONVERSATION_HISTORY / INVOKE_SUBAGENT 等跳過
        break;
    }
    return parts;
  }
}

export class AgyAgent implements Agent {
  readonly type = 'agy' as const;
  readonly finder: AgySessionFinder;
  readonly parser: AgyLineParser;

  constructor(
    options: ParserOptions = { verbose: false },
    paths?: { baseDir?: string; historyPath?: string; cachePath?: string }
  ) {
    this.finder = new AgySessionFinder(paths);
    this.parser = new AgyLineParser(options);
  }
}
