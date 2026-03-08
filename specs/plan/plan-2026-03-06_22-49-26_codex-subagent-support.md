# Codex Subagent 顯示支援

## Context

Codex CLI 最近支援 subagent（`spawn_agent`），但 agent-tail 目前只支援 Claude 的 subagent 偵測與顯示。需要為 Codex 加入完整的 subagent 支援：`--with-subagents`、`--pane`、`--interactive`。

Codex subagent 與 Claude 有三個根本差異：
1. **扁平目錄**：subagent session 和主 session 在同一個日期目錄（非巢狀 `subagents/`）
2. **偵測機制**：`spawn_agent` function_call + `function_call_output`（需 call_id 追蹤）
3. **ID 格式**：UUID（`019cc375-5af5-7ed1-9ff8-8a5757d815d1`），非 7-40 hex

**已驗證的格式假設**：
- `agent_id` = 檔名中的 UUID。例：`agent_id: "019cc375-5af5-..."` → `rollout-2026-03-06T22-02-54-019cc375-5af5-...jsonl`
- `subagent_notification` 格式：`{type:"response_item", payload:{type:"message", role:"user", content:[{type:"input_text", text:"<subagent_notification>{\"agent_id\":\"...\",\"status\":{\"completed\":\"...\"}}</subagent_notification>"}]}}`
- `wait` output 含 `{status: {[agent_id]: {completed: "..."}}}` 也可偵測完成

## 實作方案

### Phase 0: 介面提取（前置重構）

**問題**：`OutputHandler`、`SessionHandler`、`WatcherHandler`、`RetryConfig` 定義在 `src/claude/subagent-detector.ts` 中，讓 Codex 模組依賴 Claude 模組語義不合理。

**動作**：新建 `src/core/detector-interfaces.ts`，將這 4 個介面搬移過去。Claude 和 Codex 都從 core 引入。

- 新建 `src/core/detector-interfaces.ts` — 介面定義
- 修改 `src/claude/subagent-detector.ts` — 改為從 core re-export
- 修改 `src/claude/output-handlers.ts` — import 路徑更新
- 修改 `src/claude/session-handlers.ts` — import 路徑更新

同時將 `MAIN_LABEL`、`makeAgentLabel` 等通用 label 工具搬到 `src/core/detector-interfaces.ts` 或保持在 claude 並讓 codex 定義自己的版本。

### Phase 1: 核心偵測 + `--with-subagents`

#### 1.1 新建 `src/codex/subagent-detector.ts`

獨立的 `CodexSubagentDetector`，從 `src/core/detector-interfaces.ts` 引入介面。

**偵測流程（Phase 1 只做 spawn + completion）**：
```
spawn_agent function_call (call_id, agent_type, message)
  → 記錄 pendingSpawns Map<callId, {agentType, message, timestamp}>
function_call_output (call_id, output: {agent_id, nickname})
  → 匹配 pendingSpawns，取得 agent_id
  → glob rollout-*-{uuid}.jsonl 找檔案（含重試）
  → registerNewAgent(agentId, path, description)
  → 觸發 onNewSubagent 回呼
subagent_notification / wait output (含 agent_id + completed)
  → 觸發 onSubagentDone 回呼
```

**Phase 2 再加**：`resume_agent` / `send_input` → `onSubagentEnter` 回呼

**關鍵方法**：
- `handleSpawnAgent(callId, agentType, message)` - 記錄 pending
- `handleSpawnAgentOutput(callId, output)` - 匹配並註冊新 subagent
- `handleSubagentDone(agentId)` - 完成通知
- `stop()` - 清理 timers、pending spawns（含 TTL timers）

**UUID 驗證**：`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`

**檔案發現**：`agent_id` 就是檔名中的 UUID（已驗證）。用 `Bun.Glob` 在日期目錄搜 `rollout-*-${agentId}.jsonl`。日期目錄 = `dirname(mainSessionPath)`。找不到時重試（100ms interval, max 10 retries），因為檔案可能尚未建立。

