import type { LineParser } from '../agents/agent.interface.ts';
import type { ParsedLine } from '../core/types.ts';
import { drainParser } from '../utils/parser-drain.ts';

interface BufferedEntry {
  line: string;
  id: string | null;
  parentId: string | null;
}

/**
 * 樹狀 active-path replay filter（v2 §4.3）。
 *
 * 包裝任意 LineParser：初始 dump 期間緩衝 entries（只記 id/parentId/line），
 * `flushHistory()` 時沿 parentId 從最後 entry 走回 root，只輸出 active 路徑
 * （/tree 編輯重送留下的死分支被排除），之後切換 live 模式透傳。
 *
 * 設計約束：
 * - **預設 live 模式**：`--summary` 等不呼叫 `beginHistory()` 的路徑直接透傳，
 *   不會輸出空白。
 * - 掛載點是 FileWatcher 的 `onInitialDumpComplete` 事件（取代「start() await
 *   初始讀取」的隱含契約），`beginHistory()` 在 watcher.start() 前呼叫。
 * - `LineParser` 介面保持純粹（parse + setConversationId）— 樹狀過濾是
 *   「格式屬性」不是「parser 能力」，不為單一格式在共用介面開洞。
 *
 * 記憶體：緩衝只在初始 dump 期間存在（暫態）。兩段式索引（只記
 * `{id, parentId, byteOffset}` + 二次讀取，v2 §4.4）是「大 session 友善」
 * 的優化，非正確性修復，排程上放最後。
 */
export class ActivePathFilter implements LineParser {
  private buffered: BufferedEntry[] = [];
  private live = true;

  constructor(
    private inner: LineParser,
    private walkParent: (entry: unknown) => string | null
  ) {}

  /** 進入歷史緩衝模式（初始 dump 期間收集，不輸出） */
  beginHistory(): void {
    this.live = false;
    this.buffered = [];
  }

  parse(line: string): ParsedLine | null {
    if (!this.live) {
      // 緩衝期間：收集 entry 資訊，不輸出
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        this.buffered.push({
          line,
          id: (entry.id as string) ?? null,
          parentId: this.walkParent(entry),
        });
      } catch {
        // 無法解析的行（非 JSONL）也緩衝，flush 時照原樣輸出
        this.buffered.push({ line, id: null, parentId: null });
      }
      return null;
    }
    return this.inner.parse(line);
  }

  /**
   * 輸出緩衝的歷史並切換為 live 模式。
   * 沿 parentId 從最後 entry 走回 root，只輸出 active 路徑上的行
   * （-n 截斷時 walk 停在 buffer 邊緣）。
   */
  flushHistory(): ParsedLine[] {
    this.live = true;
    const active = this.computeActivePath();
    const out: ParsedLine[] = [];
    for (const e of active) {
      // drainArg=''：inner 可能是 stateless parser（parse('') 立即 null），
      // 也可能是 stateful multi-emit parser（drain 中 state 優先，繼續吐 parts）
      drainParser(this.inner, e.line, (parsed) => out.push(parsed), {
        drainArg: '',
      });
    }
    this.buffered = [];
    return out;
  }

  setConversationId?(id: string): void {
    this.inner.setConversationId?.(id);
  }

  private computeActivePath(): BufferedEntry[] {
    if (this.buffered.length === 0) return [];

    // id → entry 索引（找 parent 用）
    const byId = new Map<string, BufferedEntry>();
    for (const e of this.buffered) {
      if (e.id) byId.set(e.id, e);
    }

    // 從最後 entry 沿 parentId 走回 root
    const active = new Set<BufferedEntry>();
    let current: BufferedEntry | null =
      this.buffered[this.buffered.length - 1] ?? null;
    let guard = 0;
    while (current && guard <= this.buffered.length) {
      active.add(current);
      const parent = current.parentId
        ? (byId.get(current.parentId) ?? null)
        : null;
      current = parent;
      guard++;
    }

    // 保持原始順序輸出 active 路徑
    return this.buffered.filter((e) => active.has(e));
  }
}
