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
  private commandBuilder: (agentId: string) => string;
  private panes: Map<string, PaneInfo> = new Map(); // agentId -> PaneInfo
  /** 正在開啟中的 agentId（防止併發超開） */
  private pendingAgentIds: Set<string> = new Set();

  constructor(
    controller: TerminalController,
    commandBuilder: (agentId: string) => string
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
  async openPane(agentId: string): Promise<void> {
    if (this.panes.has(agentId)) {
      console.error(`[pane-debug] skip: already has pane for ${agentId}`);
      return;
    }
    if (this.pendingAgentIds.has(agentId)) {
      console.error(`[pane-debug] skip: pending for ${agentId}`);
      return;
    }
    if (this.panes.size + this.pendingAgentIds.size >= MAX_PANES) {
      console.error(`[pane-debug] skip: MAX_PANES reached`);
      return;
    }

    this.pendingAgentIds.add(agentId);
    try {
      const cmd = this.commandBuilder(agentId);
      console.error(`[pane-debug] createPane cmd: ${cmd}`);
      const pane = await this.controller.createPane(cmd, agentId);
      console.error(
        `[pane-debug] createPane result: ${pane ? `id=${pane.id}` : 'null'}`
      );
      if (pane) {
        this.panes.set(agentId, pane);
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
   * 目前開啟的 pane 數量
   */
  get activePaneCount(): number {
    return this.panes.size;
  }
}
