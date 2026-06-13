import { Glob } from 'bun';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeAgentLabel, MAIN_SOURCE } from '../core/detector-interfaces.ts';
import { isSubagentTool, SUBAGENT_TOOL_NAMES } from '../utils/format-tool.ts';

/** 子字串前置過濾：避免每行都 JSON.parse；涵蓋所有 spawn tool 名稱 */
const SPAWN_TOOL_PREFILTER: string[] = [...SUBAGENT_TOOL_NAMES].map(
  (n) => `"name":"${n}"`
);
import type {
  OutputHandler,
  SessionHandler,
  WatcherHandler,
  RetryConfig,
} from '../core/detector-interfaces.ts';

// Re-export for backward compatibility (consumers can still import from this file)
export type {
  OutputHandler,
  SessionHandler,
  WatcherHandler,
  RetryConfig,
} from '../core/detector-interfaces.ts';
export {
  MAIN_LABEL,
  makeAgentLabel,
  extractAgentIdFromLabel,
} from '../core/detector-interfaces.ts';

/**
 * SubagentDetector 配置
 */
export interface SubagentDetectorConfig {
  /** subagents 目錄路徑 */
  subagentsDir: string;
  /** 輸出處理器 */
  output: OutputHandler;
  /** Watcher 處理器 */
  watcher: WatcherHandler;
  /** Session 處理器（可選，Interactive 模式使用） */
  session?: SessionHandler;
  /** 是否啟用（對應 options.follow） */
  enabled: boolean;
  /** 是否啟用目錄監控（預設 true） */
  watchDir?: boolean;
  /** 新 subagent 偵測時的回呼（用於 pane 自動開啟等） */
  onNewSubagent?: (
    agentId: string,
    subagentPath: string,
    description?: string
  ) => void;
  /** Subagent 進入時的回呼（含 resume，每次進入都觸發，用於 pane 開啟） */
  onSubagentEnter?: (agentId: string, subagentPath: string) => void;
  /** Subagent 完成時的回呼（用於 pane 自動關閉等） */
  onSubagentDone?: (agentId: string) => void;
  /** 檢查 agentId 是否有對應的 pane（用於判斷是否需要關閉） */
  hasPane?: (agentId: string) => boolean;
}

// ============================================================
// Constants
// ============================================================

/** Early detection 預設配置 */
export const EARLY_DETECTION_RETRY: RetryConfig = {
  maxRetries: 10,
  retryDelay: 100,
  initialDelay: 50,
};

/** Fallback detection 預設配置 */
export const FALLBACK_DETECTION_RETRY: RetryConfig = {
  maxRetries: 5,
  retryDelay: 100,
  initialDelay: 100,
};

/**
 * spawnRegistry 反查 retry 參數（Phase 2 nested parent lookup）。
 * 蓋住 parent JSONL line 在 nested 檔案出現後才被解析的 race window。
 * 4 × 50 = 最壞 150ms（不含最後一輪的 sleep）— Claude Code 實測時序為前提。
 */
export const PARENT_LOOKUP_MAX_ATTEMPTS = 4;
export const PARENT_LOOKUP_DELAY_MS = 50;

/**
 * subagents/ 與其父目錄都不存在時的初始 retry 間隔（base）。
 * agent-tail 在首個 subagent 出現前啟動是常態，必須持續輪詢直到目錄被建立。
 * 指數退避：1s, 2s, 4s, 8s, 16s, 30s, 30s...（cap）
 */
export const SUBAGENTS_DIR_RETRY_DELAY_MS = 1000;
export const SUBAGENTS_DIR_RETRY_MAX_DELAY_MS = 30000;

/**
 * Polling backup 間隔 — fs.watch 在 macOS 上對 dir 內新檔事件偶發 miss
 * （特別是 watch start 後立刻有檔案出現的情況）。定期掃描補漏；
 * scheduleScan() / knownAgentIds 在 registerNewAgent 內 dedup，安全重入。
 */
export const SUBAGENTS_DIR_POLL_BACKUP_MS = 500;

/** 建立 subagent 檔案路徑 */
export function buildSubagentPath(
  subagentsDir: string,
  agentId: string
): string {
  return join(subagentsDir, `agent-${agentId}.jsonl`);
}

