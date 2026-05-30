# Workflow Session Log Support — Implementation Spec

## 1. Overview / Goal

Claude Code 2.1.x 起新增 `Workflow` 工具，啟動的 multi-agent workflow run 在
session 目錄底下產生一組額外的 log 檔案（journal、subagent transcript、snapshot
JSON、script）。**agent-tail 目前完全看不到這層**。

本 SPEC 目標：讓 agent-tail 成為 workflow log 的一等公民監控工具，能：

1. **發現** 進行中或歷史的 workflow run（first-class source，可被 `listSessions` 列出）
2. **即時偵測** 新 workflow 啟動 — 主 session JSONL 中 `Workflow` 工具的
   `tool_result.toolUseResult.status === "async_launched"` 出現後立即取得
   `runId / transcriptDir`，attach journal + agents。延遲 = JSONL 連續兩行寫入間隔
   （實測幾十毫秒），比 `fs.watch` 仍快很多
3. **完整呈現** workflow main 軌跡（journal）+ N 個 subagent transcript +
   snapshot metadata（phase 進度、workflow name）
4. **整合互動模式** — workflow 與其 subagents 各佔一個 SessionManager tab；tmux
   pane 動態開合（FIFO eviction）

**目標時序**（修正版，與 §9.1 path A 一致）：

```
T0          → Assistant 主 session 寫入 Workflow tool_use（pending state，runId 未知）
T0+~ms      → agent-tail tail 看到 tool_use，記下「workflow launching」（尚未 attach）
T0+~50ms~   → Workflow 完成 async launch，主 session 寫入 tool_result（含 runId + transcriptDir）
            → agent-tail 同步解析 → WorkflowDetector.handleMainLine → attach journal.jsonl
T0+早       → workflow 內第一個 subagent 啟動 → §9.3 inner dir-watch attach agent-*.jsonl
T0+各階段    → 每個 subagent 啟動／結束 → 動態 attach（subagent 流出 / pane FIFO eviction）
T0+結束     → wf_*.json snapshot 更新 status="completed"
            → SnapshotWatcher → status event / status line 顯示完成
            → WorkflowAttachment.stop('completed')
```

> **關鍵說明**：早期偵測**不是 T0+0**——必須等 main session 收到 tool_result（含 `toolUseResult.status="async_launched"` 才有 runId / transcriptDir）。實測延遲約幾十毫秒（同一條 main session JSONL 連續寫入兩行）。比 `fs.watch` 仍快非常多（fs 事件有 IO buffer），且**不需要等 workflows/wf_*.json 落盤**。

## 2. Background — 現有架構

### 2.1 已支援的 session log 來源

| Harness | Main session 路徑                                                                    | Subagent 機制                                          |
| ------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Claude  | `~/.claude/projects/{enc-cwd}/{UUID}.jsonl`                                          | `{enc-cwd}/{UUID}/subagents/agent-*.jsonl`（扁平）     |
| Codex   | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                                       | 同日期目錄 `rollout-*-{UUID}.jsonl`                    |
| Cursor  | `~/.cursor/projects/{slug}/agent-transcripts/{UUID}/{UUID}.jsonl`                    | `{UUID}/subagents/{UUID}.jsonl`                        |
| Gemini  | `~/.gemini/tmp/{proj}/chats/session-*.json`                                          | — 無                                                   |

### 2.2 既有可重用元件（必須重用，不重新發明）

- `Agent` / `SessionFinder` / `LineParser` 介面（`src/agents/agent.interface.ts:1-93`）
- `FileWatcher` / `MultiFileWatcher`（`src/core/`）
- `SubagentDetector` 雙保險設計：directory watch + event-driven（`src/claude/subagent-detector.ts:28-52`）
- `OnLineHandlerConfig`（`src/claude/watch-builder.ts:94-100`）
- `SessionManager` + `DisplayController`（interactive mode）
- `PaneManager`（tmux，max 6 panes）
- `ClaudeLineParser`（重用於 workflow 內 agent-\*.jsonl，**格式相同**）

### 2.3 SubagentDetector 的雙保險（本 SPEC 沿用相同模式）

Claude 的 SubagentDetector 同時做兩件事：

1. **Event-driven**：監聽 main JSONL 的 `Task` tool_use → 立刻掃描 `subagents/`
2. **Directory watch**：`fs.watch(subagentsDir)` → 新檔案出現也接

Workflow detection 採同樣模式：early detection（from main JSONL Workflow event）+ directory watch（fallback）。

## 3. Workflow Log File Layout

Workflow run 啟動時，Claude Code 在 main session 目錄下產生**四個位置**的檔案：

### 3.1 路徑彙總

```
~/.claude/projects/{enc-cwd}/{session-uuid}/
├── workflows/
│   ├── wf_{8hex}-{3hex}.json              ← snapshot（A）
│   └── scripts/
│       └── {workflow-name}-wf_{...}.js    ← workflow 腳本（D）
└── subagents/workflows/
    └── wf_{8hex}-{3hex}/
        ├── journal.jsonl                  ← workflow 事件流（B）
        ├── agent-{17hex}.jsonl × N        ← 每個 subagent transcript（C）
        └── agent-{17hex}.meta.json × N    ← subagent metadata
```

> 注意：subagent 路徑與既有 `{session-uuid}/subagents/agent-*.jsonl`（扁平）
> 不同；workflow 的 subagent 多了 `workflows/wf_{id}/` 中介層。**現有
> SubagentDetector 必須跳過 `workflows/` 子目錄**，避免誤把 workflow agent 當
> 一般 subagent 收。

### 3.2 wf\_\*.json — Workflow snapshot（A）

**性質**：**whole-file overwrite**（每次更新覆寫整個檔案，不是 append）。
不能用 `tail -f` 風格的 FileWatcher 處理。

**Schema**（從 `wf_6f7d9da9-37e.json` 實測）：

```json
{
  "runId": "wf_6f7d9da9-37e",
  "timestamp": "2026-05-30T06:27:14.229Z",
  "taskId": "wile2fghi",
  "script": "...(完整 workflow .ts 源碼，內含 export const meta = {...})...",
  "scriptPath": "...workflows/scripts/briefshare-impl-wf_....js",
  "workflowName": "briefshare-impl",
  "summary": "Set up ~/git/briefshare, ...",
  "status": "completed" | "running" | "failed",
  "defaultModel": "claude-opus-4-7[1m]",
  "startTime": 1780122060327,
  "durationMs": 373899,
  "agentCount": 8,
  "totalTokens": 329470,
  "totalToolCalls": 54,
  "phases": [
    { "title": "Setup", "detail": "..." },
    ...
  ],
  "workflowProgress": [
    { "type": "workflow_phase", "index": 1, "title": "Setup" },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "setup-repo",
      "phaseIndex": 1,
      "phaseTitle": "Setup",
      "agentId": "adca0c33ebe734c2d",
      "model": "claude-opus-4-7[1m]",
      "state": "done",
      "startedAt": 1780122060332,
      "lastProgressAt": 1780122065647,
      "tokens": 28191,
      "toolCalls": 1,
      "durationMs": 5315
    },
    ...
  ],
  "result": {
    /* workflow return value */
  },
  "logs": []
}
```

**Agent-tail 用法**：用於 status line（顯示 workflow name、phase 進度、agent
count、status）。不需要解析全部欄位，**只取 `workflowName` / `status` /
`phases` / `workflowProgress` 的 `phaseIndex` 即可**。

### 3.3 journal.jsonl — Workflow 事件流（B）

**性質**：append-only JSONL，可直接用既有 `FileWatcher` 處理。

**Schema**：

```jsonl
{"type":"started","key":"v2:{sha256-hex}","agentId":"{17hex}"}
{"type":"result","key":"v2:{sha256-hex}","agentId":"{17hex}","result":"...string or object..."}
```

- `type`：`"started"` | `"result"`（**目前已知只有這兩種**；解析器需容錯未知 type）
- `key`：cache key（`v2:` 開頭 + sha256-hex），同一個 `started` / `result` 配對共用
- `agentId`：對應 `subagents/workflows/wf_{id}/agent-{agentId}.jsonl` 的 agent
- `result`：可以是 string（多數）或 object（schema-validated subagent 回 JSON）

**Parser 輸出**：一律映射為 `ParsedLine`，type 設為 `system`（已存在 type），
formatter 用 emoji 區分 started/result。

### 3.4 agent-{17hex}.jsonl — 每個 workflow subagent transcript（C）

**性質**：append-only JSONL，**格式與既有 Claude subagent transcript 完全相同**
（同樣是 `{type:"user"|"assistant"|"system", message, uuid, ...}`）。

**直接重用 `ClaudeLineParser`** — 不需要新 parser。

但 ClaudeLineParser 有 stateful 欄位（`currentMessageState`），所以**每個
workflow agent 必須擁有獨立 parser instance**（這點與既有 Claude multi-subagent
模式一致，已是 watch-builder 的責任）。

### 3.5 `*-wf_*.js` — Workflow 腳本（D）

靜態檔案，workflow 啟動時寫一次。**Phase 1 / M4 範圍內不解析**（只在 SPEC 提及，
未來若要顯示 script content 可在 status line 加 hyperlink）。

## 4. Design Decisions（已敲定）

| #   | 議題           | 結論                                                                                                                                                                       |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 定位           | **First-class source** — workflow run 可被 `listSessions()` 列出，可用 `--workflow <runId>` 單獨 tail                                                                       |
| D2  | MVP 範圍       | **M4 完整版** — journal + workflow-subagents + snapshot metadata + interactive mode + tmux pane                                                                            |
| D3  | 偵測策略       | **雙路徑** — Primary: early detection from main JSONL（`tool_use.name="Workflow"` + `toolUseResult.status="async_launched"`）；Fallback: directory watch on `workflows/`    |
| D4  | Harness 範圍   | **僅 Claude** — Codex/Cursor 目前無 workflow 概念，不過度抽象。介面層保持 Claude-internal                                                                                   |
| D5  | Pane 上限      | workflow main pane = priority slot（不會被 evict）；workflow subagents = FIFO eviction（max 5 slots，保留 main 1 slot 給 6 上限）                                           |
| D6  | Workflow ID 命名 | 直接用 runId（`wf_6f7d9da9-37e`）— 唯一、易讀、與 Claude Code 文件一致                                                                                                   |
| D7  | Snapshot 重讀策略 | fs.watch(filename, 'change') + 50ms debounce + whole-file JSON.parse                                                                                                    |

