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
  /** 觸發條件：resume_agent / send_input 且 agentId 已知 */
  onSubagentEnter?: (agentId: string, path: string) => void;
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
  private registeredAgentPaths: Map<string, string> = new Map();
  private config: CodexSubagentDetectorConfig;
  private stopped = false;

  constructor(
    _existingAgentIds: string[],
    config: CodexSubagentDetectorConfig
  ) {
    this.config = config;
    // existingAgentIds reserved for future deduplication use
  }

  /**
   * 預先登錄已存在的 subagent（供 handleSubagentResume 查詢）
   */
  registerExistingAgent(agentId: string, path: string): void {
    this.registeredAgentPaths.set(agentId, path);
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

    // Guard：stop() 後捨棄結果，避免向舊 watcher 注入資料
    if (this.stopped) return;

    if (!foundPath) {
      this.config.output.warn(
        `Codex subagent file not found after retries: ${agentId}`
      );
      return;
    }

    // Cleanup pending
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(callId);

    // 記錄已知 agent（供 handleSubagentResume 查詢路徑）
    this.registeredAgentPaths.set(agentId, foundPath);

    // Guard：addFile 前再次確認未停止（watcher 是 let 閉包，可能已換新實例）
    if (this.stopped) return;

    const label = makeCodexAgentLabel(agentId);
    await this.config.watcher.addFile({ path: foundPath, label });

    // Guard：addFile 是 async，完成後再確認一次，防止 onNewSubagent 對已切換的 session 觸發
    if (this.stopped) return;

    const description =
      pending.agentType && pending.message
        ? `${pending.agentType}: ${pending.message.slice(0, 50)}`
        : undefined;
    this.config.onNewSubagent?.(agentId, foundPath, description);
  }

  handleSubagentResume(agentId: string): void {
    if (!this.config.enabled) return;
    if (!isValidCodexAgentId(agentId)) return;

    const path = this.registeredAgentPaths.get(agentId);
    if (path) {
      this.config.onSubagentEnter?.(agentId, path);
    }
  }

  getAgentPath(agentId: string): string | undefined {
    return this.registeredAgentPaths.get(agentId);
  }

  handleSubagentDone(agentId: string): void {
    this.config.onSubagentDone?.(agentId);
  }

  stop(): void {
    this.stopped = true;
    for (const pending of this.pendingSpawns.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingSpawns.clear();
    this.registeredAgentPaths.clear();
  }
}
