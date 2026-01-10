# Early Subagent Detection Implementation Plan

## Goal

實現 Subagent 早期偵測機制，讓使用者能在 Subagent 啟動後立即看到其輸出，而非等到 Subagent 完成後才開始監控。

**目標行為**：
```
T0        → Assistant 發送 tool_use (Task)
T0+100ms  → agent-tail 偵測到 Task 呼叫，開始掃描 subagents 目錄
T0+少量   → subagent 檔案建立，立即開始監控 ← 新偵測點
T0+30秒   → subagent 完成，toolUseResult 確認
```

## Prerequisites

- [x] `specs/early-subagent-detection.md` - 技術分析文件
- [x] Interactive Mode Phase 1-5 已完成
- [x] 現有 `toolUseResult` 偵測邏輯正常運作

## Solution Approach

採用 **混合方案（方案 3）**：
1. 監聽 `tool_use` (Task) 事件作為觸發信號
2. 收到觸發後立即掃描 `subagents/` 目錄尋找新檔案
3. 保持 `toolUseResult` 作為 Subagent 完成的確認信號

## Steps

### Step 1: 擴展 ParsedLine 類型以支援 Task 事件標記

**檔案**: `src/core/types.ts`

新增 `isTaskToolUse` 欄位到 `ParsedLine` 類型：

```typescript
export interface ParsedLine {
  type: 'text' | 'function_call' | 'tool_result' | 'system' | 'error';
  timestamp: string;
  raw: unknown;
  formatted: string;
  toolName?: string;
  isTaskToolUse?: boolean;  // 新增：標記是否為 Task tool_use
}
```

### Step 2: 修改 ClaudeLineParser 標記 Task tool_use 事件

**檔案**: `src/agents/claude/claude-agent.ts`
**位置**: `processAssistantPart()` 方法，約行 280-290

在處理 `tool_use` 類型時，檢查是否為 Task 並設置標記：

```typescript
if (part.type === 'tool_use' && part.name) {
  return {
    type: 'function_call',
    timestamp,
    raw: part,
    formatted: formatToolUse(part.name, part.input, {
      verbose: this.verbose,
    }),
    toolName: part.name,
    isTaskToolUse: part.name === 'Task',  // 新增此行
  };
}
```

### Step 3: 實作目錄掃描函數

**檔案**: `src/index.ts`
**位置**: 在 `extractAgentIds` 函數附近（約行 140）

新增 `scanForNewSubagents` 函數：

```typescript
/**
 * 掃描 subagents 目錄，找出尚未被監控的新 subagent 檔案
 * @param subagentsDir subagents 目錄路徑
 * @param knownAgentIds 已知的 agentId 集合
 * @returns 新發現的 agentId 陣列
 */
async function scanForNewSubagents(
  subagentsDir: string,
  knownAgentIds: Set<string>
): Promise<string[]> {
  const newAgentIds: string[] = [];

  try {
    // 使用已 import 的 Glob（不是 Bun.Glob）
    const glob = new Glob('agent-*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir })) {
      // 從檔名 "agent-{id}.jsonl" 提取 id
      const match = file.match(/^agent-([0-9a-f]{7})\.jsonl$/i);
      if (match) {
        const agentId = match[1];
        if (!knownAgentIds.has(agentId)) {
          newAgentIds.push(agentId);
        }
      }
    }
  } catch {
    // 目錄不存在或無法存取時靜默忽略
    // 這是預期行為：subagent 可能尚未建立目錄
  }

  return newAgentIds;
}
```

### Step 4: 在 Multi-Watch 模式整合早期偵測

**檔案**: `src/index.ts`
**位置**: `startClaudeMultiWatch` 函數內，`onLine` callback（約行 195-210）

在處理 parsed line 後，檢查 `isTaskToolUse` 並觸發掃描：

