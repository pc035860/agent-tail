import type {
  PaneInfo,
  TerminalController,
} from './terminal-controller.interface.ts';

/** MVP 最大 pane 數量（安全上限，Phase 2 可設定） */
const MAX_PANES = 6;

/** Pane title description 最大長度 */
const MAX_DESCRIPTION_LENGTH = 50;

/**
 * 清理並格式化 pane title
 * - 移除 control characters 和 tmux # 特殊序列
 * - 截斷超長描述
 */
function sanitizePaneTitle(description: string): string {
  return (
    description
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ') // control chars -> space
      .replace(/#/g, '') // tmux interprets #() sequences
      .trim()
      .slice(0, MAX_DESCRIPTION_LENGTH)
  );
}

/** applyLayout debounce 延遲（ms） */
const LAYOUT_DEBOUNCE_MS = 50;

/**
 * Pane 生命週期管理器
 *
 * 負責追蹤所有開啟的 pane，並在需要時統一清理。
 * 是 pane 狀態的唯一 source of truth。
 */
export class PaneManager {
  private controller: TerminalController;
  private commandBuilder: (agentId: string, subagentPath: string) => string;
  private logger?: (msg: string) => void;
  private panes: Map<string, PaneInfo> = new Map(); // agentId -> PaneInfo
  /** 正在開啟中的 agentId（防止併發超開） */
  private pendingAgentIds: Set<string> = new Set();
  /** 待關閉的 agentId（pane 還在 pending 時就收到 done 事件） */
  private pendingCloseAgentIds: Set<string> = new Set();
  /** applyLayout debounce timer */
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    controller: TerminalController,
    commandBuilder: (agentId: string, subagentPath: string) => string,
    logger?: (msg: string) => void
  ) {
    this.controller = controller;
    this.commandBuilder = commandBuilder;
    this.logger = logger;
  }

  /**
   * 為 subagent 開啟新 pane
   * - 已存在相同 agentId 的 pane 時跳過（去重）
   * - 超過 MAX_PANES 時跳過（安全上限）
   * - 使用 pendingAgentIds 防止併發呼叫超開
   * - description 用於命名 pane（可選，來自 Task tool_use 的 description 欄位）
   */
  async openPane(
    agentId: string,
    subagentPath: string,
    description?: string
  ): Promise<void> {
    if (this.panes.has(agentId)) return;
    if (this.pendingAgentIds.has(agentId)) return;
    if (this.panes.size + this.pendingAgentIds.size >= MAX_PANES) return;

    this.logger?.(`[pane] Opening pane for ${agentId}...`);
    this.pendingAgentIds.add(agentId);
    try {
      const cmd = this.commandBuilder(agentId, subagentPath);
      const pane = await this.controller.createPane(cmd, agentId);
      if (pane) {
        this.panes.set(agentId, pane);

        // Best-effort pane naming (before pendingClose check)
        if (description && this.controller.renamePane) {
          const title = sanitizePaneTitle(description);
          try {
            await this.controller.renamePane(pane.id, title);
          } catch {
            // 命名失敗不影響 pane 功能
          }
        }

        // 排程佈局更新（debounce，連續開多個 pane 時只觸發一次）
        this.scheduleLayout();

        // 檢查是否在 pending 期間收到了 done 事件
        if (this.pendingCloseAgentIds.has(agentId)) {
          this.pendingCloseAgentIds.delete(agentId);
          // 立刻關閉這個 pane
          await this.closePaneByAgentId(agentId);
        }
      } else {
        // createPane 失敗，清除待關閉狀態（沒有 pane 就不需要關閉）
        this.pendingCloseAgentIds.delete(agentId);
      }
    } catch (e) {
      // 非預期錯誤（如 commandBuilder throw），清理所有相關狀態後向外拋出
      this.pendingCloseAgentIds.delete(agentId);
      throw e;
    } finally {
      this.pendingAgentIds.delete(agentId);
    }
  }

  /**
   * 關閉所有已追蹤的 pane（best-effort）
   */
  async closeAll(): Promise<void> {
    this.clearLayoutTimer();
    const closePromises = [...this.panes.values()].map((p) =>
      this.controller.closePane(p.id).catch(() => {})
    );
    await Promise.all(closePromises);
    this.panes.clear();
    this.pendingCloseAgentIds.clear();
  }

  /**
   * 排程佈局更新（debounce）
   * 連續開多個 pane 時只在最後觸發一次 tmux select-layout
   */
  private scheduleLayout(): void {
    this.clearLayoutTimer();
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      this.applyLayout().catch(() => {});
    }, LAYOUT_DEBOUNCE_MS);
  }

  private clearLayoutTimer(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
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
   * 根據 agentId 關閉對應的 pane
   * Best-effort 操作，失敗不影響核心功能
   * 如果 pane 還在 pending，會標記為待關閉，等 pane 建立後自動關閉
   */
  async closePaneByAgentId(agentId: string): Promise<void> {
    // 如果 pane 還在開啟中，標記為待關閉
    if (this.pendingAgentIds.has(agentId) && !this.panes.has(agentId)) {
      this.pendingCloseAgentIds.add(agentId);
      return;
    }

    const pane = this.panes.get(agentId);
    if (!pane) return;

    this.logger?.(`[pane] Closing pane for ${agentId}...`);

    // 立刻移除，防止並行呼叫重複觸發 closePane
    this.panes.delete(agentId);

    try {
      await this.controller.closePane(pane.id);
    } catch {
      // 靜默忽略關閉失敗（pane 可能已經關閉）
    }
  }

  /**
   * 目前開啟的 pane 數量
   */
  get activePaneCount(): number {
    return this.panes.size;
  }

  /**
   * 檢查指定 agentId 是否有對應的 pane（包含 pending 狀態）
   * 用於判斷是否需要觸發 onSubagentDone
   */
  hasPaneForAgent(agentId: string): boolean {
    return this.panes.has(agentId) || this.pendingAgentIds.has(agentId);
  }
}
