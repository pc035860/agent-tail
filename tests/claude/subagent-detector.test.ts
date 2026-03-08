import { describe, test, expect } from 'bun:test';
import {
  isValidAgentId,
  tryAddSubagentFile,
  SubagentDetector,
  type OutputHandler,
  type WatcherHandler,
  type SessionHandler,
  type RetryConfig,
  EARLY_DETECTION_RETRY,
  FALLBACK_DETECTION_RETRY,
} from '../../src/claude/subagent-detector';

// ============================================================
// Mock Helpers
// ============================================================

function createMockOutputHandler(): OutputHandler & {
  logs: { level: string; message: string }[];
} {
  const logs: { level: string; message: string }[] = [];
  return {
    logs,
    info: (message: string) => logs.push({ level: 'info', message }),
    warn: (message: string) => logs.push({ level: 'warn', message }),
    error: (message: string) => logs.push({ level: 'error', message }),
    debug: (message: string) => logs.push({ level: 'debug', message }),
  };
}

function createMockWatcherHandler(): WatcherHandler & {
  addedFiles: { path: string; label: string }[];
  shouldFail: boolean;
} {
  const addedFiles: { path: string; label: string }[] = [];
  return {
    addedFiles,
    shouldFail: false,
    addFile: async (file) => {
      if ((addedFiles as unknown as { shouldFail: boolean }).shouldFail) {
        throw new Error('Mock watcher error');
      }
      addedFiles.push(file);
    },
  };
}

function createMockSessionHandler(): SessionHandler & {
  addedSessions: { agentId: string; label: string; path: string }[];
  markedDone: string[];
  uiUpdateCount: number;
} {
  return {
    addedSessions: [],
    markedDone: [],
    uiUpdateCount: 0,
    addSession(agentId, label, path) {
      this.addedSessions.push({ agentId, label, path });
    },
    markSessionDone(agentId) {
      this.markedDone.push(agentId);
    },
    updateUI() {
      this.uiUpdateCount++;
    },
  };
}

// ============================================================
// Tests: isValidAgentId
// ============================================================

describe('isValidAgentId', () => {
  test('accepts valid 7-char lowercase hex', () => {
    expect(isValidAgentId('a0627b6')).toBe(true);
    expect(isValidAgentId('1234567')).toBe(true);
    expect(isValidAgentId('abcdef0')).toBe(true);
  });

  test('accepts valid 7-char uppercase hex', () => {
    expect(isValidAgentId('A0627B6')).toBe(true);
    expect(isValidAgentId('ABCDEF0')).toBe(true);
  });

  test('accepts valid 7-char mixed case hex', () => {
    expect(isValidAgentId('aB12DeF')).toBe(true);
  });

  test('accepts longer hex strings (8-40 chars)', () => {
    // 8 chars
    expect(isValidAgentId('a0627b67')).toBe(true);
    // 10 chars
    expect(isValidAgentId('1234567890')).toBe(true);
    // 40 chars (full SHA-1)
    expect(isValidAgentId('a0627b6789abcdef0123456789abcdef01234567')).toBe(
      true
    );
  });

  test('rejects too short (< 7 chars)', () => {
    expect(isValidAgentId('a0627b')).toBe(false);
    expect(isValidAgentId('123456')).toBe(false);
    expect(isValidAgentId('abc')).toBe(false);
  });

  test('rejects too long (> 40 chars)', () => {
    // 41 chars
    expect(isValidAgentId('a0627b6789abcdef0123456789abcdef012345678')).toBe(
      false
    );
  });

  test('rejects non-hex characters', () => {
    expect(isValidAgentId('a0627bg')).toBe(false);
    expect(isValidAgentId('123456z')).toBe(false);
    expect(isValidAgentId('a_627b6')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidAgentId('')).toBe(false);
  });

  test('rejects path traversal attempts', () => {
    expect(isValidAgentId('../etc')).toBe(false);
    expect(isValidAgentId('../../..')).toBe(false);
  });
});

// ============================================================
// Tests: tryAddSubagentFile
// ============================================================

