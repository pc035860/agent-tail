import { stat } from 'node:fs/promises';
import { ClaudeAgent } from '../agents/claude/claude-agent.ts';
import type { LineParser } from '../agents/agent.interface.ts';
import type { Formatter } from '../formatters/formatter.interface.ts';
import type { ParsedLine, SessionFile } from '../core/types.ts';
import {
  type SubagentDetector,
  MAIN_LABEL,
  buildSubagentPath,
} from './subagent-detector.ts';
import { labelToParentSource } from '../core/detector-interfaces.ts';
import type { WorkflowDetector } from '../claude-workflow/workflow-detector.ts';

export const SUPER_FOLLOW_POLL_MS = 500;
export const SUPER_FOLLOW_DELAY_MS = 5000;

/**
 * 從 subagent JSONL 檔案讀取最後一條 assistant 訊息的所有 ParsedLine parts
 * 用於在 pane 關閉前回顯 subagent 的最終報告
 */
export async function readLastAssistantMessage(
  filePath: string,
  verbose: boolean
): Promise<ParsedLine[]> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return [];

    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    // 從尾部往前找最後一條 type === 'assistant' 的行
    let lastAssistantLine: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      try {
        const data = JSON.parse(line);
        if (data.type === 'assistant') {
          lastAssistantLine = line;
          break;
        }
      } catch {
        // 略過無效 JSON
      }
    }

    if (!lastAssistantLine) return [];

    // 用新的 parser 實例解析（避免狀態污染）
    const parser = new ClaudeAgent({ verbose }).parser;
    const parts: ParsedLine[] = [];
    let parsed = parser.parse(lastAssistantLine);
    while (parsed) {
      parts.push(parsed);
      parsed = parser.parse(lastAssistantLine);
    }

    return parts;
  } catch {
    return [];
  }
}

/**
 * 掃描 subagents 目錄，取得現有 subagent 檔案並按 birthtime 升序排序
 */
export async function buildSubagentFiles(
  subagentsDir: string,
  initialAgentIds: Set<string>
): Promise<Array<{ agentId: string; path: string; birthtime: Date }>> {
  // 平行化 stat 呼叫，直接用 stat() 取代 exists() + stat() 的雙重 syscall
  const results = await Promise.all(
    [...initialAgentIds].map(async (agentId) => {
      const subagentPath = buildSubagentPath(subagentsDir, agentId);
      try {
        const stats = await stat(subagentPath);
        return { agentId, path: subagentPath, birthtime: stats.birthtime };
      } catch {
        // 檔案不存在（ENOENT）或無法存取，跳過
        return null;
      }
    })
  );

  // 過濾掉不存在的檔案，按建立時間升序排序（最舊的先加入）
  return results
    .filter(
      (r): r is { agentId: string; path: string; birthtime: Date } => r !== null
    )
    .sort((a, b) => a.birthtime.getTime() - b.birthtime.getTime());
}

/**
 * createOnLineHandler 的配置
 */
export interface OnLineHandlerConfig {
  parsers: Map<string, LineParser>;
  formatter: Formatter;
  detector: SubagentDetector;
  onOutput: (formatted: string, label: string) => void;
  verbose: boolean;
  /** 過濾函數：回傳 true 表示應該輸出，false 表示跳過（Phase 2.3） */
  shouldOutput?: (label: string) => boolean;
  /** Callback when a custom-title event is detected on MAIN session */
  onTitleUpdate?: (title: string) => void;
  /**
   * P5 — Workflow detector for path A (main-JSONL Workflow tool_result
   * detection). Caller must construct the detector BEFORE invoking
   * createOnLineHandler so the reference is live when initial-read replays.
   */
  workflowDetector?: WorkflowDetector;
}

/**
 * 建立標準 onLine handler，供 MultiFileWatcher 的 onLine callback 使用
 */
