// Phase 1 stub — intentionally returns null to keep tests RED.
import type { LineParser } from '../agents/agent.interface.ts';
import type { ParsedLine } from '../core/types.ts';

export interface JournalLineParserOptions {
  fileMtime?: Date;
}

/** @internal — exported for testing */
export function safeStringify(_value: unknown): string {
  return '';
}

export class JournalLineParser implements LineParser {
  constructor(_opts: JournalLineParserOptions = {}) {
    // stub
  }

  parse(_rawLine: string): ParsedLine | null {
    return null;
  }

  markLiveMode(): void {
    // stub
  }
}
