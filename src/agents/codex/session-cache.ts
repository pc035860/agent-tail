import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { SessionFile } from '../../core/types.ts';

/**
 * 快取中的 session 記錄
 */
export interface CachedSession {
  path: string;
  mtime: number; // timestamp
  cwd: string;
}

/** Negative cache entry: rollout path that is not a main session */
interface RejectedPath {
  path: string;
  mtime: number;
}

/**
 * 快取檔案格式
 */
interface CacheFile {
  version: number;
  lastScanTime: number;
  sessions: CachedSession[];
  /** Subagent / malformed / non-main rollouts — skip meta re-read while mtime matches */
  rejected?: RejectedPath[];
}

/** session_meta 的 payload 結構 */
interface SessionMetaPayload {
  cwd?: string;
  source?: unknown;
}

/** Initial head-read size; grows until first-line newline or EOF */
const META_HEAD_INITIAL_SIZE = 8192;

/**
 * Hard cap for first-line progressive read. Real session_meta is ≪8KB;
 * beyond this we treat the file as non-main rather than loading multi-MB bodies.
 */
const META_HEAD_MAX_SIZE = 1024 * 1024; // 1MB

/** Cap parallel meta/stat workers to avoid fd / I/O storms on large installs */
const RESOLVE_CONCURRENCY = 64;

/**
 * Run async mapper over items with a fixed concurrency pool.
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Classification of a Codex rollout file's first-line session_meta.
 * Distinguishes confirmed non-main from transient I/O failures so negative
 * cache never permanently excludes a briefly unreadable main session.
 */
export type MainSessionMetaClass =
  | { status: 'main'; cwd: string }
  | { status: 'not_main' }
  | { status: 'unavailable' };

/**
 * Classify Codex JSONL first-line session_meta.
 *
 * Progressive head-read until the first newline, EOF, or META_HEAD_MAX_SIZE.
 * Never loads an unbounded multi-MB body into memory.
 */
export async function classifyMainSessionMeta(
  filePath: string
): Promise<MainSessionMetaClass> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { status: 'unavailable' };
    const size = file.size;
    if (size === 0) return { status: 'not_main' };

    let chunkSize = META_HEAD_INITIAL_SIZE;
    let firstLine: string | null = null;
    while (true) {
      let content: string;
      try {
        const readSize = Math.min(size, chunkSize, META_HEAD_MAX_SIZE);
        content = await file.slice(0, readSize).text();
        const nl = content.indexOf('\n');
        if (nl !== -1) {
          firstLine = content.slice(0, nl);
          break;
        }
        if (readSize >= size) {
          firstLine = content;
          break;
        }
        if (readSize >= META_HEAD_MAX_SIZE) {
          // No newline within cap — confirmed unusable as session_meta
          return { status: 'not_main' };
        }
        chunkSize = Math.min(chunkSize * 4, size, META_HEAD_MAX_SIZE);
      } catch {
        return { status: 'unavailable' };
      }
    }
    if (!firstLine) return { status: 'not_main' };

    let meta: { type?: string; payload?: SessionMetaPayload };
    try {
      meta = JSON.parse(firstLine);
    } catch {
      return { status: 'not_main' };
    }

    if (meta.type !== 'session_meta') return { status: 'not_main' };

    const payload = meta.payload;
    if (!payload?.cwd) return { status: 'not_main' };

    const source = payload.source;
    if (typeof source === 'object' && source !== null && 'subagent' in source) {
      return { status: 'not_main' };
    }

    return { status: 'main', cwd: payload.cwd };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * 讀取 Codex JSONL 首行的 session_meta
 * 回傳 cwd（主 session）或 null（非主 session / 無法讀取）
 */
export async function readMainSessionMeta(
  filePath: string
): Promise<{ cwd: string } | null> {
  const result = await classifyMainSessionMeta(filePath);
  return result.status === 'main' ? { cwd: result.cwd } : null;
}

/** v3: persist rejected (non-main) paths for warm-list skip */
const CACHE_VERSION = 3;
const CACHE_FILE_NAME = '.agent-tail-cache.json';

/** 快取刷新間隔（毫秒）- 用於偵測新的 session */
const CACHE_REFRESH_INTERVAL_MS = 2000;

/**
 * Codex Session 快取
 * - 啟動時掃描所有 session，建立 cwd → sessions 的索引
 * - 持久化快取到 ~/.codex/.agent-tail-cache.json
 * - 使用 mtime 判斷是否需要更新
 * - 負向 cache：subagent / malformed 路徑在 mtime 不變時跳過 meta 重讀
 */
