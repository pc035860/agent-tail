import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { SessionFile } from '../../core/types.ts';

/**
 * 快取中的 session 記錄
 */
interface CachedSession {
  path: string;
  mtime: number; // timestamp
  cwd: string;
}

/**
 * 快取檔案格式
 */
interface CacheFile {
  version: number;
  lastScanTime: number;
  sessions: CachedSession[];
}

const CACHE_VERSION = 1;
const CACHE_FILE_NAME = '.agent-tail-cache.json';

/** 快取刷新間隔（毫秒）- 用於偵測新的 session */
const CACHE_REFRESH_INTERVAL_MS = 2000;

/**
 * Codex Session 快取
 * - 啟動時掃描所有 session，建立 cwd → sessions 的索引
 * - 持久化快取到 ~/.codex/.agent-tail-cache.json
 * - 使用 mtime 判斷是否需要更新
 */
export class CodexSessionCache {
  private baseDir: string;
  private cacheFile: string;
  private cache: Map<string, CachedSession[]> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private lastRefreshTime = 0;

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
      this.initialized = true;
      return;
    }

    // 快取不存在或過期，重新掃描
    await this.scanAllSessions();
    await this.saveToDisk();
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

      const data: CacheFile = {
        version: CACHE_VERSION,
        lastScanTime: Date.now(),
        sessions,
      };

      // 確保目錄存在
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify(data, null, 2));
    } catch {
      // 忽略寫入錯誤
    }
  }

  /**
   * 掃描所有 session 檔案，建立索引
   */
  private async scanAllSessions(): Promise<void> {
    const glob = new Glob('**/*.jsonl');
    const sessions: CachedSession[] = [];

    for await (const file of glob.scan({ cwd: this.baseDir, absolute: true })) {
      const filename = basename(file);
      if (!filename.startsWith('rollout-')) continue;

      try {
        // 只讀取第一行（session_meta）
        const content = await Bun.file(file).text();
        const firstLine = content.split('\n')[0];
        if (!firstLine) continue;

        const meta = JSON.parse(firstLine);
        if (meta.type === 'session_meta' && meta.payload?.cwd) {
          const stats = await stat(file);
          sessions.push({
            path: file,
            mtime: stats.mtime.getTime(),
            cwd: meta.payload.cwd,
          });
        }
      } catch {
        // 忽略無法解析的檔案
      }
    }

    // 建立 cwd 索引
    this.cache.clear();
    for (const session of sessions) {
      if (!this.cache.has(session.cwd)) {
        this.cache.set(session.cwd, []);
      }
      this.cache.get(session.cwd)!.push(session);
    }

    // 每個 cwd 內按 mtime 排序（降序）
    for (const [, cwdSessions] of this.cache) {
      cwdSessions.sort((a, b) => b.mtime - a.mtime);
    }
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
        // 檢查是否已在快取中
        let alreadyCached = false;
        for (const [, sessions] of this.cache) {
          if (sessions.some((s) => s.path === file)) {
            alreadyCached = true;
            break;
          }
        }
        if (alreadyCached) continue;

        // 只讀取第一行（session_meta）
        const content = await Bun.file(file).text();
        const firstLine = content.split('\n')[0];
        if (!firstLine) continue;

        const meta = JSON.parse(firstLine);
        if (meta.type === 'session_meta' && meta.payload?.cwd) {
          const stats = await stat(file);
          const newSession: CachedSession = {
            path: file,
            mtime: stats.mtime.getTime(),
            cwd: meta.payload.cwd,
          };

          if (!this.cache.has(newSession.cwd)) {
            this.cache.set(newSession.cwd, []);
          }
          this.cache.get(newSession.cwd)!.push(newSession);

          // 重新排序該 cwd 的 sessions（降序）
          this.cache.get(newSession.cwd)!.sort((a, b) => b.mtime - a.mtime);
        }
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
    this.initialized = false;
  }
}