## 5. Module Layout

```
src/
├── agents/claude/
│   └── workflow-agent.ts           ← NEW: WorkflowAgent + WorkflowSessionFinder (first-class)
├── claude-workflow/                 ← NEW: workflow-only utilities（與 src/claude/ 平行）
│   ├── paths.ts                    ← path helpers（getWorkflowsDir, getWorkflowRunDir 等）
│   ├── journal-parser.ts           ← JournalLineParser implements LineParser
│   ├── snapshot-watcher.ts         ← SnapshotWatcher（whole-file reload + debounce）
│   ├── workflow-detector.ts        ← WorkflowDetector（早期偵測 + directory watch）
│   └── watch-builder.ts            ← buildWorkflowFiles, createWorkflowOnLineHandler
├── core/
│   └── types.ts                    ← MODIFY: 擴充 SessionListItem, ParsedLine, CliOptions（不動 SessionFile）
├── claude/
│   └── subagent-detector.ts        ← MODIFY: 跳過 workflows/ 子目錄（避免誤收）
├── cli/
│   └── parser.ts                   ← MODIFY: 新增 --workflow / --with-workflow-agents
└── index.ts                        ← MODIFY: dispatcher 加 workflow 分支 + startClaudeWorkflowWatch

tests/
├── claude-workflow/                 ← NEW
│   ├── paths.test.ts
│   ├── journal-parser.test.ts
│   ├── snapshot-watcher.test.ts
│   ├── workflow-detector.test.ts
│   └── watch-builder.test.ts
├── agents/claude/
│   └── workflow-agent.test.ts      ← NEW: WorkflowSessionFinder 測試
└── integration/
    └── workflow-multi-watch.test.ts ← NEW: end-to-end 整合測試
```

## 6. Type Definitions

### 6.1 修改 `src/core/types.ts`（最小侵入）

**設計原則**：既有 `SessionFile`（`src/core/types.ts:49`）為 `{ path, mtime: Date, agentType, customTitle? }`，本 SPEC **不擴充 SessionFile 本身**，避免汙染所有 finder 的回傳值。Workflow 額外欄位放到既有的 `SessionListItem`（`types.ts:79`，已 `extends SessionFile`），這是唯一被 `--list` 使用的型別。

```typescript
/** SessionFile（不動）保持既有 4 欄位 */
export interface SessionFile {
  path: string;
  mtime: Date;
  agentType: AgentType;     // workflow run 仍視為 agentType='claude'
  customTitle?: string;     // workflow run 改用此欄位帶顯示名稱（[wf:briefshare-impl]）
}

/** SessionListItem：在既有結構上新增 workflow 子集欄位 */
export interface SessionListItem extends SessionFile {
  // 既有欄位
  shortId: string;
  project?: string;
  lastActivityTime?: Date;

  // 新增：workflow 識別（只在 workflow run 時有值；缺值即代表是 main session）
  logType?: 'session' | 'workflow';      // default: 'session'
  workflowRunId?: string;                // wf_{8hex}-{3hex}
  workflowSessionUuid?: string;          // 該 workflow 所屬的 main session UUID
  workflowStatus?: 'running' | 'completed' | 'failed';
}
```

> **為什麼用 `customTitle` 帶 label**：既有 list formatter 已會顯示 `customTitle`（Claude `/rename` 機制）。Workflow run 把 `customTitle = "wf:briefshare-impl"` 或 fallback `"wf:6f7d9da9"`，零成本接管現有顯示路徑。

### 6.2 擴充 `ParsedLine`

```typescript
/** 加 workflow 相關欄位（既有結構不動） */
export interface ParsedLine {
  // 既有欄位... type/timestamp/raw/formatted/toolName/sourceLabel/isTaskToolUse/taskDescription/isCustomTitle/customTitleValue

  // 新增：journal event 標記（JournalLineParser 使用）
  workflowEvent?: 'started' | 'result';
  workflowAgentId?: string;              // 對應 agent-{id}.jsonl 的 17-hex agentId

  // 新增：Workflow tool_use 偵測（ClaudeLineParser 使用）
  isWorkflowToolUse?: boolean;           // main JSONL 中遇到 tool_use.name='Workflow'
  workflowAsyncLaunch?: {                // 對應 tool_result.toolUseResult.status='async_launched'
    runId: string;
    transcriptDir: string;
    scriptPath: string;
    summary: string;
    taskId: string;
  };
}
```

> 注意：**不引入 `workflowKey`**（journal 內 `key` 欄位）— 該欄位只在 journal 內部 dedup 用，不需要傳到 ParsedLine。

### 6.3 擴充 `CliOptions`

```typescript
export interface CliOptions {
  // 既有欄位...

  // 新增：workflow 模式
  workflow?: string | true;              // --workflow [runId]；無值=latest
  withWorkflowAgents: boolean;           // --with-workflow-agents（default: true）；--no-workflow-agents 關閉
  workflowPane: boolean;                 // --workflow-pane（default: false）；與 --pane / -i 互斥
  workflowAttach: boolean;               // 主 session 模式：是否自動 attach 偵測到的 workflow（default: true）
                                         // --no-workflow-attach 關閉（escape hatch）
}
```

> **Commander 命名約定（避免 §B3 提及的混淆）**：CLI 旗標一律 kebab-case (`--with-workflow-agents`)，Commander option 物件鍵一律 camelCase (`withWorkflowAgents`)。型別欄位 = camelCase。`--no-X` 自動產生 `X: false` 的覆寫。

### 6.2 新增 `src/claude-workflow/types.ts`

```typescript
/** Workflow snapshot 反序列化結果（只取需要的欄位） */
export interface WorkflowSnapshot {
  runId: string;
  workflowName?: string;
  summary?: string;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  durationMs?: number;
  agentCount?: number;
  phases: Array<{ title: string; detail?: string }>;
  workflowProgress: Array<
    | { type: 'workflow_phase'; index: number; title: string }
    | {
        type: 'workflow_agent';
        index: number;
        label: string;
        phaseIndex: number;
        phaseTitle: string;
        agentId: string;
        state: 'running' | 'done' | 'error';
        startedAt: number;
        lastProgressAt: number;
        tokens?: number;
        toolCalls?: number;
        durationMs?: number;
      }
  >;
}

/** Workflow journal event */
export interface JournalEvent {
  type: 'started' | 'result';
  key: string;
  agentId: string;
  result?: unknown;
}

/** Workflow detection callbacks */
export interface WorkflowDetectorConfig {
  sessionUuid: string;
  sessionsRoot: string;                  // {enc-cwd}/ 路徑
  onNewWorkflow: (workflow: DetectedWorkflow) => void;
  outputHandler: OutputHandler;
  // R3-S4: 不需 onWorkflowSubagent — workflow 內 subagent 偵測由 WorkflowAttachment 自己負責
  //         （§9.3 inner watcher 直接呼叫 attachment.attachAgent，不繞 detector）。
}

export interface DetectedWorkflow {
  runId: string;
  transcriptDir: string;                 // {sessions/subagents/workflows/wf_*/}
  snapshotPath: string;                  // {workflows/wf_*.json}
  scriptPath?: string;
  summary?: string;                      // from early-detection toolUseResult
}
```

## 7. WorkflowSessionFinder（First-class Source）

**檔案**：`src/agents/claude/workflow-agent.ts`

實作 `SessionFinder` 介面（`src/agents/agent.interface.ts:13`），作為 first-class workflow 來源。**所有方法簽名必須對齊既有介面**——`findLatest({ project? })`、`findBySessionId(id, { project? })`、`getProjectInfo(sessionPath)`、`findLatestInProject(projectDir)`、`listSessions({ project?, limit? })`。

### 7.1 必要方法（簽名嚴格對齊 `SessionFinder`）

```typescript
import type {
  SessionFinder,
  // 其他既有 type
} from '../agent.interface.ts';
import type {
  SessionFile,
  SessionListItem,
  ProjectInfo,
  ClaudeSessionResult,
} from '../../core/types.ts';

export class WorkflowSessionFinder implements SessionFinder {
  getBaseDir(): string;                  // 回傳 ~/.claude/projects

  /**
   * 取得最新 workflow run snapshot。
   * **不傳 `options.project` 時掃所有專案最新**（沿用既有 ClaudeSessionFinder.findLatest 語意）。
   * 傳入 `options.project` 時用 fuzzy path-contains 過濾。
   *
   * 注意：dispatcher 在處理 `--workflow`（不帶 runId）時主動傳入 `process.cwd()`
   * 作為 `options.project` — Q7 決議「不帶 runId 範圍 = 當前 cwd」由 dispatcher 強制。
   */
  async findLatest(options: {
    project?: string;
  }): Promise<SessionFile | null>;

  /** 不實作 findSubagent — workflow 不是 subagent（介面層為 optional） */

  /** 用 runId 查找；支援精確 / 前綴 / 包含 match（沿用 ClaudeSessionFinder 策略） */
  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null>;

  /** 取得 workflow snapshot 所屬 main session 的 project info */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null>;

  /** 在指定專案範圍內找最新 workflow run（供 auto-switch 用） */
  async findLatestInProject(projectDir: string): Promise<SessionFile | null>;

  /** 列出 workflow run（caller 為 list pipeline，與 main sessions 混合請見 §7.4） */
  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]>;
}
```

> **不引入新方法**——所有需求都用既有 SessionFinder 方法達成。`findLatest`、`findBySessionId` 回傳的 `SessionFile.path` 一律指向 `wf_*.json` snapshot（讓 dispatcher 後續展開 journal/agents）。`SessionFile.customTitle` 帶 `"wf:{workflowName}"`，dispatcher 用 prefix 區分。

### 7.2 Discovery 演算法（R2-Q5：對齊既有 fuzzy filter）

> **既有 `_collectMainSessions(options.project)` 行為**：用 `glob('**/*.jsonl').scan({ cwd: baseDir })` 列出所有專案的 main sessions，`options.project` 是 fuzzy filter — 對 file path 做 `file.toLowerCase().includes(project.toLowerCase())`。WorkflowSessionFinder 必須**完全對齊**這個語意。

