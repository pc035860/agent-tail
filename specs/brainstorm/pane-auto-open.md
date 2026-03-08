# Pane Auto-Open：tmux/iTerm2 自動開啟 Pane 觀察 Subagent

> 生成日期：2026-02-28
> 方法：6 人 Agent Team 平行研究（tmux-researcher + iterm2-researcher + tools-investigator + nodejs-researcher + architect + devil's-advocate）

---

## 執行摘要

研究在 tmux/iTerm2 環境中，當 agent-tail 偵測到新 subagent 時，自動開啟 terminal pane 來觀察該 subagent 的技術方案。

**核心結論**：技術上完全可行，零外部依賴（直接 `Bun.spawn` 調用 CLI），agent-tail 已有的 `subagent-detector.ts` 是獨特優勢。但需嚴格控制 scope，避免 scope creep。

**推薦策略**：Phase 0 先輸出可複製指令提示（10 行程式碼），驗證需求後再做 Phase 1 MVP（tmux `--pane` flag）。

---

## 一、技術可行性

### tmux（最佳方案，零依賴）

| 項目 | 說明 |
|------|------|
| 環境偵測 | `process.env.TMUX` 存在即確認在 tmux 內 |
| 建立 pane | `tmux split-window -h -P -F "#{pane_id}" "command"` — 帶指令避開 send-keys race condition |
| Pane ID | `-P -F "#{pane_id}"` 返回如 `%3`，用於後續生命週期管理 |
| 關閉 pane | `tmux kill-pane -t %3` |
| Hooks | `tmux set-hook -g pane-exited 'run-shell "..."'` 可監聽 pane 結束 |
| API 穩定性 | tmux CLI 多年無 breaking change，業界標準 |
| 跨平台 | macOS（Homebrew）+ Linux 完全支援 |

```bash
# 核心指令（一行搞定）
tmux split-window -h "agent-tail claude --subagent abc123 -q"
```

**參考**：
- https://tmuxai.dev/tmux-send-keys/
- https://github.com/tmux/tmux/wiki/Control-Mode

### iTerm2（次選方案）

**優先順序**：it2 CLI (Python API) > osascript (AppleScript fallback)

| 方法 | 穩定性 | 複雜度 | 備註 |
|------|--------|--------|------|
| `it2` CLI（Python API） | 高（官方推薦方向） | 低 | Claude Code 官方 Agent Teams 也用此方案 |
| AppleScript via osascript | 中（deprecated） | 低 | 短期可用，作為 fallback |
| Python API 直接調用 | 高 | 高 | 需 Python 環境 + 手動啟用，CLI 工具不適合直接用 |

**Claude Code 官方做法**（Issue #24301）：
- 使用 `it2` CLI（`pip install it2`，v0.2.0）
- 需在 iTerm2 Settings → General → Magic 啟用 Python API
- 目前有 silent fallback bug（`teammateMode: "auto"` 時不一定生效）

**環境偵測**：
```typescript
function isInsideITerm2(): boolean {
  return process.env.TERM_PROGRAM === 'iTerm.app' ||
         process.env.LC_TERMINAL === 'iTerm2' ||
         !!process.env.ITERM_SESSION_ID;
}
```

注意：SSH 連線後環境變數不會自動傳遞。

**參考**：
- https://iterm2.com/documentation-scripting.html
- https://github.com/anthropics/claude-code/issues/24301
- https://github.com/mkusaka/it2

### Escape Sequences

**結論：無法用 escape sequences 開啟新 pane**。iTerm2 的 `OSC 1337` 不支援 pane 分割。

---

## 二、Bun 相容性

| 方案 | Bun 相容 | 備註 |
|------|---------|------|
| `Bun.spawn(['tmux', ...])` | ✅ 原生最快 | 推薦 |
| `Bun.spawn(['osascript', ...])` | ✅ | iTerm2 AppleScript fallback |
| `Bun.spawn(['it2', ...])` | ✅ | iTerm2 Python API via CLI |
| node-pty | ❌ 完全不可用 | native addon，Bun 不支援，官方標記 out-of-scope |
| 任何 npm 套件 | 不需要 | 全部直接調 CLI 即可 |

