import chalk from 'chalk';
import type { WatcherSession } from '../core/session-manager.ts';

/**
 * DisplayController 選項
 */
export interface DisplayControllerOptions {
  /** 是否啟用持久狀態列（需要 TTY） */
  persistentStatusLine?: boolean;
  /** 歷史回看時顯示的最大行數 */
  historyLines?: number;
}

/**
 * ANSI Escape Codes
 */
const ANSI = {
  // 游標控制
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  // 行控制
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[K',
  // 移動
  moveToColumn: (n: number) => `\x1b[${n}G`,
  moveUp: (n: number) => `\x1b[${n}A`,
  moveDown: (n: number) => `\x1b[${n}B`,
  moveToBottom: '\x1b[999B',
  // 螢幕控制
  scrollUp: '\x1b[S',
  setScrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  resetScrollRegion: '\x1b[r',
};

/**
 * Display Controller - 控制終端輸出和狀態列顯示
 *
 * 用於 interactive mode，管理：
 * - 持久狀態列（底部固定）
 * - 內容輸出區域（狀態列上方）
 * - 歷史回看顯示
 */
export class DisplayController {
  private isInitialized = false;
  private persistentStatusLine: boolean;
  private historyLines: number;
  private currentStatusLine = '';
  private terminalRows: number;
  private terminalCols: number;
  // 保存 handler 引用以便在 destroy() 時移除
  private onResize = () => {
    this.terminalRows = process.stdout.rows || 24;
    this.terminalCols = process.stdout.columns || 80;
    if (
      this.isInitialized &&
      this.persistentStatusLine &&
      process.stdout.isTTY
    ) {
      // 重設 scroll region 以適應新的終端大小
      process.stdout.write(ANSI.setScrollRegion(1, this.terminalRows - 1));
      // 移動游標到內容區
      process.stdout.write(`\x1b[${this.terminalRows - 1};1H`);
      // 刷新狀態列
      this.refreshStatusLine();
    }
  };

  constructor(options: DisplayControllerOptions = {}) {
    this.persistentStatusLine = options.persistentStatusLine ?? true;
    this.historyLines = options.historyLines ?? 50;
    this.terminalRows = process.stdout.rows || 24;
    this.terminalCols = process.stdout.columns || 80;

    // 監聽終端大小變化
    process.stdout.on('resize', this.onResize);
  }

  /**
   * 初始化 DisplayController
   */
  init(): void {
    if (this.isInitialized) return;

    if (this.persistentStatusLine && process.stdout.isTTY) {
      // 設定捲動區域（保留最後一行給狀態列）
      process.stdout.write(ANSI.setScrollRegion(1, this.terminalRows - 1));
      // 移到捲動區域內
      process.stdout.write(`\x1b[${this.terminalRows - 1};1H`);
      // 顯示初始狀態列
      this.refreshStatusLine();
    }

    this.isInitialized = true;
  }

  /**
   * 清理並恢復終端設定
   */
  destroy(): void {
    if (!this.isInitialized) return;

    // 移除 resize 監聽器
    process.stdout.off('resize', this.onResize);

    if (this.persistentStatusLine && process.stdout.isTTY) {
      // 清除狀態列
      process.stdout.write(`\x1b[${this.terminalRows};1H`);
      process.stdout.write(ANSI.clearLine);
      // 重設捲動區域
      process.stdout.write(ANSI.resetScrollRegion);
      // 顯示游標
      process.stdout.write(ANSI.showCursor);
    }

    this.isInitialized = false;
  }

  /**
   * 輸出內容到終端（確保不覆蓋狀態列）
   */
  write(content: string): void {
    if (this.persistentStatusLine && process.stdout.isTTY) {
      // 確保在捲動區域內輸出
      process.stdout.write(content + '\n');
    } else {
      // 非 TTY 模式直接輸出
      console.log(content);
    }
  }

  /**
   * 更新狀態列
   */
  updateStatusLine(sessions: WatcherSession[], activeIndex: number): void {
    const statusLine = this.buildStatusLine(sessions, activeIndex);
    this.currentStatusLine = statusLine;

    if (this.persistentStatusLine && process.stdout.isTTY) {
      this.refreshStatusLine();
    } else {
      // 非 TTY 模式用分隔線顯示
      console.log(statusLine);
    }
  }

  /**
   * 建構狀態列內容
   */
  private buildStatusLine(
    sessions: WatcherSession[],
    activeIndex: number
  ): string {
    const total = sessions.length;

    // 位置指示器 [3/20]
    const positionIndicator = chalk.cyan(`[${activeIndex + 1}/${total}]`);

    // 計算滑動視窗範圍（顯示 active 附近的 5 個 session）
    const windowSize = 5;
    const halfWindow = Math.floor(windowSize / 2);

    let startIndex = Math.max(0, activeIndex - halfWindow);
    let endIndex = Math.min(total, startIndex + windowSize);

    // 如果接近尾端，調整起始位置
    if (endIndex === total && total > windowSize) {
      startIndex = Math.max(0, total - windowSize);
    }
    // 如果接近開頭，調整結束位置
    if (startIndex === 0 && total > windowSize) {
      endIndex = Math.min(total, windowSize);
    }

    const hiddenLeft = startIndex;
    const hiddenRight = total - endIndex;

    // 建立可見 session 的顯示
    const visibleSessions = sessions.slice(startIndex, endIndex);
    const parts = visibleSessions.map((session, i) => {
      const actualIndex = startIndex + i;
      const isActive = actualIndex === activeIndex;
      const label = session.label.replace(/\[|\]/g, '');
      const displayLabel = session.id === 'main' ? 'MAIN' : label;
      const bufferCount = session.buffer.length;
      const doneMarker = session.isDone ? chalk.green('✓') : '';

      if (isActive) {
        return (
          chalk.cyan.bold(`[${displayLabel}]`) +
          (doneMarker ? chalk.green(doneMarker) : '')
        );
      } else {
        const bufferInfo =
          bufferCount > 0 ? chalk.yellow(`(${bufferCount})`) : '';
        return (
          chalk.gray(displayLabel) +
          (bufferInfo ? bufferInfo : '') +
          (doneMarker ? chalk.green(doneMarker) : '')
        );
      }
    });

    // 組合狀態列
    let sessionsPart = '';

    // 左側隱藏指示
    if (hiddenLeft > 0) {
      sessionsPart += chalk.yellow(`←${hiddenLeft}`) + chalk.gray(' | ');
    }

    // 可見的 sessions
    sessionsPart += parts.join(chalk.gray(' | '));

    // 右側隱藏指示
    if (hiddenRight > 0) {
      sessionsPart += chalk.gray(' | ') + chalk.yellow(`${hiddenRight}→`);
    }

    const hint = chalk.gray(' (Tab/q)');
    const prefix = '─── ';
    const suffix = ' ───';

    return (
      chalk.gray(prefix) +
      positionIndicator +
      ' ' +
      sessionsPart +
      hint +
      chalk.gray(suffix)
    );
  }

  /**
   * 重繪狀態列
   */
  private refreshStatusLine(): void {
    if (!process.stdout.isTTY) return;

    // 保存游標位置
    process.stdout.write(ANSI.saveCursor);
    // 移到最後一行
    process.stdout.write(`\x1b[${this.terminalRows};1H`);
    // 清除行
    process.stdout.write(ANSI.clearLine);
    // 輸出狀態列（截斷至終端寬度）
    const statusLine = this.truncateToWidth(
      this.currentStatusLine,
      this.terminalCols
    );
    process.stdout.write(statusLine);
    // 恢復游標位置
    process.stdout.write(ANSI.restoreCursor);
  }

  /**
   * 顯示切換訊息和歷史內容
   */
  showSwitchMessage(session: WatcherSession, historyContent: string[]): void {
    // 顯示分隔線（包含完成狀態）
    const doneStatus = session.isDone ? chalk.green(' ✓ (completed)') : '';
    const separator =
      chalk.gray(`\n─── Switched to ${session.label}`) +
      doneStatus +
      chalk.gray(` ───`);
    this.write(separator);

    // 顯示歷史內容（最近 N 行）
    const linesToShow = historyContent.slice(-this.historyLines);
    if (linesToShow.length > 0) {
      const historyHeader = chalk.gray(
        `[Showing ${linesToShow.length} buffered lines]`
      );
      this.write(historyHeader);
      for (const line of linesToShow) {
        this.write(line);
      }
      const historyFooter = chalk.gray(`[End of buffer]`);
      this.write(historyFooter);
    } else {
      // Buffer 是空的，顯示提示訊息
      if (session.isDone) {
        this.write(chalk.gray(`[No new content - session completed]`));
      } else {
        this.write(
          chalk.gray(`[No buffered content - waiting for new output...]`)
        );
      }
    }
  }

  /**
   * 截斷字串至指定寬度（考慮 ANSI codes）
   */
  private truncateToWidth(str: string, maxWidth: number): string {
    // 移除 ANSI codes 計算實際長度
    // eslint-disable-next-line no-control-regex
    const plainStr = str.replace(/\x1b\[[0-9;]*m/g, '');
    if (plainStr.length <= maxWidth) {
      return str;
    }

    // 簡單截斷（不完美但足夠用）
    let visibleLength = 0;
    let result = '';
    let inEscape = false;

    for (const char of str) {
      if (char === '\x1b') {
        inEscape = true;
        result += char;
      } else if (inEscape) {
        result += char;
        if (char === 'm') {
          inEscape = false;
        }
      } else {
        if (visibleLength >= maxWidth - 3) {
          result += '...';
          break;
        }
        result += char;
        visibleLength++;
      }
    }

    return result;
  }

  /**
   * 是否支援持久狀態列
   */
  get supportsPersistentStatusLine(): boolean {
    return process.stdout.isTTY === true;
  }
}
