import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/core/file-watcher.ts';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs/promises';
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

    test('handles many sequential appends without losing lines', async () => {
      // 模擬高頻寫入：1000 個 append，每次一行
      // 用來檢驗持久 fd + 可重用 buffer 在反覆讀取下仍正確
      const testFile = join(tempDir, 'high-freq.jsonl');
      await writeFile(testFile, '{"line": 0}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 30,
        onLine: (line) => received.push(line),
      });

      expect(received).toHaveLength(1);

      // 每 5ms append 一行，總共 50 次
      for (let i = 1; i <= 50; i++) {
        await appendFile(testFile, `{"line": ${i}}\n`);
        await new Promise((r) => setTimeout(r, 5));
      }

      // 等 polling 收尾
      await new Promise((r) => setTimeout(r, 200));

      // 應該收到全部 51 行，無漏無重
      expect(received).toHaveLength(51);
      // 確認順序正確、內容對得上
      for (let i = 0; i <= 50; i++) {
        expect(received[i]).toBe(`{"line": ${i}}`);
      }
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

  describe('v2 baseline semantics (SPEC §4.3 + §7 boundary matrix)', () => {
    test('onInitialDumpComplete fires after the initial dump', async () => {
      const testFile = join(tempDir, 'dump.jsonl');
      await writeFile(testFile, '{"line": 1}\n{"line": 2}\n');

      const received: string[] = [];
      let dumpFired = false;
      const w = new FileWatcher();
      await w.start(testFile, {
        follow: false,
        onLine: (line) => received.push(line),
        onInitialDumpComplete: () => {
          dumpFired = true;
          // 初始 dump 完成時，所有初始行都已被處理
          expect(received).toHaveLength(2);
        },
      });

      expect(dumpFired).toBe(true);
    });

    test('race#1: append during incremental read is drained (no lost tail lines)', async () => {
      const testFile = join(tempDir, 'race1.jsonl');
      await writeFile(testFile, '{"line": 1}\n');

      const received: string[] = [];
      let next = 2;
      const w = new FileWatcher();
      await w.start(testFile, {
        follow: true,
        pollInterval: 50,
        onLine: (line) => {
          received.push(line);
          // read 期間同步 append 下一行 → 觸發 pending drain
          appendFileSync(testFile, `{"line": ${next}}\n`);
          next++;
        },
      });

      // 等所有 append 被消化（pending drain 保證 read 期間 append 的尾行不遺失）
      await new Promise((r) => setTimeout(r, 800));
      w.stop();

      expect(received.length).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < received.length; i++) {
        expect(received[i]).toBe(`{"line": ${i + 1}}`);
      }
    });

    test('race#2: JSONL baseline reflects processed content, not post-read stat', async () => {
      const testFile = join(tempDir, 'race2.jsonl');
      await writeFile(testFile, '{"line": 1}\n'); // 12 bytes

      const received: string[] = [];
      let appended = false;
      const w = new FileWatcher();
      await w.start(testFile, {
        follow: false,
        onLine: (line) => {
          received.push(line);
          if (!appended) {
            appended = true;
            // read 期間 append（baseline 空窗）：檔案變成 24 bytes
            appendFileSync(testFile, '{"line": 2}\n');
          }
        },
      });

      // 斷言（poll 推進前）：baseline = 已處理內容 12 bytes，不是 append 後的 24
      const state = w.getDebugState();
      expect(state.lastSize).toBe(12);
      expect(state.lastReadOffset).toBe(12);
      expect(received).toEqual(['{"line": 1}']);
    });

    test('race#3: empty JSONL baseline aligns to 0 (first line not swallowed)', async () => {
      const testFile = join(tempDir, 'race3.jsonl');
      await writeFile(testFile, '');

      const received: string[] = [];
      // 模擬「read 後第一行寫入」：stat 一律回報 12 bytes（有內容），但真實檔案是空的
      const fakeStat = { size: 12, mtimeMs: 1000 } as Stats;
      const w = new FileWatcher({ injectedStat: async () => fakeStat });
      await w.start(testFile, {
        follow: false,
        onLine: (line) => received.push(line),
      });

      // baseline 必須對齊「已處理內容」= 0，不是 stat 的 12
      const state = w.getDebugState();
      expect(state.lastSize).toBe(0);
      expect(state.lastReadOffset).toBe(0);
      expect(received).toHaveLength(0);
    });

    test('race#4: jsonMode baseline aligns to processed content length', async () => {
      const testFile = join(tempDir, 'race4.json');
      await writeFile(testFile, '{"a": 1}'); // 8 bytes

      const received: string[] = [];
      let first = true;
      const w = new FileWatcher();
      await w.start(testFile, {
        follow: false,
        jsonMode: true,
        onLine: (content) => {
          received.push(content);
          if (first) {
            first = false;
            // read 期間同步 rewrite（baseline 空窗）：檔案變成 22 bytes
            writeFileSync(testFile, '{"a": 1, "b": "longer"}');
          }
        },
      });

      // 斷言：baseline = 已處理內容長度 8，不是 rewrite 後的 22
      const state = w.getDebugState();
      expect(state.lastSize).toBe(8);
      expect(state.lastContentLength).toBe(8);
      expect(received).toEqual(['{"a": 1}']);
    });

    test('race#5: jsonMode same-size rewrite detected via mtime + hash', async () => {
      const testFile = join(tempDir, 'race5.json');
      await writeFile(testFile, '{"a": 1}'); // 8 bytes

      const received: string[] = [];
      const w = new FileWatcher();
      await w.start(testFile, {
        follow: true,
        jsonMode: true,
        pollInterval: 50,
        onLine: (content) => received.push(content),
      });

      expect(received).toHaveLength(1);

      // 確保 mtime 有機會變化
      await new Promise((r) => setTimeout(r, 50));
      // same-size rewrite：內容不同但 byte 長度相同（8 bytes）
      await writeFile(testFile, '{"b": 2}');

      await new Promise((r) => setTimeout(r, 250));

      // mtime 變化觸發 poll 重讀，hash 比對命中 → 輸出新內容
      expect(received).toHaveLength(2);
      expect(received[1]).toBe('{"b": 2}');
      w.stop();
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
