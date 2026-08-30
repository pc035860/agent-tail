# Pi Agent Support — Implementation Spec (v2)

## 1. Overview / Goal

本 SPEC 是 Pi agent 支援的 **v2 設計**：以 v1 實作（commit `ef1ed20`）為基礎，
吸收 `specs/pi-agent-support-retrospective.md` 的 11 項重設計決策，描述「如果
重新來一次」的完整形狀。

**v1 已交付**（本 SPEC 標記為 ✅ 已落地）：tail、`--list`、`--summary`、
session-id 查找、`--auto-switch`、agent-pick、樹狀 active-path replay filter、
FileWatcher baseline race 修復。

**v2 目標**：把 v1 期間暴露的結構性債務還清 — 讓「下一個 agent」的接入成本
從 9 個接線點降到 1 個檔案 + registry 一行，讓樹狀格式過濾不再依賴隱含契約。

**非目標**：不改變任何已支援 agent 的行為；不新增 pi 的 subagent / interactive
/ pane 支援（理由見 §8）。

## 2. Pi Session Log Format

### 2.1 儲存位置

```
~/.pi/agent/sessions/--<cwd-encoded>--/<ISO-ts>_<uuid>.jsonl
```

- cwd 編碼：`/` → `-`，前後包 `--`。**編碼函數必須先剝 leading `/`**：
  `/Users/x/code/foo` → `--Users-x-code-foo--`（直接 split 會得到
  `---Users-...`，三條 dash，匹配不到任何真實目錄 — v1 踩過）
- 編碼不可逆：`-` 可能是路徑分隔符或字面連字號 → **任何需要精確專案歸屬的
  查詢必須用 header cwd 驗證**（§4.4）

### 2.2 JSONL v3 entry 類型

| type | 內容 | v2 處理 |
|------|------|---------|
| `session` | header（`cwd`、`id`、`version`），無 `id`/`parentId` | 跳過；`readPiCwdFromHead` 讀第一行取權威 cwd |
| `message` | `message.role`: `user` / `assistant` / `toolResult` / `bashExecution` / `custom` | 見 §5 parser 規則 |
| `session_info` | `name`（pi 的 `/name`） | 映射為 custom-title 事件（TITL） |
| `custom_message` | extension 注入訊息（**頂層 entry**，content/display 在頂層） | `display !== false` 時輸出為 custom |
| `model_change` / `thinking_level_change` / `compaction` / `branch_summary` / `label` / `custom` | metadata | 跳過（參與樹狀鏈但不輸出） |

**格式要點**（v1 實測確認）：

- 第一行是 session header，攜帶權威 `cwd` — 專案歸屬的唯一可信來源
- 每個 entry 都有 ISO timestamp（`entry.timestamp`）— 排序與 `--list` enrich
  直接可用
- assistant `message.content` 是 block 陣列：`text` / `thinking` / `toolCall`
  — 一行可拆多筆 ParsedLine（multi-emit）
- 樹狀結構：entry 樹（非訊息樹）— `model_change`、`session_info` 等
  metadata entry 也在 `parentId` 鏈上，leaf 可能是非 message entry
- `/tree` 的「選舊訊息 → 編輯 → 重送」會在**同一檔案**留下死分支（實測
  25 個 session 有 2 個含分支，全部是「送出後 22 秒內重送改版」的日常操作）

### 2.3 Subagent

`~/.pi/agent/ferris-pi-subagents/` 是 extension 私有格式（非官方核心）。
**v2 不支援**，理由與 v1 相同：格式不受官方保證、無 spawn 事件可掛鉤。
等 pi 官方把 subagent 格式收進核心再評估。

## 3. 架構設計（v2）

v1 的實作暴露了三層結構債。v2 的核心改動是把「agent 差異」收斂到單一
registry、把「樹狀過濾」移出 parser 介面、把 FileWatcher 的 baseline 語義
寫死為「已處理內容」。

### 4.1 Agent capabilities registry（單一來源）

**問題**：v1 新增 `pi` 動了 7 個檔案的 9 個接線點，其中 2 處是 review 抓到
的遺漏（`agent-pick` 的 `AGENT_TYPES`、`--auto-switch` help text）。

**v2 設計**：

```ts
// src/agents/registry.ts — agent 資訊的單一來源
export interface AgentCapabilities {
  factory: (opts: ParserOptions) => Agent;
  statefulParser: boolean;     // → drain 清單
  recreateOnSwitch: boolean;   // session 切換時重建 parser
  jsonMode: boolean;           // FileWatcher 模式
  supportsSubagent: boolean;   // CLI per-agent 驗證
  supportsInteractive: boolean;
  supportsPane: boolean;
  supportsAutoSwitch: boolean; // help text + 驗證
  pickEnabled: boolean;        // agent-pick AGENT_TYPES
}

export const AGENT_REGISTRY: Record<AgentType, AgentCapabilities> = { ... };
```

