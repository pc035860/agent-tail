# Cursor Agent Roadmap

> 生成日期：2026-03-25
> 背景：MVP（Phase 1）已完成並合併，支援基本 tailing、project filter、auto-switch、session ID 查找

---

## 現狀（Phase 1 MVP - Done）

- `agent-tail cursor` 基本 tailing
- `--raw`, `-v`, `-q`, `-n`, `-s`, `--no-follow`
- `-p` project filter（fuzzy match workspace slug + .workspace-trusted）
- `--auto-switch`（workspace-based super follow）
- `[session-id]` UUID 部分匹配
- 無狀態 parser，自動剝離 `<user_query>` / `<attached_files>` 標籤

### 已知限制

- **無 timestamp**：Cursor JSONL 不含時間戳，顯示 `[--:--:--]`
- **Workspace slug 不可逆**：`-` 在 slug 中有歧義（路徑分隔/連字號/底線），只有 `.workspace-trusted` 有正確對應但僅 ~10% 的目錄有此檔案

---

## Phase 2：Subagent 支援 ✅ Done

> 完成日期：2026-03-25

Cursor JSONL **沒有** subagent spawn/resume 事件，偵測策略為**純目錄監控**（`CursorSubagentDetector`）。Subagent JSONL 格式與主 session 相同，共用無狀態 parser。

### 實作內容

| 功能 | 說明 | 檔案 |
|------|------|------|
| `--subagent [id]` | 追蹤指定 subagent（UUID 部分匹配） | `src/agents/cursor/cursor-agent.ts` (`findSubagent`) |
| `--with-subagents` | 主 session + subagent 一起輸出 | `src/index.ts` (`startCursorMultiWatch`) |
| `--pane` | 自動開 tmux pane（FIFO eviction） | `src/index.ts` + `src/terminal/pane-manager.ts` |
| `-a` / `--all` | verbose + with-subagents + auto-switch | `src/cli/parser.ts` |
| 目錄監控偵測 | `CursorSubagentDetector`（純 fs.watch + parent fallback） | `src/cursor/subagent-detector.ts` |
| Watch builder 工具 | `getCursorSubagentsDir`, `scanCursorSubagents`, etc. | `src/cursor/watch-builder.ts` |

### 已釐清問題

- [x] Cursor 主 session JSONL **沒有** subagent spawn/resume 事件 → 純目錄監控
- [x] Subagent JSONL 格式與主 session **相同** → 共用 parser
- [x] **沒有** resume 事件 → pane 無法自動 reopen，使用 FIFO eviction 策略

### 已知限制

- **無 subagent 完成事件**：pane 不會自動關閉，使用 FIFO eviction（達 6-pane 上限時關閉最舊的）
- **無 resume 事件**：無法偵測 Cursor 何時切回某個 subagent

---

## Phase 3：Interactive 模式 ✅ Done

> 完成日期：2026-03-25

### 實作內容

| 功能 | 說明 | 檔案 |
|------|------|------|
| `-i` / `--interactive` | Tab/n/p 切換主 session 與 subagents | `src/index.ts` (`startCursorInteractiveWatch`) |
| Status line | 持續顯示 session 列表 + 切換狀態 | `SessionManager` + `DisplayController` |
| Super-follow | auto-switch + interactive 聯動 | `createSuperFollowController` |
| TTY fallback | 非 TTY 環境自動降級為 multi-watch | `startCursorInteractiveWatch` |

### 設計決策

- Parser 無狀態，所有 session 共用（同 Codex 模式）
- 不使用 `InteractiveSessionHandler` wrapper，改用 `onNewSubagent` callback（避免 double registration）
- 無 custom title 支援（Cursor JSONL 無 `/rename` 事件）
- Subagent 不會顯示 `isDone` 狀態（無完成事件）

---

## Phase 4：進階功能（低優先）

| 功能 | 說明 | 備註 |
|------|------|------|
| Timestamp 推測 | 從 file mtime 或行間 delta 推算大致時間 | 需要研究可行性 |
| Tool call 追蹤 | 如果 `agent-tools/` 目錄有 tool 使用記錄，整合顯示 | 需要研究 agent-tools/ 格式 |
| Custom title | 類似 Claude 的 `/rename`，如果 Cursor 有對應功能 | 待確認 |

---

## 技術債（跨 agent 改善，非 Cursor 專屬）

這些在 Cursor 實作過程中被 review 發現，適用於所有 agent：

| 項目 | 說明 |
|------|------|
| `AGENT_TYPES` array 派生 | 用 `as const` array 取代重複字串比較，自動生成驗證和錯誤訊息 |
| glob+stat+sort 共用 utility | 4 個 agent 共 10+ 處重複的掃描排序邏輯，可抽出 `findLatestFile` / `findBestMatchFile` |
| `matchPriority()` 工具函數 | exact/prefix/contains 三級匹配在 5+ 處重複 |
| `comparePriorityThenMtime()` | priority+mtime 比較器在 5+ 處重複 |
| Agent interface metadata | 在 Agent 介面加 `fileMode` / `statefulParser` 屬性，消除 `startSingleWatch` 中的 agent-type 硬編碼 |