```typescript
// 偽碼：fuzzy filter（path-contains），不是 encodeCwdPath() exact
interface InternalWorkflow {
  file: SessionFile;            // path=snapshot, mtime, agentType='claude', customTitle='wf:...'
  runId: string;
  sessionUuid: string;
  status?: 'running' | 'completed' | 'failed';
}

async function _collectWorkflows(
  options: { project?: string }
): Promise<InternalWorkflow[]> {
  // 用 glob 對等的方式直接掃描 ~/.claude/projects/**/workflows/wf_*.json
  const glob = new Glob('**/workflows/wf_*.json');
  const projectsRoot = this.baseDir;              // ~/.claude/projects
  const workflows: InternalWorkflow[] = [];
  const filenameRegex = /^(wf_[0-9a-f]{8}-[0-9a-f]{3})\.json$/;

  for await (const file of glob.scan({ cwd: projectsRoot, absolute: true })) {
    const basename = file.split('/').pop() ?? '';
    const m = basename.match(filenameRegex);
    if (!m) continue;

    // R2-Q5：fuzzy filter 對齊 _collectMainSessions
    if (options.project) {
      const needle = options.project.toLowerCase();
      if (!file.toLowerCase().includes(needle)) continue;
    }

    // 從 path 拆出 {enc-cwd}/{UUID}/workflows/wf_*.json，取 sessionUuid
    const parts = file.split('/');
    const workflowsIdx = parts.indexOf('workflows');
    if (workflowsIdx < 1) continue;
    const sessionUuid = parts[workflowsIdx - 1]!;
    const runId = m[1]!;

    let stats;
    try { stats = await stat(file); } catch { continue; }

    let workflowName: string | undefined;
    let workflowStatus: 'running' | 'completed' | 'failed' | undefined;
    try {
      const snap = JSON.parse(await Bun.file(file).text());
      workflowName = snap.workflowName ?? snap.meta?.name;
      workflowStatus = snap.status;
    } catch {
      /* snapshot 讀失敗忽略 */
    }

    workflows.push({
      file: {
        path: file,
        mtime: stats.mtime,                       // Date instance（對齊 SessionFile）
        agentType: 'claude',
        customTitle: `wf:${workflowName ?? runId}`,
      },
      runId,
      sessionUuid,
      status: workflowStatus,
    });
  }

  workflows.sort((a, b) => b.file.mtime.getTime() - a.file.mtime.getTime());
  return workflows;
}
```

`listSessions` 映射成 `SessionListItem`：

```typescript
async listSessions(options: { project?: string; limit?: number }) {
  const items = await this._collectWorkflows(options);
  const limit = options.limit ?? 20;
  return items.slice(0, limit).map((w) => ({
    ...w.file,
    shortId: w.runId,                       // 直接用 runId（已是短形式 wf_8hex-3hex）
    // R4-S2: project 欄用 encoded project dir（路徑 `~/.claude/projects/{encoded}/` 的目錄名），
    //         對齊既有 `_collectMainSessions` 的「父目錄名」邏輯。sessionUuid 走 NOTES 欄（§11.3）。
    project: deriveEncodedProjectDir(w.file.path),  // 從 snapshot path 拆出 encoded dir 名
    logType: 'workflow' as const,
    workflowRunId: w.runId,
    workflowSessionUuid: w.sessionUuid,
    workflowStatus: w.status,
  }));
}

// 從 ~/.claude/projects/{encoded}/{UUID}/workflows/wf_*.json 拆出 {encoded}
function deriveEncodedProjectDir(snapshotPath: string): string {
  const parts = snapshotPath.split('/');
  // ['', 'Users', 'x', '.claude', 'projects', '{encoded}', '{UUID}', 'workflows', 'wf_*.json']
  const projectsIdx = parts.indexOf('projects');
  return projectsIdx >= 0 ? parts[projectsIdx + 1] ?? '' : '';
}
```

### 7.3 與既有 `ClaudeSessionFinder` 的關係（R2-B3 修正）

> **R2-B3 修正**：既有 `ClaudeSessionFinder`（`src/agents/claude/claude-agent.ts:33`）是**非 `export`** 的，且**沒有 `getProjectInfo` 方法**。本 SPEC **不**假設委派路徑可用。

**P2 必做**：

1. 將 `class ClaudeSessionFinder` 改為 `export class ClaudeSessionFinder`
2. 在 `ClaudeSessionFinder` 補上 `getProjectInfo(sessionPath: string): Promise<ProjectInfo | null>`（從既有 `readCwdFromHead` helper 包一下，加上 displayName 推斷）
3. 在 `ClaudeSessionFinder` 補上 `findLatestInProject(projectDir: string): Promise<SessionFile | null>`（既有似乎也沒實作，需驗證）

`WorkflowSessionFinder` 之後可：

- **共用** path 編碼工具（`baseDir = ~/.claude/projects`、glob 形式）
- **委派** `getProjectInfo(snapshotPath)` — 先從 `snapshotPath` 路徑反推到對應的 main session JSONL 路徑（用 `{enc-cwd}/{UUID}/workflows/wf_*.json` → `{enc-cwd}/{UUID}.jsonl`），再呼叫 `ClaudeSessionFinder.getProjectInfo(mainPath)`

### 7.4 `--list` 整合（R2-B2 + Q4 修正）

> **Q4 決議**：保持既有 `--list` 預設語意——列**所有專案** main session + workflow run，`-p <project>` 是 fuzzy filter。`parser.ts:127` 對 `--list --all` 的禁止維持不變（Q2）。
>
> **R2-B2 修正**：`ClaudeSessionFinder.listSessions(options)` 預設行為已是「所有專案」（透過 `_collectMainSessions` 內部不指定 cwd 過濾）。本 SPEC 直接沿用，無需新增 cwd 限制。

**解法**：**ClaudeSessionFinder（既有）內部負責合併**：

1. 列出自己的 main sessions（既有邏輯，含 enrich tail metadata）
2. **內部**呼叫 `this._workflowFinder.listSessions(options)`（同 `options` 傳遞 fuzzy filter）
3. 依 `lastActivityTime ?? mtime` 合併排序、套用 `limit`
4. 回傳

```typescript
// ClaudeSessionFinder.listSessions 改動偽碼（既有檔案 src/agents/claude/claude-agent.ts:113）
async listSessions(options: { project?: string; limit?: number }) {
  const limit = options.limit ?? 20;
  // 1. 既有：main sessions（含 enrich，含 fuzzy filter）— 不傳 limit，下面合併後再切
  const mainItems = await this._collectMainSessionsEnriched({ project: options.project });
  // 2. 新增：workflows（同 options，fuzzy filter 對齊）
  const wfItems = await this._workflowFinder.listSessions({ project: options.project });
  // 3. 合併排序、切 limit
  const merged = [...mainItems, ...wfItems].sort((a, b) => {
    const ta = (a.lastActivityTime ?? a.mtime).getTime();
    const tb = (b.lastActivityTime ?? b.mtime).getTime();
    return tb - ta;
  });
  return merged.slice(0, limit);
}
```

> 既有 `listSessions` 邏輯：先 slice(limit) 再 enrich。改動：先 enrich main + 取 workflow → 合併 → slice。Workflow snapshot 已內含 metadata，不需要 enrich。

**T1/T2 acceptance**（Q4 修正版）：

- **T1**: `agent-tail claude --list` 列**所有專案**的 main session + workflow run（沿用既有預設）
- **T2**: `agent-tail claude --list -p <project>` 對 path 做 fuzzy 包含過濾，正確顯示符合的 main session + workflow（兩家 filter 語意一致）

`WorkflowSessionFinder` **仍**作為 first-class source（被 `--workflow` dispatcher、`findBySessionId` 直接使用），但 list 路徑由 ClaudeSessionFinder 統一聚合。

### 7.5 `findBySessionId` 兩家共存

當使用者下 `agent-tail claude wf_6f7d9da9` 時：

```typescript
// ClaudeSessionFinder.findBySessionId 改動偽碼
async findBySessionId(sessionId: string, options: { project?: string }) {
  if (sessionId.startsWith('wf_')) {
    // 委派給 WorkflowSessionFinder（直接 by-id 查找）
    return this._workflowFinder.findBySessionId(sessionId, options);
  }
  // 既有邏輯不變
  return this._findMainOrSubagent(sessionId, options);
}
```

`src/index.ts:221+` 的 dispatcher 看到回傳的 `SessionFile.customTitle.startsWith('wf:')` 時，改走 `startClaudeWorkflowMultiWatch`（§11.3）。

## 8. Parsers

### 8.1 JournalLineParser（`src/claude-workflow/journal-parser.ts`）

實作 `LineParser`，解析 journal.jsonl 每一行。

**Timestamp 處理（B6 修正）**：journal events 本身**不帶 timestamp**。解決方式：

- **歷史回放（initial dump）**：parser 接收的每行用「**file order**」順序輸出——既有 `FileWatcher` 是 sequential read，行序即時間序。`timestamp` 欄位填 file mtime 的 ISO 字串（雖然全部行共享同一個 mtime，但 file order 已隱含順序）。
- **即時 tail**：新行接收當下用 `new Date().toISOString()`——此時時間是真的接收時間，不影響歷史排序。
- **與 agent transcript 的 interleave**：journal events 與 agent-\*.jsonl 行**不**做精確時間 interleave。每個 source 內部維持 file order，跨 source 間以 label 區分顯示（已足夠 UX）。T4 acceptance 改寫：「**每個來源內部依 file order 顯示**」（非「全域時間 interleave」）。

