import chalk from 'chalk';
import type { LineParser } from '../agents/agent.interface.ts';
import type { ParsedLine } from '../core/types.ts';
import type { JournalEvent } from './types.ts';

// SPEC §8.1 — JournalLineParser handles workflow `journal.jsonl` events.
// Events have no timestamp field; history dump uses file mtime, live tail
// uses current time. Switch is explicit via markLiveMode().

const RESULT_TRUNCATE_MAX = 100;

export interface JournalLineParserOptions {
  fileMtime?: Date;
}

/** @internal — exported for unit testing only. */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[object]';
  }
}

function truncateLine(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max) + '…';
}

export class JournalLineParser implements LineParser {
  private historyTimestamp: string;

  constructor(opts: JournalLineParserOptions = {}) {
    this.historyTimestamp = (opts.fileMtime ?? new Date(0)).toISOString();
    if (!opts.fileMtime) {
      // No fileMtime supplied → assume live mode from the start.
      this.historyTimestamp = '';
    }
  }

  markLiveMode(): void {
    this.historyTimestamp = '';
  }

  parse(rawLine: string): ParsedLine | null {
    let event: JournalEvent;
    try {
      event = JSON.parse(rawLine) as JournalEvent;
    } catch {
      return null;
    }

    if (event === null || typeof event !== 'object') return null;
    if (event.type !== 'started' && event.type !== 'result') return null;
    if (typeof event.key !== 'string') return null;
    if (typeof event.agentId !== 'string') return null;

    const shortAgentId = event.agentId.slice(0, 7);
    const timestamp = this.historyTimestamp || new Date().toISOString();

    let formatted: string;
    if (event.type === 'started') {
      formatted = chalk.cyan(`▶ agent ${shortAgentId} started`);
    } else {
      const body = truncateLine(
        safeStringify(event.result),
        RESULT_TRUNCATE_MAX
      );
      formatted = chalk.green(`✓ agent ${shortAgentId} result`) + `: ${body}`;
    }

    return {
      type: 'system',
      timestamp,
      raw: event,
      formatted,
      workflowEvent: event.type,
      workflowAgentId: event.agentId,
    };
  }
}
