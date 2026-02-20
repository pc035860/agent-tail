import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeminiAgent } from '../../src/agents/gemini/gemini-agent.ts';

describe('GeminiSessionFinder - super follow', () => {
  let tempDir: string;
  let geminiTmpDir: string;
  let finder: InstanceType<typeof GeminiAgent>['finder'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-sf-'));
    geminiTmpDir = join(tempDir, 'gemini', 'tmp');
    await mkdir(geminiTmpDir, { recursive: true });

    const agent = new GeminiAgent({ verbose: false });
    finder = agent.finder;

    // 覆蓋 baseDir 為臨時目錄
    (finder as unknown as { baseDir: string }).baseDir = geminiTmpDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getProjectInfo', () => {
    test('reads .project_root file', async () => {
      // 建立專案目錄結構
      const projectDir = join(geminiTmpDir, 'myproject');
      const chatsDir = join(projectDir, 'chats');
      await mkdir(chatsDir, { recursive: true });

      // 建立 .project_root 檔案
      await writeFile(join(projectDir, '.project_root'), '/path/to/project');

      // 建立 session 檔案
      const sessionPath = join(
        chatsDir,
        'session-2026-02-20T10-00-abc12345.json'
      );
      await writeFile(sessionPath, '{"sessionId": "test"}');

      const info = await finder.getProjectInfo!(sessionPath);

      expect(info).not.toBeNull();
      expect(info!.projectDir).toBe(projectDir);
      expect(info!.displayName).toBe('/path/to/project');
    });

    test('falls back to directory name when .project_root missing', async () => {
      // 建立專案目錄結構（無 .project_root）
      const projectDir = join(geminiTmpDir, 'hashdir123');
      const chatsDir = join(projectDir, 'chats');
      await mkdir(chatsDir, { recursive: true });

      // 建立 session 檔案
      const sessionPath = join(
        chatsDir,
        'session-2026-02-20T10-00-abc12345.json'
      );
      await writeFile(sessionPath, '{"sessionId": "test"}');

      const info = await finder.getProjectInfo!(sessionPath);

      expect(info).not.toBeNull();
      expect(info!.projectDir).toBe(projectDir);
      expect(info!.displayName).toBe('hashdir123');
    });
  });

  describe('findLatestInProject', () => {
    test('returns session with max mtime', async () => {
      const projectDir = join(geminiTmpDir, 'testproj');
      const chatsDir = join(projectDir, 'chats');
      await mkdir(chatsDir, { recursive: true });

      // 建立多個 session 檔案
      const oldSession = join(
        chatsDir,
        'session-2026-02-19T10-00-old11111.json'
      );
      const newSession = join(
        chatsDir,
        'session-2026-02-20T10-00-new22222.json'
      );

      await writeFile(oldSession, '{"sessionId": "old"}');
      await writeFile(newSession, '{"sessionId": "new"}');

      // 設定不同的 mtime
      await utimes(oldSession, new Date(1000), new Date(1000));
      await utimes(newSession, new Date(2000), new Date(2000));

      const result = await finder.findLatestInProject!(projectDir);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(newSession);
      expect(result!.agentType).toBe('gemini');
    });

    test('returns null when no sessions found', async () => {
      const projectDir = join(geminiTmpDir, 'emptyproj');
      await mkdir(projectDir, { recursive: true });

      const result = await finder.findLatestInProject!(projectDir);

      expect(result).toBeNull();
    });

    test('returns null when chats directory does not exist', async () => {
      const projectDir = join(geminiTmpDir, 'nochatsproj');
      await mkdir(projectDir, { recursive: true });

      const result = await finder.findLatestInProject!(projectDir);

      expect(result).toBeNull();
    });

    test('ignores non-session files', async () => {
      const projectDir = join(geminiTmpDir, 'mixedfiles');
      const chatsDir = join(projectDir, 'chats');
      await mkdir(chatsDir, { recursive: true });

      // 建立 session 和非 session 檔案
      const sessionFile = join(
        chatsDir,
        'session-2026-02-20T10-00-abc12345.json'
      );
      const otherFile = join(chatsDir, 'other-data.json');

      await writeFile(sessionFile, '{"sessionId": "test"}');
      await writeFile(otherFile, '{"data": "other"}');

      await utimes(sessionFile, new Date(2000), new Date(2000));
      await utimes(otherFile, new Date(3000), new Date(3000));

      const result = await finder.findLatestInProject!(projectDir);

      expect(result).not.toBeNull();
      expect(result!.path).toBe(sessionFile);
    });
  });
});