```typescript
export class JournalLineParser implements LineParser {
  /** caller 在 attach 時設定 file mtime 作為歷史 timestamp 基準 */
  private historyTimestamp: string;

  constructor(opts: { fileMtime?: Date } = {}) {
    this.historyTimestamp = (opts.fileMtime ?? new Date()).toISOString();
  }

  /** FileWatcher 進入 tail 模式時呼叫，切換 timestamp 來源 */
  markLiveMode(): void {
    this.historyTimestamp = '';
  }

  parse(rawLine: string): ParsedLine | null {
    let event: JournalEvent;
    try {
      event = JSON.parse(rawLine);
    } catch {
      return null;                                          // 容錯（B-T18）
    }

    if (event.type !== 'started' && event.type !== 'result') return null;
    if (typeof event.key !== 'string') return null;
    if (typeof event.agentId !== 'string') return null;

    const shortAgentId = event.agentId.slice(0, 7);
    const isStart = event.type === 'started';
    const formatted = isStart
      ? chalk.cyan(`▶ agent ${shortAgentId} started`)
      : chalk.green(`✓ agent ${shortAgentId} result`) +
        (typeof event.result === 'string'
          ? ': ' + truncateLine(event.result, 100)
          : ': ' + truncateLine(JSON.stringify(event.result), 100));

    return {
      type: 'system',
      timestamp: this.historyTimestamp || new Date().toISOString(),
      raw: event,
      formatted,
      workflowEvent: event.type,
      workflowAgentId: event.agentId,
    };
  }

  // Stateless（除了 historyTimestamp flag）— 沒有 currentMessageState 需要維護
}
```

### 8.2 SnapshotWatcher（`src/claude-workflow/snapshot-watcher.ts`）

**不實作 LineParser**（snapshot 不是 line-based）。獨立元件，類似
FileWatcher 但 reload 整檔。

```typescript
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface SnapshotWatcherConfig {
  path: string;
  onChange: (snapshot: WorkflowSnapshot) => void;
  onError?: (err: Error) => void;
  debounceMs?: number; // default 50
}

export class SnapshotWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastJson: string | null = null; // 變更去重

  constructor(private config: SnapshotWatcherConfig) {}

  async start(): Promise<void> {
    // 啟動立即讀一次
    await this.reload();

    this.watcher = watch(this.config.path, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        void this.reload();
      }, this.config.debounceMs ?? 50);
    });
  }

  private async reload(): Promise<void> {
    try {
      const json = await readFile(this.config.path, 'utf8');
      if (json === this.lastJson) return; // 內容沒變不通知
      this.lastJson = json;
      const snapshot = JSON.parse(json) as WorkflowSnapshot;
      this.config.onChange(snapshot);
    } catch (err) {
      this.config.onError?.(err as Error);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
```

### 8.3 重用 ClaudeLineParser

Workflow 內 `agent-*.jsonl` 直接交給 `new ClaudeLineParser({ verbose })` 處理。
這在 watch-builder 中為每個 workflow subagent 各建立一個 parser instance。

## 9. WorkflowDetector

**檔案**：`src/claude-workflow/workflow-detector.ts`

對應 `src/claude/subagent-detector.ts` 的角色，但範圍是 workflow。

> **Q1 決議**：普通模式（`agent-tail claude`，不帶 `--workflow`）**預設啟用** workflow detection ——只要在 main session 偵測到 Workflow tool_use，自動 attach。`CliOptions.workflowAttach: true` 為預設；`--no-workflow-attach` 可關閉。

### 9.1 雙路徑偵測（B5 + B7 修正）

**Path A — Early detection from main JSONL（無 fs latency）**：

agent-tail 已經在 tail main session JSONL。Detector **不額外開檔監看**，而是提供 `handleMainLine(parsed: ParsedLine)` 方法給 main session 的 onLine handler 呼叫。Trigger 條件：

1. `parsed.workflowAsyncLaunch` 非空（由 `ClaudeLineParser` 從 `toolUseResult.status === "async_launched"` 解出，含 `runId / transcriptDir / scriptPath / summary`）
2. **同步**檢查 + 加入 `knownRunIds`（B5 race fix，見下方 §9.1.1）
3. 觸發 `onNewWorkflow({ runId, transcriptDir, scriptPath, summary })`

> `parsed.isWorkflowToolUse`（assistant tool_use）只用來在 logger 提示「workflow launching...」，不觸發 attach（因為此時還沒有 runId）。

**Path B — Directory watch fallback（舊 session resume / async tool_result 缺失場景）**：

```typescript
// 對 {session}/workflows/ 做 fs.watch（non-recursive）
const watcher = watch(workflowsDir, (eventType, filename) => {
  if (!filename) return;
  const m = filename.match(/^(wf_[0-9a-f]{8}-[0-9a-f]{3})\.json$/);
  if (!m) return;
  const runId = m[1]!;
  if (!this.markRunIdKnown(runId)) return;                  // 同步守門（B5）

  // R4-S1: 用 IIFE try/finally + success flag，rollback 一定觸發
  void (async () => {
    let succeeded = false;
    try {
      await this.tryHandleNewWorkflow(runId, /* retries */ 10);
      succeeded = true;
    } catch (err) {
      this.config.outputHandler.debug(
        `[workflow-detector] path B attach failed for ${runId}: ${err}`
      );
    } finally {
      if (!succeeded) {
        // Q8 + R4-S1：保證 rollback——即使 tryHandleNewWorkflow throw 同步 / async 都收得到
        this.knownRunIds.delete(runId);
        this.config.outputHandler.debug(
          `[workflow-detector] rolled back ${runId} (path A may retry)`
        );
      }
    }
  })();
});
```

#### 9.1.1 同步 mark 機制（B5 race fix）

```typescript
class WorkflowDetector {
  private knownRunIds = new Set<string>();

  /**
   * 同步檢查 + 加入。回傳 true 表示是新發現（caller 才繼續處理）；
   * false 表示已知（caller 直接 return）。**單一原子操作**，杜絕 race。
   */
  markRunIdKnown(runId: string): boolean {
    if (this.knownRunIds.has(runId)) return false;
    this.knownRunIds.add(runId);
    return true;
  }

  handleMainLine(parsed: ParsedLine): void {
    const launch = parsed.workflowAsyncLaunch;
    if (!launch) return;
    if (!this.markRunIdKnown(launch.runId)) return;        // ← 同步守門
    this.config.onNewWorkflow({
      runId: launch.runId,
      transcriptDir: launch.transcriptDir,
      snapshotPath: this.resolveSnapshotPath(launch.runId),
      scriptPath: launch.scriptPath,
      summary: launch.summary,
    });
  }
}
```

JS 是 single-threaded，`has()` + `add()` 連續執行間不會被插斷 — 兩條路徑無論誰先到都只會有一條通過 `markRunIdKnown`。

### 9.2 整合 main session onLine handler（B7 + R2-B4 修正）

**問題**：T9/T10 要求普通 `agent-tail claude` 也能自動 attach workflow。原 SPEC 只描述 workflow-mode 內的 handler，沒講普通模式怎麼接 detector。

**對齊既有結構**（`src/claude/watch-builder.ts:94-191` 實際長相）：

- 既有 `OnLineHandlerConfig` 欄位：`parsers: Map<string, LineParser>`、`formatter`、`detector: SubagentDetector`、`onOutput: (formatted, label) => void`、`verbose`、`shouldOutput?`、`onTitleUpdate?`
- 既有 `createOnLineHandler` 行為：lazy-init 每個 label 的 parser、`while (parsed)` multi-emit、`parsed.sourceLabel = label`、套用 `shouldOutput` 過濾、`onOutput(formatted, label)`、custom-title 更新、Task 早期偵測、fallback `toolUseResult` 偵測
- **本 SPEC 必須在這個既有迴圈內加一段，不重寫整個函式**

**修正**：

1. 在 `OnLineHandlerConfig` 新增**選用**欄位（不破壞既有 caller）：

   ```typescript
   export interface OnLineHandlerConfig {
     parsers: Map<string, LineParser>;             // 既有
     formatter: Formatter;                         // 既有
     detector: SubagentDetector;                   // 既有
     onOutput: (formatted: string, label: string) => void;  // 既有
     verbose: boolean;                             // 既有
     shouldOutput?: (label: string) => boolean;    // 既有
     onTitleUpdate?: (title: string) => void;      // 既有
     workflowDetector?: WorkflowDetector;          // ← 新增；undefined 時不啟用
   }
   ```

2. 在既有 `createOnLineHandler` 的 `while (parsed)` 迴圈內，**MAIN_LABEL** 區塊既有的 Task 早期偵測之後、fallback 偵測之前，**插入一段**：

   ```typescript
   // 已存在 if (label === MAIN_LABEL && parsed.isTaskToolUse) { ... }
   // 已存在 if (label === MAIN_LABEL) { /* fallback toolUseResult */ }

   // ↓ 新增（在上述兩段之間）
   if (label === MAIN_LABEL && parsed.workflowAsyncLaunch) {
     config.workflowDetector?.handleMainLine(parsed);
   }
   ```

3. **`startClaudeMultiWatch` / `startClaudeInteractiveWatch`** 在 `options.workflowAttach !== false`（預設 true）時，建立 `WorkflowDetector` 並透過 `OnLineHandlerConfig.workflowDetector` 注入。callback `onNewWorkflow` 走 §10.2 的 `WorkflowAttachment` 路徑。

> **行為一致性**：與既有 `SubagentDetector` 透過 `config.detector` 的方式對齊；插入點精準在 MAIN_LABEL 內、`while (parsed)` 內部，**完全沿用 multi-emit 迴圈與 `onOutput` 介面**，不破壞既有 assistant multi-part / custom-title / fallback 等流程。

### 9.3 Workflow subagent 偵測（雙層 dir watch）

每個 `DetectedWorkflow` attach 後啟動一個 inner watcher，**初始掃描與 fs.watch 事件都必須走 §10.2 `WorkflowAttachment.attachAgent` 內部的 `knownAgentIds` 同步守門**（S7）——`attachAgent` 開頭就 `knownAgentIds.has(agentId)` check，新 agentId 才實際 attach。同一 agent 不會被雙觸發。

```typescript
function watchWorkflowSubagents(attachment: WorkflowAttachment, workflow: DetectedWorkflow) {
  const dir = workflow.transcriptDir;                      // .../subagents/workflows/wf_*/

  // 1) 立即掃描現有 agent-*.jsonl（每個都走 attachAgent → 內含同步守門）
  void scanAndAttachExistingAgents(attachment, dir);

  // 2) 持續監聽新檔案
  const watcher = watch(dir, (eventType, filename) => {
    if (!filename) return;
    const m = filename.match(/^agent-([0-9a-f]{17})\.jsonl$/);
    if (!m) return;
    const agentId = m[1]!;
    const transcriptPath = join(dir, filename);
    // attachAgent 內部 `if (knownAgentIds.has(agentId)) return;` — 雙重來源 race-safe（S7）
    void tryAttachAgentWithRetry(attachment, agentId, transcriptPath, 10);
  });

  return watcher;     // caller 存進 WorkflowAttachment.subagentDirWatcher
}
```