/** 建立 subagent meta.json 檔案路徑 */
export function buildSubagentMetaPath(
  subagentsDir: string,
  agentId: string
): string {
  return join(subagentsDir, `agent-${agentId}.meta.json`);
}

/**
 * Subagent meta.json 結構
 * Claude Code 在 spawn subagent 時會寫入此檔（包含 nested subagent）
 */
interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  name?: string;
}

/**
 * 嘗試讀取 subagent 的 meta.json（含 retry）
 * meta.json 可能稍晚於 .jsonl 寫入，需要短暫重試
 *
 * @param subagentsDir subagents 目錄
 * @param agentId agent 識別碼
 * @param retries 重試次數（預設 3，最壞 150ms）
 * @param retryDelayMs 每次重試間隔（預設 50ms）
 */
export async function readSubagentMeta(
  subagentsDir: string,
  agentId: string,
  retries = 3,
  retryDelayMs = 50
): Promise<SubagentMeta | null> {
  const metaPath = buildSubagentMetaPath(subagentsDir, agentId);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 直讀 text()，缺檔走 catch 而非預先 exists()（少一次 syscall + 去 TOCTOU）
      const text = await Bun.file(metaPath).text();
      const parsed = JSON.parse(text) as SubagentMeta;
      return parsed;
    } catch {
      // 讀取或解析失敗，視為缺漏 → 重試
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return null;
}

/** 從 session 檔案路徑推導 subagents 目錄 */
export function getSubagentsDir(sessionFilePath: string): string {
  const projectDir = dirname(sessionFilePath);
  const sessionId = basename(sessionFilePath, '.jsonl');
  return join(projectDir, sessionId, 'subagents');
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * 驗證 agentId 格式
 * 支援 7-40 位十六進制字符（涵蓋短 hash 到完整 SHA-1）
 * 同時防止路徑穿越攻擊
 */
export function isValidAgentId(agentId: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(agentId);
}

/**
 * 從一個 JSONL 檔案內所有 assistant message 的 tool_use 區段中，
 * 收集 subagent spawn tool（Task / Agent — Claude Code 版本演進過的名稱）的
 * (toolUseId, source) 配對。
 * source 表示「誰呼叫了這次 tool_use」（主 session 或某個 subagent）。
 *
 * 用於 cold attach 時預跑：把所有歷史 spawn 關係蒐齊，再對應到每個既存
 * subagent 的 meta.toolUseId，補出 [child◂parent] label。
 */
async function collectAgentSpawnsFromJsonl(
  filePath: string,
  source: string
): Promise<Array<[string, string]>> {
  const pairs: Array<[string, string]> = [];
  try {
    const text = await Bun.file(filePath).text();
    for (const line of text.split('\n')) {
      // 前置子字串檢查避免每行都 JSON.parse（熱路徑優化）
      // 涵蓋 Task 與 Agent 兩種 spawn tool 名稱（與 isSubagentTool 一致）
      if (!SPAWN_TOOL_PREFILTER.some((pat) => line.includes(pat))) continue;
      try {
        const data = JSON.parse(line) as {
          type?: string;
          message?: {
            content?: Array<{ type?: string; name?: string; id?: string }>;
          };
        };
        if (data.type !== 'assistant') continue;
        const content = data.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (
            c &&
            c.type === 'tool_use' &&
            typeof c.name === 'string' &&
            isSubagentTool(c.name) &&
            typeof c.id === 'string'
          ) {
            pairs.push([c.id, source]);
          }
        }
      } catch {
        /* skip non-JSON */
      }
    }
  } catch {
    /* skip missing/unreadable file */
  }
  return pairs;
}

/**
 * Cold attach 時對所有既存 subagent 預解析 parent 關係。
 *
 * 流程：
 * 1. 平行讀主 session 與每個 subagent JSONL，收集所有 Agent tool_use 的
 *    (toolUseId → source) 配對（source = MAIN_SOURCE 或某 agentId）。
 * 2. 平行讀每個 subagent 的 meta.json，用 meta.toolUseId 反查上表。
 *
 * @param subagentsDir subagents 目錄
 * @param mainSessionPath 主 session JSONL 路徑
 * @param agentIds 既存 subagent 的 id 集合
 * @returns Map<agentId, parentAgentId | undefined>
 *   - undefined：parent 是主 session（label 維持 `[child]`）或查不到
 *   - 字串：nested parent 的 agentId（label 為 `[child◂parent]`）
 */
