# agent-tail

Real-time log viewer for AI coding assistants. See what your AI is thinking and doing as it happens.

## What is this?

When you use AI coding assistants like **Claude Code**, **Codex**, **Gemini CLI**, or **Cursor**, they create session logs that record every conversation and action. These logs are stored in hidden folders and are hard to read.

**agent-tail** makes it easy to watch these logs in real-time, just like `tail -f` for regular log files. This helps you:

- See what the AI is doing right now
- Debug issues when the AI seems stuck
- Learn from the AI's reasoning process
- Monitor long-running AI tasks

## Quick Start

### Prerequisites

You need [Bun](https://bun.sh) installed. If you don't have it:

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

### Installation

```bash
# Clone the repository
git clone https://github.com/anthropics/agent-tail.git
cd agent-tail

# Install dependencies
bun install

# (Optional) Link globally to use 'agent-tail' command anywhere
bun link
```

After linking, you can use `agent-tail` directly instead of `bun start`:

```bash
agent-tail claude
agent-tail codex -p myproject
```

### Usage

```bash
# Watch Claude Code logs
bun start claude

# Watch Codex logs
bun start codex

# Watch Gemini CLI logs
bun start gemini

# Watch Cursor logs
bun start cursor

# Load a specific session by ID (partial match)
bun start claude abc123
```

That's it! You'll see a live stream of the AI's activity.

### Browse Past Sessions

List recent sessions and optionally browse them interactively with [fzf](https://github.com/junegunn/fzf):

```bash
# List recent sessions
agent-tail claude --list

# Interactive browser with preview (requires fzf)
agent-pick claude

# Filter by project
agent-pick codex -p myproject

# Forward extra tail flags after selection
agent-pick claude -v --with-subagents
```

`agent-pick` forwards extra `agent-tail` flags after you press Enter, but keeps list-only filters local (`-p/--project`, `-n/--lines`, and `--list`).

## Examples

### Basic Usage

```bash
# Start watching Claude Code
$ bun start claude
Searching for latest claude session...
Found: /Users/you/.claude/projects/-Users-you-myproject/abc123.jsonl
Modified: 1/1/2026, 10:30:00 AM
---
[10:30:01] user     What files are in this directory?
[10:30:02] function_call  Bash ls -la
[10:30:02] output   total 24
                    drwxr-xr-x  5 you staff  160 Jan  1 10:00 .
                    -rw-r--r--  1 you staff  256 Jan  1 10:00 package.json
[10:30:03] assistant There are 5 files in this directory...
Watching for changes... (Ctrl+C to stop)
```

### Filter by Project

If you have multiple projects, filter by name:

```bash
# Only show logs from projects containing "myapp"
bun start claude -p myapp
```

### Raw JSON Output

For debugging or piping to other tools:

```bash
# Output raw JSONL format
bun start claude --raw
```

### Show Everything

By default, long outputs are truncated. Use verbose mode to see everything:

```bash
# No truncation
bun start claude -v
```

### One-time Check

Don't follow new changes, just show what's already logged:

```bash
# Show existing logs and exit
bun start claude --no-follow
```

## Subagent Features (Claude, Codex & Cursor)

Claude Code, Codex, and Cursor support monitoring subagents (background tasks spawned by the main session).

### Watch Subagents

```bash
# Watch the latest subagent
bun start claude --subagent
bun start codex --subagent
bun start cursor --subagent

# Watch a specific subagent by ID
bun start claude --subagent abc123
bun start codex --subagent
bun start cursor --subagent 019cc375-5af5-7ed1-9ff8-8a5757d815d1
```

### Interactive Mode

Switch between main session and subagents in real-time:

```bash
# Start interactive mode
bun start claude -i
bun start codex -i
bun start cursor -i

# Press Tab to cycle through sessions
# Status line shows current session and available sessions
```

> **Note:** Interactive mode requires `--follow` (default) and cannot be used with `--subagent` or `--pane`.

### Include Subagent Output

Show both main session and subagent outputs together (sorted by time):

```bash
# Include all subagent content in output
bun start claude --with-subagents
bun start codex --with-subagents
bun start cursor --with-subagents
```

### Auto-Switch Mode

Automatically switch to the latest main session when new sessions start in the same project:

```bash
# Start auto-switch mode
bun start claude --auto-switch    # project-based
bun start codex --auto-switch     # cwd-based (with cache)
bun start gemini --auto-switch    # .project_root based
bun start cursor --auto-switch    # workspace-slug based

# The session will automatically switch when:
# - A new main session starts in the same project
# - Switch occurs after a 5-second delay to avoid instant switching
```

> **Note:** Can be used with or without interactive mode. Use with `--with-subagents` to include subagent content when switching. Use `-a` / `--all` for verbose + subagents + auto-switch combined. Supported for Claude, Codex, Gemini, and Cursor.

### Tmux Pane Mode

Automatically open a tmux pane for each new subagent, showing its output in a separate split:

```bash
# Auto-open tmux pane per subagent
bun start claude --pane
bun start codex --pane
bun start cursor --pane
```

> **Note:** Requires tmux environment. Cannot be combined with `--interactive` or `--subagent`. Automatically enables `--with-subagents`. Maximum 6 concurrent panes.

### Preset Override

The `--all` preset can be customized with negation flags:

```bash
# Enable all features except verbose (truncated output)
bun start claude --all --no-verbose

# Enable all features except auto-switch
bun start codex -a --no-auto-switch

# Enable all features except subagents
bun start claude --all --no-with-subagents
```

Negation flags override the preset, giving you fine-grained control while keeping the shortcut convenient.

## CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--raw` | | Output raw JSONL instead of formatted output |
| `--project <name>` | `-p` | Filter sessions by project name (fuzzy match) |
| `--verbose` | `-v` | Show full content without truncation |
| `--no-verbose` | | Show truncated content (default) |
| `--no-follow` | | Don't watch for new changes, just show existing content |
| `--quiet` | `-q` | Suppress non-error output messages |
| `--no-quiet` | | Show informational messages (default) |
| `--sleep-interval <ms>` | `-s` | Set file polling interval (100-60000ms, default: 500) |
| `--lines <number>` | `-n` | Number of initial lines to show per file (default: all). In `--list` mode: number of sessions |
| `--list` | `-l` | List recent sessions instead of tailing (tab-separated output) |
| `--subagent [id]` | | Claude/Codex/Cursor: tail subagent log (latest if no ID) |
| `--interactive` | `-i` | Claude/Codex/Cursor: interactive mode with Tab to switch sessions |
| `--no-interactive` | | Disable interactive mode (default) |
| `--with-subagents` | | Claude/Codex/Cursor: include subagent content in output |
| `--no-with-subagents` | | Exclude subagent content (default) |
| `--auto-switch` | | Auto-switch to latest session in project (all agents) |
| `--no-auto-switch` | | Disable auto-switch (default) |
| `--all` | `-a` | Claude/Codex/Cursor: show all content (verbose + subagents + auto-switch) |
| `--pane` | | Claude/Codex/Cursor: auto-open tmux pane for each new subagent |
| `--no-pane` | | Disable pane auto-open (default) |

**Positional Arguments:**
| Argument | Description |
|----------|-------------|
| `<agent-type>` | Required: `claude`, `codex`, `gemini`, or `cursor` |
| `[session-id]` | Optional: load specific session by ID (partial match supported) |

## How It Works

Each AI assistant stores its session logs in a specific location:

| Assistant | Log Location |
|-----------|--------------|
| Claude Code | `~/.claude/projects/{project}/{session}.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/{project}/chats/session-*.json` |
| Cursor | `~/.cursor/projects/{workspace}/agent-transcripts/{UUID}/{UUID}.jsonl` |

agent-tail automatically finds the most recent session and displays it in a readable format.

## Troubleshooting

### "No session file found"

This means the AI assistant hasn't created any logs yet. Make sure you've:
1. Used the AI assistant at least once
2. Specified the correct agent type (`claude`, `codex`, `gemini`, or `cursor`)

### Logs look garbled

Try the `--raw` option to see the original JSON. This helps identify parsing issues.

### Can't see recent activity

The log file might not be updating. Check if:
1. The AI session is still active
2. You're looking at the right project (use `-p` to filter)

## Development

```bash
# Run tests
bun test

# Type checking
bun run typecheck

# Run directly from source
bun run src/index.ts claude
```

## Requirements

- [Bun](https://bun.sh) runtime
- macOS or Linux (Windows not tested)

## License

MIT
