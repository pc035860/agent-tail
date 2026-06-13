import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  readLastTimestampFromJSONL,
  readLastTimestampFromGeminiJSON,
  readCwdFromHead,
  readFirstUserPromptFromHead,
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

describe('readCwdFromHead', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cwd-head-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test('reads cwd from first line', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'progress',
        cwd: '/Users/test/code/my-project',
        timestamp: '2026-01-01T00:00:00Z',
      })
    );

    const result = await readCwdFromHead(filePath);
    expect(result).toBe('/Users/test/code/my-project');
  });

  test('reads cwd from second line when first has no cwd', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'start' }),
      JSON.stringify({
        type: 'progress',
        cwd: '/Users/test/git/merp-frontend',
      }),
    ];
    await writeFile(filePath, lines.join('\n'));

    const result = await readCwdFromHead(filePath);
    expect(result).toBe('/Users/test/git/merp-frontend');
  });

  test('replaces homedir with ~', async () => {
    const { homedir } = await import('node:os');
    const home = homedir();
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({ type: 'progress', cwd: `${home}/code/test-proj` })
    );

    const result = await readCwdFromHead(filePath);
    expect(result).toBe('~/code/test-proj');
  });

  test('returns null for file with no cwd', async () => {
    const filePath = join(tempDir, 'no-cwd.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({ type: 'user', message: 'hello' })
    );

    const result = await readCwdFromHead(filePath);
    expect(result).toBeNull();
  });

  test('returns null for empty file', async () => {
    const filePath = join(tempDir, 'empty.jsonl');
    await writeFile(filePath, '');

    const result = await readCwdFromHead(filePath);
    expect(result).toBeNull();
  });
});

describe('readFirstUserPromptFromHead', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fup-'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  const makeUserLine = (
    content: unknown,
    extra: Record<string, unknown> = {}
  ) => JSON.stringify({ type: 'user', message: { content }, ...extra });

  test('returns plain text user prompt from string content', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(filePath, makeUserLine('Help me refactor the auth module'));
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('Help me refactor the auth module');
  });

  test('returns plain text from content array (first text part)', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      makeUserLine([
        { type: 'text', text: 'hihi from list content' },
        { type: 'tool_result', tool_use_id: 'x' },
      ])
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('hihi from list content');
  });

  test('scheduled-task → [cron] name (pure-ASCII marker)', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      makeUserLine(
        '<scheduled-task name="samtsan-daily-marketplace" file="/x/y">extra</scheduled-task>'
      )
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('[cron] samtsan-daily-marketplace');
  });

  test('command with args → "/cmd args"', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      makeUserLine(
        '<command-message>eshop-deploy</command-message> <command-name>/eshop-deploy</command-name> <command-args>ec-frontend, stag+prod, v1.97.0</command-args>'
      )
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('/eshop-deploy ec-frontend, stag+prod, v1.97.0');
  });

  test('command without args → just "/cmd"', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      makeUserLine('<command-name>/next</command-name>')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('/next');
  });

  test('skips Caveat: line, falls through to next user', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      [
        makeUserLine('Caveat: The messages below were generated by ...'),
        makeUserLine('actual user question here'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('actual user question here');
  });

  test('skips isMeta lines', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      [
        makeUserLine('meta noise', { isMeta: true }),
        makeUserLine('first real prompt'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('first real prompt');
  });

  test('skips non-user types', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'assistant', message: { content: 'asst' } }),
        makeUserLine('real prompt after assistant'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('real prompt after assistant');
  });

  test('truncates long prompts with ellipsis', async () => {
    const filePath = join(tempDir, 's.jsonl');
    const long = 'x'.repeat(200);
    await writeFile(filePath, makeUserLine(long));
    const result = await readFirstUserPromptFromHead(filePath, 40);
    expect(result?.length).toBe(40);
    expect(result?.endsWith('…')).toBe(true);
  });

  test('collapses internal whitespace and newlines', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(filePath, makeUserLine('line1\n\n\nline2   line3'));
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('line1 line2 line3');
  });

  test('returns null for empty file', async () => {
    const filePath = join(tempDir, 'fup-empty.jsonl');
    await writeFile(filePath, '');
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBeNull();
  });

  test('returns null when no user line exists', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({ type: 'assistant', message: { content: 'only asst' } })
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBeNull();
  });

  // Regression: previous chunk-guard logic broke out of the loop before
  // reading the 64KB chunk for ~20KB files, returning null even though the
  // prompt was within the file. Verified by codex review.
  test('finds prompt that lives past the 16KB head chunk', async () => {
    const filePath = join(tempDir, 's.jsonl');
    const padding = 'x'.repeat(18000); // pushes the real user past 16KB
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'assistant', message: { content: 'x' } }),
        padding,
        makeUserLine('prompt living after 16KB'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('prompt living after 16KB');
  });

  // Regression: generic XML strip turned <system-reminder>foo</system-reminder>
  // into 'foo' and exposed internal reminder content as the title.
  test('skips <system-reminder> wrapper, falls through to next user line', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      [
        makeUserLine(
          '<system-reminder>Do not mention this internal reminder.</system-reminder>'
        ),
        makeUserLine('the real user question'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('the real user question');
  });

  test('skips other internal wrapper tags (bash-stdout, command-stdout, etc.)', async () => {
    const filePath = join(tempDir, 's.jsonl');
    await writeFile(
      filePath,
      [
        makeUserLine('<bash-stdout>some shell output</bash-stdout>'),
        makeUserLine(
          '<local-command-stdout>more output</local-command-stdout>'
        ),
        makeUserLine('real prompt'),
      ].join('\n')
    );
    const result = await readFirstUserPromptFromHead(filePath);
    expect(result).toBe('real prompt');
  });
});
