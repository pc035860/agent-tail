import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  readLastTimestampFromJSONL,
  readLastTimestampFromGeminiJSON,
} from '../../src/utils/session-time';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('readLastTimestampFromJSONL', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-time-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test('reads timestamp from last line', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'user', timestamp: '2026-01-01T10:00:00Z' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T12:30:00Z',
        }),
      ].join('\n')
    );

    const result = await readLastTimestampFromJSONL(filePath);

    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-01-01T12:30:00.000Z');
  });

  test('skips lines without timestamp (e.g., custom-title)', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T12:00:00Z',
        }),
        JSON.stringify({ type: 'custom-title', customTitle: 'My Title' }),
      ].join('\n')
    );

    const result = await readLastTimestampFromJSONL(filePath);

    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  test('returns null for empty file', async () => {
    const filePath = join(tempDir, 'empty.jsonl');
    await writeFile(filePath, '');

    const result = await readLastTimestampFromJSONL(filePath);
    expect(result).toBeNull();
  });

  test('returns null for file with no timestamps', async () => {
    const filePath = join(tempDir, 'no-ts.jsonl');
    await writeFile(filePath, JSON.stringify({ type: 'meta', data: 'test' }));

    const result = await readLastTimestampFromJSONL(filePath);
    expect(result).toBeNull();
  });

  test('returns null for non-existent file', async () => {
    const result = await readLastTimestampFromJSONL(
      join(tempDir, 'nope.jsonl')
    );
    expect(result).toBeNull();
  });
});

describe('readLastTimestampFromGeminiJSON', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-time-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test('reads timestamp from last message', async () => {
    const filePath = join(tempDir, 'session.json');
    await writeFile(
      filePath,
      JSON.stringify({
        messages: [
          { role: 'user', timestamp: '2026-01-01T10:00:00Z' },
          { role: 'model', timestamp: '2026-01-01T12:00:00Z' },
        ],
      })
    );

    const result = await readLastTimestampFromGeminiJSON(filePath);

    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  test('returns null for empty messages array', async () => {
    const filePath = join(tempDir, 'empty.json');
    await writeFile(filePath, JSON.stringify({ messages: [] }));

    const result = await readLastTimestampFromGeminiJSON(filePath);
    expect(result).toBeNull();
  });

  test('returns null for non-existent file', async () => {
    const result = await readLastTimestampFromGeminiJSON(
      join(tempDir, 'nope.json')
    );
    expect(result).toBeNull();
  });
});
