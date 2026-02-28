import type { TerminalController } from './terminal-controller.interface.ts';
import { TmuxController } from './tmux-controller.ts';
import { NullController } from './null-controller.ts';

/**
 * 根據環境偵測建立適合的 TerminalController
 *
 * 優先順序：
 * 1. tmux（偵測 TMUX 環境變數）
 * 2. NullController（降級方案）
 *
 * Phase 2 將加入 iTerm2 支援。
 */
export function createTerminalController(): TerminalController {
  const tmux = new TmuxController();
  if (tmux.isAvailable()) return tmux;
  return new NullController();
}
