/**
 * TDD RED tests for CodexSessionFinder.findSubagent()
 *
 * Phase 1-Remaining: findSubagent() is NOT YET IMPLEMENTED in CodexSessionFinder.
 * These tests must fail until the implementation is added.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgent } from '../../src/agents/codex/codex-agent.ts';
import type { SessionFinder } from '../../src/agents/agent.interface.ts';

// ============================================================
// Helpers
// ============================================================

type FinderWithSetBaseDir = SessionFinder & {
  setBaseDir: (dir: string) => void;
};

/** 建立 function_call_output 行（帶 agent_id），用於模擬主 session 含 subagent 引用 */
function makeSpawnOutputLine(agentId: string, nickname = 'TestAgent'): string {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-03-07T00:00:00.000Z',
    payload: {
      type: 'function_call_output',
      call_id: `call-${agentId.slice(0, 8)}`,
      output: JSON.stringify({ agent_id: agentId, nickname }),
    },
  });
}

/** 建立 session_meta 第一行 */
function makeSessionMeta(cwd = '/path/to/project'): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-03-07T00:00:00.000Z',
    payload: {
      id: '019cc370-2c35-75b0-a529-2ce5efaffdb8',
      cwd,
      cli_version: '0.104.0',
    },
  });
}

// ============================================================
// Test constants
// ============================================================

const MAIN_UUID = '019cc370-2c35-75b0-a529-2ce5efaffdb8';
const SUBAGENT_UUID = '019cc375-5af5-7ed1-9ff8-8a5757d815d1';
const SUBAGENT_UUID_2 = '019cc376-aaaa-7ed1-9ff8-8a5757d815d1';

const MAIN_FILENAME = `rollout-2026-03-07T00-00-00-${MAIN_UUID}.jsonl`;
const SUBAGENT_FILENAME = `rollout-2026-03-07T00-00-01-${SUBAGENT_UUID}.jsonl`;
const SUBAGENT_FILENAME_2 = `rollout-2026-03-07T00-00-02-${SUBAGENT_UUID_2}.jsonl`;

// ============================================================
// Tests
// ============================================================

