import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Glob } from 'bun';
import { FileWatcher } from '../core/file-watcher.ts';
import type {
  OutputHandler,
  SessionHandler,
} from '../core/detector-interfaces.ts';
import type { Formatter } from '../formatters/formatter.interface.ts';
import { ClaudeAgent } from '../agents/claude/claude-agent.ts';
import type { LineParser } from '../agents/agent.interface.ts';
import { drainParser } from '../utils/parser-drain.ts';
import { JournalLineParser } from './journal-parser.ts';
import { parseWorkflowAgentFilename, isValidWorkflowAgentId } from './paths.ts';
import type { DetectedWorkflow, WorkflowSnapshot } from './types.ts';

// SPEC §10.2 — WorkflowAttachment manages the lifecycle of a single
// workflow run's watchers (journal + agent transcripts + subagent dir).

const TRANSCRIPT_DIR_RETRIES = 10;
const TRANSCRIPT_DIR_INTERVAL_MS = 100;

export interface WorkflowAttachmentConfig {
  workflow: DetectedWorkflow;
  withAgents: boolean;
  verbose: boolean;
  follow: boolean;
  pollInterval?: number;
  initialLines?: number;
  formatter: Formatter;
  /** Per-line output. label is `[wf:{runId}:journal]` or `[wf:{shortAgentId}]`. */
  onOutput: (formatted: string, label: string) => void;
  outputHandler: OutputHandler;
  sessionHandler?: SessionHandler;
}

export function makeWorkflowJournalLabel(runId: string): string {
  return `[wf:${runId}:journal]`;
}

export function makeWorkflowAgentLabel(agentId: string): string {
  return `[wf:${agentId.slice(0, 7)}]`;
}

export class WorkflowAttachment {
  private journalWatcher: FileWatcher | null = null;
  private journalParser: JournalLineParser | null = null;
  private readonly agentWatchers = new Map<string, FileWatcher>();
  private readonly agentParsers = new Map<string, LineParser>();
  private subagentDirWatcher: FSWatcher | null = null;
  private readonly knownAgentIds = new Set<string>();
  private stopped = false;

  constructor(private readonly config: WorkflowAttachmentConfig) {}

  /** P4 stub — returns null. Real impl reads currentSnapshot field. */
  getCurrentSnapshot(): WorkflowSnapshot | null {
    return null;
  }

  async start(): Promise<void> {
    await this._waitForTranscriptDir();

    // Step 1 — journal
    await this._startJournalAndFlushHistory();

    // Step 2/3 — workflow agents (initial scan + directory watch)
    if (this.config.withAgents) {
      await this._scanAndAttachInitialAgents();
      this._startSubagentDirWatch();
    }

    // Step 4 — snapshot watcher: P4 scope (not wired here)
  }

  async attachAgent(agentId: string, transcriptPath: string): Promise<void> {
    if (this.knownAgentIds.has(agentId)) return;
    this.knownAgentIds.add(agentId);

    let succeeded = false;
    try {
      const parser = new ClaudeAgent({ verbose: this.config.verbose }).parser;
      this.agentParsers.set(agentId, parser);

      const watcher = new FileWatcher();
      const label = makeWorkflowAgentLabel(agentId);
      await watcher.start(transcriptPath, {
        follow: this.config.follow,
        pollInterval: this.config.pollInterval,
        initialLines: this.config.initialLines,
        onLine: (line) => this._handleAgentLine(agentId, line, label),
        onError: (err) =>
          this.config.outputHandler.debug(
            `[wf:${this.config.workflow.runId}] agent ${agentId.slice(0, 7)} read error: ${err}`
          ),
      });
      this.agentWatchers.set(agentId, watcher);

      this.config.sessionHandler?.addSession?.(agentId, label, transcriptPath);
      this.config.sessionHandler?.updateUI?.();
      succeeded = true;
    } finally {
      if (!succeeded) {
        this.knownAgentIds.delete(agentId);
        this.agentParsers.delete(agentId);
        this.agentWatchers.delete(agentId);
        this.config.outputHandler.debug(
          `[wf:${this.config.workflow.runId}] attachAgent ${agentId.slice(0, 7)} failed; rolled back`
        );
      }
    }
  }

  async stop(
    reason: 'completed' | 'directory-removed' | 'user'
  ): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.subagentDirWatcher?.close();
    this.subagentDirWatcher = null;

    this.journalWatcher?.stop();
    this.journalWatcher = null;

    for (const w of this.agentWatchers.values()) {
      w.stop();
    }
    this.agentWatchers.clear();

