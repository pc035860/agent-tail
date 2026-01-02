import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  MultiFileWatcher,
  type WatchedFile,
} from '../../src/core/multi-file-watcher';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('MultiFileWatcher', () => {
  let tempDir: string;
  let watcher: MultiFileWatcher;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'multi-watcher-test-'));
    watcher = new MultiFileWatcher();
  });

  afterEach(async () => {
    watcher.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('start', () => {
    test('should start watching multiple files', async () => {
      // Create test files
      const file1 = join(tempDir, 'file1.jsonl');
      const file2 = join(tempDir, 'file2.jsonl');
      await writeFile(file1, '{"type": "user", "message": "from file1"}\n');
      await writeFile(file2, '{"type": "user", "message": "from file2"}\n');

      const files: WatchedFile[] = [
        { path: file1, label: '[1]' },
        { path: file2, label: '[2]' },
      ];

      const lines: { line: string; label: string }[] = [];

      await watcher.start(files, {
        follow: false,
        onLine: (line, label) => {
          lines.push({ line, label });
        },
      });

      expect(lines).toHaveLength(2);
      expect(lines.find((l) => l.label === '[1]')).toBeDefined();
      expect(lines.find((l) => l.label === '[2]')).toBeDefined();
    });

    test('should pass correct label to onLine callback', async () => {
      const file1 = join(tempDir, 'main.jsonl');
      const file2 = join(tempDir, 'agent-abc123.jsonl');
      await writeFile(file1, '{"type": "user"}\n');
      await writeFile(file2, '{"type": "assistant"}\n');

      const files: WatchedFile[] = [
        { path: file1, label: '[M]' },
        { path: file2, label: '[abc123]' },
      ];

      const receivedLabels: string[] = [];

      await watcher.start(files, {
        follow: false,
        onLine: (_line, label) => {
          receivedLabels.push(label);
        },
      });

      expect(receivedLabels).toContain('[M]');
      expect(receivedLabels).toContain('[abc123]');
    });
  });

  describe('addFile', () => {
    test('should add new file to watch list', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      const file2 = join(tempDir, 'file2.jsonl');
      await writeFile(file1, '{"line": 1}\n');
      await writeFile(file2, '{"line": 2}\n');

      const lines: string[] = [];

      // Start with only file1
      await watcher.start([{ path: file1, label: '[1]' }], {
        follow: false,
        onLine: (line) => {
          lines.push(line);
        },
      });

      expect(lines).toHaveLength(1);

      // Add file2
      await watcher.addFile({ path: file2, label: '[2]' });

      expect(lines).toHaveLength(2);
    });

    test('should not add duplicate files', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      await writeFile(file1, '{"line": 1}\n');

      const lines: string[] = [];

      await watcher.start([{ path: file1, label: '[1]' }], {
        follow: false,
        onLine: (line) => {
          lines.push(line);
        },
      });

      expect(lines).toHaveLength(1);

      // Try to add same file again
      await watcher.addFile({ path: file1, label: '[1]' });

      // Should still have only 1 line (no duplicate processing)
      expect(lines).toHaveLength(1);
    });
  });

  describe('hasFile', () => {
    test('should return true for watched files', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      await writeFile(file1, '{"line": 1}\n');

      await watcher.start([{ path: file1, label: '[1]' }], {
        follow: false,
        onLine: () => {},
      });

      expect(watcher.hasFile(file1)).toBe(true);
    });

    test('should return false for unwatched files', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      const file2 = join(tempDir, 'file2.jsonl');
      await writeFile(file1, '{"line": 1}\n');

      await watcher.start([{ path: file1, label: '[1]' }], {
        follow: false,
        onLine: () => {},
      });

      expect(watcher.hasFile(file2)).toBe(false);
    });
  });

  describe('fileCount', () => {
    test('should return correct number of watched files', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      const file2 = join(tempDir, 'file2.jsonl');
      await writeFile(file1, '{"line": 1}\n');
      await writeFile(file2, '{"line": 2}\n');

      await watcher.start(
        [
          { path: file1, label: '[1]' },
          { path: file2, label: '[2]' },
        ],
        {
          follow: false,
          onLine: () => {},
        }
      );

      expect(watcher.fileCount).toBe(2);
    });
  });

  describe('stop', () => {
    test('should clear all watchers', async () => {
      const file1 = join(tempDir, 'file1.jsonl');
      await writeFile(file1, '{"line": 1}\n');

      await watcher.start([{ path: file1, label: '[1]' }], {
        follow: false,
        onLine: () => {},
      });

      expect(watcher.fileCount).toBe(1);

      watcher.stop();

      expect(watcher.fileCount).toBe(0);
    });
  });
});