導出規則：`AGENT_TYPES = Object.keys(AGENT_REGISTRY)`。CLI 驗證、
`index.ts` 的實例化 / stateful drain 清單 / parser 重建清單 / jsonMode 特判、
`agent-pick` 的清單 — 全部從 registry 導出。新增 agent = 一個 agent 檔案 +
registry 一行，**零個散落清單**。

遷移：v1 已落地的 6 個 agent 逐一遷移（每個都是把既有特判搬進 registry），
行為不變，測試不變。

### 4.2 MultiEmitParserBase — stateful multi-emit 的第三次抽取消

**問題**：Claude、Cursor、pi 三個 parser 都手寫同一個狀態機：
`currentMessageState`（block 佇列 + index）+ `lastProcessedLine` dedup guard +
「drain 完成後清 state 但保留 lastProcessedLine」。這個模式有兩個已知的坑：

1. `drainArg: ''`（summary 路徑）會在 state 存在時斷流 — v1 的 pi parser
   踩過（summary 只顯示 multi-block 訊息的第一個 block）
2. drain 完成後清掉 `lastProcessedLine` → 同一行 re-init → 無限迴圈
   （Cursor 事故，CLAUDE.md 有記錄）

**v2 設計**：

```ts
export abstract class MultiEmitParser implements LineParser {
  private state: { parts: ParsedLine[]; index: number } | null = null;
  private lastProcessedLine: string | null = null;

  parse(line: string): ParsedLine | null {
    // drain 中：無視 line 內容（含 drainArg=''）繼續吐 parts
    if (this.currentParts) { /* 逐個 emit，耗盡後清 state 保留 guard */ }
    if (!line.trim()) return null;
    if (line === this.lastProcessedLine) return null;   // dedup guard
    this.lastProcessedLine = line;
    return this.emitFirst(this.toParts(line));          // 子類別唯一的責任
  }

  /** 子類別只寫這個：一個 JSONL entry → 0..N 個 ParsedLine */
  protected abstract toParts(entry: unknown): ParsedLine[];
}
```

- drain 契約、dedup guard、`drainArg: ''` 相容性**寫一次、測一次**
- agent parser 從 ~150 行狀態機縮減為純映射函數
- Cursor 的無限迴圈事故（清掉 guard）結構上不可能再發生

**v1 已有的三個 parser（Claude/Cursor/pi）遷移為子類別**，行為不變、
既有測試不變。

### 4.3 FileWatcher baseline：語義寫死為「已處理內容」

v1 的 review 追出 4 條 baseline race（pending drain 遞迴、baseline 吞空窗
append、jsonMode 跳過對齊、空 JSONL 的 `> 0` 條件）。v2 的修復已落地，
v2 SPEC 把它升格為**設計約束**：

```ts
// baseline 的唯一語義：描述「已處理內容」，永不描述「stat 瞬間值」
private async readCycle(): Promise<void> {
  await this.updateMtime(this.filePath!);   // baseline 先行（mtime = 讀前）
  await this.readAndProcess(...);           // lastReadOffset / lastContentLength 前進
  this.alignSizeBaseline();                 // lastSize = 已處理長度（含 0）
}
```

- **size baseline**：JSONL → `lastReadOffset`（含 0）；jsonMode →
  `lastContentLength`。唯一寫入點是讀取完成後的對齊 — read 與 baseline
  更新之間不存在「吞資料」的中間態
- **mtime baseline**：讀取開始前的值 — read 期間的同長度 rewrite 會讓
  真實 mtime 偏離 baseline，poll 能觸發重讀（hash 機制的盲區由 mtime 補）
- **pending drain**：`while` 迴圈在同一個 `isProcessing` 區間內消化，
  禁止遞迴（遞迴會被自己的 guard 擋回，pending 永遠不重跑）
- **`start()` 的錯誤語義**：初始讀取錯誤往上拋（`WorkflowAttachment.attachAgent`
  的 rollback 依賴），poll/watch 的錯誤走 `onError` — 兩條路徑共用
  `readCycle()` 但錯誤處理分離

✅ v1 已落地（commit `ef1ed20`）。v2 剩餘工作：把「baseline 描述已處理內容」
寫進 `FileWatcher` 的類別層級註解與 `readCycle` 的函數名（改名
`readAndUpdateBaseline`），讓未來修改者無法寫出吞資料的順序。

