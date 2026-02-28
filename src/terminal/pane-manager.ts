import type {
  PaneInfo,
  TerminalController,
} from './terminal-controller.interface.ts';

/** MVP 最大 pane 數量（安全上限，Phase 2 可設定） */
const MAX_PANES = 6;

/**
 * Pane 生命週期管理器
 *
 * 負責追蹤所有開啟的 pane，並在需要時統一清理。
 * 是 pane 狀態的唯一 source of truth。
 */
export class PaneManager {
  private controller: TerminalController;
  private commandBuilder: (agentId: string, subagentPath: string) => string;
  private panes: Map<string, PaneInfo> = new Map(); // agentId -> PaneInfo
  /** 正在開啟中的 agentId（防止併發超開） */
  private pendingAgentIds: Set<string> = new Set();

  constructor(
    controller: TerminalController,
    commandBuilder: (agentId: string, subagentPath: string) => string
  ) {
    this.controller = controller;
    this.commandBuilder = commandBuilder;
  }

  /**
   * 為 subagent 開啟新 pane
   * - 已存在相同 agentId 的 pane 時跳過（去重）
   * - 超過 MAX_PANES 時跳過（安全上限）
   * - 使用 pendingAgentIds 防止併發呼叫超開
   */
  async openPane(agentId: string, subagentPath: string): Promise<void> {
    if (this.panes.has(agentId)) return;
    if (this.pendingAgentIds.has(agentId)) return;
    if (this.panes.size + this.pendingAgentIds.size >= MAX_PANES) return;

    this.pendingAgentIds.add(agentId);
    try {
      const cmd = this.commandBuilder(agentId, subagentPath);
      const pane = await this.controller.createPane(cmd, agentId);
      if (pane) {
        this.panes.set(agentId, pane);
        // 每次開新 pane 後重新計算佈局
        await this.applyLayout();
      }
    } finally {
      this.pendingAgentIds.delete(agentId);
    }
  }

  /**
   * 關閉所有已追蹤的 pane（best-effort）
   */
  async closeAll(): Promise<void> {
    const closePromises = [...this.panes.values()].map((p) =>
      this.controller.closePane(p.id).catch(() => {})
    );
    await Promise.all(closePromises);
    this.panes.clear();
  }

  /**
   * 套用佈局（如果 controller 支援）
   * Best-effort 操作，失敗不影響核心功能
   */
  private async applyLayout(): Promise<void> {
    if (this.controller.applyLayout) {
      try {
        await this.controller.applyLayout('main-vertical');
      } catch {
        // 靜默忽略佈局失敗
      }
    }
  }

  /**
   * 目前開啟的 pane 數量
   */
  get activePaneCount(): number {
    return this.panes.size;
  }
}
