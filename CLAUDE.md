# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

agent-tail is a CLI tool for tailing AI agent session logs (Codex, Claude Code, Gemini CLI & Cursor) in real-time. Built with Bun runtime.

## Commands

```bash
# Run the CLI
bun run src/index.ts <agent-type>  # agent-type: codex | claude | gemini | cursor

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

# Cursor-specific options
agent-tail cursor                  # tail latest Cursor session
agent-tail cursor -p myproject     # filter by project (fuzzy match on workspace slug)
agent-tail cursor --auto-switch    # auto-switch to latest session in workspace
agent-tail cursor --subagent       # tail latest subagent log
agent-tail cursor --subagent <uuid> # tail specific subagent by UUID
agent-tail cursor --with-subagents # include subagent content in output
agent-tail cursor -i               # interactive mode (Tab to switch sessions)
agent-tail cursor -a               # show all content (verbose + subagents + auto-switch)
agent-tail cursor --pane           # auto-open tmux pane for each new subagent

# Session listing and browsing
agent-tail claude --list              # list recent sessions (tab-separated)
agent-tail codex --list -p myproject  # list with project filter
agent-tail claude --list -n 10        # show top 10 sessions (-n = session count in list mode)
agent-pick claude                     # interactive fzf browser with preview (requires fzf)
agent-pick codex -p myproject         # fzf browser with project filter
agent-tail claude abc123 --summary    # show head+tail summary of a session

# Super Follow (auto-switch to latest session in project)
agent-tail claude --auto-switch    # Claude: project-based
agent-tail gemini --auto-switch    # Gemini: .project_root based
agent-tail codex --auto-switch     # Codex: cwd-based (with cache)
agent-tail cursor --auto-switch    # Cursor: workspace-slug based
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
│   ├── cursor/cursor-agent.ts  # CursorSessionFinder (with findSubagent) + CursorLineParser (stateful multi-emit for assistant tool_use, no timestamps)
│   └── gemini/gemini-agent.ts # GeminiSessionFinder with .project_root support
├── claude/                   # Claude-specific modules
│   ├── subagent-detector.ts  # Detect and monitor subagent sessions (with directory watch)
│   ├── auto-switch.ts        # Find latest session in project for auto-switch mode
│   ├── custom-title.ts       # readCustomTitle(): extract last custom-title from JSONL
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
├── cursor/                    # Cursor-specific modules
│   ├── subagent-detector.ts  # CursorSubagentDetector: pure directory-watch detection
│   │                         # No JSONL events (unlike Claude/Codex). Parent dir fallback.
│   │                         # Rolls back knownAgentIds on file-add failure (retry on next scan).
│   └── watch-builder.ts      # getCursorSubagentsDir, scanCursorSubagents, buildCursorSubagentFiles,
│                             # buildCursorSubagentPath, isValidCursorSubagentId, makeCursorAgentLabel
├── interactive/
│   └── display-controller.ts # Terminal UI for interactive mode (status line, history)
├── terminal/                 # Terminal pane management (tmux, future iTerm2)
│   ├── terminal-controller.interface.ts  # TerminalController interface
│   ├── tmux-controller.ts    # Tmux implementation (split-window, kill-pane)
│   ├── null-controller.ts    # No-op fallback when no terminal detected
│   ├── controller-factory.ts # Auto-detect terminal environment
│   └── pane-manager.ts       # Pane lifecycle manager (open/close/closeAll, max 6 panes)
│                             # Phase 4 will add iTerm2 support
├── list/
│   ├── session-lister.ts    # formatRelativeTime, formatSessionList (tab-separated output for --list)
│   └── summary.ts           # formatSummary: head+tail preview with gap separator (═══ ↕ N messages skipped ═══)
├── pick/
│   ├── index.ts             # agent-pick entry point (fzf integration, collect-first then printf|fzf)
│   ├── fzf-helpers.ts       # buildFzfArgs, parseSelection, resolveAgentTailPath, checkFzfAvailable
│   └── arg-passthrough.ts   # extractTailPassthroughArgs, extractPickListArgs (forward extra CLI args to agent-tail)
├── formatters/
│   ├── formatter.interface.ts
│   ├── raw-formatter.ts
│   └── pretty-formatter.ts
└── utils/
    ├── text.ts               # Text utilities (truncate, truncateByLines, formatMultiline)
    ├── format-tool.ts        # Tool call formatting for all agents
    ├── parser-drain.ts       # drainParser(parser, line, onEach, { drainArg? }): shared drain helper (max 100 iterations)
    └── session-time.ts       # Tail-read utilities: readLastTimestampFromJSONL, readCwdFromHead,
                              # readCustomTitleFromTail, readLastTimestampFromGeminiJSON
```

