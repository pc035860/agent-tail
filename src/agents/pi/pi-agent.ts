import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import {
  contentToString,
  formatMultiline,
  truncateByLines,
} from '../../utils/text.ts';
import { formatToolUse } from '../../utils/format-tool.ts';
import { readLastTimestampFromJSONL } from '../../utils/session-time.ts';

/**
 * Pi (pi coding agent) Session Finder
 *
 * 目錄結構: ~/.pi/agent/sessions/--<cwd 編碼>--/<ISO timestamp>_<uuid>.jsonl
 * - cwd 編碼：`/` 換成 `-`，前後再包一層 `-`（如 --Users-x-code-foo--）
 * - JSONL v3：第一行 session header（含權威 cwd），每行 entry 都有 ISO timestamp
 * - 檔名：<timestamp>_<uuid>.jsonl，uuid 為 session ID
 */
export class PiSessionFinder implements SessionFinder {
  private baseDir: string;

  constructor(paths?: { baseDir?: string }) {
    this.baseDir =
      paths?.baseDir ?? join(homedir(), '.pi', 'agent', 'sessions');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * 收集所有 session 檔案（findLatest / listSessions / findBySessionId 共用）
   */
  private async _collectSessions(
    options: {
      project?: string;
    } = {}
  ): Promise<SessionListItem[]> {
    const glob = new Glob('*/*.jsonl');
    const files: SessionListItem[] = [];

    try {
      for await (const file of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        if (options.project) {
          const pattern = options.project.toLowerCase();
          const dirName = basename(dirname(file));
          const matchDir = dirName.toLowerCase().includes(pattern);
          const matchPath = file.toLowerCase().includes(pattern);
          if (!matchDir && !matchPath) continue;
        }

        try {
          const stats = await stat(file);
          const filename = file.split('/').pop() || '';
          const uuid = extractUuidFromFilename(filename);
          const project = decodePiProjectDirName(basename(dirname(file)));

          files.push({
            path: file,
            mtime: stats.mtime,
            agentType: 'pi',
            shortId: uuid.slice(0, 8),
            project,
          });
        } catch {
          // 忽略無法讀取的檔案
        }
      }
    } catch {
      // baseDir 不存在
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    if (files.length === 0) return null;
    const first = files[0]!;
    return { path: first.path, mtime: first.mtime, agentType: 'pi' };
  }

  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    const files = await this._collectSessions(options);
    const limit = options.limit ?? 20;
    const sliced = files.slice(0, limit);

    // 平行 enrich：最後活動時間（entry.timestamp）+ session 顯示名稱（/name）
    await Promise.all(
      sliced.map(async (item) => {
        const [lastActivity, name] = await Promise.all([
          readLastTimestampFromJSONL(item.path),
          readPiSessionNameFromTail(item.path),
        ]);
        item.lastActivityTime = lastActivity ?? undefined;
        if (name) {
          item.customTitle = name;
        }
      })
    );

    sliced.sort((a, b) => {
      const ta = (a.lastActivityTime ?? a.mtime).getTime();
      const tb = (b.lastActivityTime ?? b.mtime).getTime();
      return tb - ta;
    });

    return sliced;
  }

  /**
   * 依 session ID 查找（partial match：UUID 精確 > 前綴 > 包含 > 全路徑包含，
   * 同級多重匹配取 mtime 最新）
   */
  async findBySessionId(
    sessionId: string,
    options: { project?: string } = {}
  ): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    const search = sessionId.toLowerCase();

    let best: { item: SessionListItem; priority: number } | null = null;
    for (const item of files) {
      const filename = item.path.split('/').pop() || '';
      const uuid = extractUuidFromFilename(filename).toLowerCase();
      let priority = 0;
      if (uuid === search) priority = 4;
      else if (uuid.startsWith(search)) priority = 3;
      else if (uuid.includes(search)) priority = 2;
      else if (item.path.toLowerCase().includes(search)) priority = 1;
      if (priority === 0) continue;

      if (
        !best ||
        priority > best.priority ||
        (priority === best.priority &&
          item.mtime.getTime() > best.item.mtime.getTime())
      ) {
        best = { item, priority };
      }
    }

    if (!best) return null;
    return {
      path: best.item.path,
      mtime: best.item.mtime,
      agentType: 'pi',
    };
  }

