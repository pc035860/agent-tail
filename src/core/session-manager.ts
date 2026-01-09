import type { WatchedFile } from './multi-file-watcher.ts';

/**
 * Watcher session 資訊
 */
export interface WatcherSession {
  id: string; // 識別碼（如 "main" 或 agentId）
  label: string; // 顯示標籤（如 "[MAIN]" 或 "[a0627b6]"）
  path: string; // 檔案路徑
  buffer: string[]; // 輸出緩衝
  isDone: boolean; // 是否已結束
}

/**
 * SessionManager 選項
 */
export interface SessionManagerOptions {
  /** 每個 session 的緩衝大小限制（行數），預設 1000 */
  bufferSize?: number;
  /** active session 的輸出回調 */
  onOutput: (content: string, session: WatcherSession) => void;
  /** 新 session 加入時的回調 */
  onSessionAdded?: (session: WatcherSession) => void;
  /** session 切換時的回調 */
  onSessionSwitched?: (
    session: WatcherSession,
    allSessions: WatcherSession[]
  ) => void;
}

/**
 * Session 管理器 - 管理多個 watcher session 的輸出切換
 *
 * 用於 interactive mode，讓使用者可以在主會話和 subagent 之間切換顯示。
 * 專注於 session 狀態管理和輸出路由，不直接控制 file watching。
 */
export class SessionManager {
  private sessions: WatcherSession[] = [];
  private activeIndex: number = 0;
  private bufferSize: number;
  private options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.bufferSize = options.bufferSize ?? 1000;
  }

  /**
   * 新增 session
   */
  addSession(id: string, label: string, path: string): WatcherSession {
    // 檢查是否已存在
    const existing = this.sessions.find((s) => s.id === id);
    if (existing) {
      return existing;
    }

    const session: WatcherSession = {
      id,
      label,
      path,
      buffer: [],
      isDone: false,
    };

    this.sessions.push(session);
    this.options.onSessionAdded?.(session);

    return session;
  }

  /**
   * 取得所有 sessions
   */
  getAllSessions(): WatcherSession[] {
    return [...this.sessions];
  }

  /**
   * 取得目前 active 的 session
   */
  getActiveSession(): WatcherSession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  /**
   * 取得 active index
   */
  getActiveIndex(): number {
    return this.activeIndex;
  }

  /**
   * 切換到下一個 session
   */
  switchNext(): WatcherSession | null {
    if (this.sessions.length === 0) return null;

    this.activeIndex = (this.activeIndex + 1) % this.sessions.length;
    const session = this.sessions[this.activeIndex] ?? null;
    if (session) {
      this.options.onSessionSwitched?.(session, this.sessions);
    }

    return session;
  }

  /**
   * 切換到上一個 session
   */
  switchPrev(): WatcherSession | null {
    if (this.sessions.length === 0) return null;

    this.activeIndex =
      (this.activeIndex - 1 + this.sessions.length) % this.sessions.length;
    const session = this.sessions[this.activeIndex] ?? null;
    if (session) {
      this.options.onSessionSwitched?.(session, this.sessions);
    }

    return session;
  }

  /**
   * 切換到指定 session（by id）
   */
  switchTo(id: string): WatcherSession | null {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index === -1) return null;

    this.activeIndex = index;
    const session = this.sessions[this.activeIndex] ?? null;
    if (session) {
      this.options.onSessionSwitched?.(session, this.sessions);
    }

    return session;
  }

  /**
   * 處理輸出
   * - active session: 直接輸出
   * - 非 active session: 存入 buffer
   */
  handleOutput(label: string, content: string): void {
    const session = this.sessions.find((s) => s.label === label);
    if (!session) return;

    const activeSession = this.getActiveSession();

    if (session === activeSession) {
      // Active session - 直接輸出
      this.options.onOutput(content, session);
    } else {
      // 非 active - 存入 buffer
      session.buffer.push(content);

      // 限制 buffer 大小
      if (session.buffer.length > this.bufferSize) {
        session.buffer.shift();
      }
    }
  }

  /**
   * 取得 session 的緩衝內容（回傳 copy 以防止外部意外修改）
   */
  getSessionBuffer(id: string): string[] {
    const session = this.sessions.find((s) => s.id === id);
    return session?.buffer.slice() ?? [];
  }

  /**
   * 清空 session 的緩衝
   */
  clearSessionBuffer(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.buffer = [];
    }
  }

  /**
   * 標記 session 為已結束
   */
  markSessionDone(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.isDone = true;
    }
  }

  /**
   * 輸出當前 active session 的緩衝內容（切換後顯示歷史）
   */
  flushActiveBuffer(): void {
    const session = this.getActiveSession();
    if (!session || session.buffer.length === 0) return;

    for (const content of session.buffer) {
      this.options.onOutput(content, session);
    }

    session.buffer = [];
  }

  /**
   * 建立 WatchedFile 列表給 MultiFileWatcher 使用
   */
  getWatchedFiles(): WatchedFile[] {
    return this.sessions.map((s) => ({
      path: s.path,
      label: s.label,
    }));
  }

  /**
   * Session 總數
   */
  get sessionCount(): number {
    return this.sessions.length;
  }

  /**
   * 是否只有一個 session（無需切換）
   */
  get isSingleSession(): boolean {
    return this.sessions.length <= 1;
  }
}
