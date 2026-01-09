import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { ClaudeAgent } from '../../src/agents/claude/claude-agent';
import type {
  LineParser,
  SessionFinder,
} from '../../src/agents/agent.interface';
import type { ParsedLine } from '../../src/core/types';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 模擬 while loop 收集所有 parsed lines
 * 如果超過 maxIterations 表示有無限迴圈
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

describe('ClaudeAgent parser', () => {
  let parser: LineParser;

  beforeEach(() => {
    const agent = new ClaudeAgent({ verbose: false });
    parser = agent.parser;
  });

  describe('user message', () => {
    test('should parse once and terminate (no infinite loop)', () => {
      const line = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'Hello world' },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('user');
    });

    test('should return null on second parse of same line', () => {
      const line = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'Hello world' },
      });

      const first = parser.parse(line);
      const second = parser.parse(line);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('assistant message with single text', () => {
    test('should parse once and terminate', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'Hello from Claude' }],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('assistant');
    });
  });

  describe('assistant message with single tool_use', () => {
    test('should parse once and terminate', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('Bash');
    });
  });

  describe('assistant message with multiple tool_use', () => {
    test('should parse each tool_use and terminate correctly', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/tmp/test' },
            },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe('function_call');
      expect(results[0]!.toolName).toBe('Bash');
      expect(results[1]!.type).toBe('function_call');
      expect(results[1]!.toolName).toBe('Read');
    });
  });

  describe('assistant message with mixed content', () => {
    test('should parse text and tool_use separately', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Let me check that for you' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'cat file.txt' },
            },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'error' } },
          ],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(3);
      expect(results[0]!.type).toBe('assistant');
      expect(results[1]!.type).toBe('function_call');
      expect(results[1]!.toolName).toBe('Bash');
      expect(results[2]!.type).toBe('function_call');
      expect(results[2]!.toolName).toBe('Grep');
    });
  });

  describe('assistant message with empty content', () => {
    test('should return null and not loop', () => {
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:00:00Z',
        message: {
          model: 'claude-sonnet-4-20250514',
          content: [],
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(0);
    });
  });

  describe('file-history-snapshot', () => {
    test('should be ignored and not loop', () => {
      const line = JSON.stringify({
        type: 'file-history-snapshot',
        timestamp: '2024-01-01T00:00:00Z',
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(0);
    });
  });

  describe('toolUseResult (subagent completion)', () => {
    test('should parse toolUseResult with agentId', () => {
      const line = JSON.stringify({
        uuid: 'f32695c5-7183-412e-857c-fdb946d2a0af',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          agentId: 'a0627b6',
          totalDurationMs: 36628,
          totalTokens: 42215,
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('tool_result');
      expect(results[0]!.formatted).toContain('completed');
      expect(results[0]!.formatted).toContain('agent:a0627b6');
      expect(results[0]!.formatted).toContain('36.6s');
      expect(results[0]!.formatted).toContain('42215 tokens');
    });

    test('should parse toolUseResult without agentId', () => {
      const line = JSON.stringify({
        uuid: 'test-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          totalDurationMs: 1000,
        },
      });

      const results = collectAllParsedLines(parser, line);

      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe('tool_result');
      expect(results[0]!.formatted).toContain('completed');
      expect(results[0]!.formatted).not.toContain('agent:');
    });

    test('should not loop on toolUseResult', () => {
      const line = JSON.stringify({
        uuid: 'test-uuid',
        timestamp: '2024-01-01T00:00:00Z',
        toolUseResult: {
          status: 'completed',
          agentId: 'abc123',
        },
      });

      // Should not throw infinite loop error
      const results = collectAllParsedLines(parser, line);
      expect(results).toHaveLength(1);
    });
  });

  describe('multiple different lines', () => {
    test('should handle different lines correctly', () => {
      const line1 = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { content: 'First message' },
      });
      const line2 = JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:01Z',
        message: { content: 'Second message' },
      });

      const results1 = collectAllParsedLines(parser, line1);
      const results2 = collectAllParsedLines(parser, line2);

      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(1);
    });
  });
});