export class CodexSessionCache {
  private baseDir: string;
  private cacheFile: string;
  private cache: Map<string, CachedSession[]> = new Map();
  /** path → mtime for non-main rollouts */
  private rejected: Map<string, number> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private lastRefreshTime = 0;
  /** Set by doInit when a full filesystem scan ran (not disk load) */
  private lastInitWasFullScan = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.codex', 'sessions');
    this.cacheFile = join(dirname(this.baseDir), CACHE_FILE_NAME);
  }

  /**
   * 初始化快取（懶加載）
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 防止並發初始化
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInit();
    await this.initPromise;
    this.initPromise = null;
  }

  private async doInit(): Promise<void> {
    // 嘗試從磁碟載入快取
    const loaded = await this.loadFromDisk();
    if (loaded) {
      this.lastInitWasFullScan = false;
      this.initialized = true;
      return;
    }

    // 快取不存在或過期，重新掃描
    await this.scanAllSessions();
    await this.saveToDisk();
    this.lastInitWasFullScan = true;
    this.initialized = true;
  }

  /**
   * 從磁碟載入快取
   */
  private async loadFromDisk(): Promise<boolean> {
    try {
      const content = await readFile(this.cacheFile, 'utf-8');
      const data: CacheFile = JSON.parse(content);

      if (data.version !== CACHE_VERSION) {
        return false;
      }

      // 重建索引
      this.cache.clear();
      for (const session of data.sessions) {
        if (!this.cache.has(session.cwd)) {
          this.cache.set(session.cwd, []);
        }
        this.cache.get(session.cwd)!.push(session);
      }

      // 每個 cwd 內按 mtime 排序（降序）
      for (const [, sessions] of this.cache) {
        sessions.sort((a, b) => b.mtime - a.mtime);
      }

      this.rejected.clear();
      for (const entry of data.rejected ?? []) {
        this.rejected.set(entry.path, entry.mtime);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 儲存快取到磁碟
   */
  private async saveToDisk(): Promise<void> {
    try {
      const sessions: CachedSession[] = [];
      for (const [, cwdSessions] of this.cache) {
        sessions.push(...cwdSessions);
      }

      const rejected: RejectedPath[] = [];
      for (const [path, mtime] of this.rejected) {
        rejected.push({ path, mtime });
      }

      const data: CacheFile = {
        version: CACHE_VERSION,
        lastScanTime: Date.now(),
        sessions,
        rejected,
      };

      // 確保目錄存在
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify(data, null, 2));
    } catch {
      // 忽略寫入錯誤
    }
  }

  /**
   * 掃描所有 session 檔案，建立索引（parallel meta + stat）
   */
  private async scanAllSessions(): Promise<void> {
    const paths = await this.collectRolloutPaths();
    this.rejected.clear();
    const sessions = await this.resolveMainSessions(paths);
    this.replaceCache(sessions);
  }

  /** Glob all rollout-*.jsonl paths under baseDir */
  private async collectRolloutPaths(): Promise<string[]> {
    const glob = new Glob('**/rollout-*.jsonl');
    const paths: string[] = [];
    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      paths.push(file);
    }
    return paths;
  }

  /**
   * Parallel classifyMainSessionMeta + stat for a list of rollout paths.
   * Main sessions returned; confirmed non-main recorded in `rejected`.
   * Transient `unavailable` results are skipped without negative-caching.
   */
  private async resolveMainSessions(paths: string[]): Promise<CachedSession[]> {
    const results = await mapPool(
      paths,
      RESOLVE_CONCURRENCY,
      async (file): Promise<CachedSession | null> => {
        try {
          const stats = await stat(file);
          const mtime = stats.mtime.getTime();
          const classified = await classifyMainSessionMeta(file);
          if (classified.status === 'main') {
            this.rejected.delete(file);
            return {
              path: file,
              mtime,
              cwd: classified.cwd,
            };
          }
          if (classified.status === 'not_main') {
            this.rejected.set(file, mtime);
          }
          // unavailable → do not poison negative cache
          return null;
        } catch {
          return null;
        }
      }
    );
    return results.filter((s): s is CachedSession => s !== null);
  }

  /** Replace in-memory cwd index from a flat session list */
  private replaceCache(sessions: CachedSession[]): void {
    this.cache.clear();
    for (const session of sessions) {
      if (!this.cache.has(session.cwd)) {
        this.cache.set(session.cwd, []);
      }
      this.cache.get(session.cwd)!.push(session);
    }
    for (const [, cwdSessions] of this.cache) {
      cwdSessions.sort((a, b) => b.mtime - a.mtime);
    }
  }

  private buildPathIndex(): Map<string, CachedSession> {
    const known = new Map<string, CachedSession>();
    for (const sessions of this.cache.values()) {
      for (const s of sessions) known.set(s.path, s);
    }
    return known;
  }

  /**
   * Sync cache with filesystem:
   * - add missing main sessions (meta + stat)
   * - prune deleted paths (main + rejected)
   * - re-stat known paths so mtime stays fresh for findLatest / list slice
   * - skip meta re-read for rejected paths whose mtime is unchanged
   * Returns true when the in-memory index changed.
   */
  private async syncWithFilesystem(): Promise<boolean> {
    const existingPaths = await this.collectRolloutPaths();
    const existingSet = new Set(existingPaths);
    const knownByPath = this.buildPathIndex();

    const unknownPaths = existingPaths.filter((p) => !knownByPath.has(p));
    const knownStillThere = existingPaths.filter((p) => knownByPath.has(p));

    // Sequential pools so total concurrency stays ≤ RESOLVE_CONCURRENCY
    const refreshed = await mapPool(
      knownStillThere,
      RESOLVE_CONCURRENCY,
      async (
        path
      ): Promise<{ session: CachedSession | null; touched: boolean }> => {
        const prev = knownByPath.get(path)!;
        try {
          const stats = await stat(path);
          const mtime = stats.mtime.getTime();
          if (mtime !== prev.mtime) {
            return { session: { ...prev, mtime }, touched: true };
          }
          return { session: prev, touched: false };
        } catch {
          return { session: null, touched: true };
        }
      }
    );

    // For unknown paths: skip meta if negative-cached with matching mtime
    const needResolve: string[] = [];
    let rejectedTouched = false;
    const rejectStats = await mapPool(
      unknownPaths,
      RESOLVE_CONCURRENCY,
      async (path): Promise<'skip' | 'resolve' | 'gone'> => {
        const cachedMtime = this.rejected.get(path);
        if (cachedMtime === undefined) return 'resolve';
        try {
          const stats = await stat(path);
          if (stats.mtime.getTime() === cachedMtime) return 'skip';
          return 'resolve'; // mtime changed — reclassify
        } catch {
          this.rejected.delete(path);
          rejectedTouched = true;
          return 'gone';
        }
      }
    );
    for (let i = 0; i < unknownPaths.length; i++) {
      if (rejectStats[i] === 'resolve') needResolve.push(unknownPaths[i]!);
    }

    const discovered =
      needResolve.length > 0
        ? await this.resolveMainSessions(needResolve)
        : ([] as CachedSession[]);

    // Prune deleted main paths and deleted rejected paths
    const prunedMain = [...knownByPath.keys()].some((p) => !existingSet.has(p));
    for (const path of [...this.rejected.keys()]) {
      if (!existingSet.has(path)) {
        this.rejected.delete(path);
        rejectedTouched = true;
      }
    }

    const mtimeTouched = refreshed.some((r) => r.touched);
    const mainsChanged = prunedMain || mtimeTouched || discovered.length > 0;
    // needResolve always rewrites rejected entries inside resolveMainSessions
    const rejectedChanged = rejectedTouched || needResolve.length > 0;

    if (!mainsChanged && !rejectedChanged) return false;

    if (mainsChanged) {
      const nextSessions: CachedSession[] = [
        ...refreshed
          .map((r) => r.session)
          .filter((s): s is CachedSession => s !== null),
        ...discovered,
      ];
      this.replaceCache(nextSessions);
    }

    return true;
  }

  /**
   * List all known main sessions (for --list / findLatest).
   * Ensures cache is initialized, then syncs with filesystem so sessions
   * created since the last disk cache write are not missed and mtimes stay fresh.
   *
   * Cold-scan skip is call-scoped and ownership-scoped: only when *this* call
   * starts doInit AND that init performs a full scan. Joining another API's
   * in-flight initPromise never skips sync.
   */
  async listAllSessions(options?: {
    project?: string;
  }): Promise<CachedSession[]> {
    const didFullScanHere = await this.initOwned();

    if (!didFullScanHere) {
      const changed = await this.syncWithFilesystem();
      if (changed) {
        await this.saveToDisk();
      }
    }

    const all: CachedSession[] = [];
    const pattern = options?.project?.toLowerCase();
    for (const [cwd, sessions] of this.cache) {
      if (pattern && !cwd.toLowerCase().includes(pattern)) continue;
      all.push(...sessions);
    }
    all.sort((a, b) => b.mtime - a.mtime);
    return all;
  }

  /**
   * Init for listAllSessions. Returns true only if this call owned doInit and
   * that init performed a full filesystem scan (not a disk load / join).
   */
  private async initOwned(): Promise<boolean> {
    if (this.initialized) return false;
    if (this.initPromise) {
      await this.initPromise;
      return false;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
    this.initPromise = null;
    return this.lastInitWasFullScan;
  }

  /**
   * 取得指定 cwd 的最新 session
   * 會驗證檔案是否存在，若不存在則嘗試下一個
   * 定期刷新以偵測新的 session
   */
  async getLatestByCwd(cwd: string): Promise<SessionFile | null> {
    await this.init();

    // 檢查是否需要刷新（增量更新）
    await this.maybeRefresh();

    const sessions = this.cache.get(cwd);
    if (!sessions || sessions.length === 0) return null;

    // 找到第一個存在且有效的 session
    for (const session of sessions) {
      // 驗證檔案是否存在
      const file = Bun.file(session.path);
      if (await file.exists()) {
        return {
          path: session.path,
          mtime: new Date(session.mtime),
          agentType: 'codex',
        };
      }
    }

    return null;
  }

  /**
   * 檢查是否需要刷新快取（根據時間間隔）
   * 如果需要，掃描最近的 session 進行增量更新
   */
  private async maybeRefresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshTime < CACHE_REFRESH_INTERVAL_MS) {
      return;
    }

    this.lastRefreshTime = now;

    // 增量刷新：只掃描今天的 session
    const today = new Date();
    const year = today.getFullYear().toString();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    const todayDir = join(this.baseDir, year, month, day);

    // 檢查今天的目錄是否存在（使用 stat 而非 Bun.file）
    try {
      const dirStats = await stat(todayDir);
      if (!dirStats.isDirectory()) return;
    } catch {
      return;
    }

    // 掃描今天的 session
    const glob = new Glob('rollout-*.jsonl');
    for await (const file of glob.scan({ cwd: todayDir, absolute: true })) {
      const filename = basename(file);
      if (!filename.startsWith('rollout-')) continue;

      try {
        // 檢查是否已在快取中 — refresh mtime if present
        let existing: CachedSession | undefined;
        let existingCwd: string | undefined;
        for (const [cwd, sessions] of this.cache) {
          const hit = sessions.find((s) => s.path === file);
          if (hit) {
            existing = hit;
            existingCwd = cwd;
            break;
          }
        }

        if (existing && existingCwd) {
          const stats = await stat(file);
          const mtime = stats.mtime.getTime();
          if (mtime !== existing.mtime) {
            existing.mtime = mtime;
            this.cache.get(existingCwd)!.sort((a, b) => b.mtime - a.mtime);
          }
          continue;
        }

        // Negative cache hit with unchanged mtime — skip meta
        const rejectedMtime = this.rejected.get(file);
        if (rejectedMtime !== undefined) {
          const stats = await stat(file);
          if (stats.mtime.getTime() === rejectedMtime) continue;
        }

        const stats = await stat(file);
        const mtime = stats.mtime.getTime();
        const classified = await classifyMainSessionMeta(file);
        if (classified.status === 'main') {
          this.rejected.delete(file);
          const newSession: CachedSession = {
            path: file,
            mtime,
            cwd: classified.cwd,
          };

          if (!this.cache.has(newSession.cwd)) {
            this.cache.set(newSession.cwd, []);
          }
          this.cache.get(newSession.cwd)!.push(newSession);

          // 重新排序該 cwd 的 sessions（降序）
          this.cache.get(newSession.cwd)!.sort((a, b) => b.mtime - a.mtime);
        } else if (classified.status === 'not_main') {
          this.rejected.set(file, mtime);
        }
        // unavailable → leave alone (retry next refresh)
      } catch {
        // 忽略無法解析的檔案
      }
    }
  }

  /**
   * 列出所有已知專案
   */
  async getAllProjects(): Promise<string[]> {
    await this.init();
    return Array.from(this.cache.keys());
  }

  /**
   * 清除快取（用於測試或強制刷新）
   */
  clear(): void {
    this.cache.clear();
    this.rejected.clear();
    this.initialized = false;
    this.initPromise = null;
    this.lastRefreshTime = 0;
    this.lastInitWasFullScan = false;
  }
}
