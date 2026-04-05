# Brainstorm: Session 列表 + 即時預覽功能

> 日期：2026-04-04
> 參與者：ux-designer, tech-researcher, codebase-analyst, devils-advocate

---

## 問題陳述

使用者不在電腦旁時，AI agent 可能產生了多個 session。回來後需要：
1. 列出最近執行過的 session
2. 快速瀏覽各 session 內容
3. 決定要深入查看哪個 session

目前 agent-tail 只支援 `findLatest()`（自動找最新）或 `findBySessionId()`（指定 ID），沒有列出多個 session 的能力。

---

## Phase 1 提案摘要

### UX 設計（3 種互動方案）

| 方案 | 佈局 | 預覽方式 | 實作成本 | 適用場景 |
|------|------|----------|----------|----------|
| **A: fzf-style** | 全螢幕單欄，底部預覽區 + 搜尋列 | 即時預覽（debounce 150ms） | 低 | 日常使用，模糊搜尋 |
| **B: Split-Pane** | 左右 30/70 分割，類 lazygit | 完整預覽 + PgUp/PgDn 捲動 | 中 | 深度回顧，subagent 展開 |
| **C: Quick-Pick** | 非全螢幕，數字鍵選取 | 選取後顯示 3 行確認 | 極低 | 快速選一個就走 |

### 技術選型

| 方案 | Bun 相容 | 依賴影響 | 推薦度 |
|------|----------|----------|--------|
| **fzf 整合** (Bun.spawn) | ✅ 完美 | 外部依賴 (fzf) | ⭐⭐⭐⭐ MVP |
| **Ink** (React for CLI) | ✅ 好 | 重（React 依賴鏈） | ⭐⭐⭐⭐⭐ 進階 |
| **自寫 ANSI** | ✅ 完美 | 無 | ⭐⭐ 維護風險高 |
| **@clack/prompts** | ✅ 好 | 輕 | ⭐ 不支援分割 |

### Codebase 整合分析

**關鍵發現**：四個 agent 的 `findLatest()` 內部**已遍歷所有 session 檔案**，只取 mtime 最新的一個。`listSessions()` 只需「回傳全部」而非「取 max」，核心改動極小。

可用 metadata：

| Agent | mtime | project | customTitle | cwd | subagent count |
|-------|-------|---------|-------------|-----|----------------|
| Claude | ✅ | ✅ | ✅ | ❌ | ✅ |
| Codex | ✅ | ✅ | ❌ | ✅ | ✅ |
| Gemini | ✅ | ✅ | ❌ | ❌ | ❌ |
| Cursor | ✅ | ✅ | ❌ | ❌ | ✅ |

---

## Devil's Advocate 核心批判

### 1. 需求未經驗證
- agent-tail 是 **tail** 工具，「回顧歷史」不是主要使用場景
- 沒有使用者數據支撐這是高頻需求
- 更簡單的替代方案被忽略

### 2. 所有技術路線都有風險
- **fzf 外部依賴**：非標準工具，版本碎片化，Windows 排除
- **Ink 依賴爆炸**：目前只有 2 個 dependencies（commander + chalk），Ink 會拉進 React 全家桶
- **自寫 TUI**：display-controller.ts 342 行只處理一行狀態列，全螢幕分割是數量級升級

### 3. 效能問題被低估
- 活躍使用者一年可能累積 1,800-7,300 個 session 檔案
- `readCustomTitle()` 讀取整個 JSONL（可能 50-200MB），記憶體風險大
- 正確做法是從檔案尾部反向讀取，但 Bun API 不直接支援

### 4. CLI 語意混淆
- `tail` 和 `list` 是不同操作語意（`tail -f` vs `ls`）
- `-n` 語意複用會造成混淆（50 行 vs 50 個 session）
- 三份報告推薦了三種不同觸發方式（`--list`、`browse`、`pick`），無共識

### 5. 被忽略的替代方案
- **純文字 `--list` + pipe 到系統 fzf**：零 TUI 開發成本
- **`--list --json` 結構化輸出**：符合 Unix 哲學
- **改善 `findBySessionId` 錯誤訊息**：20 行程式碼覆蓋大量場景
- **擴展現有 `--interactive` 啟動流程**：已有 session 切換、buffer、歷史回看

---

## 綜合結論與推薦方案

### 採納的批判觀點

Devil's Advocate 的核心論點成立：**在需求未驗證前，不應投入 TUI 開發**。但使用者（批醬）明確提出了這個需求，所以問題不是「要不要做」，而是「做到什麼程度」。

### 推薦：三階段漸進策略

#### Phase 0 — 低果實（1-2 小時）⭐ 立即可做
> 改善現有 UX，不引入新功能