/**
 * ClaudeSessionFinder.findSubagent 測試
 * 使用臨時目錄模擬 ~/.claude/projects/ 結構
 */
describe('ClaudeSessionFinder.findSubagent', () => {
  let tempDir: string;
  let finder: SessionFinder;

  // 建立臨時目錄結構
  async function setupTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'claude-test-'));
    return dir;
  }

  // 建立模擬的 subagent 檔案
  async function createSubagentFile(
    projectDir: string,
    agentId: string,
    content = '{}'
  ): Promise<string> {
    // 新結構: {projectDir}/{UUID}/subagents/agent-{agentId}.jsonl
    const sessionId = 'test-session-uuid';
    const subagentsDir = join(projectDir, sessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    const filePath = join(subagentsDir, `agent-${agentId}.jsonl`);
    await writeFile(filePath, content);
    return filePath;
  }

  beforeEach(async () => {
    tempDir = await setupTempDir();
    // 建立一個使用臨時目錄的 finder（需要 mock getBaseDir）
    const agent = new ClaudeAgent({ verbose: false });
    finder = agent.finder;
    // 注入臨時目錄作為 baseDir（繞過型別檢查）
    (finder as unknown as { baseDir: string }).baseDir = tempDir;
  });

  afterAll(async () => {
    // 清理臨時目錄
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns null when no subagent files exist', async () => {
    const result = await finder.findSubagent!({});
    expect(result).toBeNull();
  });

  test('returns matching file when subagentId is provided', async () => {
    const projectDir = join(tempDir, 'project1');
    const filePath = await createSubagentFile(projectDir, 'a0627b6');

    const result = await finder.findSubagent!({ subagentId: 'a0627b6' });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(filePath);
    expect(result!.agentType).toBe('claude');
  });

  test('returns null when subagentId not found', async () => {
    const projectDir = join(tempDir, 'project1');
    await createSubagentFile(projectDir, 'a0627b6');

    const result = await finder.findSubagent!({ subagentId: 'notexist' });

    expect(result).toBeNull();
  });

  test('returns latest subagent when no id provided', async () => {
    const projectDir = join(tempDir, 'project1');

    // 建立多個 subagent 檔案
    await createSubagentFile(projectDir, 'a111111');
    // 稍微延遲確保 mtime 不同
    await new Promise((resolve) => setTimeout(resolve, 10));
    const latestPath = await createSubagentFile(projectDir, 'b222222');

    const result = await finder.findSubagent!({});

    expect(result).not.toBeNull();
    // 應該回傳最新的（b222222）
    expect(result!.path).toBe(latestPath);
  });

  test('respects project filter', async () => {
    // 建立兩個專案目錄
    const project1 = join(tempDir, 'myproject');
    const project2 = join(tempDir, 'otherproject');

    await createSubagentFile(project1, 'a111111');
    await createSubagentFile(project2, 'b222222');

    const result = await finder.findSubagent!({ project: 'myproject' });

    expect(result).not.toBeNull();
    expect(result!.path).toContain('myproject');
    expect(result!.path).toContain('a111111');
  });

  test('project filter is case insensitive', async () => {
    const projectDir = join(tempDir, 'MyProject');
    const filePath = await createSubagentFile(projectDir, 'a111111');

    const result = await finder.findSubagent!({ project: 'myproject' });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(filePath);
  });

  test('ignores files with invalid agentId format', async () => {
    const projectDir = join(tempDir, 'project1');

    // 新結構: {projectDir}/{UUID}/subagents/
    const sessionId = 'test-session-uuid';
    const subagentsDir = join(projectDir, sessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    // 建立無效格式的檔案（不是 7 位十六進制）
    await writeFile(join(subagentsDir, 'agent-short.jsonl'), '{}');
    await writeFile(join(subagentsDir, 'agent-toolongid123.jsonl'), '{}');
    await writeFile(join(subagentsDir, 'agent-invalid!.jsonl'), '{}');

    // 建立有效的檔案
    const validPath = await createSubagentFile(projectDir, 'a0627b6');

    const result = await finder.findSubagent!({});

    expect(result).not.toBeNull();
    expect(result!.path).toBe(validPath);
  });
});