**結論：不需要任何 npm 套件，零依賴。**

---

## 三、市場空白分析

### 現有工具矩陣

| 工具 | Stars | FS 事件偵測 subagent | 自動開 pane | 跨 agent 支援 |
|------|-------|---------------------|-------------|--------------|
| **agent-tail**（待做） | — | **有**（subagent-detector） | **待做** | Claude/Codex/Gemini |
| Agent Deck | ~940 | 無（Claude 主動） | 是 | Claude/Gemini/Codex |
| NTM | ~133 | 無 | 是（手動） | 多種 |
| ittybitty | — | 無（agent 主動） | 是（worktree+tmux） | Claude |
| spymux | ~64 | 無 | 否（只讀） | tmux pane |
| tmux-agent-indicator | — | 是（Claude hook） | 否 | Claude/Codex |
| tmux-mcp | ~17 | 無（agent 主動） | 是（MCP tool） | 任何 |

**真正的市場空白**：沒有任何工具做到「file system 事件驅動 → 自動計算佈局 → 開 pane → 監聽 subagent → 結束時關閉」的完整流程。

agent-tail 的 `subagent-detector.ts`（使用 directory watch 偵測新 session 檔案）是獨特優勢。

**參考**：
- https://github.com/asheshgoplani/agent-deck
- https://github.com/Dicklesworthstone/ntm
- https://github.com/terror/spymux
- https://github.com/accessd/tmux-agent-indicator
- https://adamwulf.me/2026/01/itty-bitty-ai-agent-orchestrator/

### Claude Code 官方 Agent Teams

Claude Code 已有內建 tmux/iTerm2 pane 管理（`teammateMode: "tmux" | "auto"`），但：
- 只管理 Claude Code 自己的 teammates
- 有 tmux race condition bug（Issue #23615：send-keys 亂碼）
- iTerm2 有 silent fallback bug（Issue #24301）
- agent-tail 定位不同：「觀察」vs「控制」

**參考**：
- https://code.claude.com/docs/en/agent-teams
- https://github.com/anthropics/claude-code/issues/23615
- https://github.com/anthropics/claude-code/issues/24301
- https://github.com/anthropics/claude-code/issues/25396

---

## 四、架構設計方案

### 新目錄結構

```
src/terminal/
├── terminal-controller.interface.ts  # TerminalController 介面
├── tmux-controller.ts               # tmux 實作
├── iterm2-controller.ts             # iTerm2 實作（it2 CLI + osascript fallback）
├── null-controller.ts               # 降級方案
├── controller-factory.ts            # 環境偵測 + 建立
└── pane-manager.ts                  # 生命週期管理
```

### TerminalController 介面

```typescript
export interface PaneInfo {
  id: string;      // tmux pane_id 或 iTerm2 session handle
  agentId: string; // 對應的 subagent ID
}

export interface PaneLayout {
  direction: 'horizontal' | 'vertical';
  maxPanes: number;
}

export interface TerminalController {
  isAvailable(): boolean;
  createPane(command: string, agentId: string, layout: PaneLayout): Promise<PaneInfo | null>;
  closePane(paneId: string): Promise<void>;
  readonly name: string;
}
```

### Controller 優先順序

```typescript
export async function createTerminalController(): Promise<TerminalController> {
  // 1. tmux 內優先用 tmux
  if (process.env.TMUX) return new TmuxController();
  // 2. iTerm2：偵測 it2 CLI 是否可用，有就用（Python API）
  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    const hasIt2 = await commandExists('it2');
    if (hasIt2) return new Iterm2Controller('it2');
    return new Iterm2Controller('osascript'); // AppleScript fallback
  }
  // 3. 降級
  return new NullController();
}
```

### 最小侵入性整合

在 `SubagentDetectorConfig` 加一個可選 hook（一行改動）：