**不使用目錄監控**：與 Claude 不同，Codex 的日期目錄混合了其他使用者的主 session，無法用 `fs.watch` 過濾。偵測完全靠 event-driven（解析主 session JSONL）+ glob 重試。

**pendingSpawns TTL**：每個 entry 用 `setTimeout(60s)` 自動移除，所有 timers 在 `stop()` 清除。

**Label 格式**：`[MAIN]` 和 `[{uuid前13碼}]`（取 UUID 前兩段如 `019cc375-5af5`，避免同秒碰撞）。維護 shortId → fullId 映射表。

#### 1.2 新建 `src/codex/watch-builder.ts`

**從零實作** `createCodexOnLineHandler`（不包裝 Claude 的 `createOnLineHandler`，因為偵測邏輯完全不同）。

**偵測的 JSON 路徑**：
- spawn_agent：`data.type === 'response_item' && data.payload.type === 'function_call' && data.payload.name === 'spawn_agent'` → 取 `payload.call_id`、parse `payload.arguments` 取 `agent_type`、`message`
- function_call_output：`data.type === 'response_item' && data.payload.type === 'function_call_output'` → 取 `payload.call_id`、parse `payload.output` 取 `agent_id`、`nickname`
- subagent_notification：`data.type === 'response_item' && data.payload.type === 'message' && data.payload.role === 'user'` → 檢查 content text 是否含 `<subagent_notification>`，解析 XML 內的 JSON 取 `agent_id` + `status.completed`
- wait output（備用）：`function_call_output` 且 `call_id` 對應的 function_call name 為 `wait` → parse output 取 `status.{agent_id}.completed`

**快速字串前篩**（只對 MAIN label 的行）：
```typescript
if (label === MAIN_LABEL) {
  if (line.includes('"spawn_agent"')) { /* parse spawn */ }
  if (line.includes('"function_call_output"')) { /* parse output */ }
  if (line.includes('<subagent_notification>')) { /* parse notification */ }
}
```

**其他函式**：
- `buildCodexSubagentFiles(sessionDateDir, agentIds)` - 根據已知 UUID glob 找檔案
- `extractCodexSubagentIds(sessionPath)` - 掃描主 session 提取所有 `function_call_output` 中含 `agent_id` 的 output
- `readLastCodexAssistantMessage(filePath, verbose)` - 從尾部找 `response_item` + `payload.type === 'message'` + `payload.role === 'assistant'`

#### 1.3 修改 `src/cli/parser.ts`

放寬限制從 `claude` only → `claude | codex`：
- L89-95: `--subagent`
- L97-103: `--all`
- L119-125: `--interactive`
- L143-149: `--pane`
- L180-186: `--with-subagents`

更新錯誤訊息和 option description（移除 "Claude only"，改為 "Claude/Codex"）。

#### 1.4 修改 `src/core/types.ts`

更新 `CliOptions` 欄位的 JSDoc 註解（"Claude only" → "Claude/Codex"）。

#### 1.5 修改 `src/agents/codex/codex-agent.ts`

新增 `CodexSessionFinder.findSubagent()` 方法：
- 有 subagentId：glob `rollout-*-{subagentId}.jsonl`
- 無 subagentId：掃描最新的、session_meta 含 `source.subagent` 的檔案

#### 1.6 修改 `src/index.ts`

**路由修改**（main 函式，約 L205）：
```typescript
if (options.agentType === 'claude' && options.subagent === undefined) {
  // Claude multi-watch（不變）
} else if (options.agentType === 'codex' && options.subagent === undefined &&
           (options.withSubagents || options.interactive || options.pane)) {
  // Codex multi-watch（新增）
  if (options.interactive) {
    await startCodexInteractiveWatch(sessionFile, formatter, options);
  } else {
    await startCodexMultiWatch(sessionFile, formatter, options);
  }
} else {
  // 單檔案監控（不變）
}
```

**同時修改 `--subagent` 路由**（L135-163）：擴展 codex 也能走 `findSubagent` 路徑。

