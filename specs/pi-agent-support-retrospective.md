# Pi Agent Support — 如果重新來一次（Retrospective Spec）

## 概述

以「如果重新來一次」的視角回顧 Pi agent 支援的實作（commit `ef1ed20`，2026-08-30）。
這份文件不是事後諸葛清單 — 每一項都對應這次實作中**實際踩到**的問題（多數由
codex review-loop 的 5 輪循環抓出），並給出重來一次時會採用的設計。

範圍：pi agent 本身的實作決策 + 被它暴露出來的共用模組（FileWatcher、agent 註冊）
既有設計債。每項標注優先級與重構成本，供未來排程參考。

## 會保留的設計（先講做對的）

重來一次不會動的部分，記錄下來避免未來被「重構」掉：

1. **樹狀 active-path replay filter 的「緩衝 + flush」模型**。pi 的樹狀結構
   （`id`/`parentId`）意味著初始 replay 必須兩段式：先收集、算出 leaf→root
   路徑、再輸出。這個模型正確且成本低（buffer 只在初始 dump 期間存在）。
   問題不在模型本身，而在它的**掛載點**（見 §1）。
2. **`findLatestInProject` 用 header cwd 嚴格驗證**。encoded dir name 不可逆
   （`-` 可能是分隔符或字面連字號），`/work/foo-bar` 與 `/work/foo/bar` 碰撞
   到同一目錄。這次 review 抓到後改成 header cwd 驗證 — 如果重來，這會是
   第一版就有的設計，而不是 review 補丁。
3. **dedup guard 的 Cursor 模式**（`lastProcessedLine` 在 drain 完成後保留）。
   這個模式被證明是對的，而且這次有前例可查（CLAUDE.md 的事故記錄）。
4. **`--subagent`/`--interactive`/`--pane` 不做**。pi 的 subagent 目錄
   （`~/.pi/agent/ferris-pi-subagents/`）是 extension 私有格式，不受官方
   保證。MVP 範圍的紀律這次守住了。

## 會修改的設計

### 1. `beginHistory()`/`flushHistory()` 不該掛在共用的 `LineParser` 介面上

**優先級**: 🔴 高（介面污染 + 隱含契約）

**這次怎麼做的**：pi 的樹狀過濾需求透過 `LineParser` 的兩個 optional 方法
（`beginHistory()` / `flushHistory()`）實現，由 `startSingleWatch` 在
`watcher.start()` 前後手動呼叫。時機依賴一個**隱含契約**：`FileWatcher.start()`
會 await 初始讀取。

**踩到的問題**：
- 共用介面被單一 agent 的需求污染 — 其他 5 個 agent 永遠不會實作這兩個方法
- 呼叫時機綁在 `index.ts` 的特判程式碼裡，`FileWatcher` 若改變「start() 是否
  await 初始讀取」的行為，pi 的過濾會靜默失效（buffer 永遠不 flush → 零輸出）
- `--summary` 路徑不呼叫 flush — parser 必須設計成「預設 live 模式」才不會
  在 summary 下輸出空白。這個隱含約束沒有型別保護

**重來會這樣做**：
- FileWatcher 提供 `onInitialDumpComplete` callback（初始 dump 完成的明確
  事件），parser 訂閱它，`index.ts` 的特判消失
- 或者：把「樹狀重播過濾」做成獨立的 decorator（`ActivePathFilter`），包在
  `PiLineParser` 外面，`LineParser` 介面不動。樹狀過濾是「格式屬性」不是
  「parser 能力」，介面不該為單一格式開洞

**觸發條件**：下一個樹狀格式 agent 出現時（或 FileWatcher 重構時）。

### 2. FileWatcher 的 baseline 語義：一開始就該是「已處理內容」

**優先級**: 🔴 高（已修，但這是重新設計會直接做對的部分）

**這次怎麼做的**：baseline（`lastSize`/`lastMtimeMs`）原本是「read 完成後某個
瞬間的 stat 值」。這次 pi 的 review 追出了 **4 條** race 路徑，全部根源相同：

- pending drain 用遞迴 → 被自己的 `isProcessing` guard 擋回，pending 永遠不重跑
- baseline 在 read 之後 stat → 空窗期的 append/rewrite 被吞進 baseline，
  poll 誤判「沒有變化」而永久跳過
