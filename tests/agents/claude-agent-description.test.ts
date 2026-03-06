import { describe, test, expect, beforeEach } from 'bun:test';
import { ClaudeAgent } from '../../src/agents/claude/claude-agent';
import type { LineParser } from '../../src/agents/agent.interface';
import type { ParsedLine } from '../../src/core/types';

/**
 * Collect all parsed lines from a single JSONL line
 */
function collectAllParsedLines(
  parser: LineParser,
  line: string,
  maxIterations = 100
): ParsedLine[] {
  const results: ParsedLine[] = [];
  let parsed = parser.parse(line);
  let iterations = 0;

  while (parsed && iterations < maxIterations) {
    results.push(parsed);
    parsed = parser.parse(line);
    iterations++;
  }

  if (iterations >= maxIterations) {
    throw new Error('Infinite loop detected');
  }
  return results;
}

describe('ClaudeAgent parser taskDescription', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new ClaudeAgent({ verbose: false });
    parser = agent.parser;
  });

  test('Task tool_use with description extracts taskDescription', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: {
              description: 'memory search',
              prompt: 'Search for related memories',
              subagent_type: 'memory-graph-analyst',
            },
          },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.isTaskToolUse).toBe(true);
    expect(results[0]!.taskDescription).toBe('memory search');
  });

  test('Task tool_use without description has undefined taskDescription', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: {
              prompt: 'Search for files',
            },
          },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.isTaskToolUse).toBe(true);
    expect(results[0]!.taskDescription).toBeUndefined();
  });

  test('Task tool_use with non-string description has undefined taskDescription', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: {
              description: 123,
              prompt: 'test',
            },
          },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.isTaskToolUse).toBe(true);
    expect(results[0]!.taskDescription).toBeUndefined();
  });

  test('non-Task tool_use has no taskDescription', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.taskDescription).toBeUndefined();
  });
});
