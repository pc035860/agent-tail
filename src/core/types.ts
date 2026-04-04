/**
 * Agent 類型
 */
export type AgentType = 'codex' | 'claude' | 'gemini' | 'cursor';

/**
 * CLI 選項
 */
export interface CliOptions {
  agentType: AgentType;
  raw: boolean;
  project?: string;
  follow: boolean;
  verbose: boolean;
  /** Suppress non-error output messages */
  quiet: boolean;
  /** File polling interval in milliseconds (default: 500) */
  sleepInterval: number;
  /** Number of initial lines to show per file (default: all) */
  lines?: number;
  /** Claude/Codex: tail subagent log (true = latest, string = specific ID) */
  subagent?: string | true;
  /** Claude/Codex: interactive mode for switching between main session and subagents (Codex: Phase 3) */
  interactive: boolean;
  /** Claude/Codex: include subagent content in output (non-interactive mode) */
  withSubagents: boolean;
  /** Auto-switch to latest main session in project */
  autoSwitch: boolean;
  /** Claude/Codex: auto-open tmux pane for each new subagent (Codex: Phase 2) */
  pane: boolean;
  /** List recent sessions instead of tailing */
  list: boolean;
  /** Show session summary (first N + last M lines) */
  summary: boolean;
  /** Optional session ID to load (partial match supported) */
  sessionId?: string;
}

/**
 * Parser 設定選項
 */
export interface ParserOptions {
  verbose: boolean;
}

/**
 * Session 檔案資訊
 */
export interface SessionFile {
  path: string;
  mtime: Date;
  agentType: AgentType;
  /** Claude Code custom session title (from /rename command) */
  customTitle?: string;
}

/**
 * 專案資訊（用於 auto-switch）
 */
export interface ProjectInfo {
  /** 專案目錄路徑（用於 session 搜尋範圍） */
  projectDir: string;
  /** 顯示名稱（用於日誌輸出） */
  displayName?: string;
}

/**
 * Claude Session 查找結果（支援 subagent 關聯）
 * 當指定 subagent ID 時，會同時返回主 session 和 subagent
 */
export interface ClaudeSessionResult {
  main: SessionFile;
  subagent?: SessionFile;
}

/**
 * Session 列表項目（用於 --list 輸出）
 */
export interface SessionListItem extends SessionFile {
  /** 顯示用短識別碼 */
  shortId: string;
  /** 專案識別（decoded path, cwd, slug, dir name） */
  project?: string;
  /** 最後活動時間（從 session 內容讀取，比 file mtime 更準確） */
  lastActivityTime?: Date;
}

/**
 * JSONL 解析結果
 */
export interface ParsedLine {
  type: string;
  timestamp: string;
  raw: unknown;
  formatted: string;
  /** Tool 名稱（僅 function_call 類型使用，用於顏色判斷） */
  toolName?: string;
  /** 來源標籤（多檔案監控時用於區分來源，如 "[MAIN]" 或 "[a0627b6]"） */
  sourceLabel?: string;
  /** 是否為 Task (or Agent) tool_use（用於早期 Subagent 偵測） */
  isTaskToolUse?: boolean;
  /** Task (or Agent) tool_use 的 description 欄位（用於 pane 命名） */
  taskDescription?: string;
  /** Whether this is a custom-title event (Claude only) */
  isCustomTitle?: boolean;
  /** The custom title value from the event */
  customTitleValue?: string;
}
