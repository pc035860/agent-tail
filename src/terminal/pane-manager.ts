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
  private panes: Map<string, PaneInfo> = new Map(); // agentId -> PaneInfo

  constructor(controller: TerminalController) {
    this.controller = controller;
  }

  /**
   * 為 subagent 開啟新 pane
   * - 已存在相同 agentId 的 pane 時跳過（去重）
   * - 超過 MAX_PANES 時跳過（安全上限）
   */
  async openPane(agentId: string, _subagentPath: string): Promise<void> {
    if (this.panes.has(agentId)) return;
    if (this.panes.size >= MAX_PANES) return;

    const cmd = this.buildCommand(agentId);
    const pane = await this.controller.createPane(cmd, agentId);
    if (pane) {
      this.panes.set(agentId, pane);
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
   * 目前開啟的 pane 數量
   */
  get activePaneCount(): number {
    return this.panes.size;
  }

  /**
   * 建構 pane 中執行的指令
   *
   * 已知限制：假設 agent-tail 在 PATH 中（全域安裝或 npx）。
   * 如果使用 bun run 方式執行，pane 中的指令可能失敗。
   */
  private buildCommand(agentId: string): string {
    return `agent-tail claude --subagent ${agentId} -q`;
  }
}
