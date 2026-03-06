import { join } from 'node:path';
import { Glob } from 'bun';
import {
  makeAgentLabel,
  type OutputHandler,
  type WatcherHandler,
} from '../core/detector-interfaces.ts';

// ============================================================
// UUID Validation
// ============================================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCodexAgentId(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * 取 UUID 的高位時間戳段 + node 段前 4 碼作為短 label
 * 例如 '019cc375-8a57'（避免 UUID v7 前兩段均為 timestamp 導致碰撞）
 */
export function makeCodexAgentLabel(agentId: string): string {
  const parts = agentId.split('-');
  // parts[4] 為 node/random 段，提供唯一性；parts[0] 為可讀時間戳
  const shortId = `${parts[0]}-${(parts[4] ?? '').slice(0, 4)}`;
  return makeAgentLabel(shortId);
}

// ============================================================
// Config & Types
// ============================================================

export interface CodexSubagentDetectorConfig {
  /** dirname(mainSessionPath) — 日期目錄 */
  sessionDateDir: string;
  output: OutputHandler;
  watcher: WatcherHandler;
  /** options.follow && options.withSubagents */
  enabled: boolean;
  onNewSubagent?: (agentId: string, path: string, description?: string) => void;
  onSubagentDone?: (agentId: string) => void;
}

interface PendingSpawn {
  agentType: string;
  message: string;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================
// File finder with retry
// ============================================================

async function findSubagentFile(
  dateDir: string,
  agentId: string
): Promise<string | null> {
  const glob = new Glob(`rollout-*-${agentId}.jsonl`);
  for (let i = 0; i < 10; i++) {
    for await (const file of glob.scan(dateDir)) {
      return join(dateDir, file);
    }
    if (i < 9) await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// ============================================================
// CodexSubagentDetector
// ============================================================

export class CodexSubagentDetector {
  private pendingSpawns: Map<string, PendingSpawn> = new Map();
  private config: CodexSubagentDetectorConfig;

  constructor(
    _existingAgentIds: string[],
    config: CodexSubagentDetectorConfig
  ) {
    this.config = config;
    // existingAgentIds reserved for future deduplication use
  }

  handleSpawnAgent(callId: string, agentType: string, message: string): void {
    if (!this.config.enabled) return;

    // 防止同一 callId 重複登錄導致舊 timer 洩漏
    const existing = this.pendingSpawns.get(callId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pendingSpawns.delete(callId);
    }, 60000);

    this.pendingSpawns.set(callId, { agentType, message, timer });
  }

  handleSpawnAgentOutput(
    callId: string,
    output: { agent_id: string; nickname?: string }
  ): void {
    if (!this.config.enabled) return;

    const pending = this.pendingSpawns.get(callId);
    if (!pending) {
      this.config.output.debug(`Codex: unknown callId ${callId}, ignoring`);
      return;
    }

    const agentId = output.agent_id;
    if (!isValidCodexAgentId(agentId)) {
      this.config.output.warn(
        `Codex: invalid agent_id format (not UUID): ${agentId}`
      );
      return;
    }

    // Fire async, but don't await in sync handler
    this._resolveSubagent(callId, pending, agentId).catch((err) => {
      this.config.output.error(
        `Codex: Failed to resolve subagent ${agentId} - ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private async _resolveSubagent(
    callId: string,
    pending: PendingSpawn,
    agentId: string
  ): Promise<void> {
    const foundPath = await findSubagentFile(
      this.config.sessionDateDir,
      agentId
    );

    if (!foundPath) {
      this.config.output.warn(
        `Codex subagent file not found after retries: ${agentId}`
      );
      return;
    }

    // Cleanup pending
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(callId);

    const label = makeCodexAgentLabel(agentId);
    await this.config.watcher.addFile({ path: foundPath, label });
    // pending.message reserved for Phase 2 pane description
    this.config.onNewSubagent?.(agentId, foundPath);
  }

  handleSubagentDone(agentId: string): void {
    this.config.onSubagentDone?.(agentId);
  }

  stop(): void {
    for (const pending of this.pendingSpawns.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingSpawns.clear();
  }
}