### 9.4 與既有 Claude SubagentDetector 的衝突（T17 修正）

**問題**：既有 SubagentDetector 監聽 `{session}/subagents/` 目錄。`subagents/` 下面除了 `agent-*.jsonl` 還會有 `workflows/` 子目錄。

**修正點**（`src/claude/subagent-detector.ts`）：

- 既有 `scanForNewSubagents` 用 `Bun.Glob('agent-*.jsonl').scan({ cwd: subagentsDir })`——`Bun.Glob` 預設 **non-recursive**，不會吃到 `workflows/` 內檔案，**但** glob 不會主動跳過子目錄 dirent。
- `tryAddSubagentFile`／`scanForNewSubagents` 內部**明確加** `if (file.includes('/')) continue;` 守門（保護萬一 glob behavior 改變）。
- 既有 `fs.watch(subagentsDir, ...)` 是 non-recursive，但會收到 `workflows/` 子目錄變動的事件——filename 會是 `'workflows'` 字串，正則 `^agent-[...]\.jsonl$` 不會 match，已自然濾掉。

**T17 acceptance fixture**：

```
tests/integration/fixtures/mixed-subagents/
├── subagents/
│   ├── agent-aaaaaaa.jsonl                       ← 應被 ClaudeSubagentDetector 收
│   └── workflows/
│       └── wf_test01-abc/
│           ├── journal.jsonl
│           └── agent-bbbbbbbbbbbbbbbbb.jsonl     ← 應被 WorkflowDetector 收，不應出現在 main subagent 清單
```

驗證：`scanForNewSubagents(subagentsDir, new Set())` 回傳長度 = 1（`aaaaaaa`），不含 17-hex agentId。

## 10. Watch Orchestration

### 10.1 `buildWorkflowFiles`（`src/claude-workflow/watch-builder.ts`）

```typescript
export interface BuildWorkflowFilesConfig {
  workflow: DetectedWorkflow;
  withAgents: boolean;                     // 是否含 workflow subagents
}

export interface WorkflowFiles {
  journal: WatchedFile;                    // journal.jsonl
  snapshot: { path: string };              // wf_*.json (給 SnapshotWatcher，非 FileWatcher)
  agents: WatchedFile[];                   // 初始掃描到的 agent-*.jsonl
}

export function buildWorkflowFiles(config: BuildWorkflowFilesConfig): WorkflowFiles;
```

### 10.2 `WorkflowAttachment` — 單一 workflow 的生命週期 handle（S5 修正）

> **問題**：原 SPEC 直接把 workflow journal/agents 推給共用 `MultiFileWatcher`，但 `MultiFileWatcher.stop()` 是全停。T20 要求 workflow 結束 / 目錄消失時**只**終止該 workflow 的監看，主程式不退出。

每個 attached workflow 用一個獨立 `WorkflowAttachment` 物件包起它自己的 watchers：

```typescript
import type {
  OutputHandler,         // { info, warn, error, debug }（src/core/detector-interfaces.ts:10）
  SessionHandler,        // { addSession?, markSessionDone?, updateUI? }（同檔:24）
} from '../core/detector-interfaces.ts';

export interface WorkflowAttachmentConfig {
  workflow: DetectedWorkflow;
  withAgents: boolean;
  snapshotState: { current: WorkflowSnapshot | null };
  parsers: Map<string, LineParser>;        // key='journal' 或 agentId
  formatter: Formatter;

  /** 一般輸出（journal 行 / agent transcript 行 / status event）— 沿用既有 watch-builder 的 `onOutput` 命名 */
  onOutput: (formatted: string, label: string) => void;

  /** 系統訊息（attach / detach / errors）— 既有 `OutputHandler` 物件（不是函式！） */
  outputHandler: OutputHandler;

  /** Interactive 模式整合（non-interactive 時為 undefined） */
  sessionHandler?: SessionHandler;

  verbose: boolean;
}

export class WorkflowAttachment {
  private journalWatcher!: FileWatcher;
  private agentWatchers = new Map<string, FileWatcher>(); // agentId -> watcher
  private snapshotWatcher!: SnapshotWatcher;
  private subagentDirWatcher: ReturnType<typeof watch> | null = null;
  private knownAgentIds = new Set<string>();    // 同步守門（B5 同款）
  private stopped = false;

  constructor(private config: WorkflowAttachmentConfig) {}

  /**
   * R3-B4 修正 — 嚴格順序：history dump 全部完成才開放 SnapshotWatcher onChange 觸發 stop。
   *
   * 順序：
   *   1) journal FileWatcher.start() → 等初始 batch dump 完 → 呼叫 journalParser.markLiveMode() (S9)
   *   2) 初始掃描現有 agent-*.jsonl → await attachAgent() × N（每個 FileWatcher 等初始 batch dump 完）
   *   3) 啟動 subagent directory watch（§9.3）→ 之後新增的 agent 走動態 attach
   *   4) **最後**才 SnapshotWatcher.start()（含預讀一次）；此時的 onChange handler 才允許執行
   *      stop('completed')—— 因為前面 batch 已 dump 完。
   *   5) 若預讀時 status 已是 completed/failed → SnapshotWatcher 預讀同步把 snapshot 灌入 onChange
   *      → onChange 看到 completed → queueMicrotask(stop)。dump 早於 stop 因為 stop 排在 microtask 尾巴。
   */
  async start(): Promise<void> {
    // R5-S2 — Step 0: transcriptDir 容錯重試
    // Early detection 收到 `async_launched` tool_result 時，{subagents/workflows/wf_*/}
    // 與 journal.jsonl 可能尚未落盤。先 retry 10×100ms 等候建立，再進入後續步驟。
    await this._waitForTranscriptDir(/* retries */ 10, /* intervalMs */ 100);
    // Step 1
    await this._startJournalAndFlushHistory();
    // Step 2
    if (this.config.withAgents) await this._scanAndAttachInitialAgents();
    // Step 3 — R4-B2: 受 withAgents 守門，否則 `--no-workflow-agents` 仍會動態 attach 新 agent
    if (this.config.withAgents) {
      this.subagentDirWatcher = watchWorkflowSubagents(this, this.config.workflow);
    }
    // Step 4 — SnapshotWatcher 最後啟動；onChange 觸發的 stop 不會搶在歷史 dump 之前
    this.snapshotWatcher = new SnapshotWatcher({
      path: this.config.workflow.snapshotPath,
      onChange: (snap) => {
        this.config.snapshotState.current = snap;
        if (snap.status === 'completed' || snap.status === 'failed') {
          // Q6 — completed 排在 microtask 尾巴；步驟 1/2 已 awaited，順序穩定
          queueMicrotask(() => void this.stop('completed'));
        }
      },
    });
    await this.snapshotWatcher.start();
  }

  /**
   * 動態加入新偵測到的 workflow subagent（被 §9.3 inner watcher + 初始掃描共用）。
   * **同步守門**（S7）：先 markAgentKnown，回 false 直接 return。
   * R5-S1：watcher 建立失敗 rollback knownAgentIds，避免單次失敗後永久跳過。
   */
  async attachAgent(agentId: string, transcriptPath: string): Promise<void> {
    if (this.knownAgentIds.has(agentId)) return;
    this.knownAgentIds.add(agentId);

    let succeeded = false;
    try {
      /* 建 FileWatcher + 註冊到 agentWatchers */
      /* Interactive 模式：通知 sessionHandler 加 tab */
      this.config.sessionHandler?.addSession?.(
        agentId,
        makeWorkflowAgentLabel(agentId, this.config.snapshotState.current),
        transcriptPath
      );
      this.config.sessionHandler?.updateUI?.();
      succeeded = true;
    } finally {
      if (!succeeded) {
        // R5-S1：rollback，讓下次同 agent 偵測能 retry
        this.knownAgentIds.delete(agentId);
        this.config.outputHandler.debug(
          `[wf:${this.config.workflow.runId}] attachAgent failed for ${agentId}, rolled back`
        );
      }
    }
  }

  /** S5：只停這個 workflow，主程式繼續執行 */
  async stop(
    reason: 'completed' | 'directory-removed' | 'user'
  ): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.snapshotWatcher.stop();
    this.subagentDirWatcher?.close();
    await this.journalWatcher.stop();
    await Promise.all(
      [...this.agentWatchers.values()].map((w) => w.stop())
    );
    // Interactive：通知 SessionHandler 各 agent / journal session done
    for (const agentId of this.knownAgentIds) {
      this.config.sessionHandler?.markSessionDone?.(agentId);
    }
    this.config.sessionHandler?.markSessionDone?.(
      `wf:${this.config.workflow.runId}`
    );
    // 系統訊息用 OutputHandler.info（物件方法，不是函式呼叫！）
    this.config.outputHandler.info(
      `[wf:${this.config.workflow.runId}] stopped (${reason})`
    );
  }
}
```

`startClaudeWorkflowMultiWatch` / `startClaudeInteractiveWatch` 持有 `Map<runId, WorkflowAttachment>`；新 workflow 偵測 → 建立 WorkflowAttachment 並 start；snapshot status 變 `completed`/`failed` 或 directory `ENOENT` → 對應 attachment `stop()`。

**`MultiFileWatcher` 不改**——本 SPEC 不依賴 MultiFileWatcher 的 dynamic add/remove；每個 workflow attachment 內部直接用 `FileWatcher`（既有 `src/core/file-watcher.ts`），更貼合 lifecycle 需求。

**Interactive mode 與 SessionHandler**：`startClaudeWorkflowInteractiveWatch` 把 `SessionManager` 包成 `SessionHandler`（`{ addSession, markSessionDone, updateUI }`）注入到所有 `WorkflowAttachment`。journal pane 用 `addSession('wf:' + runId, ...)` 註冊；每個 workflow agent 用 `addSession(agentId, ...)`。Tab 切換、Display 更新照既有路徑走（§12）。

### 10.3 `createWorkflowOnLineHandler`

每個 workflow attachment 的 onLine：

