# Early Subagent Detection 計劃

## 概述

目前 interactive mode 的 subagent 偵測時機太晚，是在收到 `toolUseResult` 時才偵測，此時 subagent 已經完成執行。這導致使用者無法即時看到 subagent 的輸出。

## 目前行為

```
時間軸：
T0        → Assistant 發送 tool_use (Task)
T0+少量   → subagent 檔案 agent-{id}.jsonl 被建立
T0+30秒   → subagent 完成，toolUseResult 被記錄（包含 agentId）
T0+30秒+  → agent-tail 偵測到新 agentId ← 目前偵測點
T0+30秒+100ms → 開始監控 subagent 檔案（但已經結束了）
```

## 目標行為

在 subagent 檔案建立後立即開始監控，讓使用者能即時看到 subagent 的輸出。

## 技術分析

### Claude JSONL 中的相關事件

| 事件 | 出現時機 | 是否包含 agentId |
|------|---------|-----------------|
| `tool_use` (Task) | 最早，發送時 | ❌ 否 |
| subagent 檔案建立 | 中間 | ✅ 可從檔名推斷 |
| `toolUseResult` | 最晚，完成時 | ✅ 是 |

### tool_use 事件結構

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_011sYAkw4L9mVY67FDCsVY1F",
        "name": "Task",
        "input": {
          "subagent_type": "Explore",
          "prompt": "...",
          "description": "...",
          "model": "haiku"
        }
      }
    ]
  }
}
```

### toolUseResult 事件結構

```json
{
  "toolUseResult": {
    "status": "completed",
    "agentId": "a4f0650",
    "totalDurationMs": 28326,
    "totalTokens": 39041,
    "totalToolUseCount": 5
  }
}
```

## 解決方案

### 方案 1：監控 tool_use 事件（推薦）

在 ClaudeLineParser 中偵測 `tool_use` (Task) 事件，立即開始掃描 subagents 目錄。

**優點**：
- 最早偵測點
- 無需等待 subagent 完成

**缺點**：
- `tool_use` 事件中沒有 `agentId`
- 需要透過掃描目錄來找新檔案

**實作步驟**：
1. 在 `parseAssistantMessage` 中檢測 `tool_use` (name === "Task")
2. 產生新事件類型 `task_start`
3. 在 `index.ts` 中監聽此事件
4. 收到事件後立即掃描 subagents 目錄
5. 對新檔案啟動監控

### 方案 2：主動掃描 subagents 目錄

定期掃描 subagents 目錄，發現新檔案時啟動監控。

**優點**：
- 不依賴日誌事件
- 簡單直接

**缺點**：
- I/O 成本（定期掃描）
- 難以區分新舊檔案

### 方案 3：混合方案（最佳）

結合方案 1 和 2：
1. 監聽 `tool_use` (Task) 事件作為觸發
2. 收到觸發後立即掃描 subagents 目錄
3. 保持 `toolUseResult` 作為確認信號

## 實作優先級

| 方案 | 難度 | 延遲 | 推薦度 |
|------|------|------|--------|
| 監控 toolUseResult | 低 | ~30s | ✅ 當前 |
| 監控 tool_use | 中 | ~0s | ⭐ |
| 主動掃描 | 中 | ~1s | 部分 |
| 混合方案 | 高 | ~0.1s | ⭐⭐ |

## 相關檔案

- `src/index.ts` - startClaudeInteractiveWatch, startClaudeMultiWatch
- `src/agents/claude/claude-agent.ts` - ClaudeLineParser
- `src/utils/format-tool.ts` - formatToolUse

---

*建立日期：2026-01-10*
*實作完成：2026-01-10*
*狀態：已完成 ✅*
*實作計劃：specs/early-subagent-detection-plan.md*
