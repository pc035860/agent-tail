import { describe, test, expect, beforeEach } from 'bun:test';
import { SessionManager } from '../../src/core/session-manager';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  const mockOnOutput = () => {};

  beforeEach(() => {
    sessionManager = new SessionManager({
      onOutput: mockOnOutput,
    });
  });

  describe('addSession - 排序邏輯', () => {
    test('main session 永遠在 index 0', () => {
      // 先加入一般 session
      sessionManager.addSession('agent-1', '[agent-1]', '/path/agent-1.jsonl');
      sessionManager.addSession('agent-2', '[agent-2]', '/path/agent-2.jsonl');

      // 再加入 main session
      sessionManager.addSession('main', '[MAIN]', '/path/main.jsonl');

      const sessions = sessionManager.getAllSessions();
      expect(sessions[0]?.id).toBe('main');
    });

    test('非 main session 插入到 index 1（新的在左邊）', () => {
      // 先加入 main
      sessionManager.addSession('main', '[MAIN]', '/path/main.jsonl');

      // 依序加入 agent
      sessionManager.addSession('agent-1', '[agent-1]', '/path/agent-1.jsonl');
      sessionManager.addSession('agent-2', '[agent-2]', '/path/agent-2.jsonl');
      sessionManager.addSession('agent-3', '[agent-3]', '/path/agent-3.jsonl');

      const sessions = sessionManager.getAllSessions();
      const ids = sessions.map((s) => s.id);

      // 預期順序：main 在最前面，後加入的 agent 在 index 1（最靠近 main）
      expect(ids).toEqual(['main', 'agent-3', 'agent-2', 'agent-1']);
    });

    test('模擬初始化場景：按建立時間升序加入（最舊先加入）', () => {
      // 先加入 main
      sessionManager.addSession('main', '[MAIN]', '/path/main.jsonl');

      // 模擬 index.ts 的初始化邏輯：
      // 檔案按建立時間升序排序後，依序加入
      // 假設建立時間順序為：ab56f31(最舊) -> a4489b8 -> a9bce32 -> a5cfc31 -> a36dd38(最新)
      const sortedByBirthtime = [
        'ab56f31', // 最舊，第一個加入
        'a4489b8',
        'a9bce32',
        'a5cfc31',
        'a36dd38', // 最新，最後加入
      ];

      for (const agentId of sortedByBirthtime) {
        sessionManager.addSession(
          agentId,
          `[${agentId}]`,
          `/path/agent-${agentId}.jsonl`
        );
      }

      const sessions = sessionManager.getAllSessions();
      const ids = sessions.map((s) => s.id);

      // 預期結果：main 在最前，最新的(a36dd38)在 main 旁邊，最舊的(ab56f31)在最右邊
      expect(ids).toEqual([
        'main',
        'a36dd38', // 最新
        'a5cfc31',
        'a9bce32',
        'a4489b8',
        'ab56f31', // 最舊
      ]);
    });

    test('重複加入相同 id 的 session 不會重複', () => {
      sessionManager.addSession('main', '[MAIN]', '/path/main.jsonl');
      sessionManager.addSession('agent-1', '[agent-1]', '/path/agent-1.jsonl');
      sessionManager.addSession('agent-1', '[agent-1]', '/path/agent-1.jsonl'); // 重複

      const sessions = sessionManager.getAllSessions();
      expect(sessions).toHaveLength(2);
    });

    test('沒有 main session 時，一般 session 從 index 0 開始', () => {
      sessionManager.addSession('agent-1', '[agent-1]', '/path/agent-1.jsonl');
      sessionManager.addSession('agent-2', '[agent-2]', '/path/agent-2.jsonl');

      const sessions = sessionManager.getAllSessions();
      const ids = sessions.map((s) => s.id);

      // 沒有 main，新的 session 會插入到 index 0
      expect(ids).toEqual(['agent-2', 'agent-1']);
    });
  });
});