### 4.2 jsonMode 與 JSONL 的 fingerprint 統一

v1 修復後已接近目標形狀，v2 收尾：

```ts
// 兩套機制統一為「content fingerprint」
// JSONL:   { offset: lastReadOffset }              — 增量讀取的游標
// jsonMode:{ length: lastContentLength, hash: lastContentHash }
// poll 觸發條件只有一個：fingerprint !== baseline
```

`lastMtimeMs` 降級為 fs.watch 的輔助信號，**不進 baseline 語義** —
same-size rewrite 的偵測不再依賴「baseline 先行」的時序約定，而是
jsonMode 的 hash 比對直接命中。

### 4.3 樹狀 replay 過濾：從 parser 移到 watcher 層

**v1 的形狀**：`beginHistory()`/`flushHistory()` 掛在共用 `LineParser`
介面（optional），`index.ts` 特判呼叫時機，依賴「`start()` await 初始
讀取」的隱含契約（CLAUDE.md 散文維繫，型別不可見）。

**v2 設計**：

1. `WatchOptions` 新增 `onInitialDumpComplete?: () => void` — FileWatcher
   在初始讀取完成時觸發的**明確事件**，取代「start() await 初始讀取」的
   隱含契約
2. 樹狀過濾做成獨立 decorator，不進 `LineParser` 介面：

```ts
// src/core/active-path-filter.ts
export class ActivePathFilter {
  // beginHistory / flushHistory 的邏輯原封不動搬進來
  // 包裝任意 LineParser：緩衝期間收集，flush 後 live 透傳
  constructor(inner: LineParser, private walkParent: (entry: unknown) => string | null) {}
}
```

3. `LineParser` 介面移除 `beginHistory`/`flushHistory` — 介面回到
   `parse()` + `setConversationId()` 的純粹形狀

**收益**：`LineParser` 介面回到單一職責；下一個樹狀格式 agent 只提供
`parentIdWalk` 實作，不碰介面；`index.ts` 的 pi 特判消失。

### 4.4 replay 的記憶體：兩段式索引

v1 的 `flushHistory` 把整個初始 dump 的 entries buffer 在記憶體（含解析後
的 JSON）。10MB+ 的 session 會有記憶體尖峰。

v2 改為兩段式：第一段只記 `{ id, parentId, byteOffset }` 索引（輕量），
flush 時沿 `parentId` 算出 active path 的 byte 區間，第二次讀取只解析
路徑上的行。前提：replay 過濾掛在 watcher 層（§4.3）— parser 只看行序列，
拿不到檔案路徑，做不了二次讀取。

**取捨**：v1 的 buffer 模型在 ≤10MB session 上沒有實際問題（緩衝是暫態的），
兩段式是「大 session 友善」的優化，不是正確性修復。排程上放最後。

### 4.5 `-p` 過濾的分層語義

| 方法 | 過濾依據 | 理由 |
|------|----------|------|
| `findLatest` / `listSessions` | encoded dir name fuzzy | 成本考量，可接受誤差 |
| `findBySessionId`（多重匹配時） | header cwd 消歧 | 正確性優先 |
| `findLatestInProject` | header cwd 嚴格（v1 已做） | 碰撞安全 |

v1 的 `findLatestInProject` 已做對（mtime 降序 + 第一個 header cwd 吻合即
返回）；v2 把 `findBySessionId` 的 `-p` 也補上同樣的消歧 — 候選 > 1 時
才讀 header（成本只在多重匹配時發生）。這同時解掉 Codex 與 pi 共有的
「`-p` 在 sessionId 模式下不可靠」限制。

### 4.6 FileWatcher race 測試的 DI

v1 的 race regression test 依賴兩個技巧：onLine 回呼裡同步寫檔（製造
baseline 空窗）、內部狀態斷言（`lastSize === lastReadOffset`）。macOS 的
FSEvents 會在部分場景「救場」（註冊後送達註冊前的事件），讓某些 race
難以確定性重現。

v2：FileWatcher constructor 加 `injectedStat?: (path) => Promise<Stats>`，
race 測試直接控制「read 與 baseline 更新之間」的檔案狀態 — 完全確定性，
不依賴同步回呼副作用與平台 fs.watch 行為。

## 5. 資料流（v2 時序）

```
T0        → agent-tail 啟動，registry 解析 'pi' → PiAgent（finder + parser）
T0+stat   → readCycle: updateMtime（baseline 先行）→ firstRead（整檔）
T0+讀完   → alignSizeBaseline（lastSize = lastReadOffset）
          → onInitialDumpComplete → ActivePathFilter.flushHistory()
            → 沿 parentId 從最後 entry 走回 root，只輸出 active 路徑
            → parser 切換 live 模式
T0+live   → poll/watch → incrementalRead → parse() 直接輸出（append 永遠在 leaf）
T0+切換   → super-follow → 重建 parser（registry.recreateOnSwitch）→ 同上
```

