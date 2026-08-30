import type { LineParser } from './agent.interface.ts';
import type { ParsedLine } from '../core/types.ts';

/**
 * Stateful multi-emit parser 的共用基底（v2 §4.2）。
 *
 * 管理三個狀態機元件，寫一次、測一次：
 * 1. `parts` + `partIndex`：drain 佇列（一個 JSONL entry → 0..N ParsedLine）
 * 2. `lastProcessedLine` dedup guard：避免 caller drain 完後再對同一行
 *    parse(line) 又重新 init state（否則無限重發第一個 part）
 * 3. 「drain 完成後清 state 但保留 lastProcessedLine」
 *
 * 子類別只實作 `toParts(entry)`：一個 JSONL entry → 0..N 個 ParsedLine。
 * 這讓 agent parser 從 ~150 行狀態機縮減為純映射函數；Cursor 的無限迴圈
 * 事故（drain 完成時清掉 guard）結構上不可能再發生。
 *
 * drain 契約：caller 用 drainParser（重複 parse(line) 直到 null）。drain 中
 * 無視 line 內容（含 drainArg=''），繼續吐 parts。
 */
export abstract class MultiEmitParser implements LineParser {
  private parts: ParsedLine[] | null = null;
  private partIndex = 0;
  private lastProcessedLine: string | null = null;

  parse(line: string): ParsedLine | null {
    // drain 中：無視 line 內容（含 drainArg=''）繼續吐 parts
    if (this.parts) {
      const part = this.parts[this.partIndex++];
      if (part === undefined) {
        // 耗盡：清 state 但保留 lastProcessedLine（dedup guard）
        this.parts = null;
        this.partIndex = 0;
        return null;
      }
      return part;
    }

    if (!line.trim()) return null;
    if (line === this.lastProcessedLine) return null; // dedup guard
    this.lastProcessedLine = line;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }

    let newParts: ParsedLine[];
    try {
      newParts = this.toParts(entry);
    } catch {
      // 與舊 parser 的 parse() try/catch 一致：malformed entry → null
      return null;
    }
    if (newParts.length === 0) return null;
    this.parts = newParts;
    this.partIndex = 1;
    return newParts[0] ?? null;
  }

  /** 子類別只寫這個：一個 JSONL entry → 0..N 個 ParsedLine */
  protected abstract toParts(entry: unknown): ParsedLine[];
}
