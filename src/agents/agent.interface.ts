import type { AgentType, ParsedLine, SessionFile } from '../core/types.ts';

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