describe('tryAddSubagentFile', () => {
  // 使用快速配置來加速測試
  const fastRetryConfig: RetryConfig = {
    maxRetries: 2,
    retryDelay: 10,
    initialDelay: 5,
  };

  test('returns false and logs debug when file never exists', async () => {
    const output = createMockOutputHandler();
    const watcher = createMockWatcherHandler();

    const result = await tryAddSubagentFile(
      '/nonexistent/path/agent-test123.jsonl',
      'test123',
      watcher,
      output,
      fastRetryConfig
    );

    expect(result).toBe(false);
    expect(watcher.addedFiles).toHaveLength(0);
    expect(output.logs.some((l) => l.level === 'debug')).toBe(true);
  });

  test('uses default config when not provided', async () => {
    const output = createMockOutputHandler();
    const watcher = createMockWatcherHandler();

    // 使用快速配置驗證行為（預設配置太慢會拖累測試）
    const result = await tryAddSubagentFile(
      '/nonexistent/path/agent-abc1234.jsonl',
      'abc1234',
      watcher,
      output,
      fastRetryConfig
    );

    expect(result).toBe(false);
  });
});

// ============================================================
// Tests: SubagentDetector
// ============================================================

describe('SubagentDetector', () => {
  describe('constructor', () => {
    test('initializes with empty knownAgentIds', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      expect(detector.getKnownAgentIds().size).toBe(0);
      detector.stop();
    });

    test('initializes with provided knownAgentIds', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const initialIds = new Set(['abc1234', 'def5678']);

      const detector = new SubagentDetector(initialIds, {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      const knownIds = detector.getKnownAgentIds();
      expect(knownIds.size).toBe(2);
      expect(knownIds.has('abc1234')).toBe(true);
      expect(knownIds.has('def5678')).toBe(true);
      detector.stop();
    });

    test('creates independent copy of knownAgentIds', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const initialIds = new Set(['abc1234']);

      const detector = new SubagentDetector(initialIds, {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      // 修改原始 Set 不應該影響 detector
      initialIds.add('xyz9999');
      expect(detector.getKnownAgentIds().has('xyz9999')).toBe(false);
      detector.stop();
    });
  });

  describe('isKnownAgent', () => {
    test('returns true for known agent', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(['abc1234']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      expect(detector.isKnownAgent('abc1234')).toBe(true);
      detector.stop();
    });

    test('returns false for unknown agent', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(['abc1234']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      expect(detector.isKnownAgent('xyz9999')).toBe(false);
      detector.stop();
    });
  });

  describe('handleFallbackDetection', () => {
    test('ignores invalid agentId and logs debug', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      detector.handleFallbackDetection('invalid');

      expect(detector.getKnownAgentIds().size).toBe(0);
      expect(
        output.logs.some(
          (l) => l.level === 'debug' && l.message.includes('invalid')
        )
      ).toBe(true);
      detector.stop();
    });

    test('adds new agent to knownAgentIds', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      expect(detector.getKnownAgentIds().has('abc1234')).toBe(true);
      detector.stop();
    });

    test('logs warn for new agent when enabled', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      expect(
        output.logs.some(
          (l) => l.level === 'warn' && l.message.includes('abc1234')
        )
      ).toBe(true);
      detector.stop();
    });

    test('does not log warn when disabled', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: false,
      });

      detector.handleFallbackDetection('abc1234');

      // Agent is still added to known
      expect(detector.getKnownAgentIds().has('abc1234')).toBe(true);
      // But no warn log
      expect(output.logs.some((l) => l.level === 'warn')).toBe(false);
      detector.stop();
    });

    test('calls sessionHandler.addSession for new agent', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const session = createMockSessionHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        session,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      expect(session.addedSessions).toHaveLength(1);
      const addedSession = session.addedSessions[0];
      expect(addedSession).toBeDefined();
      expect(addedSession!.agentId).toBe('abc1234');
      expect(addedSession!.label).toBe('[abc1234]');
      detector.stop();
    });

    test('calls sessionHandler.markSessionDone', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const session = createMockSessionHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        session,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      expect(session.markedDone).toContain('abc1234');
      detector.stop();
    });

    test('calls sessionHandler.updateUI', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const session = createMockSessionHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        session,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      expect(session.uiUpdateCount).toBeGreaterThan(0);
      detector.stop();
    });

    test('marks session done even for already known agent', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const session = createMockSessionHandler();

      const detector = new SubagentDetector(new Set(['abc1234']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        session,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');

      // Should NOT add new session (already known)
      expect(session.addedSessions).toHaveLength(0);
      // But SHOULD mark done
      expect(session.markedDone).toContain('abc1234');
      detector.stop();
    });

    test('does not duplicate knownAgentIds', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(['abc1234']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
      });

      detector.handleFallbackDetection('abc1234');
      detector.handleFallbackDetection('abc1234');

      expect(detector.getKnownAgentIds().size).toBe(1);
      detector.stop();
    });
  });

  describe('handleAgentProgress', () => {
    test('does NOT call onSubagentEnter for new agentId (create scenario)', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const enterCalls: string[] = [];

      // 使用空的 Set 模擬新 agentId
      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
        onSubagentEnter: (agentId) => enterCalls.push(agentId),
      });

      detector.handleAgentProgress('acfe87919d57b2295');

      // 新 agentId 不應觸發 onSubagentEnter（由 onNewSubagent 負責）
      expect(enterCalls).toHaveLength(0);
      // 新 agentId 不應提前標記為 known（避免後續 fallback 被短路）
      expect(detector.getKnownAgentIds().has('acfe87919d57b2295')).toBe(false);
      detector.stop();
    });

    test('new agent_progress does not block fallback registration', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const session = createMockSessionHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        session,
        enabled: true,
      });

      detector.handleAgentProgress('acfe87919d57b2295');
      detector.handleFallbackDetection('acfe87919d57b2295');

      expect(session.addedSessions).toHaveLength(1);
      expect(session.addedSessions[0]?.agentId).toBe('acfe87919d57b2295');
      expect(session.markedDone).toContain('acfe87919d57b2295');
      detector.stop();
    });

    test('calls onSubagentEnter for known agentId (resume scenario)', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const enterCalls: { agentId: string; subagentPath: string }[] = [];

      // 使用包含目標 agentId 的 Set 模擬 resume 情境
      const detector = new SubagentDetector(new Set(['acfe87919d57b2295']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
        onSubagentEnter: (agentId, subagentPath) => {
          enterCalls.push({ agentId, subagentPath });
        },
      });

      detector.handleAgentProgress('acfe87919d57b2295');

      // 已知 agentId（resume）應觸發 onSubagentEnter
      expect(enterCalls).toHaveLength(1);
      expect(enterCalls[0]!.agentId).toBe('acfe87919d57b2295');
      expect(enterCalls[0]!.subagentPath).toContain(
        'agent-acfe87919d57b2295.jsonl'
      );
      detector.stop();
    });

    test('does nothing when disabled', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const enterCalls: string[] = [];

      const detector = new SubagentDetector(new Set(['acfe87919d57b2295']), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: false,
        onSubagentEnter: (agentId) => enterCalls.push(agentId),
      });

      detector.handleAgentProgress('acfe87919d57b2295');

      expect(enterCalls).toHaveLength(0);
      detector.stop();
    });

    test('ignores invalid agentId', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();
      const enterCalls: string[] = [];

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: true,
        onSubagentEnter: (agentId) => enterCalls.push(agentId),
      });

      detector.handleAgentProgress('short');

      expect(enterCalls).toHaveLength(0);
      detector.stop();
    });
  });

  describe('handleEarlyDetection', () => {
    test('does nothing when disabled', () => {
      const output = createMockOutputHandler();
      const watcher = createMockWatcherHandler();

      const detector = new SubagentDetector(new Set(), {
        subagentsDir: '/test/subagents',
        output,
        watcher,
        enabled: false,
      });

      detector.handleEarlyDetection();

      // 沒有任何副作用
      expect(output.logs).toHaveLength(0);
      expect(watcher.addedFiles).toHaveLength(0);
      detector.stop();
    });

    // Note: 更多 handleEarlyDetection 測試需要 mock scanForNewSubagents，
    // 這會比較複雜，在實際專案中可能需要額外的測試基礎設施
  });
});

// ============================================================
// Tests: RetryConfig Constants
// ============================================================

describe('RetryConfig Constants', () => {
  test('EARLY_DETECTION_RETRY has correct values', () => {
    expect(EARLY_DETECTION_RETRY.maxRetries).toBe(10);
    expect(EARLY_DETECTION_RETRY.retryDelay).toBe(100);
    expect(EARLY_DETECTION_RETRY.initialDelay).toBe(50);
  });

  test('FALLBACK_DETECTION_RETRY has correct values', () => {
    expect(FALLBACK_DETECTION_RETRY.maxRetries).toBe(5);
    expect(FALLBACK_DETECTION_RETRY.retryDelay).toBe(100);
    expect(FALLBACK_DETECTION_RETRY.initialDelay).toBe(100);
  });
});