export async function resolveExistingParents(
  subagentsDir: string,
  mainSessionPath: string,
  agentIds: Iterable<string>
): Promise<Map<string, string | undefined>> {
  const ids = [...agentIds];
  const parentMap = new Map<string, string | undefined>();
  if (ids.length === 0) return parentMap;

  // 1. 平行收集所有 Agent tool_use 的 (toolUseId → source)
  const collectionTasks: Array<Promise<Array<[string, string]>>> = [
    collectAgentSpawnsFromJsonl(mainSessionPath, MAIN_SOURCE),
    ...ids.map((id) =>
      collectAgentSpawnsFromJsonl(buildSubagentPath(subagentsDir, id), id)
    ),
  ];
  const collected = await Promise.all(collectionTasks);
  const spawnSources = new Map(collected.flat());

  // 2. 平行讀每個 subagent 的 meta.json（cold attach 檔案穩定，retry=0）
  const metaResults = await Promise.all(
    ids.map(async (id) => ({
      id,
      meta: await readSubagentMeta(subagentsDir, id, 0, 0),
    }))
  );

  // 3. 反查
  for (const { id, meta } of metaResults) {
    const source = meta?.toolUseId
      ? spawnSources.get(meta.toolUseId)
      : undefined;
    parentMap.set(id, source && source !== MAIN_SOURCE ? source : undefined);
  }
  return parentMap;
}

/**
 * 從主 session 檔案中提取所有 agentId
 */
export async function extractAgentIds(
  sessionPath: string
): Promise<Set<string>> {
  const agentIds = new Set<string>();

  try {
    const file = Bun.file(sessionPath);
    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        // 從 toolUseResult 中提取 agentId，並驗證格式以防止路徑穿越
        const agentId = data.toolUseResult?.agentId;
        if (agentId && isValidAgentId(agentId)) {
          agentIds.add(agentId);
        }
      } catch {
        // 忽略解析錯誤
      }
    }
  } catch {
    // 忽略檔案讀取錯誤
  }

  return agentIds;
}

/**
 * 掃描 subagents 目錄，找出尚未被監控的新 subagent 檔案
 * @param subagentsDir subagents 目錄路徑
 * @param knownAgentIds 已知的 agentId 集合
 * @returns 新發現的 agentId 陣列
 */
export async function scanForNewSubagents(
  subagentsDir: string,
  knownAgentIds: Set<string>
): Promise<string[]> {
  const newAgentIds: string[] = [];

  try {
    const glob = new Glob('agent-*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir })) {
      // Defensive: skip anything under a subdirectory (e.g. nested
      // workflows/wf_*/agent-*.jsonl). Bun.Glob is non-recursive by
      // default but this guard protects against future behavior changes.
      if (file.includes('/')) continue;
      // 從檔名 "agent-{id}.jsonl" 提取 id（支援 7-40 位 hex）
      const match = file.match(/^agent-([0-9a-f]{7,40})\.jsonl$/i);
      if (match && match[1]) {
        const agentId = match[1];
        if (!knownAgentIds.has(agentId)) {
          newAgentIds.push(agentId);
        }
      }
    }
  } catch {
    // 目錄不存在或無法存取時靜默忽略
    // 這是預期行為：subagent 可能尚未建立目錄
  }

  return newAgentIds;
}

// ============================================================
// Core Functions
// ============================================================

/**
 * 嘗試新增 subagent 檔案監控（含重試邏輯）
 *
 * @param subagentPath - subagent 檔案路徑
 * @param agentId - agent 識別碼
 * @param watcher - watcher 處理器
 * @param output - 輸出處理器
 * @param config - 重試配置
 * @returns Promise<boolean> 是否成功新增
 */