1. **journal line** → JournalLineParser → 格式化 → 顯示為 `[wf:<runName>]` label
2. **agent transcript line** → 該 agent 的 ClaudeLineParser → 格式化 → 顯示為 `[wf:<agentLabel>]`
3. **label 對應**：用 `snapshotState.current?.workflowProgress` 內 label 對應 agentId；snapshot 還沒讀到 label 時 fallback 顯示 `[wf:adca0c3]` 短 hash。

```typescript
export function createWorkflowOnLineHandler(
  config: WorkflowAttachmentConfig
): (line: string, label: string) => void;
```

### 10.4 `startClaudeWorkflowWatch`（`src/index.ts`）

新增 dispatcher：

```typescript
// main() 內，agentType === 'claude' 分支
const wantsWorkflowMode = options.workflow !== undefined ||
  (sessionFile?.customTitle?.startsWith('wf:') === true);   // findBySessionId 走進 wf_*

if (wantsWorkflowMode) {
  if (options.interactive) {
    await startClaudeWorkflowInteractiveWatch(options);
  } else {
    await startClaudeWorkflowMultiWatch(options);
  }
  return;
}
```

`startClaudeWorkflowMultiWatch`：

1. WorkflowSessionFinder.findLatest 或 findBySessionId 找出 workflow run
2. 建立並 start 一個 `WorkflowAttachment`
3. 監聽該 attachment 的 snapshot — `status==='completed'` 時呼叫 `attachment.stop('completed')`
4. 主程式持續執行直到 Ctrl-C 或 attachment.stop 完成才退出

**普通模式（沒帶 --workflow）**：`startClaudeMultiWatch` 持有一個 `Map<runId, WorkflowAttachment>`；`WorkflowDetector.onNewWorkflow` callback 建立新 attachment 並插入 map。

## 11. CLI Options

### 11.1 新增旗標

| CLI 旗標                  | Commander 鍵                  | 型別           | 預設        | 說明                                                              |
| ------------------------- | ----------------------------- | -------------- | ----------- | ----------------------------------------------------------------- |
| `--workflow [runId]`      | `workflow`                    | `string\|true` | `undefined` | Tail workflow run；無 runId 時用最新 workflow                     |
| `--with-workflow-agents`  | `withWorkflowAgents`          | `boolean`      | `true`      | 同時 tail workflow 內所有 subagent                                |
| `--no-workflow-agents`    | （Commander 自動覆寫上一個鍵） | —              | —           | 關閉 `--with-workflow-agents`                                     |
| `--workflow-pane`         | `workflowPane`                | `boolean`      | `false`     | tmux：為 workflow main + 每個 subagent 開 pane                    |
| `--no-workflow-attach`    | `workflowAttach`              | `boolean`      | `true`      | 普通模式 escape hatch：關閉 main session 的 workflow auto-attach  |

> **命名一致性（S3）**：所有 CLI 旗標 kebab-case；所有 CliOptions 欄位 camelCase。`--no-X` 用 Commander 標準語法 `option('--no-x', ...)` 自動產生 `x: false` 覆寫。

### 11.2 互斥與相容性（Q3 決議）

| 組合                              | 結果                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| `--workflow` + `--subagent`       | **互斥** — exit 1（不同概念）                                    |
| `--workflow` + `agentType !== 'claude'` | **錯誤** — exit 1                                          |
| `--workflow` + `-i`               | **相容** — 走 workflow interactive 分支                          |
| `--workflow-pane` + `-i`          | **互斥**（Q3 決議，與既有 `--pane` + `-i` 互斥規則一致）— exit 1 |
| `--workflow-pane` + `--pane`      | **互斥** — exit 1（語意重疊；pane 數量無法協調）                 |
| `--workflow` 不帶 runId + 當前 cwd 無 workflow | **錯誤** — exit 1，hint：「使用 `--list` 或 `--workflow <runId>`」（Q7：範圍 = 當前 cwd，不跨專案 fallback） |
| `--workflow` 不帶 runId 帶 `-p <project>` | 走 fuzzy filter；若仍無 workflow → exit 1 |

> **R4-B1 修正：cwd → fuzzy filter 轉換**
>
> Claude project 目錄名稱是 encoded form（`/Users/x/code/foo` → `-Users-x-code-foo`），**raw `process.cwd()` 不會是 encoded path 的 substring**。Dispatcher 在處理 `--workflow` 不帶 runId 時，必須先把 cwd 編碼成 Claude project dir 形式，再傳入 `options.project` 做 fuzzy `includes` 過濾。
>
> 新增 helper（建議放 `src/claude-workflow/paths.ts`，與 SubagentDetector 共用）：
>
> ```typescript
> /**
>  * 把 cwd 編碼成 Claude project dir 名稱片段。
>  * `/Users/pc035860/code/agent-tail` → `-Users-pc035860-code-agent-tail`
>  * 規則：所有 `/` 替換成 `-`（path 開頭的 `/` 自然產生前綴 `-`）。
>  * 與 `~/.claude/projects/` 目錄命名格式對齊。
>  */
> export function cwdToClaudeProjectFilter(cwd: string): string {
>   return cwd.replaceAll('/', '-');
> }
> ```
>
> Dispatcher 用法：
>
> ```typescript
> if (options.workflow === true) {
>   // 不帶 runId → 範圍限縮當前 cwd
>   const filter = cwdToClaudeProjectFilter(process.cwd());
>   const wf = await finder.findLatest({ project: filter });
>   if (!wf) { /* exit 1 with hint */ }
> }
> ```
| `--list` + `--all`                | **保持禁止**（Q2 決議，沿用 `parser.ts:127`）                    |
| `--no-workflow-attach` + `--workflow` | 允許但無效果（已是 workflow mode）— 印一行 warning            |

### 11.3 `--list` 顯示契約

list pipeline（`listCommand` in `src/index.ts`）回傳的 `SessionListItem[]` 已由 `ClaudeSessionFinder.listSessions` 內部合併 main session + workflow（§7.4），formatter 依 `logType` 與 `customTitle` 分流：

```
TYPE  ID                  TIME              TITLE                            NOTES
wf    wf_6f7d9da9-37e     2026-05-30 14:27  briefshare-impl                  completed · in session 5fe53568
sess  5fe53568            2026-05-30 14:21  (no custom title)
sess  d581d8c7            2026-05-30 09:30  (no custom title)
```

- 第 1 欄 `TYPE`：`sess` | `wf`，依 `logType`（未設視為 `sess`）
- 第 5 欄 `NOTES`：workflow 顯示 `workflowStatus` + 所屬 main session 短 UUID

### 11.4 `agent-pick` 選 workflow 的路由（S4 + R3-S1）

agent-pick 顯示與 `--list` 相同欄位（fzf preview）。

**fzf 行格式契約**（R3-S1 — 明確規定，給 `src/pick/fzf-helpers.ts` 解析）：

```
{TYPE}\t{ID}\t{TIME}\t{TITLE}\t{NOTES}\t{HIDDEN_RUNID_OR_UUID}
```

- 6 欄、tab 分隔
- 第 6 欄 `HIDDEN_RUNID_OR_UUID`：對 main session 為 full UUID；對 workflow 為 full runId（`wf_8hex-3hex`）
- fzf 用 `--with-nth 1..5` 顯示前 5 欄；第 6 欄保留給 parser 用
- **R4-S3 一致性**：preview action / Enter / Ctrl-Y 全部用 `awk -F'\t' '{print $6}'` 取第 6 欄；不再用 `{1}` / `{2}`（避免顯示欄與資料欄混淆）

**選定後路由**（依**第 1 欄 TYPE**判斷）：

- `TYPE === 'sess'` → 既有路徑 `agent-tail <agentType> <第 6 欄 UUID>`
- `TYPE === 'wf'`   → spawn `agent-tail claude --workflow <第 6 欄 runId>`

選 workflow 時若使用者在 fzf 行尾按特定鍵（保留：未來可支援 `--workflow-pane` / `-i` 變體），目前 MVP 固定 `--workflow <runId>` 無附加旗標。

## 12. Interactive Mode

### 12.1 SessionManager workflow tab

當 `--workflow` 時 SessionManager 內部 sessions 結構：

```
sessions[0] = workflow journal    label='[wf:briefshare-impl]'
sessions[1] = workflow agent #1   label='[wf:setup-repo]'
sessions[2] = workflow agent #2   label='[wf:write-spec]'
...
```

Tab / Shift-Tab 切換邏輯**完全沿用既有**。

### 12.2 DisplayController status line

新增 workflow 模式狀態列格式（snapshot 取得後渲染）：

```
[wf:briefshare-impl] Phase 3/6: Implement | agent 5/8 running | 312k tokens | ⏱ 6m 14s
```

snapshotState.current 是 null 時退回基本格式 `[wf:{runId}] (loading snapshot...)`。

### 12.3 agent-pick workflow 列

新增 `--workflow` 選單模式（與既有 `--subagent` 選單對應）。

## 13. Tmux Pane Strategy

### 13.1 槽位分配（max 6 panes）

```
slot 0 (priority): workflow journal          ← 永不 evict
slot 1-5         : workflow subagents        ← FIFO eviction
```

當第 6 個 subagent 啟動時，evict slot 1（最舊的 subagent pane）。

### 13.2 PaneManager 擴充（B9 — 不破壞既有 API）

> **既有 API**：`PaneManager.openPane(agentId, subagentPath, description?)` 已被 Claude / Codex / Cursor 三家呼叫（`src/terminal/pane-manager.ts:66`）。**SPEC 不更動此簽名**。

**新增 pin 機制**（最小擴充，僅供 workflow 使用）：

> **S10 修正**：既有 `PaneInfo` 沒有 `openedAt` 欄位，FIFO eviction 改用 PaneManager 內部維護的 **insertion-order array**（新 agentId push 末尾、被 evict / closed 時從 array 移除）。controller interface 不動。