1. **改善 `findBySessionId` 錯誤訊息**：找不到時列出候選 session
2. **改善 `--interactive` 啟動體驗**：啟動時如果同專案有多個 session，在狀態列提示 "Tab to switch (5 sessions)"

#### Phase 1 — 純文字列表（3-4 小時）⭐⭐ 推薦 MVP
> `--list` 輸出可 pipe 的純文字 + `--json` 結構化輸出

```bash
# 純文字（人類可讀）
agent-tail claude --list
# 2026-04-04 15:30  abc123  my-project  "Fix auth bug"
# 2026-04-04 14:00  def456  my-project
# 2026-04-03 09:15  ghi789  other-proj

# JSON（可 pipe）
agent-tail claude --list --json | jq '.[].shortId' | fzf

# 搭配專案過濾
agent-tail claude --list -p myproject

# 搭配 -n 限制數量（注意：list 模式下 -n = session 數量）
agent-tail claude --list -n 10
```

**實作要點**：
- `SessionFinder` 新增 `listSessions()` 方法（從 `findLatest()` 簡單改造）
- `SessionListItem` 介面：`{ path, mtime, agentType, shortId, project, customTitle? }`
- `customTitle` 使用 lazy load + 從尾部讀取（避免載入整個 JSONL）
- `-n` 在 list 模式下語意為「顯示前 N 個 session」（需在 help text 說明）
- 新增 `src/list/session-lister.ts` 處理格式化輸出

**CLI 設計決策**：採用 `--list` 選項而非子命令
- 理由：保持現有 `<agent-type>` 第一引數的 CLI 結構
- 與 `--raw`、`--json` 等選項風格一致
- 不引入 `browse`/`pick` 等新概念

#### ~~Phase 1~~ ✅ 已完成（2026-04-04）

實作內容：
- `--list` / `-l` CLI 選項，tab-separated 輸出
- `SessionListItem extends SessionFile` 介面
- 所有 4 個 agent 的 `listSessions()` 方法
- `formatRelativeTime()` + `formatSessionList()` 格式化工具
- `agent-pick` 啟動器（fzf 整合 + graceful fallback）
- `listCommand()` 在 `index.ts` 的入口接線
- 112 個新測試（全部通過）

偏離原始規劃：
- 新增了 `agent-pick` 獨立啟動器（brainstorm 後討論決定用獨立 script 而非內建 TUI）
- `customTitle` 未在 list 輸出中顯示（效能考量，延後到 Phase 2）
- 未實作 `--json` 輸出（tab-separated 已足夠供 fzf 使用）

#### Phase 2 — 互動式選擇器（4-6 小時，需求驗證後）
> 內建簡易選擇器，不依賴外部工具

採用 **方案 C (Quick-Pick) 的精簡版**：
- 非全螢幕，只佔需要的終端行數
- 數字鍵直接選取 + 方向鍵瀏覽
- 選取後顯示 3 行預覽確認
- 不需外部 TUI 框架（自寫 readline + ANSI，複雜度可控）

觸發方式：`agent-tail claude --list -i` 或 `agent-tail claude --pick`

#### Phase 3 — 進階瀏覽器（長期，視需求）
> 僅在 Phase 1-2 被頻繁使用後才考慮

- fzf-style 全螢幕 + 即時預覽（方案 A）
- 技術選型：優先考慮自寫 ANSI（擴展 display-controller），不引入 Ink
- 如果需要分割視窗，考慮獨立的 `agent-browse` 指令（避免 `agent-tail` 語意膨脹）

### 關鍵設計決策

| 決策 | 選擇 | 理由 |
|------|------|------|
| CLI 觸發 | `--list` 選項 | 保持現有結構，不引入子命令 |
| 外部依賴 | 不引入 fzf/Ink | 零依賴原則，讓使用者自行 pipe |
| customTitle 讀取 | 尾部反向讀取 + lazy load | 避免記憶體炸彈 |
| `-n` 語意 | list 模式=session 數量 | 在 help text 明確說明雙重語意 |
| 預覽方式 | Phase 1 無預覽，Phase 2 最小預覽 | 漸進增強，避免 MVP 膨脹 |
| 介面設計 | 新增 `listSessions()` 到 SessionFinder | 最小改動，未來可考慮拆分 SessionLister |

### 風險緩解

| 風險 | 緩解策略 |
|------|----------|
| 大量 session 效能 | `listSessions()` 加入 `limit` 參數，預設 20 |
| readCustomTitle I/O | lazy load + 尾部讀取（Bun.file + slice） |
| `-n` 語意混淆 | help text 明確說明 + 錯誤訊息提示 |
| SessionFinder 膨脹 | Phase 1 先加到現有介面，Phase 3 時考慮拆分 |