```typescript
// src/claude/subagent-detector.ts
export interface SubagentDetectorConfig {
  // ... 現有欄位不變
  onNewSubagentPane?: (agentId: string, subagentPath: string) => Promise<void>;
}
```

在 `registerNewAgent()` 中呼叫：
```typescript
this.config.onNewSubagentPane?.(agentId, subagentPath);
```

### CLI

```bash
agent-tail claude --pane                # 啟動 pane 自動管理（Phase 2 自動 main-vertical 佈局）
```

`--pane` 與 `-i`（interactive mode）互斥。

---

## 五、Devil's Advocate 挑戰摘要

### 風險 1：Claude Code 官方 tmux race condition
> Issue #23615：`send-keys` 出現亂碼（`mmcd` 而非 `cd`），連 Anthropic 都沒解決。

**緩解**：agent-tail 用 `tmux split-window -h "command"` 直接帶指令，**不用 send-keys**，避開此問題。

### 風險 2：孤兒進程問題
> gastown Issue #699（11K stars 專案）：tmux kill-session 留下孤兒進程，花了 3 個 PR 處理。

**緩解**：agent-tail 的 pane 只是 tail log，無複雜子進程樹。`kill-pane` + `process.on('SIGINT')` 清理應足夠。

### 風險 3：Scope Creep
> agent-tail 本職是 log tailing，pane 管理是完全不同性質的工程問題。

**緩解**：嚴格限制在 `src/terminal/` 目錄，與核心 log tailing 邏輯解耦。Phase 0 先驗證需求。

### 風險 4：被 Claude Code 官方淘汰
> Agent Teams 正在快速迭代。

**緩解**：agent-tail 護城河是跨 agent 支援（Codex/Gemini）+ 純觀察定位。官方是「控制」，agent-tail 是「觀察」。

### 替代方案 A（最低成本）
```
[agent-tail] New subagent detected: abc123
  → To monitor: tmux split-window -h "agent-tail claude --subagent abc123"
```
成本 10 行程式碼，收益 99% 體驗改善。

**參考**：
- https://github.com/anthropics/claude-code/issues/23615
- https://github.com/steveyegge/gastown/issues/699
- https://news.ycombinator.com/item?id=46904365

---

## 六、推薦實作策略

### Phase 0：提示訊息（10 行，立即可做）

偵測到 subagent 時，根據環境輸出可複製的指令提示：
- tmux 內 → `tmux split-window -h "agent-tail claude --subagent <id> -q"`
- iTerm2 → `it2 session split` 或 osascript 指令
- 其他 → 基本的 `agent-tail claude --subagent <id>` 提示

**目的**：驗證使用者是否真的想要自動開 pane。

### Phase 1 MVP：tmux `--pane`

- `--pane` flag（`src/cli/parser.ts`）
- `src/terminal/`：`interface` + `TmuxController` + `NullController` + `factory`
- `src/terminal/pane-manager.ts`：基本生命週期
- `SubagentDetectorConfig` 加 `onNewSubagentPane` hook
- `SIGINT` 清理

### Phase 2：tmux 佈局與生命週期

- pane 自動佈局：每次開新 pane 後執行 `tmux select-layout main-vertical`（主左、subagent 堆右均分）
- subagent 結束後自動關閉 pane
- `--pane` 模式下主窗格不重複輸出已開 pane 的 subagent 內容

### Phase 3：進階功能

- pane resize / focus 管理
- tmux Control Mode (-CC) 雙向通訊
- pane 狀態指示（借鑑 tmux-agent-indicator）
- 與 `--auto-switch` 搭配：主 session 切換後 subagent pane 也跟著更新

### Phase 4：iTerm2 支援

- `Iterm2Controller`：偵測 `it2` CLI → Python API，fallback → osascript
- 環境偵測整合至 `controller-factory.ts`

---

## 七、與現有模式的關係

```
--pane              → 新模式：subagent 各自在獨立 pane
-i (interactive)    → 現有：單一 terminal 內切換顯示
--with-subagents    → 現有：合併輸出到同一個 terminal
```

`--pane` 可與 `--auto-switch` 搭配使用。
