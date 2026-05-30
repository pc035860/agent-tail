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
import chalk from 'chalk';
import { JournalLineParser } from './journal-parser.ts';
import { SnapshotWatcher } from './snapshot-watcher.ts';
import {
  parseWorkflowAgentFilename,
  isValidWorkflowAgentId,
  makeWorkflowJournalSessionId,
} from './paths.ts';
import type {
  DetectedWorkflow,
  WorkflowProgressItem,
  WorkflowSnapshot,
} from './types.ts';

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
  /** P5 — called at the end of stop() so dispatcher can drop refs / unregister. */
  onStop?: (reason: 'completed' | 'directory-removed' | 'user') => void;
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
  private snapshotWatcher: SnapshotWatcher | null = null;
  private currentSnapshot: WorkflowSnapshot | null = null;
  // One-shot latch — true once auto-exit (snapshot terminal status) is
  // scheduled, so duplicate terminal-status snapshots don't schedule
  // multiple stop() calls.
  private autoStopScheduled = false;
  private readonly knownAgentIds = new Set<string>();
  private stopped = false;

  constructor(private readonly config: WorkflowAttachmentConfig) {}

  getCurrentSnapshot(): WorkflowSnapshot | null {
    return this.currentSnapshot;
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

    // Step 4 — snapshot watcher (LAST, so onChange-triggered stop runs after
    // history dump completes — see _startJournalAndFlushHistory note).
    this.snapshotWatcher = new SnapshotWatcher({
      path: this.config.workflow.snapshotPath,
      onChange: (snap) => this._handleSnapshotChange(snap),
      onError: (err) => this._handleSnapshotError(err),
    });
    await this.snapshotWatcher.start();
  }

  async attachAgent(agentId: string, transcriptPath: string): Promise<void> {
    // Post-stop subagent-dir-watch events must not spawn new watchers
    // during the queueMicrotask gap between scheduling and executing stop().
    if (this.stopped) return;
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

    // Close snapshot watcher first to silence further onChange firings.
    this.snapshotWatcher?.stop();
    this.snapshotWatcher = null;

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
    // Journal session id matches the dispatcher's session id
    // (P6 interactive) and the PaneManager pinned key (P7 --workflow-pane).
    this.config.sessionHandler?.markSessionDone?.(
      makeWorkflowJournalSessionId(this.config.workflow.runId)
    );

    this.config.outputHandler.info(
      `[wf:${this.config.workflow.runId}] stopped (${reason})`
    );

    // P5 — notify owner so it can drop the runId from its registry.
    this.config.onStop?.(reason);
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

  private _handleSnapshotChange(snap: WorkflowSnapshot): void {
    if (this.stopped) return;

    this.currentSnapshot = snap;

    const label = makeWorkflowJournalLabel(this.config.workflow.runId);
    const phaseInfo = this._phaseProgress(snap);
    const body = `[snapshot] status=${snap.status}${phaseInfo ? ` ${phaseInfo}` : ''}`;
    const color =
      snap.status === 'failed'
        ? chalk.red
        : snap.status === 'completed'
          ? chalk.green
          : chalk.gray;
    this.config.onOutput(color(body), label);

    // Q6 / T8b — auto-exit on completed/failed (one-shot latch).
    // stop() reason union is 'completed' | 'directory-removed' | 'user'.
    // The actual 'failed' status is conveyed via the colored event line above;
    // we stop with reason 'completed' (semantically: "workflow finished").
    if (
      (snap.status === 'completed' || snap.status === 'failed') &&
      !this.autoStopScheduled
    ) {
      this.autoStopScheduled = true;
      queueMicrotask(() => {
        void this.stop('completed');
      });
    }
  }

  private _handleSnapshotError(err: Error): void {
    if (this.stopped) return;

    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // T20 — snapshot file removed. stop('directory-removed') will emit
      // an info line; no extra warn here to avoid duplication.
      queueMicrotask(() => void this.stop('directory-removed'));
      return;
    }

    // Invalid JSON / transient read failure (T19) — log and continue.
    this.config.outputHandler.debug(
      `[wf:${this.config.workflow.runId}] snapshot error: ${err.message}`
    );
  }

  private _phaseProgress(snap: WorkflowSnapshot): string {
    const progress = snap.workflowProgress ?? [];
    const phaseEvents = progress.filter(
      (p): p is Extract<WorkflowProgressItem, { type: 'workflow_phase' }> =>
        p.type === 'workflow_phase'
    );
    const currentPhase = phaseEvents.at(-1);
    if (!currentPhase) return '';
    const total = snap.phases?.length ? snap.phases.length : '?';
    return `(phase ${currentPhase.index}/${total}: ${currentPhase.title})`;
  }
}
