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
│   └── watch-builder.ts      # Shared utilities (buildSubagentFiles, createSuperFollowController)
├── interactive/
│   └── display-controller.ts # Terminal UI for interactive mode (status line, history)
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

**Adding Super Follow to a New Agent:**
1. Implement `getProjectInfo(sessionPath)` - Return `{ projectDir, displayName }` for the session
2. Implement `findLatestInProject(projectDir)` - Find newest session in same project scope
3. Add agent-specific logic to `startSingleWatch` in `src/index.ts`

**Gotchas:**
- **Gemini parser has state** (`processedMessageIds`). Must recreate parser when switching sessions to avoid message skip bugs.
- **`Bun.file(dir).exists()` returns false for directories**. Use `stat(dir)` instead.
- **Codex cache only scans "today"** for incremental refresh. Cross-midnight sessions handled on next startup.

## Code Quality

- **ESLint**: v9 flat config (`eslint.config.js`) with TypeScript support
- **Prettier**: Code formatting (`prettier.config.js`)
- **Husky + lint-staged**: Pre-commit hooks auto-run lint and format on staged `.ts` files
