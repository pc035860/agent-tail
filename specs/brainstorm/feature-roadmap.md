# agent-tail Feature Roadmap Brainstorm

> 生成日期：2026-02-19
> 方法：4 人 Agent Team 腦力激盪（Feature Proposer + Market Researcher + Technical Analyst + Devil's Advocate）

---

## 執行摘要

agent-tail 是「個人開發者的 AI agent log viewer」，核心價值是讓開發者即時看到 agent 在幹嘛。
**最大風險不是功能太少，而是功能太多導致失焦。**

市場調查確認：目前無工具同時支援 Claude + Codex + Gemini 的即時日誌追蹤，這是 agent-tail 的獨特定位。
但「企業 AI Observability 平台」的路線並不適合，應保持「個人開發者工具」的定位。

---

## Phase 0：基礎穩固（先於所有新功能）

> **Devil's Advocate 重點提醒**：1107 行的 index.ts、缺乏測試覆蓋、尚無分發策略，這些比新功能重要。

| 項目 | 說明 | 技術負債描述 |
|------|------|-------------|
| 重構 `index.ts` | 拆分 `startClaudeMultiWatch` / `startClaudeInteractiveWatch` 的重複邏輯到 `src/claude/watch-builder.ts` | 兩個函式有 3 套幾乎相同的 subagent 偵測邏輯 |
| 補齊測試 | subagent detection、auto-switch、interactive mode 等複雜路徑缺乏測試 | FileWatcher 全讀模式大檔案效能問題 |
| 分發策略 | npm publish 或 homebrew formula，讓使用者能安裝 | 目前只能 `git clone` 使用 |
| 確認 `--raw` 輸出 | 確保每行都是 valid JSON（`--raw` 是 pipe 工具鏈的基礎） | 若已正確，不需要額外的「JSON formatter」 |

---

## Phase 1：高價值核心功能

### 1.1 Session 列表（`--list`）
**優先級：P0（最被低估的功能）**

- **痛點**：使用者無法知道有哪些可用 session，可發現性嚴重缺失
- **實現**：用 `--list` flag 而非 subcommand（避免 breaking change）
  ```
  agent-tail claude --list           # 列出最近 20 個 session
  agent-tail claude --list -p myproj # 按專案過濾
  agent-tail claude --list --since 2h
  ```
- **輸出格式**：`SESSION_ID | PROJECT | MODIFIED | LINES`
- **需修改**：擴展各 agent 的 `SessionFinder.findAll()`，`parser.ts` 加 `--list` flag
- **注意**：CLI subcommand 重構（`agent-tail tail claude`、`agent-tail list`）是更乾淨的方案，但會是 breaking change，留待 Phase 2 評估

### 1.2 類型過濾（`--type`）
**優先級：P1**

- **痛點**：在長 session 中只想看特定類型的互動（例如只看 tool call）
- **實現**：按 `ParsedLine.type` 篩選，保留格式化輸出
  ```
  agent-tail claude --type tool_use    # 只看工具呼叫
  agent-tail claude --type tool_result # 只看工具結果
  agent-tail claude --type user        # 只看用戶訊息
  ```
- **不做**：通用文字 grep（`--grep "pattern"`）—— 交給 `| grep` 處理
- **需修改**：`parser.ts` 加 `--type` 選項，`onLine` callback 加過濾層
- **難度**：低

---

## Phase 2：有價值但不急

### 2.1 Session 統計摘要（`--stats`）
**優先級：P2（非即時 tailing 的核心需求）**

- **痛點**：想知道一個 session 花了多少 token、用了哪些工具
- **限制**：僅在 `--no-follow` 模式下才有意義（事後分析）
- **實現**：解析完整 session 後顯示統計摘要
  ```
  agent-tail claude --no-follow --stats
  ```
