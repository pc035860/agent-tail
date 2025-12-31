import type { ParsedLine } from '../core/types.ts';

/**
 * 格式化器介面
 */
export interface Formatter {
  format(parsed: ParsedLine): string;
}