    for (const agentId of this.knownAgentIds) {
      this.config.sessionHandler?.markSessionDone?.(agentId);
    }
    this.config.sessionHandler?.markSessionDone?.(
      `wf:${this.config.workflow.runId}`
    );

    this.config.outputHandler.info(
      `[wf:${this.config.workflow.runId}] stopped (${reason})`
    );
  }

  // --- internals ---

  /**
   * Wait for transcriptDir to exist. Uses stat() because
   * Bun.file(dir).exists() returns false for directories.
   */
  private async _waitForTranscriptDir(): Promise<void> {
    for (let i = 0; i < TRANSCRIPT_DIR_RETRIES; i++) {
      if (this.stopped) return;
      try {
        await stat(this.config.workflow.transcriptDir);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, TRANSCRIPT_DIR_INTERVAL_MS));
      }
    }
  }

  private async _startJournalAndFlushHistory(): Promise<void> {
    const journalPath = join(
      this.config.workflow.transcriptDir,
      'journal.jsonl'
    );

    let fileMtime: Date | undefined;
    try {
      fileMtime = (await stat(journalPath)).mtime;
    } catch {
      /* journal may not exist yet */
    }

    this.journalParser = new JournalLineParser({ fileMtime });
    const label = makeWorkflowJournalLabel(this.config.workflow.runId);

    const watcher = new FileWatcher();
    this.journalWatcher = watcher;
    await watcher.start(journalPath, {
      follow: this.config.follow,
      pollInterval: this.config.pollInterval,
      initialLines: this.config.initialLines,
      onLine: (line) => this._handleJournalLine(line, label),
      onError: (err) =>
        this.config.outputHandler.debug(
          `[wf:${this.config.workflow.runId}] journal read error: ${err}`
        ),
    });

    // FileWatcher.start() awaits initial readAndProcess (see
    // src/core/file-watcher.ts:49) — all history lines have been emitted
    // to onLine. Safe to switch to live mode before the tail begins.
    // P4 SnapshotWatcher must start AFTER this point so its onChange
    // can't fire before history dump completes.
    this.journalParser.markLiveMode();
  }

  private _handleJournalLine(line: string, label: string): void {
    if (!this.journalParser) return;
    const parsed = this.journalParser.parse(line);
    if (!parsed) return;
    parsed.sourceLabel = label;
    const formatted = this.config.formatter.format(parsed);
    if (formatted) this.config.onOutput(formatted, label);
  }

  private _handleAgentLine(agentId: string, line: string, label: string): void {
    const parser = this.agentParsers.get(agentId);
    if (!parser) return;
    drainParser(parser, line, (parsed) => {
      parsed.sourceLabel = label;
      const formatted = this.config.formatter.format(parsed);
      if (formatted) this.config.onOutput(formatted, label);
    });
  }

  private async _scanAndAttachInitialAgents(): Promise<void> {
    const glob = new Glob('agent-*.jsonl');
    const found: { agentId: string; path: string; birthtime: Date }[] = [];
    for await (const file of glob.scan({
      cwd: this.config.workflow.transcriptDir,
    })) {
      if (file.includes('/')) continue; // defensive
      const agentId = parseWorkflowAgentFilename(file);
      if (!agentId) continue;
      const path = join(this.config.workflow.transcriptDir, file);
      try {
        const stats = await stat(path);
        found.push({ agentId, path, birthtime: stats.birthtime });
      } catch {
        /* skip */
      }
    }
    found.sort((a, b) => a.birthtime.getTime() - b.birthtime.getTime());
    for (const { agentId, path } of found) {
      await this.attachAgent(agentId, path);
    }
  }

  private _startSubagentDirWatch(): void {
    try {
      this.subagentDirWatcher = watch(
        this.config.workflow.transcriptDir,
        (_eventType, filename) => {
          if (this.stopped || !filename) return;
          const agentId = parseWorkflowAgentFilename(filename);
          if (!agentId || !isValidWorkflowAgentId(agentId)) return;
          const transcriptPath = join(
            this.config.workflow.transcriptDir,
            filename
          );
          void this.attachAgent(agentId, transcriptPath);
        }
      );
      this.subagentDirWatcher.on('error', (err) =>
        this.config.outputHandler.debug(
          `[wf:${this.config.workflow.runId}] subagent dir watch error: ${err}`
        )
      );
    } catch (err) {
      this.config.outputHandler.debug(
        `[wf:${this.config.workflow.runId}] subagent dir watch failed: ${err}`
      );
    }
  }
}
