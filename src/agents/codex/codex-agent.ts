import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type { ParsedLine, SessionFile } from '../../core/types.ts';

/**
 * Codex Session Finder
 * 目錄結構: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
class CodexSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor() {
    this.baseDir = join(homedir(), '.codex', 'sessions');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const glob = new Glob('**/*.jsonl');
    const files: { path: string; mtime: Date }[] = [];

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      // 只匹配 rollout-*.jsonl
      const filename = file.split('/').pop() || '';
      if (!filename.startsWith('rollout-')) continue;

      // 如果有 project filter，做模糊比對（對 Codex 來說是日期過濾）
      if (options.project) {
        const pattern = options.project.toLowerCase();
        if (!file.toLowerCase().includes(pattern)) continue;
      }

      try {
        const stats = await stat(file);
        files.push({ path: file, mtime: stats.mtime });
      } catch {
        // 忽略無法讀取的檔案
      }
    }

    if (files.length === 0) return null;

    // 按修改時間排序，取最新的
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return {
      path: files[0].path,
      mtime: files[0].mtime,
      agentType: 'codex',
    };
  }
}

/**
 * Codex JSONL 解析器
 */
class CodexLineParser implements LineParser {
  parse(line: string): ParsedLine | null {
    if (!line.trim()) return null;

    try {
      const data = JSON.parse(line);
      const type = data.type || 'unknown';
      const timestamp = data.timestamp || '';

      return {
        type,
        timestamp,
        raw: data,
        formatted: this.format(data),
      };
    } catch {
      return null;
    }
  }

  private format(data: Record<string, unknown>): string {
    const type = data.type as string;

    switch (type) {
      case 'session_meta': {
        const payload = data.payload as Record<string, unknown>;
        return `Session started: ${payload.cwd || 'unknown'} (${payload.cli_version || ''})`;
      }

      case 'response_item': {
        const payload = data.payload as Record<string, unknown>;
        const role = payload.role as string;
        const content = payload.content as Array<{ type: string; text?: string }>;
        const text = content?.find((c) => c.type === 'input_text' || c.type === 'output_text')?.text || '';
        const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
        return `[${role?.toUpperCase()}] ${preview}`;
      }

      case 'event_msg': {
        const payload = data.payload as Record<string, unknown>;
        const eventType = payload.event_type as string;
        return `[EVENT] ${eventType}`;
      }

      case 'function_call': {
        const payload = data.payload as Record<string, unknown>;
        const name = payload.name as string;
        return `[FUNCTION] ${name}`;
      }

      default:
        return `[${type}]`;
    }
  }
}

/**
 * Codex Agent
 */
export class CodexAgent implements Agent {
  readonly type = 'codex' as const;
  readonly finder: SessionFinder;
  readonly parser: LineParser;

  constructor() {
    this.finder = new CodexSessionFinder();
    this.parser = new CodexLineParser();
  }
}