**Key Patterns:**
- Each agent implements `Agent` interface with `finder` (SessionFinder) and `parser` (LineParser)
- **SessionFinder interface** includes optional methods for super-follow:
  - `getProjectInfo(sessionPath)` - Extract project context from session
  - `findLatestInProject(projectDir)` - Find newest session in same project
- SessionFinder locates session files in agent-specific directories:
  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (all projects mixed, cwd in session_meta)
  - Claude: `~/.claude/projects/{encoded-path}/{UUID}.jsonl` (per-project directory)
  - Cursor: `~/.cursor/projects/{workspace-slug}/agent-transcripts/{UUID}/{UUID}.jsonl` (per-workspace, subagents in `{UUID}/subagents/{UUID}.jsonl`)
  - Gemini: `~/.gemini/tmp/{hash或name}/chats/session-*.json` (.project_root for project info)
- FileWatcher supports two modes: JSONL (line-by-line) and JSON (whole-file, for Gemini)
- **Super Follow** (`createSuperFollowController`): Auto-switch to latest session, configurable per-agent via `findLatestInProject` callback
- **Codex Session Cache**: Cwd-indexed cache with 2s incremental refresh (scans today's directory only). Uses `readMainSessionMeta()` to parse first line and filter out subagent sessions.
- Formatters transform ParsedLine to output string (raw JSON or pretty colored)
- **Pane auto-open** (`--pane`): Uses `SubagentDetector` hooks → `PaneManager` → `TerminalController` to open tmux panes for subagent create/resume, and closes on `toolUseResult`. Requires tmux environment.
  - `onNewSubagent`: Fired on subagent **create** (via `registerNewAgent`)
  - `onSubagentEnter`: Fired on subagent **resume** (via `handleAgentProgress` when agentId already known)
  - Both callbacks point to same `openPaneForSubagent` function; `PaneManager.openPane` guards against duplicate panes
- **Pane naming**: Task/Agent `description` is extracted from `tool_use` input, queued in `SubagentDetector` (FIFO), and matched to new agents. `PaneManager` sanitizes and applies via `tmux select-pane -T` (2.6+, best-effort). Known limitation: parallel Tasks may mismatch descriptions.
- **Custom-title support**: Claude Code `/rename` writes `{"type":"custom-title","customTitle":"..."}` to session JSONL. `readCustomTitle()` in `src/claude/custom-title.ts` scans from end (last entry wins). `SessionFile.customTitle` is populated by `ClaudeSessionFinder`. `WatcherSession.displayName` drives interactive mode status line display. `onTitleUpdate` callback in `OnLineHandlerConfig` enables real-time status line refresh in interactive mode.

- **Session Listing** (`--list`): `SessionFinder.listSessions()` is optional on the interface. Each agent extracts a shared `_collectMainSessions()` helper (Claude/Codex/Gemini) or `_collectSessions()` (Gemini) used by both `findLatest()` and `listSessions()`. **Exception**: Cursor's `findLatest()` keeps its own O(1) rolling-max loop for performance — do not merge it into `_collectMainSessions`. Enrichment reads `lastActivityTime`, `customTitle`, and `cwd` via parallel I/O using `src/utils/session-time.ts` tail-read utilities (8KB per file). Claude reads all three; Codex/Gemini only read timestamps; Cursor uses none (no timestamps in JSONL).
- **`--summary`**: Head+tail preview (first 5 + last 15 lines) with `═══ ↕ N messages skipped ═══` gap separator (chalk.dim). Used by `agent-pick` fzf preview. Small files (≤32KB) single-read; large files parallel head+tail 16KB chunk reads.
- **`agent-pick`**: Thin Bun script at `bin/agent-pick` that collects `agent-tail --list` output first, then pipes via `printf | fzf` (avoids TTY race). Preview uses `--summary`. Falls back to plain list when fzf not installed. The shortId (first column of `--list` output) is passed to `agent-tail <type> <shortId>` via `findBySessionId` partial match. Extra CLI args (e.g., `-v`, `-i`, `--pane`) are forwarded to the final `agent-tail` command via `extractTailPassthroughArgs`; list-only args (`-n`, `-p`, `-l`) are stripped.
- **`agent-pick` Ctrl-Y copy**: `formatSessionList` emits a hidden 2nd column (`extractFullId(path)`) carrying the full session ID (UUID for Claude/Codex/Cursor, hex8 for Gemini). fzf is configured with `--with-nth 3..` to hide cols 1+2 from view, while `ctrl-y:execute-silent(printf %s {2} | pbcopy)+change-header(...)` copies the full ID to macOS clipboard. macOS-only (pbcopy hard-coded); no Linux/Windows fallback. `parseSelection` still reads col 1 (shortId) for the final tail command — Enter behavior unchanged.
- **`-n` dual semantics**: In tail mode = last N lines per file. In list mode = number of sessions to show (default 20).
- **Session time tail-read pattern**: `readCwdFromHead` uses progressive chunk reading (16KB→64KB→256KB) because some Claude sessions have 30+ `file-history-snapshot` lines before `cwd`. `readLastTimestampFromJSONL` and `readCustomTitleFromTail` read last 8KB and scan backward.

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

**Cursor Agent (Phases 1-3 complete):**
- **No timestamps**: Cursor JSONL entries have no timestamp field. Parser returns `''`, formatter shows `[--:--:--]`.
- **Workspace slug is NOT reversible**: `-` in slug could be path separator, literal hyphen, or underscore. Only `.workspace-trusted` (present in ~10% of dirs) has authoritative `workspacePath`. Project filter (`-p`) checks both slug and workspacePath.
- **Stateful multi-emit parser (assistant only)**: Cursor `assistant.message.content` 可含 text + 多個 `tool_use`，parser 仿 Claude 用 `currentMessageState` 拆成多筆 `ParsedLine` 回傳（text → `type: 'assistant'`；tool_use → `type: 'function_call'` + `toolName` + `formatToolUse(normalizeCursorToolInput(name, input))`）。caller 用 `drainParser(parser, line, onEach)` from `src/utils/parser-drain.ts` 處理（5 個 callsite 都抽到 helper）。`user` role 仍走 single-emit。session 切換時 `currentMessageState` 在 drain loop 結束時必為 null，跨 session 共用 parser 不會污染。
- **Cursor `lastProcessedLine` must survive drain completion**: `CursorLineParser.parse()` clears `currentMessageState` when drain returns null but **must keep** `lastProcessedLine`. Clearing it here looks like a memory win (one JSONL line retained until next line arrives) but breaks the dedup guard — caller's next `parse(line)` with the same line re-inits state and re-emits the first part, locking the drain loop into the guard=100 cap. The retained string releases naturally on the next non-equal line. Codex review caught this (session `019e2c15`) — see regression test in `tests/agents/cursor-agent.test.ts`.
- **Cursor tool input keys differ from Claude/Codex**: `normalizeCursorToolInput()` in `cursor-agent.ts` remaps cursor's keys before `formatToolUse()` so the formatter stays agent-neutral: Read/Delete/StrReplace `path` → `file_path`; Write `contents` → `content`; Glob `glob_pattern` → `pattern` + `target_directory` → `path`; WebSearch `search_term` → `query`. Cursor-only tools (SemanticSearch / ReadLints / Shell / CreatePlan / Await / call_mcp_tool) fall through to `formatToolUse`'s default branch (picks the first non-empty string arg). Add a case here when supporting a new Cursor tool with non-standard keys.
- **Tag stripping order matters**: Must run `stripAttachedFilesTags` before `stripUserQueryTags` — attached_files block can precede user_query, and user_query regex uses `^` anchor.
- **`findLatestInProject` glob `*/*.jsonl`**: Only matches one level deep, so subagent files in `subagents/` subdirectory are naturally excluded — no explicit `/subagents/` check needed.
- **Subagent detection is pure directory-watch**: Cursor JSONL has **no** spawn/resume/done events. `CursorSubagentDetector` uses only `fs.watch` on `subagents/` dir (with parent dir fallback for the ~88% of sessions that don't have subagents at startup).
- **Subagent filenames have no prefix**: `{UUID}.jsonl` (not `agent-{hex}.jsonl` like Claude). Use `isValidCursorSubagentId` (UUID regex) for validation.
- **`CursorSubagentDetector` rolls back on failure**: Unlike Claude's detector, Cursor's `tryAddSubagentFile` removes `agentId` from `knownAgentIds` on failure, since there are no JSONL events for fallback detection.
- **Pane FIFO eviction**: Cursor has no subagent completion events, so panes accumulate. `startCursorMultiWatch` uses a FIFO array (`paneAgentOrder`) to evict the oldest pane when at 6-pane capacity. `paneAgentOrder` must be cleared on session switch.
- **Interactive mode follows Codex pattern**: Shared parser instance (stateful multi-emit, but drain completes within each onLine call so session switching is safe), no `detectionHandler`, no custom title support. Do NOT pass `session` to `CursorSubagentDetector` config in interactive mode — the detector's `registerExistingAgent` and `registerNewAgent` both call `session?.addSession?()` internally, which would cause double registration if combined with `onNewSubagent` callback.
- **`--no-follow --with-subagents` uses sequential output**: NOT `outputTimeSorted` (Cursor JSONL has no timestamp for sorting). Output main session first, then subagents by birthtime.
- **All CLI options supported**: `--subagent`, `--with-subagents`, `--all`, `--pane`, `--interactive` now supported for `claude`, `codex`, and `cursor`.
- **`createInteractiveSessionManager(displayController)`** is shared by Claude, Codex, and Cursor interactive watches.

**Gotchas:**
- **Gemini parser has state** (`processedMessageIds`). Must recreate parser when switching sessions to avoid message skip bugs.
- **`Bun.file(dir).exists()` returns false for directories**. Use `stat(dir)` instead.
- **Codex cache only scans "today"** for incremental refresh. Cross-midnight sessions handled on next startup.
- **Codex subagent sessions share same `cwd` as main session**: Both live in the same flat date directory with identical `rollout-*.jsonl` naming. The only reliable distinction is `session_meta.payload.source`: main sessions have `source: "mcp"` (string), subagents have `source: { subagent: { thread_spawn: { parent_thread_id, depth, ... } } }` (object). `readMainSessionMeta()` in `session-cache.ts` is the canonical helper for this check — use it instead of inline first-line parsing. Bump `CACHE_VERSION` when changing cache filtering logic to invalidate stale disk caches.
- **Subagent ID length varies**: Claude Code subagent filenames use 7-40 hex chars (`agent-[0-9a-f]{7,40}.jsonl`), not fixed 7. Regex must accommodate this.
- **`--pane` mutual exclusions**: Cannot combine with `--interactive` or `--subagent`. Requires `--follow` mode. Auto-enables `--with-subagents`.
- **PaneManager command builder** uses `process.argv[0]` and `process.argv[1]` to reconstruct the CLI command, supporting bun run, npx, and global install scenarios.
- **SubagentDetector description queue**: FIFO `pendingDescriptions` must be consumed in both `registerNewAgent` (early detection) and `handleFallbackDetection` (completed path) to prevent queue drift. The queue is cleared in `stop()`.
- **`handleAgentProgress` only triggers for resume**: Unknown agentIds are ignored (registration is handled by `onNewSubagent` via early/fallback paths), and only known agentIds trigger `onSubagentEnter`. This prevents duplicate pane opens and registration race issues.
- **Claude Code tool rename backward compat**: `Task` → `Agent` (subagent spawn) and `TodoWrite` → `TaskCreate/TaskUpdate/TaskList/TaskGet` (task management). Use `isSubagentTool(name)` from `format-tool.ts` (backed by `SUBAGENT_TOOL_NAMES` Set) — do not inline `=== 'Task' || === 'Agent'`. `formatToolUse` and `getToolCategory` handle both old and new names.
- **`readLastCodexAssistantMessage` signature**: Takes `(filePath, parser: LineParser)` — not `verbose` bool like the Claude version. Parser is injected to avoid circular imports.
- **`createInteractiveSessionManager(displayController)`**: Module-level helper in `src/index.ts` shared by both `startClaudeInteractiveWatch` and `startCodexInteractiveWatch`. Do not duplicate this into each function.
- **`prefillExistingSubagents(detector, files)`**: Helper in `startCodexMultiWatch` that combines `registerExistingAgent` + `registerShortId` into one loop. Used in both init and `switchToSession` — do not inline back into separate loops.
- **`onTitleUpdate` is for interactive mode only**: In non-interactive multi-watch, the formatter already outputs `TITL Session renamed: "xxx"` via `onOutput`. Adding `onTitleUpdate` there causes duplicate output. Only interactive mode needs `onTitleUpdate` (to update `displayName` + refresh status line).
- **`findLatestMainSessionInProject` intentionally skips `customTitle`**: Auto-switch polling runs every 500ms. Reading JSONL content for title would be wasteful. Title is read on-demand via `readCustomTitle()` only when a switch actually happens.
- **Codex `findBySessionId` project filter matches file path, not cwd**: This is a known limitation. Codex file paths only contain date directories, so `-p` filtering in `findBySessionId` is effectively broken for Codex. `listSessions()` correctly filters on `session_meta.cwd`. `agent-pick` intentionally does NOT forward `-p` to the final tail command to avoid this issue.
- **`--list` is mutually exclusive with most tail-mode options**: `--interactive`, `--subagent`, `--pane`, `--with-subagents`, `--auto-switch`, `--raw`, `--all`, and `[session-id]` positional arg. It auto-sets `--no-follow`.
- **Workflow snapshot dedup**: `SnapshotWatcher` updates `lastJson` AFTER successful `JSON.parse`, not before (deviates from SPEC §8.2 reference code). This prevents an invalid write from poisoning the dedup cache so the next valid snapshot reload still fires `onChange`. See `src/claude-workflow/snapshot-watcher.ts:67-93`.
- **Workflow attachment lifecycle ordering** (`WorkflowAttachment.start()`): waitForTranscriptDir → journal FileWatcher (`markLiveMode` after initial dump completes — `FileWatcher.start()` awaits the initial read per `src/core/file-watcher.ts:49`) → initial agent scan → subagent dir watch → `SnapshotWatcher` (started LAST so onChange-triggered `stop('completed')` runs after journal history dump completes; see SPEC §10.2 R3-B4).
- **Workflow `_collectAndEnrichMainSessions` enriches BEFORE slice**: P2 changed Claude `listSessions` to enrich all collected main sessions before slicing to limit, fixing a latent slice-before-enrich bug where sessions with stale `mtime` but fresh internal `lastActivityTime` were silently dropped. Workflow snapshots already carry metadata so they skip enrich and are merged before final slice.
- **Workflow path A + path B dedup**: `WorkflowDetector.markRunIdKnown` is synchronous set check + insert. Whichever path arrives first wins; the other returns false silently. Path A failure rolls back `knownRunIds` so a future fs event (path B) can retry. See SPEC §9.1.1.
- **Workflow async_launched discriminator**: subagent (Agent tool) launches and Workflow launches both use `status: 'async_launched'`. The discriminator is presence of `runId` matching `wf_[0-9a-f]{8}-[0-9a-f]{3}` AND `transcriptDir`. `scriptPath`/`summary`/`taskId` are decoration — missing values don't reject the payload (CI-2 resilience). See `parseToolUseResult` in `src/agents/claude/claude-agent.ts`.
- **WorkflowAttachment.onStop callback prevents map leak**: when snapshot status `completed`/`failed` triggers `queueMicrotask(stop)`, the `onStop` callback removes the runId from the dispatcher's `wfAttachments` map. Without this, a long-lived `agent-tail claude` session running N workflows would leak N attachment references.
- **PaneManager FIFO with pinning** (P7 `openPaneEvictIfNeeded`): workflow journal pane is pinned via `pinAgent`; subagent panes use the evict-if-needed path. Eviction iterates `insertionOrder` (oldest first) for the first non-pinned candidate. All panes pinned → cap is "full" and new pane is silently skipped. `closePaneByAgentId` removes from `insertionOrder` AND `pinnedAgentIds`.
- **Workflow project field in `--list`**: `WorkflowSessionFinder.listSessions` sets `project` to the encoded project dir name (`-Users-x-code-foo`), matching the parent-dir convention used by main sessions. The path itself is `{baseDir}/{encodedDir}/{UUID}/workflows/wf_*.json` — `_parseSnapshotPath` derives encoded dir relative to `this.baseDir` (not by searching for literal `projects/`, which doesn't appear in test fixtures).
- **`ClaudeSessionFinder.workflowFinder` is a lazy getter**: re-creates the workflow finder whenever `this.baseDir` mutates. Existing tests inject `baseDir` via `(finder as { baseDir: string }).baseDir = tempDir` — without the lazy getter, the workflow finder would bind to the real `~/.claude/projects` and tests would pollute the user's session list.
- **`customTitle` in `listSessions()` uses tail-read**: Claude's `listSessions()` populates `customTitle` via `readCustomTitleFromTail()` (8KB tail-read), not the full-file `readCustomTitle()`. Other agents don't support custom titles.
- **`Bun.spawn` pipe chaining breaks fzf TTY**: Piping `listProc.stdout` directly to fzf's `stdin` via `Bun.spawn` prevents fzf from accessing `/dev/tty` for keyboard input (arrow keys show `^[[A`). Use `sh -c "cmd | fzf ..."` instead — the shell handles pipe setup while fzf gets proper TTY access. See `buildShellCommand()` in `src/pick/fzf-helpers.ts`.
- **`drainParser` helper centralizes drain loops**: `src/utils/parser-drain.ts` exposes `drainParser(parser, line, onEach, { drainArg? })` with a 100-iteration guard. Used by `summary.ts:parseAndFormat` (passes `drainArg: ''` so stateless parsers like Codex/Gemini return null immediately instead of re-emitting up to the guard) and 4 cursor callsites in `src/index.ts` (default `drainArg: line`; cursor's `lastProcessedLine` dedup makes that safe). Rule: if a callsite might receive a stateless parser, pass `drainArg: ''`; otherwise the default is fine.
- **PaneManager logging belongs inside PaneManager, not in callbacks**: `onSubagentEnter` fires on every `agent_progress` event (repeatedly). Logging pane state in the callback causes duplicate messages. Instead, pass `logger` to `PaneManager` constructor; `openPane()` and `closePaneByAgentId()` log only when actually acting (after dedup checks). `openPane()` also re-throws errors so callers can surface `Failed to open pane` warnings.

## Code Quality

- **ESLint**: v9 flat config (`eslint.config.js`) with TypeScript support
- **Prettier**: Code formatting (`prettier.config.js`)
- **Husky + lint-staged**: Pre-commit hooks auto-run lint and format on staged `.ts` files
