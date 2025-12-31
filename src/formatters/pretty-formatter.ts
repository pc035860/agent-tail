import chalk from 'chalk';
import type { ParsedLine } from '../core/types.ts';
import type { Formatter } from './formatter.interface.ts';
import { getToolCategory, type ToolCategory } from '../utils/format-tool.ts';

/**
 * 格式化可讀輸出
 */
export class PrettyFormatter implements Formatter {
  format(parsed: ParsedLine): string {
    const time = this.formatTime(parsed.timestamp);
    const content = parsed.formatted;

    // function_call 類型使用 tool category 顏色
    if (parsed.type === 'function_call' && parsed.toolName) {
      const category = getToolCategory(parsed.toolName);
      const typeLabel = this.formatToolCategory(category);
      return `${chalk.gray(time)} ${typeLabel} ${content}`;
    }

    const typeLabel = this.formatType(parsed.type);
    return `${chalk.gray(time)} ${typeLabel} ${content}`;
  }

  /**
   * 根據 tool category 回傳對應顏色的標籤
   */
  private formatToolCategory(category: ToolCategory): string {
    switch (category) {
      case 'shell':
        return chalk.yellow('SHELL');
      case 'file':
        return chalk.green('FILE');
      case 'search':
        return chalk.cyan('SEARCH');
      case 'web':
        return chalk.blue('WEB');
      case 'task':
        return chalk.magenta('TASK');
      default:
        return chalk.white('FUNC');
    }
  }

  private formatTime(timestamp: string): string {
    if (!timestamp) return '[--:--:--]';

    try {
      const date = new Date(timestamp);
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const seconds = date.getSeconds().toString().padStart(2, '0');
      return `[${hours}:${minutes}:${seconds}]`;
    } catch {
      return '[--:--:--]';
    }
  }

  private formatType(type: string): string {
    switch (type) {
      case 'user':
        return chalk.green.bold('USER');
      case 'assistant':
      case 'gemini':
        // 統一 agent 回覆的顯示
        return chalk.blue.bold('ASST');
      case 'session_meta':
        return chalk.yellow('META');
      case 'function_call':
        return chalk.magenta('FUNC');
      case 'output':
        return chalk.cyan('OUT ');
      case 'reasoning':
        return chalk.gray('THINK');
      default:
        return chalk.white(type.toUpperCase().slice(0, 4).padEnd(4));
    }
  }
}
