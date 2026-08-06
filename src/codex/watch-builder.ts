import { join } from 'node:path';
import { Glob } from 'bun';
import {
  isValidCodexAgentId,
  type CodexSubagentDetector,
} from './subagent-detector.ts';
import { MAIN_LABEL } from '../core/detector-interfaces.ts';
import { joinCustomToolOutput, parseCodeModeCalls } from './code-mode.ts';
import type { SessionFile, ParsedLine } from '../core/types.ts';
import type { LineParser } from '../agents/agent.interface.ts';

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
// Code Mode Bridge
// ============================================================

const AGENT_ID_IN_TEXT =
  /["']?agent_id["']?\s*:\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/i;
const NICKNAME_IN_TEXT = /["']?nickname["']?\s*:\s*["']([^"']*)["']/i;

/**
 * 從 payload 取出 tool 呼叫列表，統一 function_call 與 code mode 兩種格式
 *
 * - function_call：payload.name + JSON 字串 arguments
 * - custom_tool_call（gpt-5.6+ code mode）：payload.input 是 JS，實際呼叫是 tools.xxx(...)
 */
function extractToolCalls(
  payload: Record<string, unknown> | undefined
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!payload) return [];

  if (payload.type === 'function_call') {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse((payload.arguments as string) ?? '{}');
    } catch {
      /* ignore */
    }
    return [{ name: (payload.name as string) ?? '', args }];
  }

  if (payload.type === 'custom_tool_call') {
    return parseCodeModeCalls((payload.input as string) ?? '').map((c) => ({
      name: c.name,
      args: c.args,
    }));
  }

  return [];
}

/**
 * 從 tool output 取出 spawn_agent 的結果
 *
 * function_call_output 是 JSON 字串，可直接 parse；code mode 的
 * custom_tool_call_output 只是 script 的 stdout，agent_id 混在文字裡，
 * 所以退而用 regex 掃描（UUID 格式仍會經 isValidCodexAgentId 驗證）。
 */
function extractSpawnResult(
  payload: Record<string, unknown> | undefined
): { agent_id: string; nickname?: string } | null {
  if (!payload) return null;

  if (payload.type === 'function_call_output') {
    try {
      const output = JSON.parse((payload.output as string) ?? '{}');
      if (output.agent_id) {
        return { agent_id: output.agent_id, nickname: output.nickname };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  if (payload.type === 'custom_tool_call_output') {
    const text = joinCustomToolOutput(payload.output);
    const agentId = text.match(AGENT_ID_IN_TEXT)?.[1];
    if (!agentId) return null;
    const nickname = text.match(NICKNAME_IN_TEXT)?.[1];
    return { agent_id: agentId, ...(nickname && { nickname }) };
  }

  return null;
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
      if (data.type === 'response_item') {
        const result = extractSpawnResult(data.payload);
        if (result && isValidCodexAgentId(result.agent_id)) {
          seen.add(result.agent_id);
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
 * 使用單一 Glob 掃描 + 平行 stat，效率為 O(M+N)
 */
export async function buildCodexSubagentFiles(
  dateDir: string,
  agentIds: string[]
): Promise<SessionFile[]> {
  if (agentIds.length === 0) return [];

  const idSet = new Set(agentIds);
  const glob = new Glob('rollout-*.jsonl');
  const statPromises: Promise<SessionFile | null>[] = [];

  for await (const file of glob.scan(dateDir)) {
    const uuid = extractUUIDFromPath(file);
    if (uuid && idSet.has(uuid)) {
      const fullPath = join(dateDir, file);
      statPromises.push(
        Bun.file(fullPath)
          .stat()
          .then(
            (stat): SessionFile => ({
              path: fullPath,
              mtime: stat.mtime ?? new Date(0),
              agentType: 'codex',
            })
          )
          .catch(() => null)
      );
    }
  }

  const results = await Promise.all(statPromises);
  return results.filter((r): r is SessionFile => r !== null);
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

    if (
      line.includes('spawn_agent') ||
      line.includes('resume_agent') ||
      line.includes('send_input')
    ) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'response_item') {
          for (const call of extractToolCalls(data.payload)) {
            if (call.name === 'spawn_agent') {
              detector.handleSpawnAgent(
                data.payload.call_id,
                (call.args.agent_type as string) ?? '',
                (call.args.message as string) ?? ''
              );
            } else if (
              call.name === 'resume_agent' ||
              call.name === 'send_input'
            ) {
              const agentId = call.args.agent_id as string | undefined;
              if (agentId) detector.handleSubagentResume(agentId);
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (
      line.includes('"function_call_output"') ||
      line.includes('"custom_tool_call_output"')
    ) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'response_item') {
          const result = extractSpawnResult(data.payload);
          if (result) {
            detector.handleSpawnAgentOutput(data.payload.call_id, result);
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

// ============================================================
// Last Assistant Message Reader
// ============================================================

/**
 * 讀取 Codex subagent JSONL 最後一條 assistant 訊息
 * 用於 pane 關閉前輸出最後結果
 * @param parser - 由呼叫方注入，避免循環依賴（watch-builder.ts → codex-agent.ts）
 */
export async function readLastCodexAssistantMessage(
  filePath: string,
  parser: LineParser
): Promise<ParsedLine[]> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]!);
        if (
          data.type === 'response_item' &&
          data.payload?.type === 'message' &&
          data.payload?.role === 'assistant'
        ) {
          const content = data.payload.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          const msgText = content?.find(
            (c) => c.type === 'output_text' || c.type === 'input_text'
          )?.text;
          if (!msgText?.trim()) continue;

          const parsed = parser.parse(lines[i]!);
          if (parsed) return [parsed];
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}
