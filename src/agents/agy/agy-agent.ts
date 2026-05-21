import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import type { Agent, LineParser, SessionFinder } from '../agent.interface.ts';
import type {
  ParsedLine,
  ParserOptions,
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import { formatMultiline } from '../../utils/text.ts';

export class AgySessionFinder implements SessionFinder {
  private baseDir: string;
  private historyPath: string;
  private cachePath: string;

  constructor() {
    this.baseDir = join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'conversations'
    );
    this.historyPath = join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'history.jsonl'
    );
    this.cachePath = join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'cache',
      'last_conversations.json'
    );
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * 載入 history.jsonl 與 last_conversations.json 以建立 conversationId -> workspace 的映射
   */
  private async loadWorkspaceMappings(): Promise<Map<string, string>> {
    const idToWorkspace = new Map<string, string>();
    try {
      const historyFile = Bun.file(this.historyPath);
      if (await historyFile.exists()) {
        const historyText = await historyFile.text();
        for (const line of historyText.trim().split('\n')) {
          if (!line) continue;
          try {
            const data = JSON.parse(line);
            if (data.conversationId && data.workspace) {
              idToWorkspace.set(data.conversationId, data.workspace);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      const cacheFile = Bun.file(this.cachePath);
      if (await cacheFile.exists()) {
        const cacheText = await cacheFile.text();
        const cacheData = JSON.parse(cacheText);
        for (const [workspace, id] of Object.entries(cacheData)) {
          if (typeof id === 'string') {
            idToWorkspace.set(id, workspace);
          }
        }
      }
    } catch {
      // ignore
    }

    return idToWorkspace;
  }

  // 掃描 conversations/*.pb，並藉由 history.jsonl 反查 project
  private async _collectSessions(options: {
    project?: string;
  }): Promise<SessionListItem[]> {
    const glob = new Glob('*.pb');
    const files: SessionListItem[] = [];

    const idToWorkspace = await this.loadWorkspaceMappings();

    try {
      for await (const file of glob.scan({
        cwd: this.baseDir,
        absolute: true,
      })) {
        const filename = file.split('/').pop() || '';
        const uuid = filename.replace('.pb', '');
        const workspace = idToWorkspace.get(uuid);
        const project = workspace ? basename(workspace) : undefined;

        if (options.project) {
          const pattern = options.project.toLowerCase();
          const matchProject = project?.toLowerCase().includes(pattern);
          const matchUuid = uuid.toLowerCase().includes(pattern);
          if (!matchProject && !matchUuid) {
            continue;
          }
        }

        try {
          const stats = await stat(file);
          files.push({
            path: file,
            mtime: stats.mtime,
            agentType: 'agy',
            shortId: uuid.slice(0, 8),
            project: project || 'unknown',
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    if (files.length === 0) return null;
    return {
      path: files[0]!.path,
      mtime: files[0]!.mtime,
      agentType: 'agy',
    };
  }

  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    const files = await this._collectSessions(options);
    return files.slice(0, options.limit ?? 20);
  }

  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const files = await this._collectSessions(options);
    const search = sessionId.toLowerCase();

    const found = files.find(
      (f) =>
        f.shortId.toLowerCase() === search ||
        f.path.toLowerCase().includes(search)
    );
    if (!found) return null;
    return {
      path: found.path,
      mtime: found.mtime,
      agentType: 'agy',
    };
  }

  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const uuid = basename(sessionPath).replace('.pb', '');
    const idToWorkspace = await this.loadWorkspaceMappings();
    const workspace = idToWorkspace.get(uuid);
    if (workspace) {
      return { projectDir: workspace, displayName: basename(workspace) };
    }
    return null;
  }

  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    const files = await this._collectSessions({});
    const idToWorkspace = await this.loadWorkspaceMappings();
    // 找出 workspace 吻合的最新的會話（防止多個同名 workspace 誤判）
    const found = files.find((f) => {
      const uuid = basename(f.path).replace('.pb', '');
      return idToWorkspace.get(uuid) === projectDir;
    });
    if (!found) return null;
    return {
      path: found.path,
      mtime: found.mtime,
      agentType: 'agy',
    };
  }
}

export class AgyLineParser implements LineParser {
  private processedTimestamps = new Set<number>();
  private conversationId: string = '';
  private historyPath: string;
  private pendingLines: ParsedLine[] = [];
  private verbose: boolean;

  constructor(options: ParserOptions = { verbose: false }) {
    this.historyPath = join(
      homedir(),
      '.gemini',
      'antigravity-cli',
      'history.jsonl'
    );
    this.verbose = options.verbose;
  }

  setConversationId(id: string) {
    this.conversationId = id;
  }

  parse(line: string): ParsedLine | null {
    if (this.pendingLines.length === 0) {
      if (!this.conversationId && line) {
        // 如果還沒有 conversationId，且被監控檔案的路徑/名稱就是 .pb
      }

      if (this.conversationId) {
        try {
          const content = readFileSync(this.historyPath, 'utf-8');
          for (const rawLine of content.trim().split('\n')) {
            if (!rawLine) continue;
            try {
              const data = JSON.parse(rawLine);
              if (data.conversationId === this.conversationId && data.display) {
                const timestamp = data.timestamp || Date.now();
                if (!this.processedTimestamps.has(timestamp)) {
                  this.processedTimestamps.add(timestamp);
                  this.pendingLines.push({
                    type: 'user',
                    timestamp: new Date(timestamp).toISOString(),
                    raw: data,
                    formatted: formatMultiline(data.display),
                  });
                }
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return this.pendingLines.shift() || null;
  }
}

export class AgyAgent implements Agent {
  readonly type = 'agy' as const;
  readonly finder: AgySessionFinder;
  readonly parser: AgyLineParser;

  constructor(options: ParserOptions = { verbose: false }) {
    this.finder = new AgySessionFinder();
    this.parser = new AgyLineParser(options);
  }
}
