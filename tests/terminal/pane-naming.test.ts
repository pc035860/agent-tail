import { describe, test, expect } from 'bun:test';
import { PaneManager } from '../../src/terminal/pane-manager';
import type {
  PaneInfo,
  TerminalController,
} from '../../src/terminal/terminal-controller.interface';

// ============================================================
// Mock Helpers
// ============================================================

const defaultCommandBuilder = (agentId: string, _path: string) =>
  `agent-tail claude --subagent ${agentId}`;

function createMockController(): TerminalController & {
  createdPanes: { command: string; agentId: string }[];
  closedPanes: string[];
  renamedPanes: { paneId: string; title: string }[];
  shouldFail: boolean;
  renameShouldThrow: boolean;
} {
  let paneCounter = 0;
  return {
    name: 'mock',
    createdPanes: [],
    closedPanes: [],
    renamedPanes: [],
    shouldFail: false,
    renameShouldThrow: false,
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
    renamePane: async function (paneId: string, title: string): Promise<void> {
      if (this.renameShouldThrow) throw new Error('Mock rename error');
      this.renamedPanes.push({ paneId, title });
    },
  };
}

// ============================================================
// Tests: PaneManager with description
// ============================================================

describe('PaneManager pane naming', () => {
  test('forwards description to renamePane after createPane succeeds', async () => {
    const controller = createMockController();
    const manager = new PaneManager(controller, defaultCommandBuilder);

    await manager.openPane(
      'abc1234',
      '/path/to/agent-abc1234.jsonl',
      'memory search'
    );

    expect(controller.renamedPanes).toHaveLength(1);
    expect(controller.renamedPanes[0]!.paneId).toBe('%1');
    expect(controller.renamedPanes[0]!.title).toBe('abc1234: memory search');
  });

  test('does not call renamePane when no description provided', async () => {
    const controller = createMockController();
    const manager = new PaneManager(controller, defaultCommandBuilder);

    await manager.openPane('abc1234', '/path/to/agent-abc1234.jsonl');

    expect(controller.renamedPanes).toHaveLength(0);
  });

  test('renamePane failure does not block pane tracking', async () => {
    const controller = createMockController();
    controller.renameShouldThrow = true;
    const manager = new PaneManager(controller, defaultCommandBuilder);

    await manager.openPane(
      'abc1234',
      '/path/to/agent-abc1234.jsonl',
      'memory search'
    );

    // Pane should still be tracked despite rename failure
    expect(manager.activePaneCount).toBe(1);
    expect(controller.createdPanes).toHaveLength(1);
  });

  test('sanitizes description: truncates to 50 chars', async () => {
    const controller = createMockController();
    const manager = new PaneManager(controller, defaultCommandBuilder);

    const longDesc = 'a'.repeat(100);
    await manager.openPane('abc1234', '/path/to/agent-abc1234.jsonl', longDesc);

    expect(controller.renamedPanes).toHaveLength(1);
    // "abc1234: " is 9 chars, so description part should be truncated
    // Total title should not exceed a reasonable length
    const title = controller.renamedPanes[0]!.title;
    expect(title.length).toBeLessThanOrEqual(60); // agentId: + 50 chars
  });

  test('sanitizes description: strips control characters', async () => {
    const controller = createMockController();
    const manager = new PaneManager(controller, defaultCommandBuilder);

    await manager.openPane(
      'abc1234',
      '/path/to/agent-abc1234.jsonl',
      'hello\nworld\t!'
    );

    expect(controller.renamedPanes).toHaveLength(1);
    const title = controller.renamedPanes[0]!.title;
    // Control chars should be replaced with spaces
    expect(title).not.toContain('\n');
    expect(title).not.toContain('\t');
    expect(title).toContain('hello');
    expect(title).toContain('world');
  });

  test('sanitizes description: strips tmux # sequences', async () => {
    const controller = createMockController();
    const manager = new PaneManager(controller, defaultCommandBuilder);

    await manager.openPane(
      'abc1234',
      '/path/to/agent-abc1234.jsonl',
      'test #(command) here'
    );

    expect(controller.renamedPanes).toHaveLength(1);
    const title = controller.renamedPanes[0]!.title;
    expect(title).not.toContain('#');
  });

  test('does not call renamePane when controller lacks renamePane method', async () => {
    // Simulate NullController (no renamePane method)
    const controller: TerminalController = {
      name: 'null',
      isAvailable: () => true,
      createPane: async (_cmd: string, agentId: string) => ({
        id: '%1',
        agentId,
      }),
      closePane: async () => {},
      // no renamePane
    };

    const manager = new PaneManager(controller, defaultCommandBuilder);

    // Should not throw
    await manager.openPane(
      'abc1234',
      '/path/to/agent-abc1234.jsonl',
      'some description'
    );

    expect(manager.activePaneCount).toBe(1);
  });
});
