import type {
  PaneInfo,
  TerminalController,
} from './terminal-controller.interface.ts';

/**
 * Null Terminal Controller - 降級方案
 *
 * 當沒有可用的 terminal 環境時使用，所有操作為 no-op。
 */
export class NullController implements TerminalController {
  readonly name = 'null';

  isAvailable(): boolean {
    return false;
  }

  async createPane(
    _command: string,
    _agentId: string
  ): Promise<PaneInfo | null> {
    return null;
  }

  async closePane(_paneId: string): Promise<void> {
    // no-op
  }
}
