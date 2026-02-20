import { stat } from 'node:fs/promises';
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
import { truncateByLines, formatMultiline } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';

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

  /**
   * 依 session ID 查找 session 檔案
   * 檔名格式：session-{timestamp}-{8位UUID}.json
   * 支援匹配：8位 UUID 前綴、完整 UUID（需讀取 JSON）、時間戳
   */
  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const glob = new Glob('*/chats/session-*.json');
    const candidates: { path: string; mtime: Date; priority: number }[] = [];
    // 用於完整 UUID 匹配的候選（需要讀取 JSON）
    const uuidCandidates: { path: string; mtime: Date }[] = [];

    // 檔名格式：session-{timestamp}-{8位UUID}.json
    // 例如：session-2025-12-28T10-10-3f3fa388.json
    const filenamePattern = /^session-(.+)-([0-9a-f]{8})\.json$/i;
    // 完整 UUID 格式
    const fullUuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const searchTerm = sessionId.toLowerCase();
    const isFullUuid = fullUuidPattern.test(sessionId);

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      // project filter
      if (options.project) {
        const pattern = options.project.toLowerCase();
        if (!file.toLowerCase().includes(pattern)) continue;
      }

      const filename = file.split('/').pop() || '';
      const match = filename.match(filenamePattern);

      if (!match) continue;

      const timestampPart = match[1] || '';
      const shortUuid = (match[2] || '').toLowerCase();

      // 計算匹配優先級
      let priority = 0;

      // 1. 對 8 位 UUID 前綴進行匹配
      if (shortUuid === searchTerm) {
        priority = 6; // 精確匹配
      } else if (shortUuid.startsWith(searchTerm)) {
        priority = 5; // 前綴匹配
      } else if (shortUuid.includes(searchTerm)) {
        priority = 4; // 包含匹配
      }

      // 2. 對時間戳進行匹配（如果 UUID 沒有匹配到）
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

      // 如果是完整 UUID 且沒有匹配到檔名，加入候選列表等待讀取 JSON
      if (priority === 0 && isFullUuid) {
        try {
          const stats = await stat(file);
          uuidCandidates.push({ path: file, mtime: stats.mtime });
        } catch {
          // 忽略
        }
        continue;
      }

      if (priority === 0) continue;

      try {
        const stats = await stat(file);
        candidates.push({ path: file, mtime: stats.mtime, priority });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    // 如果有檔名匹配的候選，直接使用
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.mtime.getTime() - a.mtime.getTime();
      });

      const best = candidates[0];
      if (!best) return null;

      return {
        path: best.path,
        mtime: best.mtime,
        agentType: 'gemini',
      };
    }

    // 如果是完整 UUID 且沒有檔名匹配，嘗試讀取 JSON 內容
    if (isFullUuid && uuidCandidates.length > 0) {
      for (const candidate of uuidCandidates) {
        try {
          const content = await Bun.file(candidate.path).text();
          const data = JSON.parse(content);
          if (data.sessionId && data.sessionId.toLowerCase() === searchTerm) {
            return {
              path: candidate.path,
              mtime: candidate.mtime,
              agentType: 'gemini',
            };
          }
        } catch {
          // 忽略解析錯誤
        }
      }
    }

    return null;
  }

  /**
   * 從 session 檔案取得專案資訊（用於 auto-switch）
   * 1. 檢查父目錄的 .project_root 檔案
   * 2. 若無 .project_root，使用目錄名稱作為識別
   */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    // sessionPath: ~/.gemini/tmp/pos2/chats/session-xxx.json
    // chatsDir: ~/.gemini/tmp/pos2/chats
    // projectDir: ~/.gemini/tmp/pos2
    const chatsDir = dirname(sessionPath);
    const projectDir = dirname(chatsDir);

    // 嘗試讀取 .project_root
    const projectRootPath = join(projectDir, '.project_root');
    const projectRootFile = Bun.file(projectRootPath);

    if (await projectRootFile.exists()) {
      try {
        const cwd = (await projectRootFile.text()).trim();
        return { projectDir, displayName: cwd };
      } catch {
        // 忽略讀取錯誤
      }
    }

    // 無 .project_root，使用目錄名稱
    const dirName = basename(projectDir);
    return { projectDir, displayName: dirName };
  }

  /**
   * 在指定專案目錄中找最新的 session（用於 auto-switch）
   * @param projectDir - Gemini 專案目錄（如 ~/.gemini/tmp/pos2）
   */
  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const chatsDir = join(projectDir, 'chats');
    const glob = new Glob('session-*.json');
    const files: { path: string; mtime: Date }[] = [];

    try {
      for await (const file of glob.scan({
        cwd: chatsDir,
        absolute: true,
      })) {
        try {
          const stats = await stat(file);
          files.push({ path: file, mtime: stats.mtime });
        } catch {
          // 忽略無法讀取的檔案
        }
      }
    } catch {
      // chats 目錄不存在
      return null;
    }

    if (files.length === 0) return null;

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
  /** 追蹤 gemini message 內部的處理進度：toolCalls index 和 content 是否已處理 */
  private currentMessageState: {
    messageId: string;
    toolCallIndex: number;
    contentProcessed: boolean;
  } | null = null;
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

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
   * 解析完整 session JSON，逐個回傳 message 的各個部分
   * gemini 類型的 message 會被拆分成多個輸出（每個 toolCall 和 content）
   */
  private parseSessionJson(session: {
    sessionId?: string;
    messages: Array<{
      id: string;
      type: string;
      content: string;
      timestamp: string;
      tokens?: Record<string, number>;
      toolCalls?: Array<{
        name?: string;
        args?: Record<string, unknown>;
        status?: string;
      }>;
    }>;
  }): ParsedLine | null {
    const messages = session.messages || [];

    // 如果正在處理某個 gemini message 的內部狀態
    if (this.currentMessageState) {
      const msg = messages.find(
        (m) => m.id === this.currentMessageState!.messageId
      );
      if (msg) {
        const result = this.processGeminiMessagePart(msg);
        if (result) return result;
      }
      // 當前 message 處理完畢
      this.currentMessageState = null;
    }

    // 找到下一個未處理的 message
    const nextMessage = messages.find(
      (m) => !this.processedMessageIds.has(m.id)
    );
    if (!nextMessage) return null;

    // user 類型直接輸出
    if (nextMessage.type === 'user') {
      this.processedMessageIds.add(nextMessage.id);
      const content = nextMessage.content || '';
      if (!content.trim()) {
        return this.parseSessionJson(session);
      }
      const preview = truncateByLines(content, { verbose: this.verbose });
      return {
        type: 'user',
        timestamp: nextMessage.timestamp,
        raw: nextMessage,
        formatted: formatMultiline(preview),
      };
    }

    // gemini 類型需要拆分處理
    if (nextMessage.type === 'gemini') {
      this.processedMessageIds.add(nextMessage.id);
      // 初始化內部狀態
      this.currentMessageState = {
        messageId: nextMessage.id,
        toolCallIndex: 0,
        contentProcessed: false,
      };
      const result = this.processGeminiMessagePart(nextMessage);
      if (result) return result;
      // 如果沒有內容，處理下一個 message
      this.currentMessageState = null;
      return this.parseSessionJson(session);
    }

    // 其他類型
    this.processedMessageIds.add(nextMessage.id);
    const content = nextMessage.content || '';
    const preview = truncateByLines(content, { verbose: this.verbose });
    return {
      type: nextMessage.type,
      timestamp: nextMessage.timestamp,
      raw: nextMessage,
      formatted: formatMultiline(preview),
    };
  }

  /**
   * 處理 gemini message 的下一個部分（toolCall 或 content）
   */
  private processGeminiMessagePart(msg: {
    id: string;
    timestamp: string;
    content: string;
    toolCalls?: Array<{
      name?: string;
      args?: Record<string, unknown>;
      status?: string;
    }>;
  }): ParsedLine | null {
    if (!this.currentMessageState) return null;

    const toolCalls = msg.toolCalls || [];

    // 先處理 toolCalls
    if (this.currentMessageState.toolCallIndex < toolCalls.length) {
      const tc = toolCalls[this.currentMessageState.toolCallIndex];
      this.currentMessageState.toolCallIndex++;
      if (tc) {
        const status = tc.status === 'error' ? ' ❌' : '';
        const toolName = tc.name || 'unknown';
        return {
          type: 'function_call',
          timestamp: msg.timestamp,
          raw: tc,
          formatted:
            formatToolUse(toolName, tc.args, { verbose: this.verbose }) +
            status,
          toolName,
        };
      }
    }

    // 然後處理 content
    if (!this.currentMessageState.contentProcessed) {
      this.currentMessageState.contentProcessed = true;
      const content = msg.content || '';
      if (content.trim()) {
        const preview = truncateByLines(content, { verbose: this.verbose });
        return {
          type: 'gemini',
          timestamp: msg.timestamp,
          raw: msg,
          formatted: formatMultiline(preview),
        };
      }
    }

    return null;
  }

  /**
   * 解析單一 message（非 session JSON 的情況，較少見）
   */
  private parseSingleMessage(data: Record<string, unknown>): ParsedLine | null {
    const type = (data.type as string) || 'unknown';
    const timestamp = (data.timestamp as string) || '';
    const content = (data.content as string) || '';

    if (!content.trim()) return null;

    const preview = truncateByLines(content, { verbose: this.verbose });
    return {
      type,
      timestamp,
      raw: data,
      formatted: formatMultiline(preview),
    };
  }
}

/**
 * Gemini CLI Agent
 */
export class GeminiAgent implements Agent {
  readonly type = 'gemini' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new GeminiSessionFinder();
    this.parser = new GeminiLineParser(options);
  }
}
