import type { LineParser } from '../agents/agent.interface.ts';
import type { ParsedLine } from '../core/types.ts';

/** Max iterations per JSONL line; protects against runaway stateful parsers. */
const DRAIN_GUARD_MAX = 10000;

/**
 * Drain a stateful LineParser for a single JSONL line.
 *
 * Stateful parsers (Claude, Cursor) may emit multiple ParsedLines from one
 * input line via internal state (e.g. text + several tool_use parts). Caller
 * drains by repeated parse() calls until null.
 *
 * - First call uses `line`.
 * - Subsequent calls use `options.drainArg` (defaults to `line`). Pass `''`
 *   when stateless parsers might be mixed in — empty string makes them return
 *   null immediately instead of re-yielding the same parse on every iteration.
 */
export function drainParser(
  parser: LineParser,
  line: string,
  onEach: (parsed: ParsedLine) => void,
  options: { drainArg?: string } = {}
): void {
  const drainArg = options.drainArg ?? line;
  let parsed = parser.parse(line);
  let guard = 0;
  while (parsed && guard < DRAIN_GUARD_MAX) {
    onEach(parsed);
    parsed = parser.parse(drainArg);
    guard++;
  }
}