```typescript
// 現有的 console.log(output) 之後，新增：

// 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
if (label === '[MAIN]' && parsed.isTaskToolUse && options.follow) {
  // 延遲一小段時間讓檔案有機會建立
  setTimeout(async () => {
    const newAgentIds = await scanForNewSubagents(subagentsDir, knownAgentIds);

    for (const agentId of newAgentIds) {
      knownAgentIds.add(agentId);

      const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
      const newFile: WatchedFile = {
        path: subagentPath,
        label: `[${agentId}]`,
      };

      console.log(chalk.yellow(`Early subagent detected: ${agentId}`));

      // 重試邏輯（與現有邏輯相同）
      const tryAddSubagent = async (retries = 10): Promise<void> => {
        try {
          const subagentFile = Bun.file(subagentPath);
          if (await subagentFile.exists()) {
            await multiWatcher.addFile(newFile);
          } else if (retries > 0) {
            setTimeout(() => tryAddSubagent(retries - 1), 100);
          }
        } catch (error) {
          console.error(chalk.red(`Failed to add subagent: ${error}`));
        }
      };

      tryAddSubagent();
    }
  }, 50);  // 50ms 延遲
}
```

### Step 5: 在 Interactive 模式整合早期偵測

**檔案**: `src/index.ts`
**位置**: `startClaudeInteractiveWatch` 函數內，`onLine` callback（約行 420-450）

相同的邏輯，但整合 SessionManager：

```typescript
// 在現有的 displayController.write(output) 之後，新增：

// 早期 Subagent 偵測
if (label === '[MAIN]' && parsed.isTaskToolUse) {
  setTimeout(async () => {
    const newAgentIds = await scanForNewSubagents(subagentsDir, knownAgentIds);

    for (const agentId of newAgentIds) {
      if (knownAgentIds.has(agentId)) continue;
      knownAgentIds.add(agentId);

      const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);

      // 新增到 SessionManager
      sessionManager.addSession(agentId, `[${agentId}]`, subagentPath);
      displayController.write(chalk.yellow(`Early subagent detected: ${agentId}`));

      // 重試邏輯
      const tryAddSubagent = async (retries = 10): Promise<void> => {
        try {
          const subagentFile = Bun.file(subagentPath);
          if (await subagentFile.exists()) {
            const newFile: WatchedFile = {
              path: subagentPath,
              label: `[${agentId}]`,
            };
            await multiWatcher.addFile(newFile, (line, lbl) => {
              handleSubagentLine(line, lbl, agentId);
            });
          } else if (retries > 0) {
            setTimeout(() => tryAddSubagent(retries - 1), 100);
          }
        } catch (error) {
          displayController.write(chalk.red(`Failed to add subagent: ${error}`));
        }
      };

      tryAddSubagent();
    }
  }, 50);
}
```

### Step 6: 保留現有 toolUseResult 偵測作為備援

**不需修改**：現有的 `toolUseResult` 偵測邏輯應保留，作為：
1. 標記 Subagent 完成狀態
2. 備援偵測（萬一早期偵測失敗）

現有邏輯位置：
- Multi-Watch: `src/index.ts:208-261`
- Interactive: `src/index.ts:469-530`

## Verification

### 測試場景 1: 早期偵測生效
```bash
# 終端 1: 啟動 agent-tail
bun run src/index.ts claude -i

# 終端 2: 觸發 Claude Code 使用 Task tool
# 預期：看到 "Early subagent detected: {id}" 訊息
# 預期：Subagent 輸出即時顯示（而非等到完成）
```

### 測試場景 2: 備援機制運作
```bash
# 模擬早期偵測失敗（如目錄掃描延遲）
# 預期：toolUseResult 偵測仍能正常捕捉 Subagent
```

### 驗證清單
- [x] Task tool_use 事件被正確標記 (`isTaskToolUse: true`)
- [x] 目錄掃描能正確找出新的 subagent 檔案
- [x] Multi-Watch 模式下早期偵測正常運作
- [x] Interactive 模式下早期偵測正常運作
- [x] 現有 toolUseResult 偵測仍正常運作（備援）
- [x] 不會重複監控同一個 subagent
- [x] 所有單元測試通過 (133 pass)