describe('CodexSessionFinder.findSubagent', () => {
  let tempDir: string;
  let sessionsDir: string;
  let dateDir: string;
  let finder: FinderWithSetBaseDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-subagent-finder-'));
    sessionsDir = join(tempDir, 'codex', 'sessions');
    dateDir = join(sessionsDir, '2026', '03', '07');
    await mkdir(dateDir, { recursive: true });

    const agent = new CodexAgent({ verbose: false });
    finder = agent.finder as unknown as FinderWithSetBaseDir;
    finder.setBaseDir(sessionsDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ============================================================
  // findSubagent should be implemented (method existence check)
  // ============================================================

  test('findSubagent method should be defined on CodexSessionFinder', () => {
    // RED: CodexSessionFinder does not implement findSubagent yet
    expect((finder as SessionFinder).findSubagent).toBeDefined();
  });

  // ============================================================
  // With subagentId (UUID glob)
  // ============================================================

  describe('有 subagentId', () => {
    test('完整 UUID：精確找到匹配的 subagent 檔案', async () => {
      // 建立主 session（有 subagent 引用）
      await writeFile(
        join(dateDir, MAIN_FILENAME),
        makeSessionMeta() + '\n' + makeSpawnOutputLine(SUBAGENT_UUID) + '\n'
      );
      // 建立 subagent 檔案
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME),
        makeSessionMeta() + '\n'
      );

      const result = await (finder as SessionFinder).findSubagent!({
        subagentId: SUBAGENT_UUID,
      });

      expect(result).not.toBeNull();
      expect(result!.path).toContain(SUBAGENT_UUID);
      expect(result!.agentType).toBe('codex');
    });

    test('部分 UUID（前 8 碼）：前綴匹配也能找到', async () => {
      await writeFile(
        join(dateDir, MAIN_FILENAME),
        makeSessionMeta() + '\n' + makeSpawnOutputLine(SUBAGENT_UUID) + '\n'
      );
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME),
        makeSessionMeta() + '\n'
      );

      // 只給前 8 碼
      const result = await (finder as SessionFinder).findSubagent!({
        subagentId: SUBAGENT_UUID.slice(0, 8),
      });

      expect(result).not.toBeNull();
      expect(result!.path).toContain(SUBAGENT_UUID);
      expect(result!.agentType).toBe('codex');
    });

    test('subagentId 不存在：回傳 null', async () => {
      await writeFile(join(dateDir, MAIN_FILENAME), makeSessionMeta() + '\n');

      const result = await (finder as SessionFinder).findSubagent!({
        subagentId: '00000000-dead-beef-0000-000000000000',
      });

      expect(result).toBeNull();
    });

    test('目錄中多個 rollout 檔案，只回傳匹配 subagentId 的', async () => {
      // 建立主 session 和兩個 subagent 檔案
      await writeFile(join(dateDir, MAIN_FILENAME), makeSessionMeta() + '\n');
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME),
        makeSessionMeta() + '\n'
      );
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME_2),
        makeSessionMeta() + '\n'
      );

      // 只找 SUBAGENT_UUID
      const result = await (finder as SessionFinder).findSubagent!({
        subagentId: SUBAGENT_UUID,
      });

      expect(result).not.toBeNull();
      expect(result!.path).toContain(SUBAGENT_UUID);
      // 不應回傳 SUBAGENT_UUID_2
      expect(result!.path).not.toContain(SUBAGENT_UUID_2);
    });
  });

  // ============================================================
  // Without subagentId (scan main session)
  // ============================================================

  describe('無 subagentId', () => {
    test('最新 session 有 subagent → 回傳最新 subagent 檔案', async () => {
      // 建立主 session（JSONL 含 function_call_output 帶 agent_id）
      await writeFile(
        join(dateDir, MAIN_FILENAME),
        makeSessionMeta() + '\n' + makeSpawnOutputLine(SUBAGENT_UUID) + '\n'
      );
      // 建立對應的 subagent 檔案
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME),
        makeSessionMeta() + '\n'
      );

      const result = await (finder as SessionFinder).findSubagent!({});

      expect(result).not.toBeNull();
      expect(result!.path).toContain(SUBAGENT_UUID);
      expect(result!.agentType).toBe('codex');
    });

    test('最新 session 有多個 subagent → 回傳最新的 subagent 檔案', async () => {
      // 建立主 session（含兩個 subagent 引用）
      await writeFile(
        join(dateDir, MAIN_FILENAME),
        makeSessionMeta() +
          '\n' +
          makeSpawnOutputLine(SUBAGENT_UUID) +
          '\n' +
          makeSpawnOutputLine(SUBAGENT_UUID_2) +
          '\n'
      );
      // 建立兩個 subagent 檔案
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME),
        makeSessionMeta() + '\n'
      );
      await writeFile(
        join(dateDir, SUBAGENT_FILENAME_2),
        makeSessionMeta() + '\n'
      );

      const result = await (finder as SessionFinder).findSubagent!({});

      expect(result).not.toBeNull();
      expect(result!.agentType).toBe('codex');
      // 回傳的應是兩個 subagent 之一
      const isOneOfSubagents =
        result!.path.includes(SUBAGENT_UUID) ||
        result!.path.includes(SUBAGENT_UUID_2);
      expect(isOneOfSubagents).toBe(true);
    });

    test('最新 session 無 subagent → 回傳 null', async () => {
      // 建立主 session（不含任何 agent_id 的 function_call_output）
      await writeFile(join(dateDir, MAIN_FILENAME), makeSessionMeta() + '\n');

      const result = await (finder as SessionFinder).findSubagent!({});

      expect(result).toBeNull();
    });

    test('無任何 session 檔案 → 回傳 null', async () => {
      // 空目錄
      const result = await (finder as SessionFinder).findSubagent!({});
      expect(result).toBeNull();
    });
  });
});