新增 `startCodexMultiWatch()` 函式：
1. `dirname(sessionPath)` → 日期目錄
2. `extractCodexSubagentIds()` → 已有 subagent
3. `buildCodexSubagentFiles()` → 初始檔案列表
4. `CodexSubagentDetector` + `MultiFileWatcher`
5. `createCodexOnLineHandler()` 處理每行
6. 複用 `createSuperFollowController()`（注入 `finder.findLatestInProject`）

### Phase 2: `--pane` + resume 偵測

#### 2.1 `CodexSubagentDetector` 新增 resume 支援

新增方法：
- `handleSubagentResume(agentId)` - 解析 `resume_agent` / `send_input`
- 若已知 agentId → 觸發 `onSubagentEnter` 回呼

`createCodexOnLineHandler` 新增前篩：
```typescript
if (line.includes('"resume_agent"')) { /* parse resume */ }
if (line.includes('"send_input"')) { /* parse send_input */ }
```

#### 2.2 PaneManager 整合

在 `startCodexMultiWatch()` 中整合（完全複用現有 `PaneManager`）：
- commandBuilder：`codex --subagent ${agentId} -q --no-pane`
- description：`agent_type` + `nickname`（如 `code-auditor: Kant`）
- `openPaneForSubagent`、`onSubagentDone`、`shouldOutput` 回呼
- `readLastCodexAssistantMessage` 在 pane 關閉前輸出最終結果

### Phase 3: `--interactive` 互動模式

新增 `startCodexInteractiveWatch()` 函式，仿照 `startClaudeInteractiveWatch()`：
- 複用 `DisplayController` + `SessionManager`
- 複用 `DisplayControllerOutputHandler` + `InteractiveSessionHandler`（從 core/claude import）
- Parser 使用 `CodexAgent`（無狀態，切換 session 不需重建）
- TTY 檢查 + 降級到 `startCodexMultiWatch`

## 複用的現有元件

| 元件 | 路徑 | 用途 |
|------|------|------|
| `OutputHandler` 等介面 | `src/core/detector-interfaces.ts`（Phase 0 新建） | 共用介面 |
| `ConsoleOutputHandler`, `DisplayControllerOutputHandler` | `src/claude/output-handlers.ts` | 輸出實作 |
| `InteractiveSessionHandler`, `NoOpSessionHandler` | `src/claude/session-handlers.ts` | Session 管理 |
| `MultiFileWatcher` | `src/core/multi-file-watcher.ts` | 多檔案監控 |
| `PaneManager` | `src/terminal/pane-manager.ts` | Pane 生命週期 |
| `createTerminalController` | `src/terminal/controller-factory.ts` | 終端偵測 |
| `createSuperFollowController` | `src/claude/watch-builder.ts` | Auto-switch（通用，接受 DI） |
| `DisplayController` | `src/interactive/display-controller.ts` | Interactive UI |
| `SessionManager` | `src/core/session-manager.ts` | Session 切換 |

## 要修改的檔案

| 檔案 | 動作 | Phase | 狀態 |
|------|------|-------|------|
| `src/core/detector-interfaces.ts` | 新建 | 0 | ✅ 完成 (27b305c) |
| `src/claude/subagent-detector.ts` | 修改（re-export 介面） | 0 | ✅ 完成 (27b305c) |
| `src/claude/output-handlers.ts` | 修改（import 路徑） | 0 | ✅ 完成 (27b305c) |
| `src/claude/session-handlers.ts` | 修改（import 路徑） | 0 | ✅ 完成 (27b305c) |
| `src/codex/subagent-detector.ts` | 新建 | 1 | ✅ 完成 (1580923) |
| `src/codex/watch-builder.ts` | 新建 | 1 | ✅ 完成 (1580923) |
| `src/cli/parser.ts` | 修改（放寬 codex 選項） | 1 | ✅ 完成 (bdcaaea) |
| `src/core/types.ts` | 修改（JSDoc 更新） | 1 | ✅ 完成 |
| `src/agents/codex/codex-agent.ts` | 修改（findSubagent） | 1 | ✅ 完成 |
| `src/index.ts` | 修改（路由 + startCodexMultiWatch + startCodexInteractiveWatch） | 1-3 | ✅ 完成 |
| `tests/codex/subagent-detector.test.ts` | 新建 | 1 | ✅ 完成 (0da60fe) |
| `tests/codex/watch-builder.test.ts` | 新建 | 1 | ✅ 完成 (0da60fe) |
| `tests/cli/parser.test.ts` | 修改 | 1 | ✅ 完成 (bdcaaea) |