死分支的處理時點：**只在初始 replay**。live appends 永遠寫在當前 leaf
（pi 是 append-only），linear 讀取即正確 — v1 的實測結論維持不變。

## 6. CLI 介面（v1 已落地，v2 不變）

| 命令 | 支援 |
|------|------|
| `agent-tail pi` | ✅ main session tail |
| `agent-tail pi -p <pattern>` | ✅ encoded dir fuzzy（`--list`）/ header cwd（auto-switch） |
| `agent-tail pi <uuid-prefix>` | ✅ UUID partial match（精確 > 前綴 > 包含 > 全路徑） |
| `agent-tail pi --list` | ✅ 6-col contract；`session_info.name` → TITLE |
| `agent-tail pi --summary` | ✅ head+tail（parser 預設 live 模式，drainArg='' 相容） |
| `agent-tail pi --auto-switch` | ✅ header cwd 權威驗證 |
| `agent-pick pi` | ✅ |
| `--subagent` / `-i` / `--pane` / `--with-subagents` / `--all` | ❌ 見 §8 |

## 7. 測試計畫（邊界矩陣先行）

v1 的教訓：FileWatcher 的 4 條 race 是 review 逼出來的。v2 的測試計畫
先列「檔案狀態 × 寫入時序」矩陣，再寫實作：

| # | 檔案狀態 | 寫入時機 | 鎖定方式 |
|---|----------|----------|----------|
| 1 | 非空 JSONL | read 期間（onLine 內同步 append） | pending drain：start 返回後立即斷言（pollInterval 60s） |
| 2 | 非空 JSONL | read 後、baseline 更新前 | `lastSize === lastReadOffset` 內部斷言（poll 推進前） |
| 3 | 空 JSONL | 第一行寫入 | `lastSize === 0` 對齊 + poll 補讀 |
| 4 | jsonMode | size-changing rewrite（onLine 內） | `lastSize === lastContentLength` 斷言 |
| 5 | jsonMode | same-size rewrite | mtime baseline（讀前值）偵測 |
| 6 | 樹狀 session | 死分支 / metadata leaf / -n 截斷 | flushHistory 的 walk 邊界 |
| 7 | encoded dir 碰撞 | `/a/b-c` vs `/a/b/c` | header cwd 嚴格過濾 |

每個 regression test 必須通過 **stash 對照**：`git stash` 掉修復後測試必須紅。
「poll 掩蓋 bug」是這次學到的最大教訓 — 斷言要在 poll 補救之前做。

## 8. 明確不做

- **subagent / interactive / pane**：`~/.pi/agent/ferris-pi-subagents/` 是
  extension 私有格式。等 pi 官方收進核心格式再評估。
- **樹狀 live 過濾**：live tail 維持 linear（append-only 保證新訊息在檔尾；
  切回舊分支繼續講的訊息也 append 在尾端，linear 讀取語義正確）。
- **autoTitle**：first-prompt 抽取是 Claude JSONL 的形狀（wrapper tag 白名單
  等），pi 的 `session_info.name` 已提供 TITLE 欄位。

## 9. 驗收標準

1. `agent-tail pi` / `--list` / `--summary` / `<uuid-prefix>` / `--auto-switch`
   / `agent-pick pi` 全部可用（v1 已驗證）
2. 含死分支的 session：replay 只輸出 active path（leaf→root），live append
   即時輸出（herdr pane e2e 已驗證）
3. FileWatcher 邊界矩陣（§7 表）全數有確定性 regression test，且對照舊實作
   會紅（git stash 驗證法）
4. 新增 agent 的接線點 ≤ 2（agent 檔案 + registry 一行）— 以 registry 遷移
   完成後的下一個 agent 驗證
5. typecheck / lint / format / 全套測試乾淨

## 10. 落地狀態

| 項目 | 狀態 |
|------|------|
| §2 baseline 語義（alignSizeBaseline + baseline 先行 + readCycle） | ✅ v1 已落地（race 修復） |
| pi finder/parser/CLI/--list/agent-pick | ✅ v1 已落地（commit ef1ed20） |
| §4.1 registry、§4.3 fingerprint 統一、§4.6 callback、§4.5 MultiEmitParserBase | ⬜ 待重構（觸發條件見各節） |
| §4.7 findBySessionId 的 header cwd 消歧 | ⬜ 待辦（低頻場景） |
