/**
 * tmux/iTerm2 pane 資訊
 */
export interface PaneInfo {
  /** pane 識別碼（tmux: "%3", iTerm2: session handle） */
  id: string;
  /** 對應的 subagent ID */
  agentId: string;
}

/**
 * Terminal Controller 介面 - 抽象化 pane 管理操作
 */
export interface TerminalController {
  /** Controller 名稱（用於日誌） */
  readonly name: string;
  /** 檢查 terminal 環境是否可用 */
  isAvailable(): boolean;
  /** 建立新 pane 並執行指令 */
  createPane(command: string, agentId: string): Promise<PaneInfo | null>;
  /** 關閉指定 pane */
  closePane(paneId: string): Promise<void>;
}
