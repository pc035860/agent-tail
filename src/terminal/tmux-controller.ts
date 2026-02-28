import type {
  PaneInfo,
  TerminalController,
} from './terminal-controller.interface.ts';

/**
 * tmux Terminal Controller
 *
 * 使用 Bun.spawn 直接調用 tmux CLI，零外部依賴。
 * Stateless 設計 — 不追蹤 pane 狀態，由 PaneManager 管理。
 */
export class TmuxController implements TerminalController {
  readonly name = 'tmux';

  isAvailable(): boolean {
    return !!process.env.TMUX;
  }

  async createPane(command: string, agentId: string): Promise<PaneInfo | null> {
    try {
      const proc = Bun.spawn(
        ['tmux', 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', command],
        { stdout: 'pipe', stderr: 'pipe' }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return null;
      }

      const paneId = output.trim();
      if (!paneId) return null;

      return { id: paneId, agentId };
    } catch {
      // tmux 指令失敗（binary 不存在等情況）
      return null;
    }
  }

  async closePane(paneId: string): Promise<void> {
    try {
      const proc = Bun.spawn(['tmux', 'kill-pane', '-t', paneId], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await proc.exited;
    } catch {
      // 靜默忽略（pane 可能已經關閉）
    }
  }

  /**
   * No-op: TmuxController 是 stateless 的，
   * 由 PaneManager 負責追蹤和逐一關閉。
   */
  async closeAllPanes(): Promise<void> {
    // no-op
  }
}