### Phase 0 完成記錄（2026-03-06）

- 356 個測試全部通過，typecheck 乾淨
- 介面提取完成，Claude 模組向後相容

### Phase 1 完成記錄（2026-03-06）

- 核心偵測模組（subagent-detector、watch-builder）完成並通過 Gemini review
- CLI parser 放寬 codex 的 `--with-subagents`、`--subagent`、`--all` 選項
- 356 個測試全部通過，typecheck 乾淨

### Phase 2 完成記錄（2026-03-07）

- `CodexSubagentDetector` 新增 `handleSubagentResume`、`getAgentPath`、`registerExistingAgent` 方法
- `createCodexOnLineHandler` 新增 `resume_agent`/`send_input` 事件偵測
- `readLastCodexAssistantMessage(filePath, parser)` 實作
- `startCodexMultiWatch` 整合 PaneManager（`--pane codex` 支援）
- `stopped` guard 防止 in-flight `_resolveSubagent` 在 session 切換後繼續注入
- 384 個測試通過，typecheck + lint 乾淨

### Phase 3 完成記錄（2026-03-07）

- `startCodexInteractiveWatch()` 實作：共用 `DisplayController` + `SessionManager`
- Codex parser 無狀態 → 所有 session 共用 `sharedParser`（不同於 Claude 每 session 獨立）
- `detectionHandler` 作為 `let` 變數，`buildInteractiveState` 結尾更新，確保 session 切換後指向新 detector
- `registerExistingAgent` 在 `buildInteractiveState` 中預填既有 subagent 路徑
- Refactor：提取 `createInteractiveSessionManager(displayController)` 共用 helper，消除 Claude/Codex 35 行重複定義
- Code review：Codex MCP review loop 通過（2 輪 blocking issue 修正，最終無 blocking）
- 384 個測試通過，typecheck + lint 乾淨

## Known Limitations

- **跨日期 subagent**：初期只掃主 session 所在日期目錄。跨午夜產生的 subagent 會找不到。未來可掃描「今天+昨天」兩個目錄。
- **扁平目錄不使用 fs.watch**：偵測完全靠 event-driven，沒有 directory watch 作為 safety net。若主 session JSONL 漏行（理論上不會），可能漏掉 subagent。
- **`--no-follow --with-subagents` 的時間排序**：需確認 `outputTimeSorted` 對 Codex parser 兼容（Codex parser 無狀態，應無問題）。

## 驗證方式

1. `bun test` - 所有測試通過
2. `bun run typecheck` - 型別檢查通過
3. `bun run lint` - ESLint 通過
4. 手動測試（用已知的 session 檔案）：
   - `bun run src/index.ts codex --with-subagents` - 主 session + subagent 內容合併顯示
   - `bun run src/index.ts codex --with-subagents --no-follow` - 靜態輸出所有內容
   - `bun run src/index.ts codex --subagent 019cc375-5af5` - 只看特定 subagent
   - `bun run src/index.ts codex --pane` - tmux pane 自動開啟/關閉
   - `bun run src/index.ts codex -i` - Tab 切換 session
   - 測試 session：主=`rollout-...-019cc370-2c35-75b0-a529-2ce5efaffdb8.jsonl`，subagent=`rollout-...-019cc375-5af5-7ed1-9ff8-8a5757d815d1.jsonl`