## Unit Tests

### 測試檔案：`tests/agents/claude-agent.test.ts`

在現有測試檔案中新增以下測試案例：

#### 1. Task tool_use 的 `isTaskToolUse` 標記

```typescript
describe('Task tool_use detection', () => {
  test('Task tool_use should have isTaskToolUse: true', () => {
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
              subagent_type: 'Explore',
              prompt: 'Search for files',
              description: 'Find files',
            },
          },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('function_call');
    expect(results[0]!.toolName).toBe('Task');
    expect(results[0]!.isTaskToolUse).toBe(true);
  });

  test('non-Task tool_use should not have isTaskToolUse: true', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(1);
    expect(results[0]!.toolName).toBe('Bash');
    expect(results[0]!.isTaskToolUse).toBeFalsy(); // undefined or false
  });

  test('mixed content with Task should mark only Task', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        model: 'claude-sonnet-4-20250514',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } },
          { type: 'tool_use', name: 'Task', input: { prompt: 'test' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo' } },
        ],
      },
    });

    const results = collectAllParsedLines(parser, line);

    expect(results).toHaveLength(3);
    expect(results[0]!.isTaskToolUse).toBeFalsy();
    expect(results[1]!.isTaskToolUse).toBe(true);
    expect(results[2]!.isTaskToolUse).toBeFalsy();
  });
});
```

### 測試檔案：`tests/index.test.ts`（新建）

建立新的測試檔案測試 `scanForNewSubagents` 函數：

```typescript
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 需要從 index.ts export scanForNewSubagents 函數
// 或將其移到獨立的 utils 模組

describe('scanForNewSubagents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'subagent-test-'));
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should find new subagent files', async () => {
    // 建立 subagent 檔案
    await writeFile(join(tempDir, 'agent-a111111.jsonl'), '{}');
    await writeFile(join(tempDir, 'agent-b222222.jsonl'), '{}');

    const knownAgentIds = new Set<string>();
    const newIds = await scanForNewSubagents(tempDir, knownAgentIds);

    expect(newIds).toHaveLength(2);
    expect(newIds).toContain('a111111');
    expect(newIds).toContain('b222222');
  });

  test('should exclude known agentIds', async () => {
    await writeFile(join(tempDir, 'agent-a111111.jsonl'), '{}');
    await writeFile(join(tempDir, 'agent-b222222.jsonl'), '{}');

    const knownAgentIds = new Set(['a111111']);
    const newIds = await scanForNewSubagents(tempDir, knownAgentIds);

    expect(newIds).toHaveLength(1);
    expect(newIds).toContain('b222222');
    expect(newIds).not.toContain('a111111');
  });

  test('should ignore invalid filename formats', async () => {
    // 有效格式
    await writeFile(join(tempDir, 'agent-a111111.jsonl'), '{}');
    // 無效格式
    await writeFile(join(tempDir, 'agent-short.jsonl'), '{}');
    await writeFile(join(tempDir, 'agent-toolongid123.jsonl'), '{}');
    await writeFile(join(tempDir, 'not-agent-file.jsonl'), '{}');
    await writeFile(join(tempDir, 'agent-INVALID!.jsonl'), '{}');

    const knownAgentIds = new Set<string>();
    const newIds = await scanForNewSubagents(tempDir, knownAgentIds);

    expect(newIds).toHaveLength(1);
    expect(newIds).toContain('a111111');
  });

  test('should return empty array when directory does not exist', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    const knownAgentIds = new Set<string>();

    const newIds = await scanForNewSubagents(nonExistentDir, knownAgentIds);

    expect(newIds).toHaveLength(0);
  });

  test('should return empty array when directory is empty', async () => {
    const knownAgentIds = new Set<string>();
    const newIds = await scanForNewSubagents(tempDir, knownAgentIds);

    expect(newIds).toHaveLength(0);
  });
});
```

