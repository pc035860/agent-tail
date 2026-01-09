# Code Quality Improvements

## 概述

在實作 Early Subagent Detection 功能時，Code Quality Validation Agent 發現了一些可改進的地方。這些是非阻塞的優化建議，不影響功能正確性。

## 待改進項目

### 1. 重複邏輯提取

**優先級**: 🟡 中

**問題描述**:
Multi-Watch 和 Interactive 模式有高度相似的偵測邏輯，出現在 4 處位置：

| 位置 | 函式 | 行數範圍 | 功能 |
|------|------|----------|------|
| A | startClaudeMultiWatch | ~242-284 | Early subagent 偵測 |
| B | startClaudeMultiWatch | ~286-339 | 備援機制偵測 (toolUseResult) |
| C | startClaudeInteractiveWatch | ~547-590 | Early subagent 偵測 |
| D | startClaudeInteractiveWatch | ~592-653 | 備援機制偵測 (toolUseResult) |

**重複的邏輯**:
- `scanForNewSubagents()` 或 `toolUseResult.agentId` 檢查
- `isValidAgentId()` 驗證
- `knownAgentIds` 去重檢查
- 嵌套的 `tryAddSubagent()` 重試邏輯

**建議方案**:

```typescript
// 提取為獨立函式
interface SubagentDetectionContext {
  subagentsDir: string;
  knownAgentIds: Set<string>;
  multiWatcher: MultiFileWatcher;
  onDetected: (agentId: string, path: string) => void;
  onError: (error: unknown) => void;
}

async function detectAndAddSubagent(
  agentId: string,
  ctx: SubagentDetectionContext,
  retries: number = 10
): Promise<void>

async function handleEarlyDetection(
  subagentsDir: string,
  knownAgentIds: Set<string>,
  ctx: SubagentDetectionContext
): Promise<void>
```

**預期效益**:
- 減少約 100 行重複代碼
- 統一錯誤處理
- 更容易測試和維護

---

### 2. 錯誤處理不一致

**優先級**: 🟡 中

**問題描述**:
錯誤處理方式不統一，部分使用 `console.error`，部分使用 `console.log`：

| 位置 | 方法 | 顏色 | 訊息格式 |
|------|------|------|----------|
| L275-278 (Multi-Watch early) | `console.error` | 紅色 | `Failed to add early subagent: ${error}` |
| L324-330 (Multi-Watch fallback) | `console.log` | 灰色 | `Failed to add subagent watcher: ${id} - ${error}` |
| L580-584 (Interactive early) | `displayController.write` | 紅色 | `Failed to add early subagent: ${error}` |

**建議方案**:

1. 定義錯誤嚴重程度：
   - **Error**（紅色）：影響功能的錯誤
   - **Warning**（黃色）：可恢復的問題
   - **Info**（灰色）：提示性訊息

2. 統一輸出方式：
   - Multi-Watch 模式：使用 `console.log` + chalk
   - Interactive 模式：使用 `displayController.write`

3. 統一訊息格式：
   ```typescript
   // 錯誤
   chalk.red(`[ERROR] Failed to add subagent ${agentId}: ${error}`)

   // 警告（如重試失敗但有備援）
   chalk.yellow(`[WARN] Subagent file not found after retries: ${agentId}`)

   // 資訊
   chalk.gray(`[INFO] Subagent completed: ${agentId}`)
   ```

---

## 相關檔案

- `src/index.ts` - 主要需要重構的檔案

## 實作建議

1. 先處理「重複邏輯提取」，這會自然解決部分「錯誤處理不一致」的問題
2. 可以在後續的 refactor session 中處理
3. 建議搭配單元測試一起重構

---

*建立日期：2026-01-10*
*來源：Early Subagent Detection 實作過程中的 Code Quality Validation*
*狀態：待處理*
