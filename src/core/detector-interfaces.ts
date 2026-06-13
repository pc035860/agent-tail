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

/** spawnRegistry 中表示 parent 是主 session 的哨值（用於 makeAgentLabel 內部判斷） */
export const MAIN_SOURCE = 'MAIN';

/** label 中分隔 child agent id 與 parent agent id 的字元 */
export const LABEL_PARENT_DELIMITER = '◂';

/**
 * 從 agentId 建立標籤
 * - 無 parent / parent 為主 session → '[abc1234]'
 * - 巢狀 parent → '[abc1234◂def5678]'（child◂parent，方便視覺辨識來源）
 */
export function makeAgentLabel(
  agentId: string,
  parentAgentId?: string
): string {
  if (parentAgentId && parentAgentId !== MAIN_SOURCE) {
    return `[${agentId}${LABEL_PARENT_DELIMITER}${parentAgentId}]`;
  }
  return `[${agentId}]`;
}

/**
 * 從標籤提取 agentId
 * - '[abc1234]' → 'abc1234'
 * - '[abc1234◂def5678]' → 'abc1234'（只取 child id）
 * - '[MAIN]' → 'MAIN'
 */
export function extractAgentIdFromLabel(label: string): string {
  const inner = label.slice(1, -1);
  const idx = inner.indexOf(LABEL_PARENT_DELIMITER);
  return idx >= 0 ? inner.slice(0, idx) : inner;
}

/** 從巢狀標籤提取 parent agentId（無 parent 時回 undefined） */
export function extractParentAgentIdFromLabel(
  label: string
): string | undefined {
  const inner = label.slice(1, -1);
  const idx = inner.indexOf(LABEL_PARENT_DELIMITER);
  return idx >= 0
    ? inner.slice(idx + LABEL_PARENT_DELIMITER.length)
    : undefined;
}
