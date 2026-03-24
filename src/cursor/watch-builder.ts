import { Glob } from 'bun';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { makeAgentLabel } from '../core/detector-interfaces.ts';
// SessionFile type is used in the return type documentation but not directly in signatures

// ============================================================
// Constants
// ============================================================

/** Cursor subagent ID 驗證：UUID 格式 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 從檔名提取 UUID 的 regex */
const UUID_FILENAME_REGEX =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// ============================================================
// Utility Functions
// ============================================================

/**
 * 從 session 檔案路徑推導 subagents 目錄
 * Cursor 路徑: {parentDir}/{UUID}/{UUID}.jsonl
 * subagents 位於: {parentDir}/{UUID}/subagents/
 */
export function getCursorSubagentsDir(sessionPath: string): string {
  return join(dirname(sessionPath), 'subagents');
}

/**
 * 建立 Cursor subagent 檔案路徑（無 agent- 前綴，與 Claude 不同）
 */
export function buildCursorSubagentPath(
  subagentsDir: string,
  agentId: string
): string {
  return join(subagentsDir, `${agentId}.jsonl`);
}

/**
 * 驗證 Cursor subagent ID 格式（UUID）
 */
export function isValidCursorSubagentId(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * 從 Cursor subagent 檔案路徑提取 UUID
 */
export function extractCursorUUIDFromPath(filePath: string): string {
  return basename(filePath, '.jsonl');
}

/**
 * 建立 Cursor subagent 標籤（使用 UUID 前 8 字元）
 */
export function makeCursorAgentLabel(agentId: string): string {
  return makeAgentLabel(agentId.slice(0, 8));
}

// ============================================================
// Scan & Build Functions
// ============================================================

/**
 * 掃描 subagents 目錄，找出尚未被監控的新 subagent 檔案
 * @param subagentsDir subagents 目錄路徑
 * @param knownAgentIds 已知的 agentId 集合
 * @returns 新發現的 agentId 陣列
 */
export async function scanCursorSubagents(
  subagentsDir: string,
  knownAgentIds: Set<string>
): Promise<string[]> {
  const newAgentIds: string[] = [];

  try {
    const glob = new Glob('*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir })) {
      const match = file.match(UUID_FILENAME_REGEX);
      if (match && match[1]) {
        const agentId = match[1];
        if (!knownAgentIds.has(agentId)) {
          newAgentIds.push(agentId);
        }
      }
    }
  } catch {
    // subagents 目錄不存在或無法存取時靜默忽略
  }

  return newAgentIds;
}

/**
 * 建立 subagent 檔案列表（含 stat 資訊）
 * @param subagentsDir subagents 目錄路徑
 * @param agentIds 已知的 agentId 陣列
 * @returns SessionFile 陣列，按 birthtime 排序（舊到新）
 */
export async function buildCursorSubagentFiles(
  subagentsDir: string,
  agentIds: string[]
): Promise<Array<{ agentId: string; path: string; mtime: Date }>> {
  const results: Array<{ agentId: string; path: string; mtime: Date }> = [];

  const statPromises = agentIds.map(async (agentId) => {
    const filePath = buildCursorSubagentPath(subagentsDir, agentId);
    try {
      const stats = await stat(filePath);
      return { agentId, path: filePath, mtime: stats.mtime };
    } catch {
      return null;
    }
  });

  const settled = await Promise.all(statPromises);
  for (const result of settled) {
    if (result) results.push(result);
  }

  // 按 mtime 排序（舊到新）
  results.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  return results;
}
