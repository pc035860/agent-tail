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
  /** Claude only: include subagent content in output (non-interactive mode) */
  withSubagents: boolean;
  /** Claude only: super follow mode for interactive (auto switch to latest main session) */
  super: boolean;
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
  /** 是否為 Task tool_use（用於早期 Subagent 偵測） */
  isTaskToolUse?: boolean;
}
