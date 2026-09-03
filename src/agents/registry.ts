import type { AgentType, ParserOptions } from '../core/types.ts';
import type { Agent } from './agent.interface.ts';
import { CodexAgent } from './codex/codex-agent.ts';
import { ClaudeAgent } from './claude/claude-agent.ts';
import { GeminiAgent } from './gemini/gemini-agent.ts';
import { CursorAgent } from './cursor/cursor-agent.ts';
import { AgyAgent } from './agy/agy-agent.ts';
import { PiAgent, piWalkParent } from './pi/pi-agent.ts';

/**
 * Agent capabilities registry（v2 §4.1）— agent 資訊的單一來源。
 *
 * 新增一個 agent = 一個 agent 檔案 + registry 一行。以下清單全部從
 * registry 導出，禁止散落手抄：
 * - `AGENT_TYPES`：CLI 驗證、agent-pick 清單、help text
 * - `factory`：index.ts 的實例化（取代三元鏈）
 * - `statefulParser`：drain 清單（startSingleWatch 的 drainParser 特判）
 * - `recreateOnSwitch`：session 切換時重建 parser 的清單
 * - `jsonMode`：FileWatcher 模式特判
 * - `supportsSubagent` / `supportsInteractive` / `supportsPane`：CLI per-agent 驗證
 * - `supportsAutoSwitch`：help text + 驗證
 * - `pickEnabled`：agent-pick AGENT_TYPES
 */
export interface AgentCapabilities {
  factory: (opts: ParserOptions) => Agent;
  /** stateful multi-emit parser → caller 需 drainParser */
  statefulParser: boolean;
  /** session 切換時重建 parser（清除狀態殘留） */
  recreateOnSwitch: boolean;
  /** FileWatcher jsonMode（整檔 hash 比對） */
  jsonMode: boolean;
  /** --subagent / --with-subagents / --all */
  supportsSubagent: boolean;
  /** --interactive */
  supportsInteractive: boolean;
  /** --pane */
  supportsPane: boolean;
  /** --auto-switch（findLatestInProject） */
  supportsAutoSwitch: boolean;
  /** agent-pick 清單 */
  pickEnabled: boolean;
  /**
   * 樹狀 active-path replay（v2 §4.3）：提供 parentId walk 實作時，
   * index.ts 會把 parser 包進 ActivePathFilter（初始 dump 緩衝 →
   * onInitialDumpComplete flush → live 透傳）。
   */
  treeReplay?: {
    walkParent: (entry: unknown) => string | null;
  };
}

export const AGENT_REGISTRY: Record<AgentType, AgentCapabilities> = {
  claude: {
    factory: (opts) => new ClaudeAgent(opts),
    statefulParser: true,
    recreateOnSwitch: false,
    jsonMode: false,
    supportsSubagent: true,
    supportsInteractive: true,
    supportsPane: true,
    supportsAutoSwitch: true,
    pickEnabled: true,
  },
  codex: {
    factory: (opts) => new CodexAgent(opts),
    statefulParser: false,
    recreateOnSwitch: false,
    jsonMode: false,
    supportsSubagent: true,
    supportsInteractive: true,
    supportsPane: true,
    supportsAutoSwitch: true,
    pickEnabled: true,
  },
  gemini: {
    factory: (opts) => new GeminiAgent(opts),
    statefulParser: true,
    recreateOnSwitch: true,
    jsonMode: true,
    supportsSubagent: false,
    supportsInteractive: false,
    supportsPane: false,
    supportsAutoSwitch: true,
    pickEnabled: true,
  },
  cursor: {
    factory: (opts) => new CursorAgent(opts),
    statefulParser: true,
    recreateOnSwitch: false,
    jsonMode: false,
    supportsSubagent: true,
    supportsInteractive: true,
    supportsPane: true,
    supportsAutoSwitch: true,
    pickEnabled: true,
  },
  agy: {
    factory: (opts) => new AgyAgent(opts),
    statefulParser: true,
    recreateOnSwitch: true,
    // antigravity-cli brain transcript 是 JSONL（非 .pb/.db binary）
    jsonMode: false,
    supportsSubagent: false,
    supportsInteractive: false,
    supportsPane: false,
    supportsAutoSwitch: true,
    pickEnabled: true,
  },
  pi: {
    factory: (opts) => new PiAgent(opts),
    statefulParser: true,
    recreateOnSwitch: true,
    jsonMode: false,
    supportsSubagent: false,
    supportsInteractive: false,
    supportsPane: false,
    supportsAutoSwitch: true,
    pickEnabled: true,
    treeReplay: { walkParent: piWalkParent },
  },
};

/** 支援特定能力的 agent 清單（錯誤訊息 / help text 用） */
export function agentsWithCapability(
  pred: (caps: AgentCapabilities) => boolean
): AgentType[] {
  return AGENT_TYPES.filter((t) => pred(AGENT_REGISTRY[t]));
}

/** agent-pick 與 CLI 驗證的單一來源（取代散落的 AGENT_TYPES 手抄清單） */
export const AGENT_TYPES = Object.keys(AGENT_REGISTRY) as AgentType[];
