import type { WatchedFile } from './multi-file-watcher.ts';

// ============================================================
// Interfaces
// ============================================================

/**
 * 輸出處理器介面 - 抽象化不同模式的輸出方式
 */
export interface OutputHandler {
  /** 訊息輸出 */
  info(message: string): void;
  /** 警告輸出（如 early detection） */
  warn(message: string): void;
  /** 錯誤輸出 */
  error(message: string): void;
  /** 輕量級訊息（如 file not found after retries） */
  debug(message: string): void;
}

/**
 * Session 管理器介面 - 抽象化 Interactive 模式的特殊需求
 */
export interface SessionHandler {
  /** 新增 session（Interactive 模式需要） */
  addSession?(agentId: string, label: string, path: string): void;
  /** 標記 session 完成（Interactive 模式需要） */
  markSessionDone?(agentId: string): void;
  /** 更新 UI（Interactive 模式需要） */
  updateUI?(): void;
}

/**
 * Watcher 介面 - 抽象化 MultiFileWatcher 的 addFile 操作
 */
export interface WatcherHandler {
  addFile(file: WatchedFile): Promise<void>;
}

/**
 * 重試配置
 */
export interface RetryConfig {
  /** 最大重試次數 */
  maxRetries: number;
  /** 重試間隔（ms） */
  retryDelay: number;
  /** 初始延遲（ms） */
  initialDelay: number;
}

// ============================================================
// Constants & Label Utilities
// ============================================================

/** 主 session 的標籤常數 */
export const MAIN_LABEL = '[MAIN]';

/** 從 agentId 建立標籤（例如 '[abc1234]'） */
export function makeAgentLabel(agentId: string): string {
  return `[${agentId}]`;
}

/** 從標籤提取 agentId（例如 '[abc1234]' -> 'abc1234'） */
export function extractAgentIdFromLabel(label: string): string {
  return label.slice(1, -1);
}
