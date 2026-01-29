import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { SessionFile } from '../core/types.ts';

const UUID_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * 取得 session 的有效活動時間
 * 包含 main session 和其所有 subagent 的最新 mtime
 */
async function getSessionActivityTime(
  mainSessionPath: string,
  mainMtime: Date
): Promise<Date> {
  const sessionId = basename(mainSessionPath, '.jsonl');
  const projectDir = dirname(mainSessionPath);
  const subagentsDir = join(projectDir, sessionId, 'subagents');

  let latestMtime = mainMtime;

  try {
    const glob = new Glob('agent-*.jsonl');
    for await (const file of glob.scan({ cwd: subagentsDir, absolute: true })) {
      try {
        const stats = await stat(file);
        if (stats.mtime > latestMtime) {
          latestMtime = stats.mtime;
        }
      } catch {
        // 忽略無法讀取的檔案
      }
    }
  } catch {
    // subagents 目錄不存在時靜默忽略
  }

  return latestMtime;
}

/**
 * 在指定 projectDir 中找最新的 Claude main session（UUID.jsonl）
 */
export async function findLatestMainSessionInProject(
  projectDir: string
): Promise<SessionFile | null> {
  const glob = new Glob('*.jsonl');
  const files: { path: string; mtime: Date; activityTime: Date }[] = [];

  for await (const file of glob.scan({ cwd: projectDir, absolute: true })) {
    const filename = file.split('/').pop() || '';

    // 排除 agent-* 開頭
    if (filename.startsWith('agent-')) continue;
    if (!UUID_SESSION_PATTERN.test(filename)) continue;

    try {
      const stats = await stat(file);
      const activityTime = await getSessionActivityTime(file, stats.mtime);
      files.push({ path: file, mtime: stats.mtime, activityTime });
    } catch {
      // 忽略無法讀取的檔案
    }
  }

  if (files.length === 0) return null;

  files.sort(
    (a, b) =>
      b.activityTime.getTime() - a.activityTime.getTime() ||
      a.path.localeCompare(b.path)
  );
  const latest = files[0];
  if (!latest) return null;

  return {
    path: latest.path,
    mtime: latest.mtime,
    agentType: 'claude',
  };
}
