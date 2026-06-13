import { Glob } from 'bun';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeAgentLabel, MAIN_SOURCE } from '../core/detector-interfaces.ts';
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
export interface SubagentMeta {
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
 * @param retries 重試次數（預設 5）
 * @param retryDelayMs 每次重試間隔（預設 50ms）
 */
export async function readSubagentMeta(
  subagentsDir: string,
  agentId: string,
  retries = 5,
  retryDelayMs = 50
): Promise<SubagentMeta | null> {
  const metaPath = buildSubagentMetaPath(subagentsDir, agentId);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const file = Bun.file(metaPath);
      if (await file.exists()) {
        const text = await file.text();
        const parsed = JSON.parse(text) as SubagentMeta;
        return parsed;
      }
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
  private isWatching = false;
  // 追蹤所有 pending 的 setTimeout 句柄，用於 stop() 時清除
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
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
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timer);
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
            `Early subagent detected: ${agentId}`
          );
        }
      } catch (error) {
        this.config.output.error(`Early detection scan failed: ${error}`);
      }
    }, EARLY_DETECTION_RETRY.initialDelay);
    this.pendingTimers.add(timer);
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
   * - parentLabel: 呼叫方的 agentId；主 session 請傳 MAIN_SOURCE
   *
   * Phase 2 用：當新 subagent 註冊且讀到 meta.json 的 toolUseId 時，
   * 反查此表得知 parent，組成 [child◂parent] label。
   */
  recordSpawn(toolUseId: string, parentLabel: string): void {
    this.spawnRegistry.set(toolUseId, parentLabel);
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
      });
      // 目錄建立後先掃描一次，避免錯過已存在的新檔案
      this.scheduleScan();
    } catch {
      // subagents 目錄可能尚未建立，改監控父層目錄
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
      });
    } catch {
      // ignore
    }
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
   * - 命中 → MAIN_SOURCE 視為無 parent（回 undefined），其他視為 nested parent。
   * - 最多 PARENT_LOOKUP_MAX_ATTEMPTS 次，間隔 PARENT_LOOKUP_DELAY_MS（第 1 次不等）。
   */
  private async lookupParentWithRetry(
    toolUseId: string
  ): Promise<string | undefined> {
    const MAX_ATTEMPTS = PARENT_LOOKUP_MAX_ATTEMPTS;
    const DELAY_MS = PARENT_LOOKUP_DELAY_MS;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const parent = this.spawnRegistry.get(toolUseId);
      if (parent) {
        return parent === MAIN_SOURCE ? undefined : parent;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
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
    let description = queuedDescription;
    let parentAgentId: string | undefined;

    // FIFO 命中 = 主 session spawn → 無 parent；FIFO 落空 = 可能 nested。
    // 已知 trade-off：FIFO shift 在 registerNewAgent 同步進行，遇到 parallel Task
    // 啟動或「主 spawn 比 main JSONL line 還早到」等罕見 race 時，stale description
    // 可能被誤配給 nested agent（且因為 description 不為空，會跳過 meta + parent
    // 反查）。視為與 line 287-288 既有 FIFO 限制同類，MVP 接受。
    if (!description) {
      const meta = await readSubagentMeta(this.config.subagentsDir, agentId);
      // detector 已 stop 則放棄（防止跨 session 污染）
      if (!this.isWatching) return;
      description = meta?.description;
      if (meta?.toolUseId) {
        // Race: parent JSONL 那行 Agent tool_use 可能比 nested 檔出現還晚被
        // 解析（→ recordSpawn 後到）。短暫 retry 蓋住典型 50-200ms 窗口；
        // 仍查不到就退回無 parent label，不阻塞註冊流程。
        parentAgentId = await this.lookupParentWithRetry(meta.toolUseId);
        if (!this.isWatching) return;
      }
    }

    const label = makeAgentLabel(agentId, parentAgentId);

    // Session 處理（Interactive 模式）
    this.config.session?.addSession?.(agentId, label, subagentPath);

    if (!this.config.enabled) return;

    this.config.output.warn(message);

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
