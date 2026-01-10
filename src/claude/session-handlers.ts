import type { SessionHandler } from './subagent-detector.ts';
import type { SessionManager } from '../core/session-manager.ts';
import type { DisplayController } from '../interactive/display-controller.ts';

/**
 * Interactive Session 處理器
 *
 * 封裝 SessionManager 和 DisplayController 的操作，
 * 用於 Interactive 模式的 session 生命週期管理。
 */
export class InteractiveSessionHandler implements SessionHandler {
  constructor(
    private sessionManager: SessionManager,
    private displayController: DisplayController
  ) {}

  addSession(agentId: string, label: string, path: string): void {
    this.sessionManager.addSession(agentId, label, path);
  }

  markSessionDone(agentId: string): void {
    this.sessionManager.markSessionDone(agentId);
  }

  updateUI(): void {
    this.displayController.updateStatusLine(
      this.sessionManager.getAllSessions(),
      this.sessionManager.getActiveIndex()
    );
  }
}

/**
 * 空操作 Session 處理器（MultiWatch 模式）
 *
 * MultiWatch 模式不需要 session 管理，
 * 所有方法皆為空操作。
 */
export class NoOpSessionHandler implements SessionHandler {
  // 所有方法皆為 undefined，不執行任何操作
  // SessionHandler 介面的方法都是 optional，
  // 所以這裡不需要實作任何方法
}