- jsonMode 跳過對齊、空 JSONL 的 `lastReadOffset > 0` 條件 — 兩個邊界路徑
  各自要一輪 review 才被發現

**重來會這樣設計**：baseline 的定義從第一天就是「已處理內容的狀態」：

```
readCycle():
  1. updateMtime()        # baseline 先行（mtime = 讀取開始前的值）
  2. readAndProcess()     # 處理內容，lastReadOffset / lastContentLength 前進
  3. alignSizeBaseline()  # lastSize = 已處理長度（JSONL: lastReadOffset 含 0；
                          #  jsonMode: content byteLength）
```

而不是「read 完成後再 stat 一次」。這次的修復是補丁式的（先修 pending drain、
再修 baseline、再修 jsonMode、再修空檔案 — 每輪 review 揭露一條新路徑），
根源是 baseline 的語義從一開始就沒有被明確定義。

**教訓**：共用模組的狀態語義要在註解/型別層級寫死（「baseline 描述已處理內容，
不是 stat 瞬間」），讓未來的修改者無法寫出吞資料的順序。

### 3. jsonMode 與 JSONL 的兩套 baseline 機制

**優先級**: 🟡 中

**這次怎麼做的**：jsonMode 用 content hash 比對、JSONL 用 byte offset —
兩套偵測機制、兩套 baseline 語義。race 修復時每條路徑都要想兩次
（alignSizeBaseline 的 jsonMode 分支、mtime baseline 的差異）。

**重來會這樣設計**：統一成「content fingerprint」概念 —
`{ length: number, hash?: string }`。JSONL 的 fingerprint 是
`(lastReadOffset, undefined)`，jsonMode 是 `(contentLength, contentHash)`。
poll 的觸發條件只有一個：`fingerprint !== baseline`。這次修復後其實已經
接近這個形狀（`alignSizeBaseline` + hash），但 `lastMtimeMs` 仍然是第三套
獨立狀態 — 它的存在讓 same-size rewrite 的偵測依賴「baseline 先行」的
時序約定。如果重新設計，jsonMode 直接用 hash + 長度雙條件，mtime 只做
fs.watch 的輔助，不進 baseline。

### 4. Agent 註冊表取代散落的特判清單

**優先級**: 🟡 中（每加一個 agent 成本線性上升）

**這次踩到的**：新增 `pi` 一共動了 **7 個檔案的 9 個接線點**：

| 位置 | 要改什麼 | 這次有沒有漏 |
|------|----------|--------------|
| `src/core/types.ts` AgentType union | 加 `'pi'` | ✓ |
| `src/cli/parser.ts` 驗證 if-chain + 錯誤訊息 | 加 `'pi'` | ✓ |
| `src/index.ts` 實例化三元鏈 | 加分支 | ✓ |
| `src/index.ts` stateful drain 清單 | 加 `'pi'` | ✓ |
| `src/index.ts` parser 重建清單 | 加分支 | ✓ |
| `src/pick/index.ts` `AGENT_TYPES` | 加 `'pi'` | ❌ codex review 抓到 |
| `--auto-switch` help text | 加 Pi | ❌ codex review 抓到 |

漏掉的兩處都是「清單散落多處」的直接後果。

**重來會這樣設計**：agent capabilities registry —

```ts
// src/agents/registry.ts — 單一來源
export const AGENT_REGISTRY: Record<AgentType, AgentCapabilities> = {
  pi: {
    factory: () => new PiAgent(),
    statefulParser: true,      // drain 清單自動涵蓋
    recreateOnSwitch: true,    // session 切換時重建 parser
    jsonMode: false,
    supportsSubagent: false,   // CLI 驗證自動拒絕
    supportsInteractive: false,
    supportsPane: false,
  },
  // ...
};
```

`index.ts` 的三元鏈、stateful 清單、jsonMode 特判、CLI 的 per-agent 驗證、
agent-pick 的清單，全部從 registry 導出。新增 agent = 一個檔案 + registry
一行。這次 `AGENT_TYPES` 漏掉 pi 正是因為它是一份手抄清單。

### 5. multi-emit state machine 已經抄了三次

**優先級**: 🟡 中

