# agent-pick: Enter 後參數轉傳

> 日期：2026-04-04
> 狀態：已實作（2026-04-05）

## 問題

`agent-pick` 按 Enter 啟動 `agent-tail` 時，只傳 `agent-tail <type> <shortId>`，不繼承使用者的其他參數。

## 期望行為

```bash
agent-pick claude -v --with-subagents
# Enter 後 →
agent-tail claude <shortId> -v --with-subagents
```

## 實作結果

已在 `src/pick/index.ts` 與 `src/pick/arg-passthrough.ts` 完成參數拆分：
- `extractPickListArgs(rawArgs)`：只保留 list 階段需要的參數，避免 `parseArgs(..., --list)` 和 tail 參數互斥
- `extractTailPassthroughArgs(rawArgs)`：只保留 Enter 後要轉傳給 `agent-tail` 的參數
- 最終執行：`agent-tail <type> <shortId> ...passthroughArgs`

需要排除的參數（不轉傳）：
- `-n` / `--lines`：list 模式專用
- `-p` / `--project`：Codex findBySessionId 的 project filter 有已知 bug
- `--list`：agent-pick 內部加的
- agent-type positional arg

應該轉傳的參數：
- `-v` / `--verbose`
- `-a` / `--all`
- `--with-subagents`
- `--pane`
- `-i` / `--interactive`
- `--auto-switch`
- `--raw`
- `-q` / `--quiet`
- `-s` / `--sleep-interval`

## 驗證

- `tests/pick/arg-passthrough.test.ts` 新增覆蓋：
  - list-only 參數剔除
  - inline 參數（`--project=...`、`-p=...` 等）
  - required-value 參數對下一個 token 的 greedy consume（含 `-p -v` 邊界）
