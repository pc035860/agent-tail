import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/core/file-watcher.ts';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('FileWatcher', () => {
  let tempDir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    watcher.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('initialLines option', () => {
    test('should show last N lines', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      const lines = [
        '{"type": "user", "message": "line 1"}',
        '{"type": "user", "message": "line 2"}',
        '{"type": "user", "message": "line 3"}',
        '{"type": "user", "message": "line 4"}',
        '{"type": "user", "message": "line 5"}',
      ];
      await writeFile(testFile, lines.join('\n') + '\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: false,
        initialLines: 3,
        onLine: (line) => receivedLines.push(line),
      });

      expect(receivedLines).toHaveLength(3);
      expect(receivedLines[0]).toBe(lines[2]);
    });

    test('should show all when N exceeds file length', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: false,
        initialLines: 10,
        onLine: (line) => receivedLines.push(line),
      });

      expect(receivedLines).toHaveLength(2);
    });

    test('should show none when N is 0', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      await writeFile(testFile, '{"line": 1}\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: false,
        initialLines: 0,
        onLine: (line) => receivedLines.push(line),
      });

      expect(receivedLines).toHaveLength(0);
    });

    test('should show all when N is negative', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: false,
        initialLines: -5,
        onLine: (line) => receivedLines.push(line),
      });

      expect(receivedLines).toHaveLength(2);
    });

    test('should show all lines when initialLines is undefined', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n{"line": 3}\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: false,
        onLine: (line) => receivedLines.push(line),
      });

      expect(receivedLines).toHaveLength(3);
    });
  });

  describe('pollInterval option', () => {
    test('should use custom poll interval', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      await writeFile(testFile, '{"type": "user"}\n');

      const startTime = Date.now();

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 200,
        onLine: () => {},
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      watcher.stop();

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(400);
    });
  });

  describe('incremental JSONL reading', () => {
    test('only emits newly appended lines after first read', async () => {
      const testFile = join(tempDir, 'inc.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n{"line": 3}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 50,
        onLine: (line) => received.push(line),
      });

      // 首次應該收到 3 行（無 initialLines 限制）
      expect(received).toHaveLength(3);

      // append 2 行
      await appendFile(testFile, '{"line": 4}\n{"line": 5}\n');

      // 等 polling 觸發
      await new Promise((r) => setTimeout(r, 200));

      expect(received).toHaveLength(5);
      expect(received[3]).toBe('{"line": 4}');
      expect(received[4]).toBe('{"line": 5}');
    });

    test('buffers partial trailing line until newline arrives', async () => {
      const testFile = join(tempDir, 'partial.jsonl');
      await writeFile(testFile, '{"line": 1}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 50,
        onLine: (line) => received.push(line),
      });

      expect(received).toHaveLength(1);

      // 寫入完整一行 + 未完成尾段
      await appendFile(testFile, '{"line": 2}\n{"line": 3_incomplete');
      await new Promise((r) => setTimeout(r, 200));

      // 應只收到 line 2，line 3 因無 newline 暫存
      expect(received).toHaveLength(2);
      expect(received[1]).toBe('{"line": 2}');

      // 補上 newline + 下一行
      await appendFile(testFile, '_tail"}\n{"line": 4}\n');
      await new Promise((r) => setTimeout(r, 200));

      expect(received).toHaveLength(4);
      expect(received[2]).toBe('{"line": 3_incomplete_tail"}');
      expect(received[3]).toBe('{"line": 4}');
    });

    test('handles truncation by resetting offset and re-processing', async () => {
      const testFile = join(tempDir, 'trunc.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n{"line": 3}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 50,
        onLine: (line) => received.push(line),
      });

      expect(received).toHaveLength(3);

      // 把檔案截斷成短內容（模擬 log rotation 或 atomic rewrite-in-place）
      await truncate(testFile, 0);
      await writeFile(testFile, '{"new": 1}\n{"new": 2}\n');

      // 等 polling 偵測
      await new Promise((r) => setTimeout(r, 200));

      expect(received).toHaveLength(5);
      expect(received[3]).toBe('{"new": 1}');
      expect(received[4]).toBe('{"new": 2}');
    });

    test('initialLines limits first read but appends emit normally', async () => {
      const testFile = join(tempDir, 'first.jsonl');
      await writeFile(
        testFile,
        '{"line": 1}\n{"line": 2}\n{"line": 3}\n{"line": 4}\n{"line": 5}\n'
      );

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        initialLines: 2,
        pollInterval: 50,
        onLine: (line) => received.push(line),
      });

      // 首次只收到最後 2 行
      expect(received).toHaveLength(2);
      expect(received[0]).toBe('{"line": 4}');
      expect(received[1]).toBe('{"line": 5}');

      // append 1 行
      await appendFile(testFile, '{"line": 6}\n');
      await new Promise((r) => setTimeout(r, 200));

      // 應該收到 append 行，且不會重發前面 1–3 行
      expect(received).toHaveLength(3);
      expect(received[2]).toBe('{"line": 6}');
    });
  });

  describe('follow mode with initialLines', () => {
    test('should show initial N lines then new lines', async () => {
      const testFile = join(tempDir, 'test.jsonl');
      const initialLines = [
        '{"type": "user", "message": "line 1"}',
        '{"type": "user", "message": "line 2"}',
        '{"type": "user", "message": "line 3"}',
        '{"type": "user", "message": "line 4"}',
        '{"type": "user", "message": "line 5"}',
      ];
      await writeFile(testFile, initialLines.join('\n') + '\n');

      const receivedLines: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        initialLines: 2,
        pollInterval: 100,
        onLine: (line) => receivedLines.push(line),
      });

      // 應該只收到最後 2 行初始行
      expect(receivedLines).toHaveLength(2);
      expect(receivedLines[0]).toBe(initialLines[3]);

      // 新增一行
      const newLine = '{"type": "user", "message": "line 6"}';
      await appendFile(testFile, newLine + '\n');

      // 等待 polling 捕捉到變化
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedLines).toHaveLength(3);
      expect(receivedLines[2]).toBe(newLine);

      watcher.stop();
    });
  });
});
