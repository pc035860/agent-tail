import type { ParsedLine } from '../core/types.ts';
import type { Formatter } from './formatter.interface.ts';

/**
 * 原始 JSON 格式化器
 */
export class RawFormatter implements Formatter {
  format(parsed: ParsedLine): string {
    return JSON.stringify(parsed.raw);
  }
}
