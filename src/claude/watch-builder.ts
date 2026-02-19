import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeAgent } from '../agents/claude/claude-agent.ts';
import type { LineParser } from '../agents/agent.interface.ts';
import type { Formatter } from '../formatters/formatter.interface.ts';
import type { SessionFile } from '../core/types.ts';
import type { SubagentDetector } from './subagent-detector.ts';
import { findLatestMainSessionInProject } from './auto-switch.ts';

export const SUPER_FOLLOW_POLL_MS = 500;
export const SUPER_FOLLOW_DELAY_MS = 5000;

/**
 * 掃描 subagents 目錄，取得現有 subagent 檔案並按 birthtime 升序排序
 */
export async function buildSubagentFiles(
  subagentsDir: string,
  initialAgentIds: Set<string>
): Promise<Array<{ agentId: string; path: string; birthtime: Date }>> {
  const result: Array<{ agentId: string; path: string; birthtime: Date }> = [];

  for (const agentId of initialAgentIds) {
    const subagentPath = join(subagentsDir, `agent-${agentId}.jsonl`);
    const subagentFile = Bun.file(subagentPath);
    if (await subagentFile.exists()) {
      const stats = await stat(subagentPath);
      result.push({
        agentId,
        path: subagentPath,
        birthtime: stats.birthtime,
      });
    }
  }

  // 按建立時間升序排序（最舊的先加入）
  result.sort((a, b) => a.birthtime.getTime() - b.birthtime.getTime());

  return result;
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
      config.onOutput(config.formatter.format(parsed), label);

      // 早期 Subagent 偵測：當偵測到 Task tool_use 時立即掃描
      if (label === '[MAIN]' && parsed.isTaskToolUse) {
        config.detector.handleEarlyDetection();
      }

      // 備援機制：從主 session 的 toolUseResult 檢查新 subagent
      if (label === '[MAIN]') {
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
        const latest = await findLatestMainSessionInProject(config.projectDir);
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
        const latest = await findLatestMainSessionInProject(config.projectDir);
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
