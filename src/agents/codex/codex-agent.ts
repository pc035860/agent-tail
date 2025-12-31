import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type { ParsedLine, ParserOptions, SessionFile } from '../../core/types.ts';
import { truncate, formatMultiline } from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';

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

    const latest = files[0];
    if (!latest) return null;

    return {
      path: latest.path,
      mtime: latest.mtime,
      agentType: 'codex',
    };
  }
}

/**
 * Codex JSONL 解析器
 */
class CodexLineParser implements LineParser {
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

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
        const subType = payload.type as string;

        switch (subType) {
          case 'message': {
            const role = payload.role as string;
            const content = payload.content as Array<{ type: string; text?: string }>;
            const text =
              content?.find((c) => c.type === 'input_text' || c.type === 'output_text')?.text || '';
            const preview = truncate(text, { verbose: this.verbose });
            return `[${role?.toUpperCase()}]${formatMultiline(preview)}`;
          }

          case 'function_call': {
            const name = payload.name as string;
            const argsStr = payload.arguments as string;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(argsStr);
            } catch {
              /* ignore */
            }
            return formatToolUse(name, args, { verbose: this.verbose });
          }

          case 'function_call_output': {
            const outputStr = payload.output as string;
            let output: { output?: string; metadata?: { exit_code?: number } } = {};
            try {
              output = JSON.parse(outputStr);
            } catch {
              /* ignore */
            }
            const exitCode = output.metadata?.exit_code;
            const content = output.output || '';
            const exitInfo = exitCode !== undefined ? ` (exit: ${exitCode})` : '';
            if (!content) return `[OUTPUT${exitInfo}]`;
            const preview = truncate(content, {
              verbose: this.verbose,
              headLength: 100,
              tailLength: 50,
            });
            return `[OUTPUT${exitInfo}]${formatMultiline(preview)}`;
          }

          case 'reasoning': {
            const summary = payload.summary as Array<{ type: string; text?: string }> | undefined;
            const text = summary?.find((s) => s.type === 'summary_text')?.text || '';
            if (!text) return '[REASONING]';
            const preview = truncate(text, {
              verbose: this.verbose,
              headLength: 80,
              tailLength: 40,
            });
            return `[REASONING] ${preview}`;
          }

          default:
            return `[RESPONSE: ${subType}]`;
        }
      }

      case 'event_msg': {
        const payload = data.payload as Record<string, unknown>;
        const eventType = payload.type as string; // 修正：使用 type 而非 event_type

        switch (eventType) {
          case 'token_count': {
            const info = payload.info as {
              total_token_usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
              };
            };
            const usage = info?.total_token_usage;
            if (usage) {
              return `[TOKENS] in:${usage.input_tokens || 0} out:${usage.output_tokens || 0} total:${usage.total_tokens || 0}`;
            }
            return '[TOKENS]';
          }

          case 'agent_reasoning': {
            const text = payload.text as string | undefined;
            if (!text) return '[AGENT_REASONING]';
            const preview = truncate(text, {
              verbose: this.verbose,
              headLength: 60,
              tailLength: 30,
            });
            return `[AGENT_REASONING] ${preview}`;
          }

          default:
            return `[EVENT: ${eventType}]`;
        }
      }

      case 'turn_context': {
        return '[TURN_CONTEXT]';
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

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new CodexSessionFinder();
    this.parser = new CodexLineParser(options);
  }
}
