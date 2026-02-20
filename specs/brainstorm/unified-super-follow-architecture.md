# Unified Super Follow Architecture（通用架構重構）

> 生成日期：2026-02-20
> 狀態：Brainstorm / Future Consideration

---

## 背景

目前的 Super Follow 實作是 Claude 專用的，若要支援 Gemini 和 Codex，有兩條路：

1. **漸進式**：各自實作 `findLatestInProject`，複用 `createSuperFollowController`（目前計畫）
2. **統一架構**：抽象出通用介面，所有 agent 共用同一套流程

本文檔探討「統一架構」的可能性，作為未來重構的參考。

---

## 設計理念

### 核心抽象

```
┌─────────────────────────────────────────────────────────────┐
│                    SuperFollowController                     │
│  (核心輪詢與切換邏輯 - agent 無關)                            │
│                                                             │
│  - 定期輪詢 (500ms)                                         │
│  - 延遲切換 (5s)                                            │
│  - 去重機制                                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ depends on
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 LatestSessionFinder (介面)                  │
│                                                             │
│  + findLatest(scope: Scope): Promise<SessionFile | null>    │
│  + getScope(sessionPath: string): Promise<Scope | null>     │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ClaudeFinder     │  │CodexFinder      │  │GeminiFinder     │
│                 │  │                 │  │                 │
│ Scope: {        │  │ Scope: {        │  │ Scope: {        │
│   projectDir    │  │   cwd,          │  │   projectDir,   │
│ }               │  │   dateRange?    │  │   hash?         │
│                 │  │ }               │  │ }               │
│ 實作:           │  │                 │  │                 │
│ - UUID.jsonl    │  │ 實作:           │  │ 實作:           │
│ - subagents/    │  │ - session_meta  │  │ - .project_root │
│                 │  │ - 快取索引      │  │ - 目錄名稱      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Scope 介面

```typescript
// src/core/types.ts

/**
 * Super Follow 的搜尋範圍
 * 不同 agent 有不同的範圍定義
 */
export type Scope =
  | { type: 'claude'; projectDir: string }
  | { type: 'codex'; cwd: string; dateRange?: { start: Date; end: Date } }
  | { type: 'gemini'; projectDir: string; projectHash?: string };
```

---

## 實作細節

### 1. 統一的 LatestSessionFinder 介面

```typescript
// src/agents/agent.interface.ts

export interface LatestSessionFinder {
  /**
   * 從 session 路徑識別其所屬的 Scope
   */
  getScope(sessionPath: string): Promise<Scope | null>;

  /**
   * 在指定 Scope 內找最新的 session
   */
  findLatest(scope: Scope): Promise<SessionFile | null>;
}
```

### 2. 重構後的 SuperFollowController

```typescript
// src/core/super-follow.ts (新檔案)

export interface SuperFollowControllerConfig {
  scope: Scope;
  getCurrentPath: () => string;
  onSwitch: (nextFile: SessionFile) => Promise<void>;
  autoSwitch: boolean;
  finder: LatestSessionFinder;  // 注入 finder
}

export function createSuperFollowController(
  config: SuperFollowControllerConfig
): { start: () => void; stop: () => void } {
  const { scope, finder, ...rest } = config;

  const poll = async () => {
    const latest = await finder.findLatest(scope);
    // ... 切換邏輯
  };

  // ...
}
```

### 3. Agent 實作範例

#### Claude 實作

```typescript
// src/agents/claude/claude-finder.ts

export class ClaudeLatestSessionFinder implements LatestSessionFinder {
  async getScope(sessionPath: string): Promise<Scope | null> {
    // ~/.claude/projects/{encoded-path}/{uuid}.jsonl
    //                ^^^^^^^^^^^^^^
    const projectDir = dirname(sessionPath);
    return { type: 'claude', projectDir };
  }

  async findLatest(scope: Scope): Promise<SessionFile | null> {
    if (scope.type !== 'claude') return null;
    // ... 現有 findLatestMainSessionInProject 邏輯
  }
}
```

#### Gemini 實作

```typescript
// src/agents/gemini/gemini-finder.ts

export class GeminiLatestSessionFinder implements LatestSessionFinder {
  async getScope(sessionPath: string): Promise<Scope | null> {
    // ~/.gemini/tmp/{hash}/chats/session-*.json
    //               ^^^^
    const chatsDir = dirname(sessionPath);
    const projectDir = dirname(chatsDir);

    // 嘗試讀取 .project_root
    const projectRootPath = join(projectDir, '.project_root');
    // ...

    return { type: 'gemini', projectDir };
  }

  async findLatest(scope: Scope): Promise<SessionFile | null> {
    if (scope.type !== 'gemini') return null;
    // ... 掃描 chats/ 目錄
  }
}
```

#### Codex 實作（帶快取）

```typescript
// src/agents/codex/codex-finder.ts

export class CodexLatestSessionFinder implements LatestSessionFinder {
  private cache: CodexSessionCache;

  async getScope(sessionPath: string): Promise<Scope | null> {
    // 解析 session_meta 取得 cwd
    const meta = await this.parseSessionMeta(sessionPath);
    if (!meta?.cwd) return null;

    return {
      type: 'codex',
      cwd: meta.cwd,
      dateRange: { start: subDays(new Date(), 7), end: new Date() }
    };
  }

  async findLatest(scope: Scope): Promise<SessionFile | null> {
    if (scope.type !== 'codex') return null;

    // 使用快取索引查找
    return this.cache.getLatestByCwd(scope.cwd);
  }
}
```

---

## 優缺點分析

### 優點

| 項目 | 說明 |
|------|------|
| **統一介面** | 所有 agent 使用相同的 API |
| **易於擴展** | 新增 agent 只需實作 `LatestSessionFinder` |
| **可測試** | 可以 mock finder 進行測試 |
| **關注點分離** | 控制器邏輯與 agent 細節解耦 |

### 缺點

| 項目 | 說明 |
|------|------|
| **過度抽象** | 目前只有 3 個 agent，可能不需要這麼多抽象 |
| **增加複雜度** | 需要理解 Scope 類型和型別守衛 |
| **維護成本** | 介面變更時需更新所有實作 |

---

## 決策建議

### 短期（Phase 1-2）

**採用漸進式方案**：
- 各 agent 自行實作 `findLatestInProject`
- 複用現有 `createSuperFollowController`（稍作修改）
- 不引入新的抽象層

### 長期（Phase 3+）

**考慮統一架構**，當：
- 新增第 4 個 agent 時
- 發現各 agent 實作有大量重複邏輯時
- 需要更複雜的 scope 管理（如跨專案搜尋）時

---

## 遷移路徑

如果決定從漸進式遷移到統一架構：

1. **建立新介面**：定義 `LatestSessionFinder` 和 `Scope`
2. **包裝現有函數**：將 `findLatestInProject` 包裝為 finder
3. **重構控制器**：`createSuperFollowController` 改為接受 finder
4. **逐個遷移**：Claude → Gemini → Codex
5. **移除舊程式碼**：清理重複邏輯

---

## 結論

統一架構是更「乾淨」的設計，但對於目前的規模（3 個 agent）可能過早優化。

**建議**：先完成漸進式實作，觀察實際使用情況，再決定是否重構。

> "Premature optimization is the root of all evil." — Donald Knuth
