// Phase 2 stub — intentionally returns null/empty so RED tests fail on assertions.
import type { SessionFinder } from '../agent.interface.ts';
import type {
  ProjectInfo,
  SessionFile,
  SessionListItem,
} from '../../core/types.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class WorkflowSessionFinder implements SessionFinder {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.claude', 'projects');
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async findLatest(_options: {
    project?: string;
  }): Promise<SessionFile | null> {
    return null;
  }

  async findBySessionId(
    _sessionId: string,
    _options: { project?: string }
  ): Promise<SessionFile | null> {
    return null;
  }

  async getProjectInfo(_sessionPath: string): Promise<ProjectInfo | null> {
    return null;
  }

  async findLatestInProject(_projectDir: string): Promise<SessionFile | null> {
    return null;
  }

  async listSessions(_options: {
    project?: string;
    limit?: number;
  }): Promise<SessionListItem[]> {
    return [];
  }
}
