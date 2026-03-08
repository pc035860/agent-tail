# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

agent-tail is a CLI tool for tailing AI agent session logs (Codex, Claude Code, Gemini CLI) in real-time. Built with Bun runtime.

## Commands

```bash
# Run the CLI
bun run src/index.ts <agent-type>  # agent-type: codex | claude | gemini

# Or via npm script
bun start                          # requires agent-type argument

# Development commands
bun test                           # run tests
bun run typecheck                  # TypeScript type checking
bun run lint                       # ESLint check
bun run lint:fix                   # ESLint auto-fix
bun run format                     # Prettier format all files
bun run format:check               # Check Prettier formatting

# CLI options
agent-tail <agent-type>            # basic usage
agent-tail <agent-type> <session-id>  # load specific session (partial match)
agent-tail claude --raw            # output raw JSONL
agent-tail codex -p myproject      # filter by project (fuzzy match)
agent-tail gemini --no-follow      # don't follow, only show existing content
agent-tail claude -v               # verbose mode (no truncation)
agent-tail <agent-type> -q         # quiet mode (suppress non-error messages)
agent-tail <agent-type> -n 50      # show only last 50 lines initially
agent-tail <agent-type> -s 200     # set polling interval to 200ms (default: 500)

# Claude-specific options
agent-tail claude --subagent       # tail latest subagent log
agent-tail claude --subagent abc123 # tail specific subagent by ID
agent-tail claude -i               # interactive mode (Tab to switch sessions)
agent-tail claude --with-subagents # include subagent content in output
agent-tail claude -a               # show all content (verbose + subagents + auto-switch)
agent-tail claude --all            # same as -a
agent-tail claude --pane           # auto-open tmux pane for each new subagent

# Codex-specific options (Phase 2/3 complete)
agent-tail codex --subagent <uuid> # tail specific Codex subagent by UUID
agent-tail codex --with-subagents  # include subagent content in output
agent-tail codex -i                # interactive mode (Tab to switch sessions)
agent-tail codex -a                # show all content (verbose + subagents + auto-switch)
agent-tail codex --pane            # auto-open tmux pane for each new subagent

# Super Follow (auto-switch to latest session in project)
agent-tail claude --auto-switch    # Claude: project-based
agent-tail gemini --auto-switch    # Gemini: .project_root based
agent-tail codex --auto-switch     # Codex: cwd-based (with cache)
```

## Architecture

```
src/
├── index.ts                  # Entry point - orchestrates agents, formatters, and watchers
├── cli/parser.ts             # CLI argument parsing with commander
├── core/
│   ├── types.ts              # Shared types (AgentType, ParsedLine, SessionFile, CliOptions, ProjectInfo)
│   ├── detector-interfaces.ts # Shared interfaces: OutputHandler, WatcherHandler, SessionHandler, RetryConfig
│   │                         # + MAIN_LABEL, makeAgentLabel, extractAgentIdFromLabel
│   ├── file-watcher.ts       # Single file monitoring with tail -f behavior
│   ├── multi-file-watcher.ts # Multi-file monitoring (for subagent support)
│   └── session-manager.ts    # Session state management for interactive mode
├── agents/
│   ├── agent.interface.ts    # Agent, SessionFinder, LineParser interfaces
│   ├── codex/
│   │   ├── codex-agent.ts    # CodexSessionFinder with getProjectInfo, findLatestInProject
│   │   └── session-cache.ts  # Cwd-indexed cache with incremental refresh
│   ├── claude/claude-agent.ts
│   └── gemini/gemini-agent.ts # GeminiSessionFinder with .project_root support
├── claude/                   # Claude-specific modules
│   ├── subagent-detector.ts  # Detect and monitor subagent sessions (with directory watch)
│   ├── auto-switch.ts        # Find latest session in project for auto-switch mode
│   ├── output-handlers.ts    # Output handler implementations (console, display controller)
│   ├── session-handlers.ts   # Session event handling
│   └── watch-builder.ts      # Shared utilities (buildSubagentFiles, createSuperFollowController, agent_progress parsing)
├── codex/                    # Codex-specific modules
│   ├── subagent-detector.ts  # CodexSubagentDetector: event-driven UUID subagent detection
│   │                         # registerExistingAgent(), handleSubagentResume(), getAgentPath()
│   │                         # stopped flag guards in-flight _resolveSubagent against session switches
│   └── watch-builder.ts      # extractUUIDFromPath, extractCodexSubagentIds, buildCodexSubagentFiles,
│                             # createCodexOnLineHandler (spawn_agent + function_call_output + resume_agent + subagent_notification)
│                             # readLastCodexAssistantMessage(filePath, parser: LineParser)
├── interactive/
│   └── display-controller.ts # Terminal UI for interactive mode (status line, history)
├── terminal/                 # Terminal pane management (tmux, future iTerm2)
│   ├── terminal-controller.interface.ts  # TerminalController interface
│   ├── tmux-controller.ts    # Tmux implementation (split-window, kill-pane)
│   ├── null-controller.ts    # No-op fallback when no terminal detected
│   ├── controller-factory.ts # Auto-detect terminal environment
│   └── pane-manager.ts       # Pane lifecycle manager (open/close/closeAll, max 6 panes)
│                             # Phase 4 will add iTerm2 support
├── formatters/
│   ├── formatter.interface.ts
│   ├── raw-formatter.ts
│   └── pretty-formatter.ts
└── utils/
    ├── text.ts               # Text utilities (truncate, truncateByLines, formatMultiline)
    └── format-tool.ts        # Tool call formatting for all agents
```

