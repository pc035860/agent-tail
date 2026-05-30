import { describe, test, expect } from 'bun:test';
import { DisplayController } from '../../src/interactive/display-controller';
import type { WorkflowSnapshot } from '../../src/claude-workflow/types';

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
