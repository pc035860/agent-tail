import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/core/file-watcher.ts';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
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