```typescript
// src/terminal/pane-manager.ts 新增：
class PaneManager {
  private pinnedAgentIds = new Set<string>();
  private insertionOrder: string[] = [];                 // S10: FIFO 順序

  // 既有 openPane 內部：成功 set 進 this.panes 後 push 到 insertionOrder
  // 既有 closePaneByAgentId 內部：成功 delete 後從 insertionOrder splice

  /** workflow main pane 開完後呼叫，標記不可被 FIFO evict */
  pinAgent(agentId: string): void {
    this.pinnedAgentIds.add(agentId);
  }

  /** unpinAgent — workflow attachment.stop() 時呼叫 */
  unpinAgent(agentId: string): void {
    this.pinnedAgentIds.delete(agentId);
  }

  /**
   * 既有 `openPane(agentId, subagentPath, description?)` 簽名**不變**、行為**不變**
   * （超過 MAX_PANES 仍直接跳過）。
   *
   * 新增 method：當 panes.size + pending >= MAX_PANES 時，
   * 從 insertionOrder 由舊到新找出第一個**非 pinned** 的 agentId，
   * 呼叫 closePaneByAgentId 把它 evict，再進行新 pane 開啟。
   * 只在 workflow 模式內被呼叫。若所有 pane 都 pinned，視為「已滿」直接跳過。
   */
  async openPaneEvictIfNeeded(
    agentId: string,
    subagentPath: string,
    description?: string
  ): Promise<void>;
}
```

**呼叫順序**：

- Workflow journal pane → `openPaneEvictIfNeeded(\`wf:${runId}:journal\`, ...)` → `pinAgent(\`wf:${runId}:journal\`)`（R3-S2：用 runId-prefixed id 避免多 workflow 撞名）
- 第 N 個 workflow subagent pane → `openPaneEvictIfNeeded(\`wf:${runId}:${agentId}\`, ...)`（觸發 FIFO 時跳過 pinned）
- WorkflowAttachment.stop() → `unpinAgent(\`wf:${runId}:journal\`)` + close 所有該 runId 的 panes

既有非 workflow code path（Claude/Codex/Cursor 一般 subagent）仍呼叫 `openPane`——行為**完全不變**，超過上限照樣跳過。

### 13.3 Pane label 命名

用 `select-pane -T '[wf:setup-repo]'` 設定 pane title（既有機制，沿用 `controller.renamePane`）。

## 14. Acceptance Criteria

### 14.1 Discovery / Listing

- **T1** (Q4): `agent-tail claude --list` 列出**所有專案**的 main session + workflow run（沿用既有預設），依 `lastActivityTime ?? mtime` 排序，workflow 列的 `TYPE` 欄為 `wf`
- **T2** (Q4): `agent-tail claude --list -p <project>` 以 fuzzy path-contains 過濾，正確顯示符合的 main session + workflow（兩家 filter 語意一致；`-p` 字串對 file path 做小寫 `includes`）
- **T2b** (Q2): `agent-tail claude --list --all` exit 1（沿用 `parser.ts:127` 既有禁止）
- **T3** (Q7): `agent-tail claude --workflow wf_DOES_NOT_EXIST` 印錯誤訊息並 exit 1，**不**留下 watcher
- **T3b** (Q7): `agent-tail claude --workflow`（不帶 runId）在當前 cwd 下無 workflow 時 → exit 1 + hint：「使用 `--list` 或 `--workflow <runId>`」（範圍 = 當前 cwd，不跨專案 fallback）

### 14.2 Multi-file Watch（non-interactive）

- **T4**: `agent-tail claude --workflow <runId>` 啟動後立即顯示 journal.jsonl 既有內容 + workflow 內所有 agent-\*.jsonl 既有內容。**排序契約**：每個來源檔內部依 file order 顯示；跨檔不保證時間 interleave（journal 不帶 timestamp，agent transcript 帶各自 timestamp，但兩者來源不同）；以 label 區分顯示來源。
- **T5**: 同 T4，新 journal 行寫入 → 1 秒內顯示
- **T6**: 同 T4，workflow 內新 agent-\*.jsonl 出現 → 1 秒內被 attach 並開始顯示
- **T7**: `--no-workflow-agents` 旗標：只 tail journal，不 attach agent-\*.jsonl
- **T8**: 同 T4，snapshot 更新（status 變 `completed`）→ 1 秒內輸出一行 event log（non-interactive 沒有真正 status line；interactive 改顯示於 status line）
- **T8b** (Q6 決議): `agent-tail claude --workflow <runId>` 對應 snapshot **初次讀到** `status='completed'` 或 `'failed'` 時，dump 完歷史 + 該 snapshot event 後**自動 exit**（呼叫 `WorkflowAttachment.stop('completed')`，主程式正常退出）。Running 中的 workflow 維持 follow 直到 Ctrl-C。

### 14.3 Early Detection（從 main session）— Q1 預設啟用

- **T9**: 普通 `agent-tail claude`（**不**帶 `--workflow`）tail 主 session + Claude Code 內呼叫 `Workflow` 工具 → 0.5 秒內自動 attach 新 workflow journal（不需 fs event）。**預設行為**，無須額外旗標。
- **T9b**: 同 T9，但使用者帶 `--no-workflow-attach`：偵測到 Workflow tool event 後**不** attach，僅顯示 main session 中該事件本身
- **T10**: 同 T9，後續 workflow 內 subagent 啟動 → 自動 attach
- **T10b**: 同一 cwd 並行多個 workflow run → 每個 runId 各自 attach、互不干擾

### 14.4 Interactive Mode

- **T11**: `agent-tail claude --workflow <runId> -i` 進入互動模式，Tab 切換 workflow journal ↔ subagents
- **T12**: status line 顯示 workflow name + phase + agent 進度（snapshot 解析後）
- **T13**: snapshot 解析前先顯示 `(loading snapshot...)`，不 crash

### 14.5 Tmux Pane（Q3：與 `-i` 互斥）

- **T14**: `agent-tail claude --workflow <runId> --workflow-pane`：開啟 workflow main pane（pinned）+ 每個現有 subagent 開新 pane
- **T15**: 第 6 個 subagent 啟動觸發 FIFO eviction，evict 最舊**非** pinned 的 subagent pane；workflow main pane（pinned）不被 evict
- **T15b**: `agent-tail claude --workflow <runId> --workflow-pane -i` → exit 1（Q3 互斥）

### 14.6 雙保險與不衝突

- **T16**: Early detection 路徑（path A）與 directory watch（path B）對同一 runId **不重複** attach — 透過 §9.1.1 `markRunIdKnown` 同步 mark 保證
- **T17**: 既有 Claude subagent detection 不誤把 workflow agent 收進「扁平 subagent」清單
  - **Fixture**（S1 要求）：`tests/integration/fixtures/mixed-subagents/subagents/` 含 `agent-aaaaaaa.jsonl`（扁平）與 `workflows/wf_test01-abc/agent-{17hex}.jsonl`
  - **驗證**：`scanForNewSubagents(subagentsDir, new Set())` 回傳 `['aaaaaaa']`（長度 1），不含 17-hex agentId

### 14.7 容錯

- **T18**: journal.jsonl 出現非法 JSON 行：跳過、繼續處理後續行、不 crash
- **T19**: snapshot 暫時讀不到 / 解析失敗：印 warning、繼續，snapshot 下次更新時自動恢復
- **T20**: 單一 workflow 目錄被刪除（罕見）：對應 `WorkflowAttachment.stop('directory-removed')` 被呼叫，主程式繼續執行其他 workflow（§10.2 設計支援）；其他 workflow 或 main session 監看**不受影響**

## 15. Out of Scope（明確不做）

- **Codex / Cursor workflow 支援**：兩個 harness 目前無 workflow 概念
- **解析 workflow `*.js` 腳本內容**：只取 snapshot 內已 embedded 的 `script` 欄位（若 status line 需要 workflow name 已從 snapshot 取得）
- **跨 session 的 workflow**：workflow run 屬於建立它的 main session，本 SPEC 不做跨 session 集合視圖
- **Workflow 控制操作**：agent-tail 是「監看工具」，不做 cancel / pause / resume
- **歷史 workflow run 統計報表**：（如 token 累計、平均時長）— 留給未來

## 16. Implementation Phases（B8 修正：每 phase 可獨立驗證）

> **修正原則**：每個 phase 必須能獨立跑出對應 acceptance 的可驗證結果，不依賴後面 phase 的 dispatcher。把最小 CLI dispatcher 提前到 P3 一起做。

| Phase   | 內容                                                                                                                                                          | 對應 Acceptance（pass 後升下一階段） |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **P1**  | Paths + types (§6 全部) + JournalLineParser (§8.1) + SnapshotWatcher (§8.2) + 單元測試                                                                        | （內部測試）                         |
| **P2**  | WorkflowSessionFinder (§7) + ClaudeSessionFinder 整合 (§7.4 / §7.5) + ClaudeSessionFinder export + getProjectInfo + findLatestInProject (§7.3) + SubagentDetector 排除 workflows/ (§9.4) + 測試 | T1, T2, T2b, T3, T3b, T17 |
| **P3**  | WorkflowDetector dir-watch path B (§9.1 path B) + WorkflowAttachment (§10.2) + `--workflow` CLI 選項 + `startClaudeWorkflowMultiWatch` dispatcher (§10.4)      | T4, T5, T6, T7                       |
| **P4**  | SnapshotWatcher attach + status events (§10.2 snapshot stream) + 容錯路徑                                                                                     | T8, T18, T19, T20                    |
| **P5**  | ClaudeLineParser 偵測 Workflow tool_use / async_launched tool_result (§6.2 isWorkflowToolUse / workflowAsyncLaunch) + WorkflowDetector early detection path A (§9.1 path A) + `OnLineHandlerConfig.workflowDetector` 整合 (§9.2) + `--no-workflow-attach` 旗標 | T9, T9b, T10, T10b, T16 |
| **P6**  | `startClaudeWorkflowInteractiveWatch` + SessionManager / DisplayController workflow 模式 + status line (§12)                                                  | T11, T12, T13                        |
| **P7**  | PaneManager `pinAgent` / `openPaneEvictIfNeeded` (§13.2) + `--workflow-pane` + Q3 互斥驗證 + agent-pick workflow list (§11.4) + 整合測試 + README + CLAUDE.md  | T14, T15, T15b + 全 SPEC 收尾        |

每個 phase 結束都跑 `bun test` + 確保 P 內對應 acceptance 寫成自動化測試（除 T9/T10 需手動驗收）。

**Phase 依賴關係驗證**：

- P3 不依賴 P5（early detection）—— path B（dir watch）足以驗證 T4-T7
- P5 不依賴 P6（interactive）—— path A 可在 `startClaudeMultiWatch` 內驗證
- P4 不依賴 P6 —— snapshot event 用單行 stderr log 驗證即可
- P7 整合測試覆蓋所有 phase 端到端