- **統計項目**：total tokens、tool 呼叫次數（按類別：shell/file/search/web/task）、session 時長、user/assistant 訊息數
- **資料來源**：Claude 的 `toolUseResult` 已有 `totalTokens`、`totalDurationMs`、`totalToolUseCount`
- **難度**：低中（資料已存在，需聚合）

### 2.2 Markdown 匯出（`--export md`）
**優先級：P2（只做 Markdown，不做 HTML）**

- **痛點**：把 agent session 分享給同事或存檔
- **實現**：新增 `MarkdownFormatter`，實現現有 `Formatter` 介面
  ```
  agent-tail claude --no-follow --export md > session.md
  ```
- **格式**：用戶訊息為 blockquote、assistant 為正文、tool_use 為 code block
- **不做**：HTML 匯出（維護成本 × 3 agent × 格式不值得）
- **難度**：中（Formatter 介面已就位）

---

## 砍掉清單（明確不做）

| 功能 | 理由 |
|------|------|
| **多 Agent 同時監控（`--multi`）** | tmux split pane 完美解決，個人開發者極少同時跑多個 agent |
| **Webhook / 事件通知（`--notify`）** | `agent-tail claude --no-follow && notify-send done` 就夠；內建 HTTP client 範圍蔓延 |
| **即時成本估算（`--cost`）** | 定價資料維護是噩夢，token 數已在 `--stats` 中包含 |
| **SQLite Session 索引** | 過度工程，JSONL + grep 就是資料庫，`bun:sqlite` 雖內建但引入狀態管理複雜度 |
| **Web Dashboard** | 另一個獨立產品；一旦做就有前端維護成本、安全性、port 管理問題 |
| **Plugin 系統** | YAGNI；PR 貢獻機制已足夠；過早凍結介面限制未來發展 |
| **Session Diff** | 酷但沒人用，且不同 agent 的 `ParsedLine` 語義不完全一致 |
| **通用 grep（`--grep "pattern"`）** | `| grep` 解決，不需要在 tail 工具中重複造輪子 |

---

## 長期願景（Phase 3+，謹慎評估）

以下方向需要使用者需求明確後才考慮：

- **CLI subcommand 重構**：`agent-tail tail claude`、`agent-tail list`、`agent-tail stats` —— 更乾淨但有 breaking change 風險
- **Bun:sqlite session 搜尋**（如果 `--list` 後有明確的歷史搜尋需求）
- **更多 agent 支援**：OpenAI Agents SDK、LangChain Agent 等（依社群需求）
- **FileWatcher 增量讀取**：用 file offset 取代每次全讀，解決大型 session 檔案（>50MB）效能問題

---

## 優先順序總覽

```
Phase 0（基礎）
├── 重構 index.ts（拆分重複邏輯）
├── 補齊測試覆蓋率
├── 分發策略（npm publish / homebrew）
└── 確認 --raw 輸出為 valid JSONL

Phase 1（高價值）
├── Session 列表（--list flag）          ← 最被低估的功能
└── 類型過濾（--type）                   ← 低難度、高頻需求

Phase 2（有價值）
├── Session 統計摘要（--stats，僅 --no-follow）
└── Markdown 匯出（--export md）

Phase 3+（謹慎）
├── CLI subcommand 重構
├── 更多 agent 支援
└── FileWatcher 增量讀取
```

---

## 腦力激盪團隊成員

| 角色 | 貢獻 |
|------|------|
| **Feature Proposer** | 從使用者痛點角度提出 7 個功能提案，識別 Claude log 中的現有資料可用性 |
| **Market Researcher** | 調查 AI Agent Observability 市場趨勢，確認多 agent 統一監控的差異化定位，發現社群自製工具需求 |
| **Technical Analyst** | 深入閱讀 codebase，識別 6 個架構擴展點，指出 CLI subcommand 重構為最大技術障礙，評估 8 個功能的技術可行性 |
| **Devil's Advocate** | 批判假 P0、識別重複造輪子、指出被忽視的基礎需求（穩定性、分發策略），精簡砍掉 7 個不必要功能 |