Claude、Cursor、pi 三個 parser 都實作了同一個模式：`currentMessageState`
（block 佇列 + index）+ `lastProcessedLine` dedup guard + 「drain 完成後
清 state 但保留 lastProcessedLine」。這個模式有兩個已知的坑（drainArg=''
斷流、清掉 lastProcessedLine 造成無限迴圈），每個新 agent 都要重新踩一遍
或靠 CLAUDE.md 的事故記錄避開。

**重來會這樣設計**：抽 `MultiEmitParserBase`：

```ts
abstract class MultiEmitParser implements LineParser {
  // 管理 currentMessageState / lastProcessedLine / dedup guard / drain 契約
  // 子類別只實作：blocksOf(entry): ParsedLine[]（block → ParsedLine 映射）
  protected abstract toParts(entry: unknown): ParsedLine[];
}
```

agent parser 從 ~150 行的狀態機縮減到一個純映射函數。Cursor 的
`lastProcessedLine` 事故（清掉 guard 導致無限迴圈）就不可能再發生 —
guard 的正確性寫一次、測一次。

### 6. replay filter 的掛載點：parser 不該知道 FileWatcher 的時序

**優先級**: 🟡 中

**這次的隱含契約**：`flushHistory()` 必須在 `FileWatcher.start()` resolve
之後呼叫（start 會 await 初始讀取）。這個契約寫在 CLAUDE.md 而不是型別裡 —
如果 FileWatcher 改成「start 立即返回、初始讀取非同步」，pi 的過濾靜默失效
（buffer 永遠不 flush）。

**重來會這樣設計**：FileWatcher 的 `WatchOptions` 加
`onInitialDumpComplete?: () => void`，由 watcher 在初始讀取完成時觸發。
pi 的 begin/flush 改訂閱這個事件，`index.ts` 不需要知道 pi 有這個需求。
或者更進一步：replay 過濾完全移出 parser — FileWatcher 的初始讀取把
「原始行陣列」交給一個 `ReplayFilter`（pi 提供 `parentIdWalk` 實作），
parser 收到的就是已過濾的行序列。parser 回到純粹的「行 → ParsedLine」。

**成本**：FileWatcher 介面變更 + 兩個 caller 更新。收益：下一個樹狀格式
agent（或 pi 格式改版）不用再動 `index.ts`。

### 7. `-p` 過濾的雙軌語義

**這次怎麼做的**：`--list` / `findLatest` 用 encoded dir name fuzzy match
（快，但 `/work/foo-bar` 與 `/work/foo/bar` 碰撞）；`findLatestInProject`
用 header cwd 嚴格驗證（準，每候選一次 head-read）。`findBySessionId` 的
`-p` 過濾走 dir name fuzzy — 跟 Codex 一樣有已知的「-p 在 sessionId 模式
下不可靠」問題。

**重來會這樣設計**：`-p` 的語義分層寫進介面文件 —
- `findLatest` / `listSessions`：dir name fuzzy（成本考量，可接受誤差）
- `findBySessionId` / `findLatestInProject`：header 權威值（正確性優先）

這次 pi 的 `findLatestInProject` 已經做對（header cwd 驗證），但
`findBySessionId` 的 `-p` 還是 fuzzy — 跟 Codex 的同一個限制。統一的話，
pi 的 `findBySessionId` 應該在候選 > 1 時用 header cwd 消歧（成本：每候選
一次 4KB head-read，只在有多重匹配時發生）。

### 8. finder helper 的 options 參數防禦

**優先級**: 🟢 低（但這次真的踩到）

`_collectSessions(options)` 的廣泛 try/catch 把 `options.project` 的
TypeError 吞成空結果 — `findBySessionId(id)` 不帶 options 時靜默回 null。
生產路徑都會傳 options 所以沒炸，但測試直接呼叫就踩到了。

**重來會這樣設計**：finder 的公開方法參數一律 `options: X = {}` 內建預設
（這次已修），並且 helper 內部對 `options?.project` 使用 optional chaining
— 防禦性預設不是可選的裝飾，是 broad try/catch 的必要配套。

### 9. 共用模組修改的 review 前置：邊界矩陣

**優先級**: 🟡 中（流程教訓）

