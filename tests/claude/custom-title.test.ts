import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCustomTitle } from '../../src/claude/custom-title';

describe('readCustomTitle', () => {
  test('returns null for file with no custom-title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(
        file,
        [
          '{"type":"user","message":"hello"}',
          '{"type":"assistant","message":"hi"}',
        ].join('\n')
      );
      expect(await readCustomTitle(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns customTitle from single entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(
        file,
        [
          '{"type":"user","message":"hello"}',
          '{"type":"custom-title","customTitle":"my session","sessionId":"abc"}',
          '{"type":"assistant","message":"hi"}',
        ].join('\n')
      );
      expect(await readCustomTitle(file)).toBe('my session');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns last customTitle when multiple entries exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(
        file,
        [
          '{"type":"custom-title","customTitle":"first name","sessionId":"abc"}',
          '{"type":"user","message":"hello"}',
          '{"type":"custom-title","customTitle":"second name","sessionId":"abc"}',
          '{"type":"assistant","message":"hi"}',
          '{"type":"custom-title","customTitle":"final name","sessionId":"abc"}',
        ].join('\n')
      );
      expect(await readCustomTitle(file)).toBe('final name');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns null for empty customTitle string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(
        file,
        '{"type":"custom-title","customTitle":"","sessionId":"abc"}'
      );
      expect(await readCustomTitle(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns null for empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(file, '');
      expect(await readCustomTitle(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns null for non-existent file', async () => {
    expect(await readCustomTitle('/tmp/nonexistent-file.jsonl')).toBeNull();
  });

  test('skips invalid JSON lines gracefully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-tail-'));
    try {
      const file = join(dir, 'session.jsonl');
      await writeFile(
        file,
        [
          '{"type":"custom-title","customTitle":"valid title","sessionId":"abc"}',
          'this is not json',
          '{broken json',
        ].join('\n')
      );
      expect(await readCustomTitle(file)).toBe('valid title');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
