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

# Claude-specific options
agent-tail claude -s               # tail latest subagent log
agent-tail claude -s abc123        # tail specific subagent by ID
agent-tail claude -i               # interactive mode (Tab to switch sessions)
agent-tail claude --with-subagents # include subagent content in output
agent-tail claude -i --super       # super follow mode (auto-switch to latest session)
```

## Architecture

```
src/
├── index.ts                  # Entry point - orchestrates agents, formatters, and watchers
├── cli/parser.ts             # CLI argument parsing with commander
├── core/
│   ├── types.ts              # Shared types (AgentType, ParsedLine, SessionFile, CliOptions)
│   ├── file-watcher.ts       # Single file monitoring with tail -f behavior
│   ├── multi-file-watcher.ts # Multi-file monitoring (for subagent support)
│   └── session-manager.ts    # Session state management for interactive mode
├── agents/
│   ├── agent.interface.ts    # Agent, SessionFinder, LineParser interfaces
│   ├── codex/codex-agent.ts
│   ├── claude/claude-agent.ts
│   └── gemini/gemini-agent.ts
├── claude/                   # Claude-specific modules
│   ├── subagent-detector.ts  # Detect and monitor subagent sessions (with directory watch)
│   ├── super-follow.ts       # Find latest session in project for super follow mode
│   ├── output-handlers.ts    # Output handler implementations (console, display controller)
│   └── session-handlers.ts   # Session event handling
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
- SessionFinder locates session files in agent-specific directories:
  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - Claude: `~/.claude/projects/{encoded-path}/{UUID}.jsonl` with subagents in `subagents/agent-*.jsonl`
  - Gemini: `~/.gemini/tmp/<project_hash>/chats/session-*.json`
- FileWatcher supports two modes: JSONL (line-by-line) and JSON (whole-file, for Gemini)
- MultiFileWatcher manages multiple FileWatcher instances for subagent monitoring
- SessionManager tracks session states and buffers for interactive mode switching
- SubagentDetector handles early detection (Task tool_use) and fallback detection (toolUseResult)
- Formatters transform ParsedLine to output string (raw JSON or pretty colored)

**Adding a New Agent:**
1. Create `src/agents/<name>/<name>-agent.ts`
2. Implement SessionFinder (getBaseDir, findLatest) for the agent's log directory structure
3. Implement LineParser (parse) to handle the agent's log format
4. Export Agent class combining finder and parser
5. Add to AgentType union in `src/core/types.ts`
6. Add case in `src/index.ts` and `src/cli/parser.ts`

## Code Quality

- **ESLint**: v9 flat config (`eslint.config.js`) with TypeScript support
- **Prettier**: Code formatting (`prettier.config.js`)
- **Husky + lint-staged**: Pre-commit hooks auto-run lint and format on staged `.ts` files

