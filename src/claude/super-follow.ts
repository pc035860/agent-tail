import { stat } from 'node:fs/promises';
import { Glob } from 'bun';
import type { SessionFile } from '../core/types.ts';

const UUID_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * 在指定 projectDir 中找最新的 Claude main session（UUID.jsonl）
 */
export async function findLatestMainSessionInProject(
  projectDir: string
): Promise<SessionFile | null> {
  const glob = new Glob('*.jsonl');
  const files: { path: string; mtime: Date }[] = [];

  for await (const file of glob.scan({ cwd: projectDir, absolute: true })) {
    const filename = file.split('/').pop() || '';

    // 排除 agent-* 開頭
    if (filename.startsWith('agent-')) continue;
    if (!UUID_SESSION_PATTERN.test(filename)) continue;

    try {
      const stats = await stat(file);
      files.push({ path: file, mtime: stats.mtime });
    } catch {
      // 忽略無法讀取的檔案
    }
  }

  if (files.length === 0) return null;

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const latest = files[0];
  if (!latest) return null;

  return {
    path: latest.path,
    mtime: latest.mtime,
    agentType: 'claude',
  };
}
