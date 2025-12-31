/**
 * Agent 類型
 */
export type AgentType = 'codex' | 'claude';

/**
 * CLI 選項
 */
export interface CliOptions {
  agentType: AgentType;
  raw: boolean;
  project?: string;
  follow: boolean;
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
}
