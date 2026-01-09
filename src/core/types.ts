/**
 * Agent 類型
 */
export type AgentType = 'codex' | 'claude' | 'gemini';

/**
 * CLI 選項
 */
export interface CliOptions {
  agentType: AgentType;
  raw: boolean;
  project?: string;
  follow: boolean;
  verbose: boolean;
  /** Claude only: tail subagent log (true = latest, string = specific ID) */
  subagent?: string | true;
  /** Claude only: interactive mode for switching between main session and subagents */
  interactive: boolean;
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
}
