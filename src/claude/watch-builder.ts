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
}

/**
 * 建立標準 onLine handler，供 MultiFileWatcher 的 onLine callback 使用
 */
export function createOnLineHandler(
  config: OnLineHandlerConfig
): (line: string, label: string) => void {
  return (line: string, label: string) => {
    let parser = config.parsers.get(label);
    if (!parser) {
      const newAgent = new ClaudeAgent({ verbose: config.verbose });
      parser = newAgent.parser;
      config.parsers.set(label, parser);
    }

    let parsed = parser.parse(line);
    while (parsed) {
      parsed.sourceLabel = label;

      // Phase 2.3: 過濾已有 pane 的 subagent 輸出
      if (config.shouldOutput && !config.shouldOutput(label)) {
        parsed = parser.parse(line);
        continue;
      }

      config.onOutput(config.formatter.format(parsed), label);

      // 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
      if (label === MAIN_LABEL && parsed.isTaskToolUse) {
        config.detector.handleEarlyDetection();
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
