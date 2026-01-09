# Interactive Mode 計劃：Tab 切換主會話/Subagent

## 概述

實作一個互動模式，讓使用者可以在 agent-tail 運行時，用 Tab 鍵在主會話和正在運行的 subagent 之間切換顯示。

## 目標功能

```bash
# 啟動互動模式
agent-tail claude -i
agent-tail claude --interactive

# 運行時按 Tab 切換顯示
[Tab] → 主會話 → Subagent-1 → Subagent-2 → 主會話 → ...
```

## 目前架構

```
index.ts
    │
    ├── Agent (finder + parser)
    │       └── 找到單一檔案
    │
    └── FileWatcher (監控單一檔案)
            └── stdout 輸出
```

**限制**：單檔案、單向輸出，無法支援多 watcher 和鍵盤互動。

## 目標架構

```
index.ts
    │
    ├── SessionManager (新)
    │       ├── mainWatcher: FileWatcher (主會話)
    │       ├── subagentWatchers: Map<string, FileWatcher>
    │       └── SubagentDetector (監控 subagents/ 目錄)
    │
    ├── KeyboardHandler (新)
    │       └── 監聽按鍵事件，發送切換指令
    │
    └── DisplayController (新)
            ├── activeIndex: number (目前顯示哪個)
            ├── buffers: Map<string, string[]> (各 watcher 的輸出緩衝)
            └── statusLine: 狀態列顯示
```

## 新增元件規格

### 1. SessionManager

**職責**：管理主會話和所有 subagent 的 FileWatcher

```typescript
interface SessionManager {
  // 初始化主會話 watcher
  initMain(sessionFile: SessionFile): void;

  // 取得所有 watcher（包含主會話）
  getAllWatchers(): Map<string, FileWatcher>;

  // 取得目前 active 的 watcher
  getActiveWatcher(): FileWatcher;

  // 切換到下一個 watcher
  switchNext(): void;

  // 切換到上一個 watcher
  switchPrev(): void;

  // 當偵測到新 subagent 時呼叫
  onNewSubagent(file: SessionFile): void;
}
```

### 2. SubagentDetector

**職責**：監控 `{sessionId}/subagents/` 目錄，發現新檔案時通知 SessionManager

```typescript
interface SubagentDetector {
  // 開始監控指定目錄
  watch(subagentsDir: string): void;

  // 停止監控
  stop(): void;

  // 新 subagent 發現時的 callback
  onDetected: (file: SessionFile) => void;
}
```

**實作方式**：使用 `fs.watch()` 或 Bun 的 file watching API

### 3. KeyboardHandler

**職責**：監聽 stdin 的按鍵事件

```typescript
interface KeyboardHandler {
  // 開始監聽
  start(): void;

  // 停止監聽
  stop(): void;

  // 按鍵事件 callbacks
  onTab: () => void;        // Tab: 切換到下一個
  onShiftTab: () => void;   // Shift+Tab: 切換到上一個
  onQuit: () => void;       // q/Ctrl+C: 退出
}
```

**實作方式**：
```typescript
process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  if (key.name === 'tab') {
    if (key.shift) onShiftTab();
    else onTab();
  }
});
```

### 4. DisplayController

**職責**：控制終端輸出，管理狀態列

```typescript
interface DisplayController {
  // 設定 active watcher 的 ID
  setActive(watcherId: string): void;

  // 接收 watcher 的輸出
  write(watcherId: string, content: string): void;

  // 更新狀態列
  updateStatusLine(): void;

  // 清除畫面並重繪
  refresh(): void;
}
```

**狀態列範例**：
```
─── [MAIN] | sub:a5e6938 | sub:a7fb6f3 ─── (Tab to switch)
```

## 實作階段

### Phase 1：基礎修正（已完成）
- [x] 探索新的目錄結構
- [x] 修正 `findSubagent()` 路徑邏輯
- [x] 新增 `totalToolUseCount` 顯示

### Phase 2：多 Watcher 支援（已完成 - 2026-01-09）
- [x] 建立 `SessionManager` 類別 (`src/core/session-manager.ts`)
- [x] 修改 `index.ts` 支援多 watcher 模式
- [x] 實作基本的輸出切換（無 UI）

