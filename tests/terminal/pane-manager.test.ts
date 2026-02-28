import { describe, test, expect } from 'bun:test';
import { PaneManager } from '../../src/terminal/pane-manager';
import type {
  PaneInfo,
  TerminalController,
} from '../../src/terminal/terminal-controller.interface';

// ============================================================
// Mock Helpers
// ============================================================

const defaultCommandBuilder = (agentId: string) =>
  `agent-tail claude --subagent ${agentId}`;

function createMockController(): TerminalController & {
  createdPanes: { command: string; agentId: string }[];
  closedPanes: string[];
  shouldFail: boolean;
} {
  let paneCounter = 0;
  return {
    name: 'mock',
    createdPanes: [],
    closedPanes: [],
    shouldFail: false,
    isAvailable: () => true,
    createPane: async function (
      command: string,
      agentId: string
    ): Promise<PaneInfo | null> {
      this.createdPanes.push({ command, agentId });
      if (this.shouldFail) return null;
      paneCounter++;
      return { id: `%${paneCounter}`, agentId };
    },
    closePane: async function (paneId: string): Promise<void> {
      this.closedPanes.push(paneId);
    },
  };
}

// ============================================================
// Tests
// ============================================================

describe('PaneManager', () => {
  describe('openPane', () => {
    test('creates a pane via controller', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');

      expect(controller.createdPanes).toHaveLength(1);
      expect(controller.createdPanes[0]!.agentId).toBe('abc1234');
      expect(controller.createdPanes[0]!.command).toContain('abc1234');
      expect(manager.activePaneCount).toBe(1);
    });

    test('deduplicates by agentId', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');
      await manager.openPane('abc1234');

      expect(controller.createdPanes).toHaveLength(1);
      expect(manager.activePaneCount).toBe(1);
    });

    test('allows different agentIds', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');
      await manager.openPane('def5678');

      expect(controller.createdPanes).toHaveLength(2);
      expect(manager.activePaneCount).toBe(2);
    });

    test('respects MAX_PANES cap (6)', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      for (let i = 0; i < 8; i++) {
        await manager.openPane(`agent${i}`);
      }

      expect(controller.createdPanes).toHaveLength(6);
      expect(manager.activePaneCount).toBe(6);
    });

    test('prevents concurrent openPane from exceeding MAX_PANES', async () => {
      const controller = createMockController();
      // Add a small delay to simulate async createPane
      const originalCreatePane = controller.createPane.bind(controller);
      controller.createPane = async function (
        command: string,
        agentId: string
      ): Promise<PaneInfo | null> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return originalCreatePane(command, agentId);
      };

      const manager = new PaneManager(controller, defaultCommandBuilder);

      // Fire 8 concurrent openPane calls
      const promises = Array.from({ length: 8 }, (_, i) =>
        manager.openPane(`agent${i}`)
      );
      await Promise.all(promises);

      // Should not exceed MAX_PANES (6) even with concurrency
      expect(manager.activePaneCount).toBeLessThanOrEqual(6);
    });

    test('handles controller failure gracefully', async () => {
      const controller = createMockController();
      controller.shouldFail = true;
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');

      expect(controller.createdPanes).toHaveLength(1);
      expect(manager.activePaneCount).toBe(0); // not tracked since creation failed
    });
  });

  describe('closeAll', () => {
    test('closes all tracked panes', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');
      await manager.openPane('def5678');
      expect(manager.activePaneCount).toBe(2);

      await manager.closeAll();

      expect(controller.closedPanes).toHaveLength(2);
      expect(manager.activePaneCount).toBe(0);
    });

    test('handles individual closePane failures gracefully', async () => {
      const controller = createMockController();
      const originalClosePane = controller.closePane;
      let callCount = 0;
      controller.closePane = async function (paneId: string): Promise<void> {
        callCount++;
        if (callCount === 1) throw new Error('Mock close error');
        return originalClosePane.call(this, paneId);
      };

      const manager = new PaneManager(controller, defaultCommandBuilder);
      await manager.openPane('abc1234');
      await manager.openPane('def5678');

      // Should not throw even if one close fails
      await expect(manager.closeAll()).resolves.toBeUndefined();
      expect(manager.activePaneCount).toBe(0);
    });

    test('is idempotent', async () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);

      await manager.openPane('abc1234');
      await manager.closeAll();
      await manager.closeAll();

      expect(controller.closedPanes).toHaveLength(1);
      expect(manager.activePaneCount).toBe(0);
    });
  });

  describe('activePaneCount', () => {
    test('starts at 0', () => {
      const controller = createMockController();
      const manager = new PaneManager(controller, defaultCommandBuilder);
      expect(manager.activePaneCount).toBe(0);
    });
  });
});
