import { describe, test, expect, beforeEach } from 'bun:test';
import { ClaudeAgent } from '../../../src/agents/claude/claude-agent';
import type { LineParser } from '../../../src/agents/agent.interface';
import type { ParsedLine } from '../../../src/core/types';

function collectAll(parser: LineParser, line: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let p = parser.parse(line);
  let guard = 0;
  while (p && guard < 100) {
    out.push(p);
    p = parser.parse(line);
    guard++;
  }
  return out;
}

describe('ClaudeLineParser — Workflow tool_use detection (P5)', () => {
  let parser: LineParser;

  beforeEach(() => {
    parser = new ClaudeAgent({ verbose: false }).parser;
  });

  test('Workflow tool_use sets isWorkflowToolUse=true', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-5-20251101',
        content: [
          {
            type: 'tool_use',
            name: 'Workflow',
            input: { name: 'briefshare-impl' },
          },
        ],
      },
    });
    const parts = collectAll(parser, line);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolName).toBe('Workflow');
    expect(parts[0]!.isWorkflowToolUse).toBe(true);
    expect(parts[0]!.isTaskToolUse).toBe(false);
  });

  test('Non-Workflow tool_use does NOT set isWorkflowToolUse', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-5-20251101',
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/x' },
          },
        ],
      },
    });
    const parts = collectAll(parser, line);
    expect(parts[0]!.isWorkflowToolUse).toBeUndefined();
  });
});

describe('ClaudeLineParser — Workflow async_launched tool_result (P5)', () => {
  let parser: LineParser;

  beforeEach(() => {
    parser = new ClaudeAgent({ verbose: false }).parser;
  });

  test('full payload populates workflowAsyncLaunch with all 5 fields', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'Workflow launched' }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskId: 'wile2fghi',
        runId: 'wf_6f7d9da9-37e',
        summary: 'Run the demo workflow',
        transcriptDir:
          '/Users/x/.claude/projects/-x/abc/subagents/workflows/wf_6f7d9da9-37e',
        scriptPath:
          '/Users/x/.claude/projects/-x/abc/workflows/scripts/demo-wf_6f7d9da9-37e.js',
      },
    });
    const parts = collectAll(parser, line);
    expect(parts).toHaveLength(1);
    const w = parts[0]!.workflowAsyncLaunch;
    expect(w).toBeDefined();
    expect(w!.runId).toBe('wf_6f7d9da9-37e');
    expect(w!.transcriptDir).toContain('wf_6f7d9da9-37e');
    expect(w!.scriptPath).toContain('demo-wf_');
    expect(w!.summary).toBe('Run the demo workflow');
    expect(w!.taskId).toBe('wile2fghi');
  });

  test('minimal payload (runId + transcriptDir only) still populates workflowAsyncLaunch (CI-2)', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }],
      },
      toolUseResult: {
        status: 'async_launched',
        runId: 'wf_aaaaaaaa-bbb',
        transcriptDir: '/tmp/abc/subagents/workflows/wf_aaaaaaaa-bbb',
      },
    });
    const parts = collectAll(parser, line);
    expect(parts).toHaveLength(1);
    const w = parts[0]!.workflowAsyncLaunch;
    expect(w).toBeDefined();
    expect(w!.runId).toBe('wf_aaaaaaaa-bbb');
    expect(w!.transcriptDir).toContain('wf_aaaaaaaa-bbb');
    expect(w!.scriptPath).toBeUndefined();
    expect(w!.summary).toBeUndefined();
    expect(w!.taskId).toBeUndefined();
  });

  test('subagent async_launched (no runId) does NOT populate workflowAsyncLaunch', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: 'a8931818048287747',
        prompt: 'do stuff',
        outputFile: '/tmp/x.output',
        canReadOutputFile: true,
      },
    });
    const parts = collectAll(parser, line);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.workflowAsyncLaunch).toBeUndefined();
  });

  test('async_launched with non-wf_ runId is rejected', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }],
      },
      toolUseResult: {
        status: 'async_launched',
        runId: 'not-a-wf-id',
        transcriptDir: '/tmp/x',
      },
    });
    const parts = collectAll(parser, line);
    expect(parts[0]!.workflowAsyncLaunch).toBeUndefined();
  });

  test('async_launched without transcriptDir is rejected', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }],
      },
      toolUseResult: {
        status: 'async_launched',
        runId: 'wf_aaaaaaaa-bbb',
      },
    });
    const parts = collectAll(parser, line);
    expect(parts[0]!.workflowAsyncLaunch).toBeUndefined();
  });

  test('existing tool_result formatting preserved (subagent completion)', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x' }],
      },
      toolUseResult: {
        status: 'completed',
        agentId: 'aaaaaaa',
        totalDurationMs: 3500,
        totalTokens: 1200,
        totalToolUseCount: 4,
      },
    });
    const parts = collectAll(parser, line);
    expect(parts[0]!.formatted).toContain('completed');
    expect(parts[0]!.formatted).toContain('agent:aaaaaaa');
    expect(parts[0]!.formatted).toContain('1200 tokens');
  });
});
