import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/core/file-watcher.ts';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
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

    test('pending read during initial onLine is drained (regression)', async () => {
      // codex review 發現的 race：scheduleRead 的 pending drain 用遞迴 —
      // isProcessing 仍為 true，遞迴被自己的 guard 擋回，read 期間
      // append 的尾行永久遺失。
      // 此測試同步 append + 手動觸發 scheduleRead（被 guard 擋成 pending），
      // 確定性重現 pending drain 場景。
      const testFile = join(tempDir, 'pending-drain.jsonl');
      await writeFile(testFile, '{"line": 1}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        // poll interval 遠大於測試時間：start() 返回後立即斷言，
        // polling 不可能有機會補救壞掉的 drain
        pollInterval: 60000,
        onLine: (line) => {
          received.push(line);
          if (received.length === 1) {
            appendFileSync(testFile, '{"line": 2}\n');
            // 模擬 fs.watch 事件在 read 進行中到達 → pendingRead
            void watcher['scheduleRead']();
          }
        },
      });

      // start() 返回時 pending 必須已被消化（不等 polling —
      // 否則 poll 會掩蓋 drain bug，regression 偶發通過）
      expect(received).toHaveLength(2);
      expect(received[1]).toBe('{"line": 2}');
    });

    test('append right after initial read is picked up by polling (baseline race regression)', async () => {
      // codex review 發現的 race：start() 若在初始讀取後才 updateMtime，
      // 空窗期的 append 會被 baseline 吞掉（lastReadOffset 停在舊位置，
      // lastSize 卻已含新資料），poll 誤判「沒有變化」而永遠不讀。
      // 修復後：baseline 先行 + size 對齊已處理內容（alignSizeBaseline），
      // append 後 size 偏離 baseline，poll 會觸發補讀。
      // 不手動觸發 scheduleRead — 純靠 polling 補讀，確定性鎖 baseline 修復。
      const testFile = join(tempDir, 'baseline-gap.jsonl');
      await writeFile(testFile, '{"line": 1}\n');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 30,
        onLine: (line) => {
          received.push(line);
          if (received.length === 1) {
            appendFileSync(testFile, '{"line": 2}\n');
          }
        },
      });

      // size baseline 必須對齊「已處理內容」而非 stat 瞬間值 —
      // 在 poll 補讀之前檢查（poll 會把 lastReadOffset 推進到與 lastSize
      // 相等，掩蓋吞 append 的 bug）
      expect(watcher['lastSize']).toBe(watcher['lastReadOffset']);

      // 等 polling 觸發補讀
      await new Promise((r) => setTimeout(r, 150));

      // 兩行都要出來（baseline 吞 append 時會永久遺失 line 2）
      expect(received).toHaveLength(2);
      expect(received[1]).toBe('{"line": 2}');
    });

    test('empty JSONL: first line written after start is picked up by polling', async () => {
      // codex review 發現的邊界：lastReadOffset > 0 條件使空 JSONL
      // 不會對齊成零 — 初始快照後寫入第一行時，post-read stat 把新
      // size 納入 baseline，poll 誤判「沒有變化」而零輸出。
      const testFile = join(tempDir, 'empty.jsonl');
      await writeFile(testFile, '');

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 30,
        onLine: (line) => received.push(line),
      });

      expect(received).toHaveLength(0);
      // 空 JSONL 的 size baseline 必須對齊 0（lastReadOffset = 0）
      expect(watcher['lastSize']).toBe(0);
      expect(watcher['lastReadOffset']).toBe(0);

      // 寫入第一行 → poll 必須補讀
      await appendFile(testFile, '{"line": 1}\n');
      await new Promise((r) => setTimeout(r, 150));

      expect(received).toHaveLength(1);
      expect(received[0]).toBe('{"line": 1}');
    });

    test('jsonMode: size-changing rewrite during initial read is picked up by polling', async () => {
      // Gemini/Agy 語義：整檔讀 + hash 比對。初始讀取期間的 rewrite
      // 不能被 baseline 吞掉（size baseline 對齊已讀內容長度）。
      const testFile = join(tempDir, 'session.json');
      await writeFile(testFile, JSON.stringify({ messages: ['a'] }));

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 30,
        jsonMode: true,
        onLine: (content) => {
          received.push(content);
          if (received.length === 1) {
            // 同步 rewrite（更長的有效 JSON）— 落在「content 已讀完、
            // baseline 未更新」的空窗（onLine 回呼正是這個位置）
            writeFileSync(
              testFile,
              JSON.stringify({ messages: ['a', 'b', 'c'] })
            );
          }
        },
      });

      // size baseline 必須對齊「已讀內容長度」而非 stat 瞬間值 —
      // 在 poll 補讀之前檢查（poll 會推進狀態，掩蓋吞 rewrite 的 bug）
      expect(watcher['lastSize']).toBe(watcher['lastContentLength']);

      // 等 polling 觸發重讀
      await new Promise((r) => setTimeout(r, 150));

      // 新內容必須被輸出（baseline 吞 rewrite 時會永久遺失）
      expect(received).toHaveLength(2);
      expect(received[1]).toContain('"b"');
    });

    test('jsonMode: same-size rewrite is detected via mtime baseline', async () => {
      // 同長度 rewrite：size baseline 對齊後不變，但 mtime baseline
      // 是「讀取開始前」的值 — rewrite 的 mtime 偏離 baseline，
      // poll 能正確觸發重讀（hash 比對命中新內容）
      const testFile = join(tempDir, 'same-size.json');
      await writeFile(testFile, JSON.stringify({ v: 1 }));

      const received: string[] = [];

      await watcher.start(testFile, {
        follow: true,
        pollInterval: 30,
        jsonMode: true,
        onLine: (content) => {
          received.push(content);
          if (received.length === 1) {
            // 同長度 rewrite 落在 onLine 回呼（content 已讀完、
            // baseline 未更新）— 只能靠 mtime baseline 偵測
            writeFileSync(testFile, JSON.stringify({ v: 2 }));
          }
        },
      });

      await new Promise((r) => setTimeout(r, 150));

      expect(received).toHaveLength(2);
      expect(received[1]).toContain('"v":2');
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
