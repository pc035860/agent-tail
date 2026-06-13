import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import type { SessionFinder } from '../agent.interface.ts';
import type {
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import { parseWorkflowSnapshotFilename } from '../../claude-workflow/paths.ts';
import { readCwdFromHead } from '../../utils/session-time.ts';

// SPEC §7 — WorkflowSessionFinder is the first-class SessionFinder for
// workflow runs (wf_*.json snapshots). Composable inside ClaudeSessionFinder
// via constructor-injected baseDir; tests pass tempDir to isolate fixtures.

interface InternalWorkflow {
  file: SessionFile;
  runId: string;
  sessionUuid: string;
  status?: 'running' | 'completed' | 'failed';
  workflowName?: string;
  encodedProjectDir: string;
}

export class WorkflowSessionFinder implements SessionFinder {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.claude', 'projects');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(options: { project?: string }): Promise<SessionFile | null> {
    const workflows = await this._collectWorkflows(options);
    return workflows[0]?.file ?? null;
  }

  /**
   * Workflow IDs never pair with a subagent, so this finder's return type
   * is narrower than `SessionFinder.findBySessionId`. Do not widen.
   */
  async findBySessionId(
    sessionId: string,
    options: { project?: string }
  ): Promise<SessionFile | null> {
    const all = await this._collectWorkflows(options);
    if (all.length === 0) return null;

    const term = sessionId.toLowerCase();
    type Candidate = InternalWorkflow & { priority: number };
    const matches: Candidate[] = [];
    for (const w of all) {
      const runIdLower = w.runId.toLowerCase();
      let priority = 0;
      if (runIdLower === term) priority = 3;
      else if (runIdLower.startsWith(term)) priority = 2;
      else if (runIdLower.includes(term)) priority = 1;
      if (priority === 0) continue;
      matches.push({ ...w, priority });
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.file.mtime.getTime() - a.file.mtime.getTime();
    });
    return matches[0]!.file;
  }

  /**
   * Returns absolute path to the encoded project dir (mirrors
   * `dirname(sessionFile.path)` semantics used elsewhere) plus a decoded
   * cwd display name read from the sibling main session JSONL head.
   */
  async getProjectInfo(sessionPath: string): Promise<ProjectInfo | null> {
    const parsed = this._parseSnapshotPath(sessionPath);
    if (!parsed) return null;

    const mainSessionPath = join(
      parsed.projectDirAbs,
      `${parsed.sessionUuid}.jsonl`
    );
    const cwd = await readCwdFromHead(mainSessionPath);

    return {
      projectDir: parsed.projectDirAbs,
      ...(cwd ? { displayName: cwd } : {}),
    };
  }

  async findLatestInProject(projectDir: string): Promise<SessionFile | null> {
    return this.findLatest({ project: projectDir });
  }

  async listSessions(options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    const all = await this._collectWorkflows(options);
    const limit = options.limit ?? 20;
    return all.slice(0, limit).map<SessionListItem>((w) => {
      // workflow name 是從 snapshot 推導出的 derived label，不是使用者 /rename
      // 設定的權威名稱 → 用 autoTitle 讓 formatTitleColumn 渲染 dim('› TEXT')，
      // 與真實 customTitle 的 plain 顯示視覺區分（CLAUDE.md autoTitle/customTitle 視覺契約）。
      // ID 列已有 wf_<runId>，去掉 'wf:' prefix 避免重複。
      // 注意：_collectWorkflows 內部仍把 'wf:<name>' 塞進 file.customTitle，
      // src/index.ts:382 的 isWorkflowMode 判斷依賴此契約，不要動。listSessions
      // 在這層把 customTitle 拆掉、改塞 autoTitle，只影響 --list 輸出。
      const { customTitle: _stripWfPrefix, ...fileWithoutCustom } = w.file;
      return {
        ...fileWithoutCustom,
        shortId: w.runId,
        project: w.encodedProjectDir,
        logType: 'workflow',
        workflowRunId: w.runId,
        workflowSessionUuid: w.sessionUuid,
        ...(w.workflowName ? { autoTitle: w.workflowName } : {}),
        ...(w.status ? { workflowStatus: w.status } : {}),
      };
    });
  }

  // --- internals ---

  private async _collectWorkflows(options: {
    project?: string;
  }): Promise<InternalWorkflow[]> {
    const glob = new Glob('**/workflows/wf_*.json');
    const workflows: InternalWorkflow[] = [];

    for await (const file of glob.scan({
      cwd: this.baseDir,
      absolute: true,
    })) {
      const filename = file.split('/').pop() ?? '';
      const runId = parseWorkflowSnapshotFilename(filename);
      if (!runId) continue;

      if (options.project) {
        const needle = options.project.toLowerCase();
        if (!file.toLowerCase().includes(needle)) continue;
      }

      const parsed = this._parseSnapshotPath(file);
      if (!parsed) continue;

      let stats;
      try {
        stats = await stat(file);
      } catch {
        continue;
      }

      let workflowName: string | undefined;
      let status: InternalWorkflow['status'];
      try {
        const text = await Bun.file(file).text();
        const snap = JSON.parse(text) as {
          workflowName?: string;
          status?: 'running' | 'completed' | 'failed';
        };
        if (typeof snap.workflowName === 'string') {
          workflowName = snap.workflowName;
        }
        if (
          snap.status === 'running' ||
          snap.status === 'completed' ||
          snap.status === 'failed'
        ) {
          status = snap.status;
        }
      } catch {
        // Snapshot read/parse failure — degrade gracefully (entry still
        // listed with runId-derived fallback customTitle).
      }

      const title = workflowName ?? runId;
      workflows.push({
        file: {
          path: file,
          mtime: stats.mtime,
          agentType: 'claude',
          customTitle: `wf:${title}`,
        },
        runId,
        sessionUuid: parsed.sessionUuid,
        ...(status ? { status } : {}),
        ...(workflowName ? { workflowName } : {}),
        encodedProjectDir: parsed.encodedDir,
      });
    }

    workflows.sort((a, b) => b.file.mtime.getTime() - a.file.mtime.getTime());
    return workflows;
  }

  /**
   * Derive encoded project dir + sessionUuid from a snapshot path that
   * lives under `this.baseDir`. Returns null if the path isn't under
   * baseDir or doesn't fit the `{enc-cwd}/{UUID}/workflows/wf_*.json` shape.
   */
  private _parseSnapshotPath(snapshotPath: string): {
    encodedDir: string;
    sessionUuid: string;
    projectDirAbs: string;
  } | null {
    const baseDirSlash = this.baseDir.endsWith('/')
      ? this.baseDir
      : `${this.baseDir}/`;
    if (!snapshotPath.startsWith(baseDirSlash)) return null;

    const rel = snapshotPath.slice(baseDirSlash.length).split('/');
    // expected: [encodedDir, sessionUuid, 'workflows', 'wf_*.json']
    if (rel.length < 4) return null;
    if (rel[2] !== 'workflows') return null;

    const encodedDir = rel[0]!;
    const sessionUuid = rel[1]!;
    return {
      encodedDir,
      sessionUuid,
      projectDirAbs: join(this.baseDir, encodedDir),
    };
  }
}
