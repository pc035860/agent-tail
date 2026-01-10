import chalk from 'chalk';
import type { OutputHandler } from './subagent-detector.ts';
import type { DisplayController } from '../interactive/display-controller.ts';

/**
 * Console 輸出處理器（MultiWatch 模式）
 *
 * 直接使用 console.log/console.error 輸出，
 * 配合 chalk 進行顏色標記。
 */
export class ConsoleOutputHandler implements OutputHandler {
  info(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.log(chalk.yellow(message));
  }

  error(message: string): void {
    console.error(chalk.red(message));
  }

  debug(message: string): void {
    console.log(chalk.gray(message));
  }
}

/**
 * DisplayController 輸出處理器（Interactive 模式）
 *
 * 透過 DisplayController 輸出，確保不會覆蓋狀態列。
 */
export class DisplayControllerOutputHandler implements OutputHandler {
  constructor(private displayController: DisplayController) {}

  info(message: string): void {
    this.displayController.write(message);
  }

  warn(message: string): void {
    this.displayController.write(chalk.yellow(message));
  }

  error(message: string): void {
    this.displayController.write(chalk.red(message));
  }

  debug(message: string): void {
    this.displayController.write(chalk.gray(message));
  }
}
