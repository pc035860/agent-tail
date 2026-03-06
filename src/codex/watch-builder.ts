import { join } from 'node:path';
import { Glob } from 'bun';
import {
  isValidCodexAgentId,
  type CodexSubagentDetector,
} from './subagent-detector.ts';
import { MAIN_LABEL } from '../core/detector-interfaces.ts';
import type { SessionFile } from '../core/types.ts';

// ============================================================
// Path Utilities
// ============================================================

const CODEX_UUID_IN_PATH =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** 從 rollout-*.jsonl 路徑中提取 UUID */
export function extractUUIDFromPath(filePath: string): string {
  return filePath.match(CODEX_UUID_IN_PATH)?.[1] ?? '';
}

// ============================================================
// Session Scanning
// ============================================================

/**
 * 掃描主 session JSONL，提取所有 subagent UUID
 */
export async function extractCodexSubagentIds(
  sessionPath: string
): Promise<string[]> {
  let text: string;
  try {
    const file = Bun.file(sessionPath);
    if (!(await file.exists())) return [];
    text = await file.text();
  } catch {
    return [];
  }

  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (
        data.type === 'response_item' &&
        data.payload?.type === 'function_call_output'
      ) {
        const output = JSON.parse(data.payload.output ?? '{}');
        const agentId = output.agent_id;
        if (agentId && isValidCodexAgentId(agentId)) {
          seen.add(agentId);
        }
      }
    } catch {
      // ignore malformed lines
    }
  }

  return Array.from(seen);
}

/**
 * 根據 agentIds 在 dateDir 中找到對應的 JSONL 檔案
 */
export async function buildCodexSubagentFiles(
  dateDir: string,
  agentIds: string[]
): Promise<SessionFile[]> {
  if (agentIds.length === 0) return [];

  const results: SessionFile[] = [];
  for (const agentId of agentIds) {
    const glob = new Glob(`rollout-*-${agentId}.jsonl`);
    for await (const file of glob.scan(dateDir)) {
      const fullPath = join(dateDir, file);
      try {
        const stat = await Bun.file(fullPath).stat();
        results.push({
          path: fullPath,
          mtime: stat.mtime ?? new Date(0),
          agentType: 'codex',
        });
      } catch {
        // skip inaccessible files
      }
      break; // take first match per agentId
    }
  }

  return results;
}

// ============================================================
// Line Handler
// ============================================================

/**
 * 建立 Codex 主 session 的行處理器，解析 spawn/output/done 事件
 */
export function createCodexOnLineHandler(
  detector: CodexSubagentDetector
): (line: string, label: string) => void {
  return (line: string, label: string) => {
    if (label !== MAIN_LABEL) return;

    if (line.includes('"spawn_agent"')) {
      try {
        const data = JSON.parse(line);
        if (
          data.type === 'response_item' &&
          data.payload?.type === 'function_call' &&
          data.payload?.name === 'spawn_agent'
        ) {
          const args = JSON.parse(data.payload.arguments ?? '{}');
          detector.handleSpawnAgent(
            data.payload.call_id,
            args.agent_type ?? '',
            args.message ?? ''
          );
        }
      } catch {
        /* ignore */
      }
    }

    if (line.includes('"function_call_output"')) {
      try {
        const data = JSON.parse(line);
        if (
          data.type === 'response_item' &&
          data.payload?.type === 'function_call_output'
        ) {
          const output = JSON.parse(data.payload.output ?? '{}');
          if (output.agent_id) {
            detector.handleSpawnAgentOutput(data.payload.call_id, {
              agent_id: output.agent_id,
              nickname: output.nickname,
            });
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (line.includes('<subagent_notification>')) {
      try {
        const data = JSON.parse(line);
        const text = data.payload?.content?.[0]?.text ?? '';
        const match = text.match(
          /<subagent_notification>(.*?)<\/subagent_notification>/s
        );
        if (match) {
          const notif = JSON.parse(match[1]);
          if (notif.agent_id && notif.status?.completed !== undefined) {
            detector.handleSubagentDone(notif.agent_id);
          }
        }
      } catch {
        /* ignore */
      }
    }
  };
}
