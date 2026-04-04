import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  ProjectInfo,
  SessionFile,
} from '../../core/types.ts';
import {
  contentToString,
  truncateByLines,
  formatMultiline,
} from '../../utils/text.ts';
import { isValidCursorSubagentId } from '../../cursor/watch-builder.ts';

/**
 * Cursor Session Finder
 * 目錄結構: ~/.cursor/projects/{workspace-slug}/agent-transcripts/{UUID}/{UUID}.jsonl
 * Subagent: {UUID}/subagents/{subagent-UUID}.jsonl
 */
class CursorSessionFinder implements SessionFinder {
  private _baseDir: string;

  constructor() {
    this._baseDir = join(homedir(), '.cursor', 'projects');
  }

  getBaseDir(): string {
    return this._baseDir;
  }

  /**
   * 設定 baseDir（用於測試）
   */
  setBaseDir(dir: string): void {
    this._baseDir = dir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const glob = new Glob('*/agent-transcripts/*/*.jsonl');
    let latest: { path: string; mtime: Date } | null = null;

    // Cache .workspace-trusted lookups per workspace slug
    const workspacePathCache = new Map<string, string | null>();

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      // 排除 subagent 檔案
      if (file.includes('/subagents/')) continue;

      // Project filter
      if (options.project) {
        const matched = await this._matchProject(
          file,
          options.project,
          workspacePathCache
        );
        if (!matched) continue;
      }

      try {
        const stats = await stat(file);
        if (!latest || stats.mtime > latest.mtime) {
          latest = { path: file, mtime: stats.mtime };
        }
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (!latest) return null;

    return {
      path: latest.path,
      mtime: latest.mtime,
      agentType: 'cursor',
    };
  }

  /**
   * 依 session ID 查找 session 檔案
   * Cursor session ID 為 UUID v4
   * 支援部分匹配：精確 > 前綴 > 包含
   */
  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const glob = new Glob('*/agent-transcripts/*/*.jsonl');
    const candidates: { path: string; mtime: Date; priority: number }[] = [];
    const searchTerm = sessionId.toLowerCase();

    const workspacePathCache = new Map<string, string | null>();

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      if (file.includes('/subagents/')) continue;

      if (options.project) {
        const matched = await this._matchProject(
          file,
          options.project,
          workspacePathCache
        );
        if (!matched) continue;
      }

      // 從路徑提取 UUID（目錄名即為 session ID）
      const sessionDir = basename(dirname(file));
      const normalizedId = sessionDir.toLowerCase();

      let priority = 0;
      if (normalizedId === searchTerm) {
        // UUID 唯一，精確匹配直接返回
        try {
          const stats = await stat(file);
          return { path: file, mtime: stats.mtime, agentType: 'cursor' };
        } catch {
          continue;
        }
      } else if (normalizedId.startsWith(searchTerm)) {
        priority = 2; // 前綴匹配
      } else if (normalizedId.includes(searchTerm)) {
        priority = 1; // 包含匹配
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

    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.mtime.getTime() - a.mtime.getTime();
    });

    const best = candidates[0];
    if (!best) return null;