export function createOnLineHandler(
  config: OnLineHandlerConfig
): (line: string, label: string) => void {
  return (line: string, label: string) => {
    // agent_progress：subagent 進入或 resume，每次進入都觸發 pane 開啟
    // 前置字串檢查避免每行都 JSON.parse（熱路徑優化）
    if (label === MAIN_LABEL && line.includes('"agent_progress"')) {
      try {
        const data = JSON.parse(line) as {
          type?: string;
          data?: { type?: string; agentId?: string };
        };
        if (
          data.type === 'progress' &&
          data.data?.type === 'agent_progress' &&
          data.data?.agentId
        ) {
          config.detector.handleAgentProgress(data.data.agentId);
        }
      } catch {
        // 非 JSON 或無關格式，略過
      }
    }

    let parser = config.parsers.get(label);
    if (!parser) {
      const newAgent = new ClaudeAgent({ verbose: config.verbose });
      parser = newAgent.parser;
      config.parsers.set(label, parser);
    }

    let parsed = parser.parse(line);
    while (parsed) {
      parsed.sourceLabel = label;

      // === Metadata extraction ===
      // 必須在 shouldOutput 抑制檢查之前；偵測邏輯不該受輸出抑制影響
      // （否則 --pane 模式下 parent subagent 被抑制時，recordSpawn 不會觸發
      //  → nested child 的 [child◂parent] label 拿不到 parent，掛回 [child]）

      // 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
      // 只有主 session 走完整偵測流程（FIFO push + early detection scan）
      // nested 那層的 description 改靠 meta.json 補；dir watch 處理檔案出現
      if (parsed.isTaskToolUse && label === MAIN_LABEL) {
        if (parsed.taskDescription) {
          config.detector.pushDescription(parsed.taskDescription);
        }
        config.detector.handleEarlyDetection();
      }
      // Phase 2: 紀錄 spawn 關係（主 session 與 nested 都收）
      // nested subagent 註冊時靠此 map 反查 parent → 組 [child◂parent] label
      if (parsed.isTaskToolUse && parsed.taskToolUseId) {
        config.detector.recordSpawn(
          parsed.taskToolUseId,
          labelToParentSource(label)
        );
      }

      // P5 — Workflow path A: main-JSONL Workflow tool_result triggers
      // auto-attach when --workflow-attach is enabled (default).
      if (label === MAIN_LABEL && parsed.workflowAsyncLaunch) {
        config.workflowDetector?.handleMainLine(parsed);
      }

      // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
      if (label === MAIN_LABEL) {
        const raw = parsed.raw as {
          toolUseResult?: {
            agentId?: string;
            commandName?: string;
            status?: string;
          };
        };
        const agentId = raw?.toolUseResult?.agentId;
        const commandName = raw?.toolUseResult?.commandName;
        const status = raw?.toolUseResult?.status;

        if (agentId && !commandName && status !== 'forked') {
          config.detector.handleFallbackDetection(agentId);
        }
      }

      // === Output (subject to suppression) ===
      // Phase 2.3: 過濾已有 pane 的 subagent 輸出
      const suppressed = !!(config.shouldOutput && !config.shouldOutput(label));
      if (!suppressed) {
        config.onOutput(config.formatter.format(parsed), label);

        // Real-time custom-title update
        if (
          label === MAIN_LABEL &&
          parsed.isCustomTitle &&
          parsed.customTitleValue
        ) {
          config.onTitleUpdate?.(parsed.customTitleValue);
        }
      }

      parsed = parser.parse(line);
    }
  };
}

/**
 * createSuperFollowController 的配置
 */
export interface SuperFollowControllerConfig {
  projectDir: string;
  getCurrentPath: () => string;
  onSwitch: (nextFile: SessionFile) => Promise<void>;
  autoSwitch: boolean;
  /** 注入的 session 搜尋函數（用於尋找專案中最新的 session） */
  findLatestInProject: (projectDir: string) => Promise<SessionFile | null>;
}

/**
 * 建立 super-follow 控制器（自動切換到最新 session）
 */
export function createSuperFollowController(
  config: SuperFollowControllerConfig
): {
  start: () => void;
  stop: () => void;
} {
  let stopped = false;
  let pendingSwitchPath: string | null = null;
  let pendingSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingSwitch = (): void => {
    if (pendingSwitchTimer) {
      clearTimeout(pendingSwitchTimer);
      pendingSwitchTimer = null;
    }
    pendingSwitchPath = null;
  };

  const scheduleSwitch = (nextPath: string): void => {
    if (pendingSwitchPath === nextPath) return;
    pendingSwitchPath = nextPath;
    if (pendingSwitchTimer) clearTimeout(pendingSwitchTimer);

    pendingSwitchTimer = setTimeout(async () => {
      if (stopped || !pendingSwitchPath) return;
      try {
        const latest = await config.findLatestInProject(config.projectDir);
        if (
          latest &&
          latest.path === pendingSwitchPath &&
          latest.path !== config.getCurrentPath()
        ) {
          await config.onSwitch(latest);
        }
      } catch {
        // ignore
      } finally {
        clearPendingSwitch();
      }
    }, SUPER_FOLLOW_DELAY_MS);
  };

  const start = (): void => {
    if (!config.autoSwitch) return;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const latest = await config.findLatestInProject(config.projectDir);
        if (latest && latest.path !== config.getCurrentPath()) {
          scheduleSwitch(latest.path);
        } else if (!latest) {
          clearPendingSwitch();
        }
      } catch {
        // ignore
      } finally {
        pollTimer = setTimeout(poll, SUPER_FOLLOW_POLL_MS);
      }
    };

    poll();
  };

  const stop = (): void => {
    stopped = true;
    clearPendingSwitch();
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  return { start, stop };
}