  /**
   * 從 session 檔案取得專案資訊（用於 auto-switch）。
   * Pi 的 session header（第一行）就帶權威 cwd。
   */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const cwd = await readPiCwdFromHead(sessionPath);
    if (!cwd) return null;
    return { projectDir: cwd, displayName: cwd };
  }

  /**
   * 在指定專案（cwd）範圍內找最新的 session（用於 auto-switch）。
   * 編碼規則：`/` → `-`，前後包 `--`。
   */
  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const encoded = encodePiProjectDir(projectDir);
    const projectDirPath = join(this.baseDir, encoded);
    const glob = new Glob('*.jsonl');
    const files: { path: string; mtime: Date }[] = [];

    try {
      for await (const file of glob.scan({
        cwd: projectDirPath,
        absolute: true,
      })) {
        try {
          const stats = await stat(file);
          files.push({ path: file, mtime: stats.mtime });
        } catch {
          // 忽略無法讀取的檔案
        }
      }
    } catch {
      // 專案目錄不存在
      return null;
    }

    if (files.length === 0) return null;

    // header cwd 驗證：encoded 目錄名不可逆（`-` 可能是分隔符或字面連字號），
    // 不同 cwd 可能碰撞到同一個目錄（如 /work/foo-bar 與 /work/foo/bar），
    // 必須用 header 的權威 cwd 過濾，否則 auto-switch 會切到別的專案。
    // 先按 mtime 降序再逐個驗證，第一個吻合即返回（super-follow 每 500ms
    // 執行一次，避免每輪讀取目錄內全部 session 的 header）。
    // 沒有任何候選吻合時回傳 null（寧可不切換，也不要切到別的專案）。
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    for (const f of files) {
      const cwd = await readPiCwdFromHead(f.path);
      if (cwd === projectDir) {
        return { path: f.path, mtime: f.mtime, agentType: 'pi' };
      }
    }
    return null;
  }
}

/**
 * 從 pi session 檔名抽出 session UUID。
 * 檔名格式：<timestamp>_<uuid>.jsonl
 */
export function extractUuidFromFilename(filename: string): string {
  const idx = filename.indexOf('_');
  const rest = idx >= 0 ? filename.slice(idx + 1) : filename;
  return rest.replace(/\.jsonl$/i, '');
}

/**
 * 將 cwd 編碼成 pi 的 project 目錄名：`/` → `-`，前後包 `--`。
 * 例如 /Users/x/code/foo → --Users-x-code-foo--
 */
export function encodePiProjectDir(cwd: string): string {
  const normalized = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  return `--${normalized.split('/').join('-')}--`;
}

/**
 * 將 pi 的 project 目錄名轉為顯示用字串（去前後 `-`）。
 * 編碼不可逆（`-` 可能是路徑分隔或字面連字號），僅供顯示與模糊過濾。
 */
export function decodePiProjectDirName(dirName: string): string {
  return dirName.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * 讀取 pi session header（第一行）的 cwd。
 * Header 永遠是第一行：{"type":"session",...,"cwd":"/path/to/project"}
 */
export async function readPiCwdFromHead(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;
    const head = await file.slice(0, Math.min(size, 4096)).text();
    const firstLine = head.split('\n', 1)[0];
    if (!firstLine) return null;
    const data = JSON.parse(firstLine);
    if (data.type === 'session' && typeof data.cwd === 'string') {
      return data.cwd;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Tail-read 最後一個 session_info entry 的 name（pi 的 /name 指令）。
 * 語義對應 Claude 的 customTitle。
 */
export async function readPiSessionNameFromTail(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return null;
    const start = Math.max(0, size - 8192);
    const tail = await file.slice(start, size).text();
    const lines = tail.split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]!);
        if (data.type === 'session_info' && typeof data.name === 'string') {
          return data.name;
        }
      } catch {
        // Skip malformed JSON
      }
    }
  } catch {
    // File read error
  }
  return null;
}

/**
 * Pi JSONL 行解析器
 *
 * 每行一個 entry（type: session / message / model_change / session_info / ...）。
 * assistant message 的 content 可含多個 blocks（text + thinking + toolCall），
 * 仿 Cursor 用 stateful multi-emit：每次 parse() 回傳一個部分，caller 用
 * drainParser() 抽乾。
 *
 * 樹狀過濾（A'）：pi session 是樹狀結構（id/parentId），/tree 改寫重送會留下
 * 死分支。parse() 預設直接輸出（live mode）；startSingleWatch 在初始 dump 前
 * 呼叫 beginHistory() 進入緩衝模式，dump 完成後呼叫 flushHistory() —— 沿
 * parentId 從最後一個 entry 走回 root，只輸出 active 路徑，再切換為 live 模式。
 */
interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role: string;
  content?: string | PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  display?: boolean;
}

interface PiMessageEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  name?: string;
  /** 頂層 custom_message entry（extension 注入，v3 持久化格式） */
  customType?: string;
  content?: string | PiContentBlock[];
  display?: boolean;
  message?: PiMessage;
}

export class PiLineParser implements LineParser {
  private verbose: boolean;
  /** 歷史緩衝模式：初始 dump 先收集，flushHistory() 沿 parentId 過濾後輸出 */
  private buffering = false;
  private historyBuffer: {
    id: string;
    parentId: string | null;
    entry: PiMessageEntry;
  }[] = [];
  /** live 模式的 multi-emit 狀態（Cursor 模式） */
  private currentMessageState: {
    blocks: PiContentBlock[];
    blockIndex: number;
    timestamp: string;
  } | null = null;
  private lastProcessedLine: string | null = null;

  constructor(options: ParserOptions = { verbose: false }) {
    this.verbose = options.verbose;
  }

  /**
   * 進入歷史緩衝模式（初始 dump 前呼叫）。
   * 緩衝期間 parse() 只收集不輸出，直到 flushHistory()。
   */
  beginHistory(): void {
    this.buffering = true;
    this.historyBuffer = [];
    this.currentMessageState = null;
    this.lastProcessedLine = null;
  }

  /**
   * 輸出緩衝的歷史：沿 parentId 從最後一個 entry 走回 root，
   * 只輸出 active 路徑（root → leaf 順序），然後切換為 live 模式。
   * 重複呼叫為 no-op。
   */
  flushHistory(): ParsedLine[] {
    if (!this.buffering) return [];
    this.buffering = false;

    const buffer = this.historyBuffer;
    this.historyBuffer = [];
    if (buffer.length === 0) return [];

    // id → index（buffer 順序 = 檔案順序）
    const byId = new Map<string, number>();
    buffer.forEach((e, i) => {
      if (e.id) byId.set(e.id, i);
    });

    // 從最後一個 entry（當前 leaf）沿 parentId 走回 root
    const pathIndices: number[] = [];
    const visited = new Set<string>();
    let cursor: string | null = buffer[buffer.length - 1]!.id || null;
    while (cursor && !visited.has(cursor) && byId.has(cursor)) {
      visited.add(cursor);
      const idx = byId.get(cursor)!;
      pathIndices.push(idx);
      cursor = buffer[idx]!.parentId ?? null;
    }
    pathIndices.reverse(); // root → leaf

    const output: ParsedLine[] = [];
    for (const idx of pathIndices) {
      this.collectEntryParts(buffer[idx]!.entry, output);
    }
    return output;
  }

  parse(line: string): ParsedLine | null {
    // drain 中：繼續輸出 currentMessageState 的剩餘部分。
    // 注意：不檢查 line 內容（含 drainArg='' 的 summary 路徑）— state 存在時
    // 必須繼續 emit，否則 multi-block assistant 訊息只會出第一個 block。
    if (this.currentMessageState) {
      if (line === this.lastProcessedLine || !line.trim()) {
        return this.emitNextPart();
      }
      // 新行抵達但狀態未清（不應發生）：丟棄殘餘狀態，保留 dedup guard
      this.currentMessageState = null;
    }

    if (!line.trim()) return null;

    // 緩衝模式：只收集不輸出
    if (this.buffering) {
      try {
        const entry = JSON.parse(line) as PiMessageEntry;
        this.historyBuffer.push({
          id: typeof entry.id === 'string' ? entry.id : '',
          parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
          entry,
        });
      } catch {
        // ignore malformed line
      }
      return null;
    }

    // dedup guard：同一行不重複處理（drain 完成後 caller 可能用同 line 再呼叫，
    // 沒有這個 guard 會 re-emit，與 drain loop 一起變無限迴圈）
    if (line === this.lastProcessedLine) {
      return null;
    }
    this.lastProcessedLine = line;

    let entry: PiMessageEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }

