import { describe, test, expect } from 'bun:test';
import { PaneManager } from '../../src/terminal/pane-manager';
import type {
  PaneInfo,
  TerminalController,
} from '../../src/terminal/terminal-controller.interface';

const cmdBuilder = (agentId: string, _path: string) =>
  `agent-tail claude --subagent ${agentId}`;

function createMockController(): TerminalController & {
  createdPanes: string[];
  closedPanes: string[];
} {
  let counter = 0;
  return {
    name: 'mock',
    createdPanes: [],
    closedPanes: [],
    isAvailable: () => true,
    createPane: async function (
      _cmd: string,
      agentId: string
    ): Promise<PaneInfo | null> {
      counter++;
      this.createdPanes.push(agentId);
      return { id: `%${counter}`, agentId };
    },
    closePane: async function (paneId: string): Promise<void> {
      this.closedPanes.push(paneId);
    },
  };
}

describe('PaneManager — P7 pin/evict (T14/T15)', () => {
  test('pinAgent excludes from FIFO eviction', async () => {
    const ctrl = createMockController();
    const mgr = new PaneManager(ctrl, cmdBuilder);

    // Open 6 panes (fill capacity)
    const ids = [
      'aaa1111',
      'bbb2222',
      'ccc3333',
      'ddd4444',
      'eee5555',
      'fff6666',
    ];
    for (const id of ids) {
      await mgr.openPane(id, `/path/${id}.jsonl`);
    }
    mgr.pinAgent('aaa1111');

    // Try to open a 7th — eviction should target the oldest NON-pinned
    // (which is 'bbb2222', second-oldest).
    await mgr.openPaneEvictIfNeeded('ggg7777', '/path/ggg7777.jsonl');

    // Pinned pane (aaa1111) must survive
    expect(ctrl.closedPanes).toContain('%2'); // bbb2222 was %2
    expect(ctrl.closedPanes).not.toContain('%1'); // aaa1111 was %1
    expect(ctrl.createdPanes).toContain('ggg7777');
  });

  test('unpinAgent re-enables eviction', async () => {
    const ctrl = createMockController();
    const mgr = new PaneManager(ctrl, cmdBuilder);

    const ids = [
      'aaa1111',
      'bbb2222',
      'ccc3333',
      'ddd4444',
      'eee5555',
      'fff6666',
    ];
    for (const id of ids) {
      await mgr.openPane(id, `/path/${id}.jsonl`);
    }
    mgr.pinAgent('aaa1111');
    mgr.unpinAgent('aaa1111');

    // Evict — without pin, oldest (aaa1111) goes first
    await mgr.openPaneEvictIfNeeded('ggg7777', '/path/ggg7777.jsonl');
    expect(ctrl.closedPanes).toContain('%1');
  });

  test('openPaneEvictIfNeeded with all pinned skips (no eviction)', async () => {
    const ctrl = createMockController();
    const mgr = new PaneManager(ctrl, cmdBuilder);

    const ids = [
      'aaa1111',
      'bbb2222',
      'ccc3333',
      'ddd4444',
      'eee5555',
      'fff6666',
    ];
    for (const id of ids) {
      await mgr.openPane(id, `/path/${id}.jsonl`);
      mgr.pinAgent(id);
    }

    await mgr.openPaneEvictIfNeeded('ggg7777', '/path/ggg7777.jsonl');

    expect(ctrl.closedPanes).toHaveLength(0);
    expect(ctrl.createdPanes).not.toContain('ggg7777');
  });

  test('closePaneByAgentId clears pin + insertion-order entry', async () => {
    const ctrl = createMockController();
    const mgr = new PaneManager(ctrl, cmdBuilder);

    await mgr.openPane('aaa1111', '/path/a.jsonl');
    mgr.pinAgent('aaa1111');
    await mgr.closePaneByAgentId('aaa1111');

    // Re-open same agentId — should succeed (not blocked by stale state)
    await mgr.openPane('aaa1111', '/path/a.jsonl');
    expect(ctrl.createdPanes.filter((id) => id === 'aaa1111')).toHaveLength(2);
  });

  test('openPaneEvictIfNeeded below capacity opens without eviction', async () => {
    const ctrl = createMockController();
    const mgr = new PaneManager(ctrl, cmdBuilder);

    await mgr.openPane('aaa1111', '/path/a.jsonl');
    mgr.pinAgent('aaa1111');

    await mgr.openPaneEvictIfNeeded('bbb2222', '/path/b.jsonl');

    expect(ctrl.closedPanes).toHaveLength(0);
    expect(ctrl.createdPanes).toEqual(['aaa1111', 'bbb2222']);
  });
});
