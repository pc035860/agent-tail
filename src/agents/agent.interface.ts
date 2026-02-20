import type {
  AgentType,
  ClaudeSessionResult,
  ParsedLine,
  ProjectInfo,
  SessionFile,
} from '../core/types.ts';

/**
 * Session 檔案發現器介面
 */
export interface SessionFinder {
  /**
   * 取得基礎目錄
   */
  getBaseDir(): string;

  /**
   * 找到最新的 session 檔案
   */
  findLatest(options: { project?: string }): Promise<SessionFile | null>;

  /**
   * 找到 subagent 檔案（可選實作，目前只有 Claude 支援）
   * @param options.subagentId - 指定的 subagent ID，不提供則找最新的
   */
  findSubagent?(options: {
    project?: string;
    subagentId?: string;
  }): Promise<SessionFile | null>;

  /**
   * 依 session ID 查找 session 檔案（可選實作）
   * 支援 partial match：精確 > 前綴 > 包含
   * 多重匹配時選擇 mtime 最新的
   * @param sessionId - 使用者提供的 session ID（可為簡化格式或部分 ID）
   * @param options.project - 專案過濾
   * @returns SessionFile（一般情況）或 ClaudeSessionResult（Claude subagent 情況）
   */
  findBySessionId?(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | ClaudeSessionResult | null>;

  /**
   * 從 session 檔案取得專案資訊（用於 auto-switch）
   * @param sessionPath - session 檔案路徑
   * @returns 專案資訊，若無法識別則回傳 null
   */
  getProjectInfo?(sessionPath: string): Promise<ProjectInfo | null>;

  /**
   * 在指定專案範圍內找最新的 session（用於 auto-switch）
   * @param projectDir - 專案目錄識別
   */
  findLatestInProject?(projectDir: string): Promise<SessionFile | null>;
}

/**
 * JSONL 行解析器介面
 */
export interface LineParser {
  /**
   * 解析單行 JSONL
   */
  parse(line: string): ParsedLine | null;
}

/**
 * Agent 介面
 */
export interface Agent {
  readonly type: AgentType;
  readonly finder: SessionFinder;
  readonly parser: LineParser;
}