### 測試執行

```bash
# 執行所有測試
bun test

# 僅執行新增的測試
bun test tests/agents/claude-agent.test.ts
bun test tests/index.test.ts
```

### 測試覆蓋重點

| 測試案例 | 覆蓋功能 | 優先級 |
|----------|----------|--------|
| Task tool_use 標記 | `isTaskToolUse: true` | ⭐⭐⭐ |
| 非 Task tool_use | `isTaskToolUse: false/undefined` | ⭐⭐⭐ |
| 混合 content 中的 Task | 正確識別多個 tool_use | ⭐⭐ |
| 找出新 subagent | `scanForNewSubagents` 基本功能 | ⭐⭐⭐ |
| 排除已知 agentId | 防止重複監控 | ⭐⭐⭐ |
| 忽略無效檔名 | 格式驗證 | ⭐⭐ |
| 目錄不存在 | 錯誤處理 | ⭐⭐ |

### 實作注意事項

1. **函數 export**：`scanForNewSubagents` 需要從 `index.ts` export 或移到獨立模組才能測試
2. **推薦做法**：將 `scanForNewSubagents` 移到 `src/utils/subagent-scanner.ts`，方便測試和重用
3. **測試順序**：先實作 Step 1-3，再執行單元測試驗證

## Related Files

| 檔案 | 變更類型 | 說明 |
|------|----------|------|
| `src/core/types.ts` | 修改 | 新增 `isTaskToolUse` 欄位 |
| `src/agents/claude/claude-agent.ts` | 修改 | 標記 Task tool_use |
| `src/index.ts` | 修改 | 新增掃描函數、整合早期偵測邏輯 |
| `tests/agents/claude-agent.test.ts` | 修改 | 新增 Task tool_use 測試案例 |
| `tests/index.test.ts` | 新增 | scanForNewSubagents 單元測試 |

## Edge Cases

### 1. 目錄掃描時機

**情境**：Tool_use 事件後 50ms 內，subagent 檔案可能尚未建立

**處理策略**：
- 初始掃描使用 50ms 延遲，給予檔案建立時間
- 若掃描未發現新檔案，依賴後續的 `toolUseResult` 備援機制
- 無需額外的掃描重試（避免過度 I/O）

### 2. 多個 Task 併發

**情境**：主 session 連續發送多個 Task tool_use

**保護機制**：
- `knownAgentIds.has(agentId)` 檢查防止重複添加
- 多個 `setTimeout` 可安全併發執行
- 現有邏輯已涵蓋此情境，無需額外處理

### 3. Session/Watcher 同步失敗

**情境**：`sessionManager.addSession()` 成功但 `multiWatcher.addFile()` 失敗

**處理策略**：
- Interactive 模式下，SessionManager 會保留該 session
- 使用者可透過鍵盤切換到該 session（即使無即時輸出）
- `toolUseResult` 備援機制會在 subagent 完成時再次嘗試添加監控

### 4. 檔案寫入中的競態條件

**情境**：監控建立時檔案正在寫入（部分內容）

**保護機制**：
- FileWatcher 使用 `tail -f` 模式，自動處理增量內容
- JSONL 格式的逐行解析天然支援部分內容
- 無效的 JSON 行會被靜默忽略

## Notes

1. **延遲時間調整**：50ms 延遲是初始值，可能需要根據實際測試調整
2. **重試次數**：從 5 次增加到 10 次，給予更多時間讓檔案建立（10 × 100ms = 1 秒）
3. **效能考量**：目錄掃描使用已 import 的 `Glob` 類別，效能良好且非阻塞
4. **向後兼容**：不影響現有的 toolUseResult 偵測機制
5. **雙重保護**：早期偵測 + toolUseResult 備援確保不遺漏任何 subagent

---

*建立日期：2026-01-10*
*實作完成：2026-01-10*
*基於：specs/early-subagent-detection.md*
*狀態：已完成 ✅*
