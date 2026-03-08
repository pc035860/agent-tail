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
   * 重新命名 pane（tmux 2.6+ 支援 select-pane -T）
   * Best-effort 操作，失敗靜默忽略
   */
  async renamePane(paneId: string, title: string): Promise<void> {
    try {
      const proc = Bun.spawn(
        ['tmux', 'select-pane', '-t', paneId, '-T', title],
        { stdout: 'ignore', stderr: 'ignore' }
      );
      await proc.exited;
    } catch {
      // 靜默忽略（tmux 版本不支援或 pane 已關閉）
    }
  }

  /**
   * 套用佈局（main-vertical：主左、subagent 堆右均分）
   * Best-effort 操作，失敗不影響 pane 建立
   */
  async applyLayout(
    type: 'main-vertical' | 'main-horizontal' | 'tiled' = 'main-vertical'
  ): Promise<void> {
    try {
      const proc = Bun.spawn(['tmux', 'select-layout', type], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await proc.exited;
    } catch {
      // 靜默忽略佈局失敗（best-effort）
    }
  }
}
