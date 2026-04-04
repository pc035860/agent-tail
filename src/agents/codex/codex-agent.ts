import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import { truncateByLines, formatMultiline } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';
import { CodexSessionCache, readMainSessionMeta } from './session-cache.ts';
import { readLastTimestampFromJSONL } from '../../utils/session-time.ts';
import {
  buildCodexSubagentFiles,
  extractCodexSubagentIds,
} from '../../codex/watch-builder.ts';

/**
 * Codex Session Finder
 * 目錄結構: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
class CodexSessionFinder implements SessionFinder {
  private _baseDir: string;
  private _cache: CodexSessionCache;

  constructor() {
    this._baseDir = join(homedir(), '.codex', 'sessions');
    this._cache = new CodexSessionCache(this._baseDir);
  }

  getBaseDir(): string {
    return this._baseDir;
  }

  /**
   * 設定 baseDir（用於測試）
   * 同時會重置 cache 使用新的目錄
   */
  setBaseDir(dir: string): void {
    this._baseDir = dir;
    this._cache = new CodexSessionCache(dir);
  }

  /**
   * 取得 cache 實例（用於 findLatestInProject）
   */
  private get cache(): CodexSessionCache {
    return this._cache;
  }

  /**
   * 收集所有主 session 檔案（共用邏輯）
   * 使用 readMainSessionMeta 過濾 subagent 並取得 cwd
   */
  private async _collectMainSessions(options: {
    project?: string;
  }): Promise<SessionListItem[]> {
    const glob = new Glob('**/*.jsonl');
    const files: SessionListItem[] = [];
    // Extract UUID from rollout filename: rollout-{timestamp}-{UUID}.jsonl
    const uuidPattern =
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      // 排除 subagent session & 取得 cwd
      const meta = await readMainSessionMeta(file);
      if (!meta) continue;

      // Project filter：match against cwd (not file path, which only has dates)
      if (options.project) {
        const pattern = options.project.toLowerCase();
        if (!meta.cwd.toLowerCase().includes(pattern)) continue;
      }

      try {
        const stats = await stat(file);
        const match = uuidPattern.exec(filename);
        const shortId = match?.[1]?.slice(0, 8) ?? filename.slice(0, 8);

        files.push({
          path: file,
          mtime: stats.mtime,
          agentType: 'codex',
          shortId,
          project: meta.cwd,
        });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const files = await this._collectMainSessions(options);
    if (files.length === 0) return null;
    return {
      path: files[0]!.path,
      mtime: files[0]!.mtime,
      agentType: 'codex',
    };
  }

  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    const files = await this._collectMainSessions(options);
    const limit = options.limit ?? 20;
    const sliced = files.slice(0, limit);

    await Promise.all(
      sliced.map(async (item) => {
        item.lastActivityTime =
          (await readLastTimestampFromJSONL(item.path)) ?? undefined;
      })
    );

    sliced.sort((a, b) => {
      const ta = (a.lastActivityTime ?? a.mtime).getTime();
      const tb = (b.lastActivityTime ?? b.mtime).getTime();
      return tb - ta;
    });

    return sliced;
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

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
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

  /**
   * 從 session 檔案取得專案資訊（用於 auto-switch）
   * 解析 session_meta 取得 cwd
   */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const meta = await readMainSessionMeta(sessionPath);
    if (!meta) return null;
    return {
      projectDir: meta.cwd,
      displayName: meta.cwd,
    };
  }

  /**
   * 在指定專案範圍內找最新的 session（用於 auto-switch）
   * @param cwd - 專案目錄路徑
   */
  async findLatestInProject(cwd: string): Promise<SessionFile | null> {
    return this.cache.getLatestByCwd(cwd);
  }

  /**
   * 找到 subagent 檔案
   * - 有 subagentId：用 UUID glob 在所有日期目錄查找
   * - 無 subagentId：從最新 session 掃描 subagent IDs，回傳最新的 subagent 檔案
   *
   * 已知限制：無 subagentId 時，findLatest() 不保證回傳主 session（可能回傳 subagent 檔案）。
   * 若 extractCodexSubagentIds 回傳空陣列，會回傳 null。
   */
  async findSubagent(options: {
    project?: string;
    subagentId?: string;
  }): Promise<SessionFile | null> {
    if (options.subagentId) {
      // 有 subagentId：用 UUID glob 精確查找
      return this._findSubagentById(options.subagentId, options.project);
    } else {
      // 無 subagentId：從最新 session 掃描 subagent IDs
      return this._findLatestSubagent(options.project);
    }
  }

  /**
   * 依 subagentId（UUID 前綴或完整 UUID）在所有日期目錄查找 subagent 檔案
   */
  private async _findSubagentById(
    subagentId: string,
    project?: string
  ): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const candidates: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      // project filter
      if (project) {
        if (!file.toLowerCase().includes(project.toLowerCase())) continue;
      }

      // 包含 subagentId（大小寫不敏感）
      if (!filename.toLowerCase().includes(subagentId.toLowerCase())) continue;

      try {
        const stats = await stat(file);
        candidates.push({ path: file, mtime: stats.mtime });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const best = candidates[0];
    if (!best) return null;

    return { path: best.path, mtime: best.mtime, agentType: 'codex' };
  }

  /**
   * 掃描所有 session，從最新的開始找第一個含 subagent IDs 的，回傳最新的 subagent 檔案
   *
   * 注意：findLatest() 不區分主 session 和 subagent session（依 mtime 排序）。
   * 此方法改為迭代所有候選 session，跳過不含 spawn_agent 事件的（通常是 subagent 本身）。
   */
  private async _findLatestSubagent(
    project?: string
  ): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const candidates: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      if (project) {
        if (!file.toLowerCase().includes(project.toLowerCase())) continue;
      }

      try {
        const stats = await stat(file);
        candidates.push({ path: file, mtime: stats.mtime });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (candidates.length === 0) return null;

    // 由新到舊排序，優先從最新的 session 找 subagent
    candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const candidate of candidates) {
      const agentIds = await extractCodexSubagentIds(candidate.path);
      if (agentIds.length === 0) continue;

      const dateDir = dirname(candidate.path);
      const subFiles = await buildCodexSubagentFiles(dateDir, agentIds);
      if (subFiles.length === 0) continue;

      subFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return subFiles[0] ?? null;
    }

    return null;
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