export async function tryAddSubagentFile(
  subagentPath: string,
  agentId: string,
  watcher: WatcherHandler,
  output: OutputHandler,
  config: RetryConfig = FALLBACK_DETECTION_RETRY,
  parentAgentId?: string
): Promise<boolean> {
  const doTry = async (retriesLeft: number): Promise<boolean> => {
    try {
      const file = Bun.file(subagentPath);
      if (await file.exists()) {
        await watcher.addFile({
          path: subagentPath,
          label: makeAgentLabel(agentId, parentAgentId),
        });
        return true;
      } else if (retriesLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelay));
        return doTry(retriesLeft - 1);
      } else {
        output.debug(`Subagent file not found after retries: ${agentId}`);
        return false;
      }
    } catch (error) {
      output.error(`Failed to add subagent watcher: ${agentId} - ${error}`);
      return false;
    }
  };

  // 初始延遲後開始嘗試
  await new Promise((resolve) => setTimeout(resolve, config.initialDelay));
  return doTry(config.maxRetries);
}

// ============================================================
// SubagentDetector Class
// ============================================================

/**
 * Subagent 偵測器 - 整合 early detection 和 fallback detection
 */
export class SubagentDetector {
  private knownAgentIds: Set<string>;
  private config: SubagentDetectorConfig;
  private dirWatcher: FSWatcher | null = null;
  private parentWatcher: FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private dirPollTimer: ReturnType<typeof setInterval> | null = null;
  private isWatching = false;
  // 追蹤所有 pending 的 setTimeout 句柄，用於 stop() 時清除
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  // subagents/ 目錄 retry 的指數退避計數（成功 attach 後重置）
  private dirRetryAttempts = 0;
  // FIFO queue: Task tool_use descriptions, matched to agents in registration order.
  // May mismatch with parallel Task launches (known limitation, wrong label only).
  private pendingDescriptions: string[] = [];
  // spawnRegistry: 紀錄每個 Agent tool_use id 由誰呼叫
  // value = parent agentId（巢狀）或 MAIN_SOURCE（主 session）
  // 用於 meta.json.toolUseId 反查 → 推導 nested subagent 的 parent
  private spawnRegistry: Map<string, string> = new Map();

  constructor(initialAgentIds: Set<string>, config: SubagentDetectorConfig) {
    this.knownAgentIds = new Set(initialAgentIds);
    this.config = config;
  }

  /**
   * 啟動 subagents 目錄監控（自動偵測新檔案）
   */
  startDirectoryWatch(): void {
    if (!this.config.enabled) return;
    if (this.isWatching) return;
    if (this.config.watchDir === false) return;

    this.isWatching = true;
    this.tryWatchSubagentsDir();
  }

  /**
   * 啟動 polling backup（僅在 subagents/ 成功 attach 後呼叫）。
   * 避免在 dir 不存在時繞過 scheduleSubagentsDirRetry 的指數退避。
   */
  private _startDirPollBackup(): void {
    if (!this.isWatching) return;
    if (this.dirPollTimer) return;
    this.dirPollTimer = setInterval(() => {
      if (!this.isWatching) return;
      this.scheduleScan();
    }, SUBAGENTS_DIR_POLL_BACKUP_MS);
  }

  private _clearDirPollBackup(): void {
    if (this.dirPollTimer) {
      clearInterval(this.dirPollTimer);
      this.dirPollTimer = null;
    }
  }

  /**
   * 停止所有監控
   */
  stop(): void {
    this.isWatching = false;
    this.clearScanTimer();
    // 清除所有 pending 的 setTimeout
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.pendingDescriptions = [];
    this.spawnRegistry.clear();
    this.dirRetryAttempts = 0;
    this._clearDirPollBackup();
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
  }

  /**
   * 處理 early subagent detection（Task tool_use 觸發）
   * 使用非同步 setTimeout 來避免阻塞主流程
   */
  handleEarlyDetection(): void {
    if (!this.config.enabled) return;

    // 延遲掃描（讓檔案有機會建立）
    this.schedulePending(EARLY_DETECTION_RETRY.initialDelay, async () => {
      try {
        const newAgentIds = await scanForNewSubagents(
          this.config.subagentsDir,
          this.knownAgentIds
        );

        for (const agentId of newAgentIds) {
          this.registerNewAgent(
            agentId,
            EARLY_DETECTION_RETRY,
            `Early subagent detected: ${agentId}`
          );
        }
      } catch (error) {
        this.config.output.error(`Early detection scan failed: ${error}`);
      }
    });
  }