這次 review-loop 跑了 5 輪才收斂，其中 3 輪都在修 FileWatcher 的 baseline
race — 而且每一輪都揭露新的邊界（非空 JSONL → jsonMode → 空 JSONL →
same-size rewrite）。這些邊界其實可以事先窮舉：

| 檔案狀態 | 寫入類型 | 場景 |
|----------|----------|------|
| 非空 JSONL | append | pi/claude/codex 日常 |
| 空 JSONL | 第一行 | 新 session 啟動 |
| jsonMode | size-changing rewrite | gemini/agy 正常更新 |
| jsonMode | same-size rewrite | hash 機制的盲區 |
| truncate / atomic replace | — | 已有處理 |

**教訓**：修改共用 hot path 時，先自己跑完「寫入類型 × 時序」矩陣的測試
設計，再交 review。這次 5 輪裡有 3 輪在補邊界 — 邊界矩陣先列，可以省
2-3 輪。

### 10. FileWatcher 的「初始 dump 完成」沒有明確信號

**這次踩到的**：pi 的 `flushHistory()` 依賴「`watcher.start()` await 初始
讀取」這個隱含契約（CLAUDE.md 記錄在案，但型別不可見）。`startSingleWatch`
在 `watcher.start()` 之後手動呼叫 `flushHistory()` — 如果 FileWatcher 的
實作改變（例如初始讀取改為非同步），過濾靜默失效。

**重來會這樣設計**：`WatchOptions` 加 `onInitialDumpComplete?: () => void`
（或讓 `start()` 的 resolve 語義進型別註解），replay filter 的觸發變成
明確的事件而不是「呼叫順序慣例」。這同時讓 §6 的 replay decorator 有
乾淨的掛載點。

### 11. 測試對 race 的確定性鎖定成本

**這次學到的**：race 的 regression test 要「在 poll 掩蓋之前斷言」—
`start()` 返回後立即斷言、或斷言內部狀態（`lastSize === lastReadOffset`），
否則 polling 會補救壞掉的修復讓測試偶發通過。jsonMode 的 rewrite 要放在
onLine 回呼裡才會落在 baseline 空窗。這些技巧這次是靠 `git stash` 對照舊
代碼逐個驗證的。

**重來會這樣設計**：FileWatcher 的 `stat`/時鐘可注入（constructor 選項），
race 測試直接控制「read 與 baseline 更新之間」的檔案狀態，不需要依賴
同步 onLine 回呼的副作用。成本：FileWatcher 建構子多一個 optional 參數。

## 優先級總覽

| # | 項目 | 優先級 | 觸發條件 |
|---|------|--------|----------|
| 2 | FileWatcher baseline 語義重設計 | 🔴 高 | 已完成（本次修復） |
| 8 | Agent capabilities registry | 🟡 中 | 下次新增 agent 時 |
| 6 | FileWatcher initial-dump-complete callback | 🟡 中 | 下一個樹狀格式 agent |
| 3 | multi-emit state machine 抽共用 base | 🟡 中 | 第三個 stateful parser 出現時 |
| 1 | beginHistory/flushHistory 移出共用介面 | 🟡 中 | 同上 |
| 7 | -p 過濾統一用 header cwd | 🟡 中 | 下次 pi/cursor -p 誤判時 |
| 9 | race 測試的 DI 注入 | 🟢 低 | 下次改 FileWatcher 時順手 |
| 13 | timestamp 時區標示 | 🟢 低 | 有使用者困惑再說 |

## 教訓摘要

1. **共用模組的修改，邊界矩陣先行**：這次 FileWatcher 的 4 條 race 路徑
   是 review 逼出來的，不是測試計畫窮舉的。下次改共用模組，先列邊界矩陣。
2. **清單式接線是 bug 溫床**：agent-type 的散落清單（types、CLI、index、
   pick）已經漏過一次。registry 化的收益隨 agent 數量線性增長。
3. **baseline 的語義要寫進型別/函數名**：`updateMtime` 這個名字隱藏了它
   同時更新 size 的事實，也是 race 的溫床。`alignSizeBaseline` 的命名
   （對齊已處理內容）是這次修復後才有的正確抽象。
4. **隱含契約要變成明確介面**：`watcher.start()` await 初始讀取 →
   parser flush 的依賴，靠 CLAUDE.md 的散文維繫。明確的 callback 或
   decorator 才是可維護的形狀。
