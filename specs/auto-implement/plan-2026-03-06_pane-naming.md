# Plan: Tmux Pane Naming

## Overview

When `--pane` mode auto-opens tmux panes for subagents, name each pane with the Task's `description` field (the 3-5 word summary visible in `[Agent] description...` output). This helps users identify what each pane is doing at a glance.

**Approach**: FIFO queue matches Task tool_use descriptions to newly detected subagents. Since Tasks are typically sequential, FIFO ordering provides correct matching in most cases. Parallel Task launches may mismatch — this is a known limitation (wrong label only, non-destructive).

## Implementation Steps

### Step 1: Extend ParsedLine to carry task description

**File**: `src/core/types.ts`

- Add optional `taskDescription?: string` to `ParsedLine` interface
- Used when `isTaskToolUse` is true

### Step 2: Extract description from Task tool_use

**File**: `src/agents/claude/claude-agent.ts`

- In `parseAssistantPart()` (line ~502), when `part.type === 'tool_use' && part.name === 'Task'`:
  - Extract `part.input.description` with type guard: `const desc = typeof part.input?.description === 'string' ? part.input.description : undefined`
  - Set `taskDescription` on the returned `ParsedLine`

### Step 3: Add description queue to SubagentDetector

**File**: `src/claude/subagent-detector.ts`

- Add `private pendingDescriptions: string[]` queue to `SubagentDetector`
- Add `pushDescription(description: string): void` — push to queue
- In `registerNewAgent()`, pop from queue (`shift()`) and pass description to `onNewSubagent` callback
- Update `onNewSubagent` callback signature in **both** the method and `SubagentDetectorConfig` interface (line 72): `(agentId: string, subagentPath: string, description?: string) => void`
- Queue is uncapped for MVP (typically drains quickly); add comment noting this

### Step 4: Feed description from watch-builder

**File**: `src/claude/watch-builder.ts`

- In `createOnLineHandler()` (line ~131), when `isTaskToolUse` is true:
  - Guard: only call if `parsed.taskDescription` is defined
  - Call `config.detector.pushDescription(parsed.taskDescription)`
  - Must happen **before** `handleEarlyDetection()` so description is queued when scan triggers

### Step 5: Add renamePane to TerminalController

**File**: `src/terminal/terminal-controller.interface.ts`

- Add optional `renamePane?(paneId: string, title: string): Promise<void>` to `TerminalController`

**File**: `src/terminal/tmux-controller.ts`

- Implement `renamePane()` using `Bun.spawn` array form (matching existing pattern, no shell injection risk):
  ```ts
  const proc = Bun.spawn(['tmux', 'select-pane', '-t', paneId, '-T', title], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
  ```
- `await proc.exited` for consistency with existing TmuxController methods (closePane, applyLayout)
- Wrap in try-catch, silently ignore errors (tmux 2.6+ required, best-effort)

### Step 6: Thread description through PaneManager

**File**: `src/terminal/pane-manager.ts`

- Update `openPane(agentId, subagentPath, description?)` signature
- **Sanitize title**: replace control chars via `/[\x00-\x1f\x7f]/g` with space, strip `#` chars (tmux interprets `#()` sequences), `.trim()`, truncate to 50 chars
- Title format: `${shortId}: ${description}` (e.g., `a0627b6: memory search`)
- After successful `createPane()`, call `controller.renamePane(pane.id, title)` **before** the `pendingCloseAgentIds` check (between current lines 53 and 58)
- Wrap `renamePane` in try-catch — failure must not block pane tracking or close logic
- If no description provided, skip `renamePane` call

### Step 7: Wire up in index.ts

**File**: `src/index.ts`

- Update `onNewSubagent` callback to accept and forward `description` to `pm.openPane()`

## Trade-offs & Decisions

1. **FIFO queue vs exact matching**: FIFO is simpler and works for sequential Task launches. Parallel Tasks could mismatch, but this is rare and non-destructive (wrong label only). Future improvement: correlate by timestamp or tool_use_id.
2. **`select-pane -T` requires tmux 2.6+**: Acceptable since `--pane` already requires tmux. Best-effort — failure is silently ignored.
3. **Description on PaneInfo vs separate call**: Separate `renamePane()` call is cleaner — keeps `createPane` focused and rename is best-effort.
4. **NullController**: No changes needed — optional method, simply not implemented.
5. **Bun.spawn array form**: All tmux commands use array form to avoid shell injection. Title comes from LLM output and must not be interpolated into a shell string.
6. **renamePane as optional method**: Keeps `NullController` and future controllers simple. Call-site uses `controller.renamePane?.()`.

## Tests (TDD Blueprint)

### Test 1: ParsedLine carries taskDescription
- **Module**: `claude-agent.ts` parser
- **Input**: JSONL line with `tool_use` type, name `Task`, input `{ description: "memory search", prompt: "..." }`
- **Expected**: Parsed result has `isTaskToolUse: true` and `taskDescription: "memory search"`

### Test 2: taskDescription undefined when input.description missing or non-string
- **Module**: `claude-agent.ts` parser
- **Input**: Task tool_use with `input: { prompt: "..." }` (no description), or `input: { description: 123 }`
- **Expected**: `taskDescription` is `undefined`

### Test 3: SubagentDetector description queue (FIFO)
- **Module**: `subagent-detector.ts`
- **Input**: Push "desc A", "desc B". Register agent1, agent2.
- **Expected**: `onNewSubagent` called with agent1+"desc A", agent2+"desc B"
- **Edge case**: Register agent without any queued description -> `onNewSubagent` called with `undefined`

### Test 4: TmuxController.renamePane
- **Module**: `tmux-controller.ts`
- **Input**: `renamePane("%5", "a0627b6: memory search")`
- **Expected**: Spawns `Bun.spawn(['tmux', 'select-pane', '-t', '%5', '-T', 'a0627b6: memory search'])`
- **Edge case**: Command failure -> silently ignored (no throw)

### Test 5: PaneManager forwards description to renamePane
- **Module**: `pane-manager.ts`
- **Input**: `openPane("abc1234", "/path/to/agent.jsonl", "memory search")`
- **Expected**: After createPane succeeds, calls `controller.renamePane(paneId, "abc1234: memory search")`
- **Edge case**: No description -> renamePane not called

### Test 6: PaneManager renamePane failure does not block openPane
- **Module**: `pane-manager.ts`
- **Input**: Mock `renamePane` to throw. Call `openPane` with description.
- **Expected**: `openPane` still completes, pane is tracked in `this.panes`

### Test 7: Description sanitization
- **Module**: `pane-manager.ts`
- **Input**: Description with newlines, control chars, or 100+ chars
- **Expected**: Title is sanitized (control chars replaced with spaces, truncated to 50 chars)

### Test 8: watch-builder pushes description on Task tool_use
- **Module**: `watch-builder.ts`
- **Input**: ParsedLine with `isTaskToolUse: true`, `taskDescription: "explore codebase"`
- **Expected**: `detector.pushDescription("explore codebase")` is called
- **Edge case**: `taskDescription` undefined -> `pushDescription` not called

## Critical Files for Implementation

- `src/claude/subagent-detector.ts` - Description queue + updated onNewSubagent signature
- `src/terminal/pane-manager.ts` - Thread description to renamePane call + sanitization
- `src/terminal/tmux-controller.ts` - New renamePane method
- `src/claude/watch-builder.ts` - Extract and push description from parsed line
- `src/agents/claude/claude-agent.ts` - Extract taskDescription from tool_use input