  /**
   * 處理 agent_progress 事件（subagent 進入或 resume 時）
   * 只在 resume（已知 agentId）時觸發 onSubagentEnter
   * 新 agentId 的 pane 開啟由 onNewSubagent 負責，避免重複觸發
   */
  handleAgentProgress(agentId: string): void {
    if (!this.config.enabled) return;
    if (!isValidAgentId(agentId)) return;

    // 新 agentId 仍由 early/fallback 路徑完成註冊，避免提前標記 known 造成漏註冊
    if (!this.knownAgentIds.has(agentId)) return;

    const subagentPath = buildSubagentPath(this.config.subagentsDir, agentId);
    this.config.onSubagentEnter?.(agentId, subagentPath);
  }

  /**
   * 處理 fallback detection（toolUseResult 觸發）
   * @param agentId - 從 toolUseResult 提取的 agentId
   */
  handleFallbackDetection(agentId: string): void {
    // 驗證 agentId 格式
    if (!isValidAgentId(agentId)) {
      this.config.output.debug(`Ignoring invalid agentId format: ${agentId}`);
      return;
    }

    // 檢查是否已經監控中
    const isAlreadyMonitored = this.knownAgentIds.has(agentId);

    if (isAlreadyMonitored) {
      // 已經監控中，表示之前透過 early detection 發現過
      // 輸出完成訊息，觸發 onSubagentDone（關閉 pane）
      this.config.output.warn(`Subagent completed: ${agentId}`);
    } else {
      // 首次發現且已完成：不開 pane，只註冊監控
      this.knownAgentIds.add(agentId);

      // Consume pending description to prevent queue drift
      // (this agent's Task tool_use pushed a description, but no pane will open)
      this.pendingDescriptions.shift();

      const subagentPath = buildSubagentPath(this.config.subagentsDir, agentId);

      // Session 處理（Interactive 模式）
      this.config.session?.addSession?.(
        agentId,
        makeAgentLabel(agentId),
        subagentPath
      );

      if (this.config.enabled) {
        this.config.output.warn(
          `New subagent detected (completed): ${agentId}`
        );

        // 非阻塞式新增檔案監控（但不觸發 onNewSubagent，因為已完成）
        // 只在 directory watch 已啟動時才建立 timer，避免孤立 timer 洩漏
        if (this.isWatching) {
          const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            if (!this.isWatching) return;

            tryAddSubagentFile(
              subagentPath,
              agentId,
              this.config.watcher,
              this.config.output,
              FALLBACK_DETECTION_RETRY
            );
          }, FALLBACK_DETECTION_RETRY.initialDelay);
          this.pendingTimers.add(timer);
        }
      }
    }

    // toolUseResult 表示 subagent 已完成
    if (this.config.session?.markSessionDone) {
      this.config.session.markSessionDone(agentId);
      this.config.output.debug(`Subagent completed: ${agentId}`);
    }
    this.config.session?.updateUI?.();

    // 只有已監控的（有開 pane 的）才需要觸發 onSubagentDone
    if (isAlreadyMonitored && this.config.hasPane?.(agentId)) {
      this.config.onSubagentDone?.(agentId);
    }
  }

  /**
   * Push a Task description to the FIFO queue.
   * Called when a Task tool_use with description is detected in the main session.
   * The description will be matched to the next newly registered agent.
   */
  pushDescription(description: string): void {
    this.pendingDescriptions.push(description);
  }

  /**
   * 記錄一次 Agent tool_use 呼叫的 spawn 關係。
   * - toolUseId: Agent tool_use 的 id（例 toolu_01Smf3mRVKSkcMH1p2X1RDxV）
   * - parentSource: 呼叫方的 agentId；主 session 請傳 MAIN_SOURCE
   *
   * Phase 2 用：當新 subagent 註冊且讀到 meta.json 的 toolUseId 時，
   * 反查此表得知 parent，組成 [child◂parent] label。
   */
  recordSpawn(toolUseId: string, parentSource: string): void {
    this.spawnRegistry.set(toolUseId, parentSource);
  }

  /**
   * 取得已知的 agentId 集合（供測試使用）
   */
  getKnownAgentIds(): Set<string> {
    return new Set(this.knownAgentIds);
  }

  /**
   * 檢查是否為已知的 agentId
   */
  isKnownAgent(agentId: string): boolean {
    return this.knownAgentIds.has(agentId);
  }

  private clearScanTimer(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private scheduleScan(): void {
    if (!this.isWatching) return;
    this.clearScanTimer();
    this.scanTimer = setTimeout(async () => {
      if (!this.isWatching) return;
      try {
        const newAgentIds = await scanForNewSubagents(
          this.config.subagentsDir,
          this.knownAgentIds
        );
        for (const agentId of newAgentIds) {
          this.registerNewAgent(
            agentId,
            EARLY_DETECTION_RETRY,
            `New subagent detected: ${agentId}`
          );
        }
      } catch (error) {
        this.config.output.error(`Directory scan failed: ${error}`);
      }
    }, 100);
  }

  private tryWatchSubagentsDir(): void {
    if (!this.isWatching) return;

    try {
      this.parentWatcher?.close();
      this.parentWatcher = null;

      this.dirWatcher = watch(this.config.subagentsDir, () => {
        this.scheduleScan();
      });
      this.dirWatcher.on('error', () => {
        this.dirWatcher?.close();
        this.dirWatcher = null;
        // dir 掉了 → 停 polling、退到 retry 退避；dir 回來再重啟 polling
        this._clearDirPollBackup();
        this.scheduleSubagentsDirRetry();
      });
      // 成功 attach → 重置 retry 計數 + 啟動 polling backup
      this.dirRetryAttempts = 0;
      this._startDirPollBackup();
      // 目錄建立後先掃描一次，避免錯過已存在的新檔案
      this.scheduleScan();
    } catch {
      // subagents 目錄可能尚未建立，改監控父層目錄
      // 不啟動 polling — 由 scheduleSubagentsDirRetry 的指數退避處理
      this.watchParentForSubagentsDir();
    }
  }

  private watchParentForSubagentsDir(): void {
    if (!this.isWatching) return;
    if (this.parentWatcher) return;

    const parentDir = join(this.config.subagentsDir, '..');
    try {
      this.parentWatcher = watch(parentDir, () => {
        // 嘗試切回 subagents 目錄監控
        this.tryWatchSubagentsDir();
      });
      this.parentWatcher.on('error', () => {
        this.parentWatcher?.close();
        this.parentWatcher = null;
        // 父層 watcher 掉了，排程 retry（subagentsDir 可能稍後出現）
        this.scheduleSubagentsDirRetry();
      });
    } catch {
      // 父層目錄也不存在（典型：session UUID 目錄要等首個 subagent 才被建立）
      // 排程 retry，否則 nested subagent 永遠不會被偵測到
      this.scheduleSubagentsDirRetry();
    }
  }

  /**
   * subagents/ 與其父目錄都不存在時排程 retry（指數退避，上限 30s）。
   * Claude Code 在首個 subagent 出現前不會建立 {sessionUUID}/ 目錄；
   * agent-tail 若先於首個 subagent 啟動，必須持續 retry 直到目錄出現。
   * 對於從不 spawn subagent 的 session，退避避免無止境的 1Hz 輪詢。
   */
  private scheduleSubagentsDirRetry(): void {
    if (!this.isWatching) return;
    // 1s, 2s, 4s, 8s, 16s, 30s, 30s...
    const delay = Math.min(
      SUBAGENTS_DIR_RETRY_DELAY_MS * 2 ** this.dirRetryAttempts,
      SUBAGENTS_DIR_RETRY_MAX_DELAY_MS
    );
    this.dirRetryAttempts++;
    this.schedulePending(delay, () => {
      if (this.dirWatcher || this.parentWatcher) return; // 同時間其他路徑已 attach
      this.tryWatchSubagentsDir();
    });
  }

  /**
   * 在 pendingTimers 集合中註冊一個延遲執行的回呼。
   * - 自動把 timer 加入 pendingTimers（stop() 會統一清掉）
   * - 進入回呼時自動從集合移除
   * - 觸發時再次檢查 isWatching，detector 已 stop 則放棄
   */
  private schedulePending(
    delayMs: number,
    fn: () => void | Promise<void>
  ): void {
    if (!this.isWatching) return;
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timer);
      if (!this.isWatching) return;
      await fn();
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  private registerNewAgent(
    agentId: string,
    retryConfig: RetryConfig,
    message: string
  ): void {
    if (this.knownAgentIds.has(agentId)) return;
    this.knownAgentIds.add(agentId);

    const subagentPath = join(
      this.config.subagentsDir,
      `agent-${agentId}.jsonl`
    );

    // 同步先取 FIFO 保持順序；async 部分（meta.json fallback、parent 解析、
    // session/watcher 註冊）丟給 finalizeRegistration
    const queuedDescription = this.pendingDescriptions.shift();
    void this.finalizeRegistration(
      agentId,
      subagentPath,
      queuedDescription,
      retryConfig,
      message
    );
  }

  /**
   * spawnRegistry 反查含 retry：parent JSONL line 與 nested 檔案出現存在 race。
   * - 命中 → 從 registry 刪除（每個 toolUseId 只會被 1 個 child consume），
   *   MAIN_SOURCE 視為無 parent 回 undefined，其他視為 nested parent。
   * - 最多 PARENT_LOOKUP_MAX_ATTEMPTS 次，間隔 PARENT_LOOKUP_DELAY_MS（第 1 次不等）。
   */
  private async lookupParentWithRetry(
    toolUseId: string
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < PARENT_LOOKUP_MAX_ATTEMPTS; attempt++) {
      const parent = this.spawnRegistry.get(toolUseId);
      if (parent) {
        this.spawnRegistry.delete(toolUseId);
        return parent === MAIN_SOURCE ? undefined : parent;
      }
      if (attempt < PARENT_LOOKUP_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, PARENT_LOOKUP_DELAY_MS)
        );
        if (!this.isWatching) return undefined;
      }
    }
    return undefined;
  }

  /**
   * 完成新 subagent 的非同步註冊流程：
   * 1. 若 FIFO 沒有 description（典型為 nested subagent）→ 讀 meta.json 補
   * 2. 若 meta.json 有 toolUseId → 反查 spawnRegistry 取得 parent agentId
   * 3. 用 parent-aware label 註冊 session 與 file watcher
   * 4. 觸發 onNewSubagent 回呼
   */
  private async finalizeRegistration(
    agentId: string,
    subagentPath: string,
    queuedDescription: string | undefined,
    retryConfig: RetryConfig,
    message: string
  ): Promise<void> {
    // 一律讀 meta.json：它是 Claude Code 寫的權威來源（description + toolUseId）。
    // 不能只在 FIFO 落空時才讀 — FIFO 可能因「歷史 Task 推進去但對應 subagent
    // 早已存在、registerNewAgent skip」而累積 stale 條目，後續任何新 subagent
    // 註冊都會 shift 到錯誤 description 並跳過 parent lookup。
    const meta = await readSubagentMeta(this.config.subagentsDir, agentId);
    // detector 已 stop 則放棄（防止跨 session 污染）
    if (!this.isWatching) return;

    // 偏好 meta.description；FIFO 僅作備援（meta.json 不在或無 description 欄位時）
    const description = meta?.description ?? queuedDescription;
    let parentAgentId: string | undefined;

    if (meta?.toolUseId) {
      // Race: parent JSONL 那行 Agent tool_use 可能比 nested 檔出現還晚被
      // 解析（→ recordSpawn 後到）。短暫 retry 蓋住典型 50-200ms 窗口；
      // 仍查不到就退回無 parent label，不阻塞註冊流程。
      parentAgentId = await this.lookupParentWithRetry(meta.toolUseId);
      if (!this.isWatching) return;
    }

    const label = makeAgentLabel(agentId, parentAgentId);

    // Session 處理（Interactive 模式）
    this.config.session?.addSession?.(agentId, label, subagentPath);

    if (!this.config.enabled) return;

    // 把 label 帶進 warn 訊息，便於 nested 場景下直接看到 [child◂parent]
    const annotatedMessage = parentAgentId ? `${message} ${label}` : message;
    this.config.output.warn(annotatedMessage);

    // 觸發 onNewSubagent 回呼（pane 自動開啟等用途）
    this.config.onNewSubagent?.(agentId, subagentPath, description);

    // 非阻塞式新增檔案監控
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (!this.isWatching) return;

      tryAddSubagentFile(
        subagentPath,
        agentId,
        this.config.watcher,
        this.config.output,
        retryConfig,
        parentAgentId
      );
    }, retryConfig.initialDelay);
    this.pendingTimers.add(timer);
  }
}
