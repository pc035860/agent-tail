import { describe, test, expect } from 'bun:test';
import { DisplayController } from '../../src/interactive/display-controller';
import type { WorkflowSnapshot } from '../../src/claude-workflow/types';
import type { WatcherSession } from '../../src/core/session-manager';

function makeSession(overrides: Partial<WatcherSession> = {}): WatcherSession {
  return {
    id: 'main',
    label: '[MAIN]',
    path: '/tmp/x.jsonl',
    buffer: [],
    isDone: false,
    createdAt: 0,
    ...overrides,
  };
}

describe('DisplayController workflow status line (P6 T12/T13)', () => {
  test('setWorkflowStatus(runId, null) → loading fallback', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    dc.setWorkflowStatus('wf_12345678-abc', null);
    const line = dc.renderWorkflowStatusLine();
    expect(line).toContain('wf_12345678-abc');
    expect(line).toContain('loading snapshot');
  });

  test('setWorkflowStatus with running snapshot renders name + status + agents', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    const snap: WorkflowSnapshot = {
      runId: 'wf_12345678-abc',
      workflowName: 'briefshare-impl',
      status: 'running',
      agentCount: 5,
    };
    dc.setWorkflowStatus('wf_12345678-abc', snap);
    const line = dc.renderWorkflowStatusLine();
    expect(line).toContain('briefshare-impl');
    expect(line).toContain('running');
    expect(line).toContain('agents 5');
  });

  test('renders Phase X/N: Title when workflowProgress + phases present', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    const snap: WorkflowSnapshot = {
      runId: 'wf_12345678-abc',
      workflowName: 'demo',
      status: 'running',
      phases: [{ title: 'Setup' }, { title: 'Build' }, { title: 'Verify' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Setup' },
        { type: 'workflow_phase', index: 2, title: 'Build' },
      ],
    };
    dc.setWorkflowStatus('wf_12345678-abc', snap);
    const line = dc.renderWorkflowStatusLine();
    expect(line).toContain('Phase 2/3');
    expect(line).toContain('Build');
  });

  test('clearWorkflowStatus returns empty render', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    dc.setWorkflowStatus('wf_xxxxxxxx-xxx', null);
    expect(dc.renderWorkflowStatusLine()).not.toBe('');
    dc.clearWorkflowStatus();
    expect(dc.renderWorkflowStatusLine()).toBe('');
  });

  test('completed snapshot renders status="completed"', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    const snap: WorkflowSnapshot = {
      runId: 'wf_xxxxxxxx-xxx',
      workflowName: 'demo',
      status: 'completed',
    };
    dc.setWorkflowStatus('wf_xxxxxxxx-xxx', snap);
    expect(dc.renderWorkflowStatusLine()).toContain('completed');
  });

  test('fallback name = runId when workflowName missing', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    const snap: WorkflowSnapshot = {
      runId: 'wf_12345678-abc',
      status: 'running',
    };
    dc.setWorkflowStatus('wf_12345678-abc', snap);
    const line = dc.renderWorkflowStatusLine();
    expect(line).toContain('wf_12345678-abc');
  });
});

/**
 * Dual-row status (statusRows: 2) — workflow mode splits the combined
 * `[wf:...] • [tabs]` single line into two rows:
 *   - row 1 (terminalRows - 1): session tabs
 *   - row 2 (terminalRows):     workflow segment
 *
 * Single-row (statusRows: 1, default) preserves the existing `•`-joined
 * single-line layout for backward compat with non-workflow watches.
 *
 * `composeStatusLines(sessions, activeIndex)` is the test seam: returns
 * the array of lines to write (length === statusRows).
 */
describe('DisplayController dual-row status (statusRows: 2)', () => {
  test('default statusRows is 1 (backward compat)', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    expect(dc.getStatusRows()).toBe(1);
  });

  test('statusRows: 2 option is honored', () => {
    const dc = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    expect(dc.getStatusRows()).toBe(2);
  });

  test('composeStatusLines length matches statusRows', () => {
    const dc1 = new DisplayController({ persistentStatusLine: false });
    expect(dc1.composeStatusLines([makeSession()], 0)).toHaveLength(1);

    const dc2 = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    expect(dc2.composeStatusLines([makeSession()], 0)).toHaveLength(2);
  });

  test('dual-row: row 1 = session tabs (top), row 2 = workflow segment (bottom)', () => {
    const dc = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    const snap: WorkflowSnapshot = {
      runId: 'wf_12345678-abc',
      workflowName: 'briefshare-impl',
      status: 'completed',
      agentCount: 8,
    };
    dc.setWorkflowStatus('wf_12345678-abc', snap);
    const lines = dc.composeStatusLines([makeSession()], 0);
    expect(lines).toHaveLength(2);
    // Top row: session tab bar (must contain MAIN label)
    expect(lines[0]).toContain('MAIN');
    // Bottom row: workflow segment
    expect(lines[1]).toContain('briefshare-impl');
    expect(lines[1]).toContain('completed');
    expect(lines[1]).toContain('agents 8');
  });

  test('dual-row: no `•` joiner — workflow segment is standalone on row 2', () => {
    const dc = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    const snap: WorkflowSnapshot = {
      runId: 'wf_xxxxxxxx-xxx',
      workflowName: 'demo',
      status: 'running',
    };
    dc.setWorkflowStatus('wf_xxxxxxxx-xxx', snap);
    const [row1, row2] = dc.composeStatusLines([makeSession()], 0);
    expect(row1).not.toContain(' • ');
    expect(row2).not.toContain(' • ');
  });

  test('single-row keeps `•` joiner (backward compat for non-workflow watches)', () => {
    const dc = new DisplayController({ persistentStatusLine: false });
    const snap: WorkflowSnapshot = {
      runId: 'wf_xxxxxxxx-xxx',
      workflowName: 'demo',
      status: 'running',
    };
    dc.setWorkflowStatus('wf_xxxxxxxx-xxx', snap);
    const lines = dc.composeStatusLines([makeSession()], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' • ');
    expect(lines[0]).toContain('demo');
    expect(lines[0]).toContain('MAIN');
  });

  test('dual-row loading state keeps both rows (workflow row shows loading)', () => {
    const dc = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    dc.setWorkflowStatus('wf_xxxxxxxx-xxx', null);
    const lines = dc.composeStatusLines([makeSession()], 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('loading snapshot');
  });

  test('dual-row with no workflow state keeps row 2 reserved (height unchanged)', () => {
    const dc = new DisplayController({
      persistentStatusLine: false,
      statusRows: 2,
    });
    // No setWorkflowStatus call — clean slate
    const lines = dc.composeStatusLines([makeSession()], 0);
    expect(lines).toHaveLength(2);
    // Row 2 may be empty string, but the slot exists so the scroll region
    // doesn't jump when workflow state arrives.
    expect(typeof lines[1]).toBe('string');
  });
});