**實作調整**：
- SessionManager 專注於 session 狀態管理和輸出路由，不直接控制 file watching
- 複用現有的 MultiFileWatcher 作為底層監控機制
- 輸出緩衝機制：非 active session 的輸出存入 buffer，切換時自動 flush

### Phase 3：鍵盤互動（已完成 - 2026-01-09）
- [x] ~~建立 `KeyboardHandler` 類別~~ → 整合於 `startClaudeInteractiveWatch()`（簡化設計）
- [x] 新增 `--interactive` CLI 選項
- [x] 實作 Tab 切換邏輯

**實作調整**：
- 鍵盤監聽直接整合在 `startClaudeInteractiveWatch()` 中，避免過度抽象
- 支援按鍵：Tab（下一個）、Shift+Tab（上一個）、n/p（替代鍵）、q/Ctrl+C（退出）
- CLI 驗證：`--interactive` 只對 claude 有效，禁止與 `--subagent`/`--no-follow` 組合

### Phase 4：狀態列 UI（已完成 - 2026-01-09）
- [x] 建立 `DisplayController` 類別 (`src/interactive/display-controller.ts`)
- [x] 實作狀態列顯示（底部固定，使用 ANSI scroll region）
- [x] 實作輸出緩衝和歷史回看（切換時顯示緩衝內容）

**實作細節**：
- 使用 ANSI escape codes 控制捲動區域（狀態列不被捲動）
- 狀態列顯示：`─── [MAIN] | a284f68 (5) | ad6c65a (done) ─── (Tab: switch, q: quit)`
- 切換時自動 flush buffer 並顯示分隔線

### Phase 5：自動偵測（已完成 - 2026-01-09）
- [x] ~~建立 `SubagentDetector` 類別~~ → 已整合於現有的動態偵測邏輯
- [x] 即時發現新 subagent 並加入監控（利用現有 `startClaudeInteractiveWatch` 中的偵測機制）
- [x] 處理 subagent 結束的情況

**實作細節**：
- 當主 session 收到 `toolUseResult` 時，標記對應 subagent 為 `isDone`
- 狀態列顯示綠色 ✓ 標記表示已完成
- 輸出 `Subagent completed: {agentId}` 訊息通知使用者

## 檔案結構（實際）

```
src/
├── index.ts                    # 修改：支援 interactive mode (startClaudeInteractiveWatch)
├── cli/parser.ts               # 修改：新增 --interactive 選項
├── core/
│   ├── types.ts                # 修改：CliOptions 新增 interactive 屬性
│   ├── file-watcher.ts
│   ├── multi-file-watcher.ts   # 現有：多檔案監控（被 SessionManager 使用）
│   └── session-manager.ts      # 新增：session 狀態管理和輸出路由
├── interactive/                # 新增目錄
│   └── display-controller.ts   # 新增：終端輸出和狀態列控制
└── ...
```

**設計簡化**：
- 不需要獨立的 `KeyboardHandler` 類別 - 直接整合於 `index.ts`
- 不需要獨立的 `SubagentDetector` 類別 - 利用現有的動態偵測邏輯
- `DisplayController` 獨立類別，負責 ANSI escape codes 和狀態列管理

## 技術考量

### 1. Raw Mode 和終端控制
- 進入 raw mode 後需要自己處理 Ctrl+C
- 需要在退出時恢復終端設定
- 使用 ANSI escape codes 控制游標和清除行

### 2. 輸出緩衝策略
- 非 active 的 watcher 輸出存入 buffer
- Buffer 大小限制（避免記憶體爆炸）
- 切換時顯示最近 N 行歷史

### 3. Subagent 生命週期
- 偵測新 subagent：監控目錄變化
- 偵測 subagent 結束：檔案不再更新 + toolUseResult 出現
- 結束後保留在列表中，標記為 (done)

## 相關資源

- [Node.js readline keypress](https://nodejs.org/api/readline.html)
- [ANSI escape codes](https://en.wikipedia.org/wiki/ANSI_escape_code)
- [Bun file watching](https://bun.sh/docs/api/file-io#watching-files-bun-watch)

---

*建立日期：2026-01-09*
*更新日期：2026-01-09*
*狀態：✅ 所有 Phase 1-5 已完成！Interactive Mode 功能完整實作*