    return {
      path: best.path,
      mtime: best.mtime,
      agentType: 'cursor',
    };
  }

  /**
   * 查找 subagent session 檔案
   * 掃描 workspace/agent-transcripts/UUID/subagents/UUID.jsonl
   * @param options.subagentId - 部分 UUID 匹配
   */
  async findSubagent(options: {
    project?: string;
    subagentId?: string;
  }): Promise<SessionFile | null> {
    const glob = new Glob('*/agent-transcripts/*/subagents/*.jsonl');
    const candidates: { path: string; mtime: Date; priority: number }[] = [];
    const searchTerm = options.subagentId?.toLowerCase();

    const workspacePathCache = new Map<string, string | null>();

    for await (const file of glob.scan({
      cwd: this._baseDir,
      absolute: true,
    })) {
      // 從檔名提取 UUID
      const filename = basename(file, '.jsonl');
      if (!isValidCursorSubagentId(filename)) continue;

      // Project filter
      if (options.project) {
        const matched = await this._matchProject(
          file,
          options.project,
          workspacePathCache
        );
        if (!matched) continue;
      }

      // Subagent ID 匹配
      const normalizedId = filename.toLowerCase();
      let priority = 3; // 無 filter 時預設優先

      if (searchTerm) {
        if (normalizedId === searchTerm) {
          // 精確匹配直接返回
          try {
            const stats = await stat(file);
            return { path: file, mtime: stats.mtime, agentType: 'cursor' };
          } catch {
            continue;
          }
        } else if (normalizedId.startsWith(searchTerm)) {
          priority = 2; // 前綴匹配
        } else if (normalizedId.includes(searchTerm)) {
          priority = 1; // 包含匹配
        } else {
          continue;
        }
      }

      try {
        const stats = await stat(file);
        candidates.push({ path: file, mtime: stats.mtime, priority });
      } catch {
        // 忽略
      }
    }

    if (candidates.length === 0) return null;

    // 按優先度排序，相同優先度按 mtime 排序（最新在前）
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.mtime.getTime() - a.mtime.getTime();
    });

    const best = candidates[0];
    if (!best) return null;

    return {
      path: best.path,
      mtime: best.mtime,
      agentType: 'cursor',
    };
  }

  /**
   * 從 session 檔案取得專案資訊（用於 auto-switch）
   * 提取 workspace 目錄作為 projectDir
   */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const workspaceDir = this._extractWorkspaceDir(sessionPath);
    if (!workspaceDir) return null;

    const slug = basename(workspaceDir);
    const workspacePath = await this._readWorkspacePath(workspaceDir);
    const displayName = workspacePath ? basename(workspacePath) : slug;

    return {
      projectDir: workspaceDir,
      displayName,
    };
  }

  /**
   * 在指定專案範圍內找最新的 session（用於 auto-switch）
   * @param projectDir - workspace 目錄路徑
   */
  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const transcriptsDir = join(projectDir, 'agent-transcripts');
    // glob */*.jsonl 只匹配一層深度，不會匹配 subagents/ 下的檔案
    const glob = new Glob('*/*.jsonl');
    let latest: { path: string; mtime: Date } | null = null;

    for await (const file of glob.scan({
      cwd: transcriptsDir,
      absolute: true,
    })) {
      try {
        const stats = await stat(file);
        if (!latest || stats.mtime > latest.mtime) {
          latest = { path: file, mtime: stats.mtime };
        }
      } catch {
        // 忽略
      }
    }

    if (!latest) return null;

    return {
      path: latest.path,
      mtime: latest.mtime,
      agentType: 'cursor',
    };
  }

  /**
   * 從 session 路徑提取 workspace 目錄
   * 路徑格式: ~/.cursor/projects/{slug}/agent-transcripts/{UUID}/{UUID}.jsonl
   * 回傳: ~/.cursor/projects/{slug}
   */
  private _extractWorkspaceDir(sessionPath: string): string | null {
    const agentTranscriptsIdx = sessionPath.indexOf('/agent-transcripts/');
    if (agentTranscriptsIdx === -1) return null;
    return sessionPath.slice(0, agentTranscriptsIdx);
  }

  /**
   * 讀取 .workspace-trusted 檔案中的 workspacePath
   */
  private async _readWorkspacePath(
    workspaceDir: string
  ): Promise<string | null> {
    try {
      const content = await readFile(
        join(workspaceDir, '.workspace-trusted'),
        'utf-8'
      );
      const data = JSON.parse(content);
      return data.workspacePath || null;
    } catch {
      return null;
    }
  }

  /**
   * 專案模糊匹配
   * 匹配 workspace slug 或 .workspace-trusted 的 workspacePath
   */
  private async _matchProject(
    filePath: string,
    project: string,
    cache: Map<string, string | null>
  ): Promise<boolean> {
    const pattern = project.toLowerCase();

    // 對完整路徑做模糊比對（包含 slug）
    if (filePath.toLowerCase().includes(pattern)) return true;

    // 嘗試 .workspace-trusted 的 workspacePath
    const workspaceDir = this._extractWorkspaceDir(filePath);
    if (!workspaceDir) return false;

    const slug = basename(workspaceDir);
    if (!cache.has(slug)) {
      cache.set(slug, await this._readWorkspacePath(workspaceDir));
    }

    const workspacePath = cache.get(slug);
    if (workspacePath && workspacePath.toLowerCase().includes(pattern)) {
      return true;
    }

    return false;
  }
}

/**
 * 從文字中去除 <user_query> 包裝標籤
 */
function stripUserQueryTags(text: string): string {
  return text
    .replace(/^<user_query>\s*/s, '')
    .replace(/\s*<\/user_query>\s*$/s, '')
    .trim();
}

/**
 * 從文字中去除 <attached_files> 區塊
 */
function stripAttachedFilesTags(text: string): string {
  return text.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '').trim();
}

/**
 * Cursor JSONL 解析器（無狀態）
 * 格式: {"role":"user|assistant","message":{"content":[{"type":"text","text":"..."}]}}
 */
class CursorLineParser implements LineParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

  parse(line: string): ParsedLine | null {
    if (!line.trim()) return null;

    try {
      const data = JSON.parse(line);
      const role = data.role as string;
      if (!role) return null;

      const content = data.message?.content;
      let text = contentToString(content);

      if (!text.trim()) return null;

      // 清除包裝標籤（先移除 attached_files 區塊，再移除 user_query 標籤）
      // 順序重要：attached_files 可能在 user_query 之前，必須先清除才能讓 user_query 的 ^ 錨點匹配
      if (role === 'user') {
        text = stripAttachedFilesTags(text);
        text = stripUserQueryTags(text);
      }

      if (!text.trim()) return null;

      const preview = truncateByLines(text, { verbose: this.verbose });

      return {
        type: role, // 'user' | 'assistant' — PrettyFormatter 已支援
        timestamp: '', // Cursor 日誌無時間戳
        raw: data,
        formatted: formatMultiline(preview),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Cursor Agent
 */
export class CursorAgent implements Agent {
  readonly type = 'cursor' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new CursorSessionFinder();
    this.parser = new CursorLineParser(options);
  }
}