    return this.parseEntry(entry, line);
  }

  /** 解析單一 entry（live 路徑） */
  private parseEntry(entry: PiMessageEntry, line: string): ParsedLine | null {
    // session_info：pi 的 /name → 對應 Claude custom-title 語義
    if (entry.type === 'session_info') {
      const name = entry.name;
      if (typeof name === 'string' && name) {
        return {
          type: 'custom-title',
          timestamp: entry.timestamp ?? '',
          raw: entry,
          formatted: `Session renamed: "${name}"`,
          isCustomTitle: true,
          customTitleValue: name,
        };
      }
      return null;
    }

    // 頂層 custom_message：extension 注入訊息的持久化格式（v3）
    if (entry.type === 'custom_message') {
      return this.makeCustomMessageEntryParsed(entry);
    }

    if (entry.type !== 'message' || !entry.message) {
      // session header / model_change / thinking_level_change / compaction /
      // branch_summary / label / custom → 不輸出
      return null;
    }

    const msg = entry.message;
    switch (msg.role) {
      case 'user': {
        const text = contentToString(msg.content).trim();
        if (!text) return null;
        return this.makeTextParsed('user', msg.content, entry);
      }
      case 'assistant': {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        if (!hasEmittableBlock(blocks)) return null;
        // 初始化 multi-emit 狀態（Cursor 模式）
        this.currentMessageState = {
          blocks,
          blockIndex: 0,
          timestamp: entry.timestamp ?? '',
        };
        this.lastProcessedLine = line;
        return this.emitNextPart();
      }
      case 'toolResult':
        return this.makeToolResultParsed(entry);
      case 'bashExecution':
        return this.makeBashExecutionParsed(entry);
      case 'custom':
        return this.makeCustomParsed(entry);
      default:
        return null;
    }
  }

  /** 收集單一 entry 的所有輸出部分（flushHistory 用，直接展開不經 drain） */
  private collectEntryParts(entry: PiMessageEntry, out: ParsedLine[]): void {
    if (entry.type === 'session_info') {
      const name = entry.name;
      if (typeof name === 'string' && name) {
        out.push({
          type: 'custom-title',
          timestamp: entry.timestamp ?? '',
          raw: entry,
          formatted: `Session renamed: "${name}"`,
          isCustomTitle: true,
          customTitleValue: name,
        });
      }
      return;
    }
    // 頂層 custom_message：extension 注入訊息的持久化格式（v3）
    if (entry.type === 'custom_message') {
      const parsed = this.makeCustomMessageEntryParsed(entry);
      if (parsed) out.push(parsed);
      return;
    }
    if (entry.type !== 'message' || !entry.message) return;

    const msg = entry.message;
    switch (msg.role) {
      case 'user': {
        if (contentToString(msg.content).trim()) {
          out.push(this.makeTextParsed('user', msg.content, entry));
        }
        return;
      }
      case 'assistant': {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          const parsed = this.blockToParsed(block, entry.timestamp ?? '');
          if (parsed) out.push(parsed);
        }
        return;
      }
      case 'toolResult': {
        const parsed = this.makeToolResultParsed(entry);
        if (parsed) out.push(parsed);
        return;
      }
      case 'bashExecution': {
        const parsed = this.makeBashExecutionParsed(entry);
        if (parsed) out.push(parsed);
        return;
      }
      case 'custom': {
        const parsed = this.makeCustomParsed(entry);
        if (parsed) out.push(parsed);
        return;
      }
      default:
        return;
    }
  }

  /** user 純文字訊息 */
  private makeTextParsed(
    type: string,
    content: string | PiContentBlock[] | undefined,
    entry: PiMessageEntry
  ): ParsedLine {
    const text = contentToString(content);
    return {
      type,
      timestamp: entry.timestamp ?? '',
      raw: entry,
      formatted: formatMultiline(
        truncateByLines(text, { verbose: this.verbose })
      ),
    };
  }

  /** toolResult → DONE */
  private makeToolResultParsed(entry: PiMessageEntry): ParsedLine | null {
    const msg = entry.message!;
    const text = contentToString(msg.content).trim();
    if (!text && !msg.isError) return null;
    const prefix = msg.isError ? '[error] ' : '';
    return {
      type: 'tool_result',
      timestamp: entry.timestamp ?? '',
      raw: entry,
      formatted: formatMultiline(
        truncateByLines(`${prefix}${text}`, { verbose: this.verbose })
      ),
    };
  }

  /** bashExecution（!! 前綴指令等） */
  private makeBashExecutionParsed(entry: PiMessageEntry): ParsedLine | null {
    const msg = entry.message!;
    const cmd = msg.command || '';
    const output = msg.output || '';
    const exit =
      msg.exitCode !== undefined && msg.exitCode !== null
        ? ` (exit ${msg.exitCode})`
        : '';
    if (!cmd && !output) return null;
    const text = `$ ${cmd}${exit}${output ? '\n' + output : ''}`;
    return {
      type: 'output',
      timestamp: entry.timestamp ?? '',
      raw: entry,
      formatted: formatMultiline(
        truncateByLines(text, { verbose: this.verbose })
      ),
    };
  }

  /** custom message（extension 注入；display=false 不顯示） */
  private makeCustomParsed(entry: PiMessageEntry): ParsedLine | null {
    const msg = entry.message!;
    if (msg.display === false) return null;
    const text = contentToString(msg.content).trim();
    if (!text) return null;
    return {
      type: 'custom',
      timestamp: entry.timestamp ?? '',
      raw: entry,
      formatted: formatMultiline(
        truncateByLines(text, { verbose: this.verbose })
      ),
    };
  }

  /** 頂層 custom_message entry（extension 注入訊息的持久化格式，v3） */
  private makeCustomMessageEntryParsed(
    entry: PiMessageEntry
  ): ParsedLine | null {
    if (entry.display === false) return null;
    const text = contentToString(entry.content).trim();
    if (!text) return null;
    return {
      type: 'custom',
      timestamp: entry.timestamp ?? '',
      raw: entry,
      formatted: formatMultiline(
        truncateByLines(text, { verbose: this.verbose })
      ),
    };
  }

  /** 單一 content block → ParsedLine（flush 用，一次展開全部） */
  private blockToParsed(
    block: PiContentBlock,
    timestamp: string
  ): ParsedLine | null {
    if (block.type === 'text' && block.text?.trim()) {
      return {
        type: 'assistant',
        timestamp,
        raw: block,
        formatted: formatMultiline(
          truncateByLines(block.text, { verbose: this.verbose })
        ),
      };
    }
    if (block.type === 'thinking' && block.thinking) {
      if (!this.verbose) return null;
      return {
        type: 'reasoning',
        timestamp,
        raw: block,
        formatted: formatMultiline(
          truncateByLines(block.thinking, { verbose: true })
        ),
      };
    }
    if (block.type === 'toolCall' && block.name) {
      return {
        type: 'function_call',
        timestamp,
        raw: block,
        formatted: formatToolUse(block.name, block.arguments, {
          verbose: this.verbose,
        }),
        toolName: block.name,
      };
    }
    return null;
  }

  /** 輸出 currentMessageState 的下一個部分；狀態耗盡時回傳 null 並清狀態 */
  private emitNextPart(): ParsedLine | null {
    const state = this.currentMessageState;
    if (!state) return null;

    while (state.blockIndex < state.blocks.length) {
      const block = state.blocks[state.blockIndex];
      state.blockIndex++;
      if (!block) continue;
      const parsed = this.blockToParsed(block, state.timestamp);
      if (parsed) return parsed;
    }

    // 全部輸出完畢：清狀態，保留 lastProcessedLine（Cursor 事故教訓：
    // 清掉會讓 dedup guard 失效，drain loop 卡死在 guard 上限）
    this.currentMessageState = null;
    return null;
  }
}

/** 判斷 assistant blocks 是否有可輸出內容 */
function hasEmittableBlock(blocks: PiContentBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.type === 'text' && !!b.text?.trim()) ||
      (b.type === 'thinking' && !!b.thinking) ||
      (b.type === 'toolCall' && !!b.name)
  );
}

/**
 * Pi Agent
 */
export class PiAgent implements Agent {
  readonly type = 'pi' as const;
  readonly finder: PiSessionFinder;
  readonly parser: PiLineParser;

  constructor(
    options: ParserOptions = { verbose: false },
    paths?: { baseDir?: string }
  ) {
    this.finder = new PiSessionFinder(paths);
    this.parser = new PiLineParser(options);
  }
}