## 17. Verification Plan

### 17.1 單元測試（每個 phase 各層）

```bash
bun test tests/claude-workflow/          # P1, P3
bun test tests/agents/claude/workflow-agent.test.ts  # P2
bun test tests/cli/                                  # P4
bun test tests/integration/                          # P7 整合
```

### 17.2 手動驗收

需要環境：機器上至少有一個歷史 workflow run（用本機跑過 briefshare-impl 即可）。

```bash
cd /Users/pc035860/code/claude-md
bun --cwd /Users/pc035860/code/agent-tail run src/index.ts claude --list
# 預期：看到 [wf:briefshare-impl] wf_6f7d9da9-37e

bun --cwd /Users/pc035860/code/agent-tail run src/index.ts claude --workflow wf_6f7d9da9-37e
# 預期：印出 journal.jsonl + 各 agent-*.jsonl 內容
```

### 17.3 整合測試夾具

在 `tests/integration/fixtures/` 放置一個迷你 workflow run 結構（手寫
journal + 1-2 個 agent-\*.jsonl + 1 個 wf\_\*.json）。用 `MutableFakeFileSystem`
（既有測試 helper）驅動。

## 18. Related Files（修改／新增清單）

| 檔案                                                  | 變更類型 | 說明                                            |
| ----------------------------------------------------- | -------- | ----------------------------------------------- |
| `src/agents/claude/workflow-agent.ts`                 | NEW      | WorkflowSessionFinder                           |
| `src/claude-workflow/paths.ts`                        | NEW      | path helpers（getWorkflowsDir / getWorkflowRunDir / `cwdToClaudeProjectFilter(cwd)` 等；R4-B1） |
| `src/claude-workflow/journal-parser.ts`               | NEW      | JournalLineParser                               |
| `src/claude-workflow/snapshot-watcher.ts`             | NEW      | SnapshotWatcher                                 |
| `src/claude-workflow/workflow-detector.ts`            | NEW      | WorkflowDetector (early + dir watch)            |
| `src/claude-workflow/watch-builder.ts`                | NEW      | buildWorkflowFiles, createWorkflowOnLineHandler |
| `src/claude-workflow/types.ts`                        | NEW      | WorkflowSnapshot, JournalEvent, configs         |
| `src/core/types.ts`                                   | MODIFY   | 擴充 SessionListItem, ParsedLine, CliOptions（**不動** SessionFile） |
| `src/claude/subagent-detector.ts`                     | MODIFY   | 排除 workflows/ 子目錄                          |
| `src/agents/claude/claude-agent.ts`                   | MODIFY   | ClaudeLineParser 偵測 Workflow tool_use / async_launched tool_result（P5）；`class ClaudeSessionFinder` 加 `export` + `getProjectInfo` + `findLatestInProject` + `listSessions` 內部聚合 workflow（P2） |
| `src/cli/parser.ts`                                   | MODIFY   | 新增 --workflow / --with-workflow-agents / --no-workflow-attach / --workflow-pane |
| `src/index.ts`                                        | MODIFY   | dispatcher + startClaudeWorkflowMultiWatch + startClaudeWorkflowInteractiveWatch |
| `src/terminal/pane-manager.ts`                        | MODIFY   | pinAgent / unpinAgent / openPaneEvictIfNeeded + insertionOrder array |
| `src/list/session-lister.ts`                          | MODIFY   | 新增 logType / workflowStatus 欄位顯示（與 §11.3 顯示契約對齊） |
| `src/pick/index.ts`                                   | MODIFY   | 選 workflow 行時改 spawn `agent-tail claude --workflow <runId>`（§11.4） |
| `src/pick/fzf-helpers.ts`                             | MODIFY   | fzf preview / 行格式：6 欄 tab 分隔（§11.4）；preview / Enter / Ctrl-Y 都改取第 6 欄 |
| `src/pick/arg-passthrough.ts`                         | MODIFY   | workflow 模式 spawn 時需傳 `--workflow <runId>`（R4-S4） |
| `tests/claude-workflow/*.test.ts`                     | NEW      | 各層單元測試                                    |
| `tests/agents/claude/workflow-agent.test.ts`          | NEW      | finder 測試                                     |
| `tests/integration/workflow-multi-watch.test.ts`      | NEW      | 整合測試                                        |
| `README.md`                                           | MODIFY   | 加 workflow 章節                                |
| `CLAUDE.md`                                           | MODIFY   | 加 workflow 概念                                |

## 19. Edge Cases & Notes

### 19.1 Snapshot 與 journal 寫入順序

`wf_*.json` snapshot 是 workflow 完成 / 大變動時整檔覆寫；journal.jsonl 是
event-by-event append。**可能** journal 已寫到某個 agent 的 result，但
snapshot 還沒更新該 agent 的 state — 這是預期、不需處理。

### 19.2 Workflow run 在啟動瞬間目錄不存在

Workflow 啟動的瞬間，`subagents/workflows/wf_*/` 可能還沒建立。
`WorkflowDetector` 收到 early detection 後對 transcriptDir 做最多 10 次
×100ms 的 mkdir 重試（mirroring 既有 Claude subagent 重試邏輯）。

### 19.3 同一 cwd 多個並行 workflow

Claude Code 允許並行 workflow run（每個 runId 不同）。本 SPEC 內所有資料結構
都用 `runId` 為 key，天然支援並行。

### 19.4 「等候 snapshot」UX

snapshot 第一次讀到之前，status line 顯示 `(loading snapshot...)`。實作上：
SnapshotWatcher.start() 預讀一次即可；若該檔案不存在會 reject → onError
回呼 → status line 顯示 fallback。

### 19.5 與既有 fs.watch 共存

既有 SubagentDetector 對 `{session}/subagents/` 做 fs.watch；本 SPEC 對
`{session}/workflows/` 與 `{session}/subagents/workflows/wf_*/` 各做一次 fs.watch。
這些目錄不同層級，不衝突。

### 19.6 macOS fs.watch 行為

macOS 的 fs.watch 在重命名/移除/重建檔案時可能不可靠（Node 已知議題）。SPEC
不額外處理 — 既有 SubagentDetector 也沒處理，目前運作正常。

---

## 20. Implementation Status

✅ **All 7 phases complete (2026-05-30)** — feature shipped on branch
`feat/workflow-support`. 740 tests pass (113 new workflow-specific).

| Phase | Status | Notes |
|-------|--------|-------|
| P1 — paths + types + JournalLineParser + SnapshotWatcher | ✅ | Lazy GREEN: `lastJson` updates AFTER successful JSON.parse (D6 deviation from §8.2 reference; prevents invalid writes from poisoning dedup cache). |
| P2 — WorkflowSessionFinder + ClaudeSessionFinder integration + SubagentDetector exclusion | ✅ | `ClaudeSessionFinder.listSessions` now enriches ALL collected main sessions before slice (D5 fix to a latent slice-before-enrich bug). Workflow + main collection run via `Promise.all` (post-simplify perf). |
| P3 — WorkflowDetector path B + WorkflowAttachment lifecycle + `--workflow` dispatcher | ✅ | Lifecycle ordering preserves the §10.2 R3-B4 invariant (journal initial dump completes before snapshot watcher starts — wedge slot reserved for P4). |
| P4 — SnapshotWatcher integration + status events + ENOENT/T20 | ✅ | Colored status events (running→gray, completed→green, failed→red). `autoStopScheduled` one-shot latch for terminal status; ENOENT routes to `stop('directory-removed')`. |
| P5 — ClaudeLineParser Workflow detection + WorkflowDetector path A + auto-attach | ✅ | Discriminator loosened (CI-2): `runId` + `transcriptDir` required; `scriptPath`/`summary`/`taskId` optional. T16 dedup via `markRunIdKnown` sync mark. |
| P6 — Interactive mode + workflow status line | ✅ | Status line combines workflow + session segments on single TTY line (no `\n` overflow). 1s poll for snapshot refresh with same-content guard. |
| P7 — PaneManager pin/evict + `--workflow-pane` execution + agent-pick + docs | ✅ | Journal pane pinned via `pinAgent`. Subagent panes use `openPaneEvictIfNeeded` (FIFO over `insertionOrder`, skips pinned). `tail -F` direct command (workflow agents nested under `subagents/workflows/`). agent-pick wf_ routing deferred (functional via existing customTitle display). |

**Post-completion review chain:**
- Codex `/review-loop` (round 1) — 8 findings flagged; 4 real bugs fixed
  (DisplayController updateStatusLine unwired, journal session id
  mismatch, `--workflow-pane` command builder wrong path, super-follow
  detector not rebound)
- Codex `/review-loop` (round 2) — 3 followups: TTY single-line render,
  shell-escape pane path, deferred fs.watch flake (env-specific)
- `tdd-reviewer` audit — PASS_WITH_ISSUES; tightened color test, rollback
  test escape hatch, shared DEFAULT_DEBOUNCE_MS
- `/simplify` (3 parallel review agents) — extracted `deriveWorkflowDirs`
  + `makeWorkflowJournalSessionId` helpers; dropped dead
  `stopRequestReason` state; parallelized main + workflow listSessions;
  same-content guard on status line redraw
- Codex post-simplify — PASS; switched to `lastIndexOf('workflows')`;
  added helper unit tests

**Deferred / acknowledged out of scope:**
- agent-pick full SPEC §11.4 6-column fzf format (workflow rows already
  visible in `--list`; functional via existing `customTitle` indicator)
- `--list` strict TYPE/NOTES column format per §11.3 (workflow rows
  appear with `customTitle = 'wf:{name}'` indicator)
- Constructor injection of `baseDir` (TDD reviewer W1 — touches
  `ClaudeAgent` factory + several test files; `workflowFinder` lazy
  getter is the current stop-gap)
- `WorkflowAttachmentConfig` 11-field bag → grouped sub-configs
  (mechanical refactor; low impact)
- macOS `fs.watch` flake mitigation via polling fallback (SPEC §19.6
  explicitly accepts; tests passed locally but sporadically fail in
  Codex sandbox)

---

_建立日期：2026-05-30_
_狀態：✅ Shipped on `feat/workflow-support` (2026-05-30)_
_批次：M4 完整版（first-class source + interactive + tmux pane）_