**Key Patterns:**
- Each agent implements `Agent` interface with `finder` (SessionFinder) and `parser` (LineParser)
- **SessionFinder interface** includes optional methods for super-follow:
  - `getProjectInfo(sessionPath)` - Extract project context from session
  - `findLatestInProject(projectDir)` - Find newest session in same project
- SessionFinder locates session files in agent-specific directories:
  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (all projects mixed, cwd in session_meta)
  - Claude: `~/.claude/projects/{encoded-path}/{UUID}.jsonl` (per-project directory)
  - Gemini: `~/.gemini/tmp/{hash或name}/chats/session-*.json` (.project_root for project info)
- FileWatcher supports two modes: JSONL (line-by-line) and JSON (whole-file, for Gemini)
- **Super Follow** (`createSuperFollowController`): Auto-switch to latest session, configurable per-agent via `findLatestInProject` callback
- **Codex Session Cache**: Cwd-indexed cache with 2s incremental refresh (scans today's directory only)
- Formatters transform ParsedLine to output string (raw JSON or pretty colored)
- **Pane auto-open** (`--pane`): Uses `SubagentDetector` hooks → `PaneManager` → `TerminalController` to open tmux panes for subagent create/resume, and closes on `toolUseResult`. Requires tmux environment.
  - `onNewSubagent`: Fired on subagent **create** (via `registerNewAgent`)
  - `onSubagentEnter`: Fired on subagent **resume** (via `handleAgentProgress` when agentId already known)
  - Both callbacks point to same `openPaneForSubagent` function; `PaneManager.openPane` guards against duplicate panes
- **Pane naming**: Task `description` is extracted from `tool_use` input, queued in `SubagentDetector` (FIFO), and matched to new agents. `PaneManager` sanitizes and applies via `tmux select-pane -T` (2.6+, best-effort). Known limitation: parallel Tasks may mismatch descriptions.

**Adding Super Follow to a New Agent:**
1. Implement `getProjectInfo(sessionPath)` - Return `{ projectDir, displayName }` for the session
2. Implement `findLatestInProject(projectDir)` - Find newest session in same project scope
3. Add agent-specific logic to `startSingleWatch` in `src/index.ts`

**Codex Subagent Detection (Phases 1-3 complete):**
- **Event-driven only** (no directory watch): Codex日期目錄混合多個使用者的主 session，無法用 fs.watch 過濾。偵測靠解析主 session JSONL 的 `spawn_agent` + `function_call_output` 事件。
- **UUID format**: Codex subagent ID 是 UUID v7（`019cc375-5af5-7ed1-9ff8-8a5757d815d1`），不同於 Claude 的 7-40 hex。`isValidCodexAgentId` 用 UUID regex 驗證。
- **Flat directory**: subagent JSONL 和主 session 在同一個日期目錄（非巢狀）。`dirname(mainSessionPath)` 即日期目錄。
- **Label collision gotcha**: UUID v7 前兩段都是 timestamp。`makeCodexAgentLabel` 改用 `parts[0]` + `parts[4].slice(0,4)`（node segment）避免同毫秒碰撞。
- **All CLI options supported**: `--with-subagents`、`--subagent`、`--all`、`--pane`、`--interactive` 現在同時支援 `claude` 和 `codex`。
- **Shared interfaces in core**: `OutputHandler`、`WatcherHandler`、`SessionHandler` 等介面在 `src/core/detector-interfaces.ts`，Claude module 透過 re-export 向後相容。
- **Stateless parser in interactive mode**: Codex parser 無狀態，`startCodexInteractiveWatch` 所有 session 共用 `sharedParser`（Claude 每 session 需獨立 parser 防止狀態污染）。
- **registerExistingAgent() required for resume**: 啟動時已知的 subagent 必須呼叫 `detector.registerExistingAgent(agentId, path)` 預填路徑，否則 `resume_agent` 事件的 `handleSubagentResume` 找不到路徑，`onSubagentEnter` 不會觸發。
- **stopped flag prevents cross-session contamination**: `CodexSubagentDetector.stop()` 設定 `stopped = true`，`_resolveSubagent` 在每個 await 點後檢查，防止舊 detector 的 in-flight resolve 污染新 session 的 watcher。
- **`handleSpawnAgentOutput` skips pre-registered agents**: 啟動時透過 `registerExistingAgent` 預填的 agentId，在歷史行重播時 `handleSpawnAgentOutput` 會跳過（避免對已知 subagent 重複 resolve + 重複 `onNewSubagent`）。
- **Codex pane output filter needs shortId→fullId mapping**: Codex label 用短 ID（`019cc375-8a57`），但 `PaneManager` 用完整 UUID 作 key。`shouldOutput` 需透過 `shortIdToFullId` Map 反查。此映射在 `switchToSession` 時 `clear()`，並由 `prefillExistingSubagents` 和 `openPaneForSubagent` 填充。
- **Use `RetryConfig` for retry loops**: `src/core/detector-interfaces.ts` 定義了 `RetryConfig` 介面（maxRetries, retryDelay, initialDelay）。Codex 的 `SUBAGENT_FILE_RETRY` 和 Claude 的 `EARLY_DETECTION_RETRY` / `FALLBACK_DETECTION_RETRY` 都應使用此介面，避免 magic numbers。

**Gotchas:**
- **Gemini parser has state** (`processedMessageIds`). Must recreate parser when switching sessions to avoid message skip bugs.
- **`Bun.file(dir).exists()` returns false for directories**. Use `stat(dir)` instead.
- **Codex cache only scans "today"** for incremental refresh. Cross-midnight sessions handled on next startup.
- **Subagent ID length varies**: Claude Code subagent filenames use 7-40 hex chars (`agent-[0-9a-f]{7,40}.jsonl`), not fixed 7. Regex must accommodate this.
- **`--pane` mutual exclusions**: Cannot combine with `--interactive` or `--subagent`. Requires `--follow` mode. Auto-enables `--with-subagents`.
- **PaneManager command builder** uses `process.argv[0]` and `process.argv[1]` to reconstruct the CLI command, supporting bun run, npx, and global install scenarios.
- **SubagentDetector description queue**: FIFO `pendingDescriptions` must be consumed in both `registerNewAgent` (early detection) and `handleFallbackDetection` (completed path) to prevent queue drift. The queue is cleared in `stop()`.
- **`handleAgentProgress` only triggers for resume**: Unknown agentIds are ignored (registration is handled by `onNewSubagent` via early/fallback paths), and only known agentIds trigger `onSubagentEnter`. This prevents duplicate pane opens and registration race issues.
- **`readLastCodexAssistantMessage` signature**: Takes `(filePath, parser: LineParser)` — not `verbose` bool like the Claude version. Parser is injected to avoid circular imports.
- **`createInteractiveSessionManager(displayController)`**: Module-level helper in `src/index.ts` shared by both `startClaudeInteractiveWatch` and `startCodexInteractiveWatch`. Do not duplicate this into each function.
- **`prefillExistingSubagents(detector, files)`**: Helper in `startCodexMultiWatch` that combines `registerExistingAgent` + `registerShortId` into one loop. Used in both init and `switchToSession` — do not inline back into separate loops.

## Code Quality

- **ESLint**: v9 flat config (`eslint.config.js`) with TypeScript support
- **Prettier**: Code formatting (`prettier.config.js`)
- **Husky + lint-staged**: Pre-commit hooks auto-run lint and format on staged `.ts` files
