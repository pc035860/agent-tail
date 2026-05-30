/**
 * Interactive keyboard handler — shared by all interactive watch modes:
 *   - startClaudeMultiWatch (interactive)
 *   - startCodexInteractiveWatch
 *   - startCursorInteractiveWatch
 *   - startClaudeWorkflowInteractiveWatch
 *
 * Two-layer design:
 *   - dispatchKey: pure key → action lookup, no side effects (unit testable)
 *   - installInteractiveKeyboard: thin glue that wires process.stdin to
 *     dispatchKey and the session manager / cleanup
 */

export interface KeyHandlers {
  onNext: () => void;
  onPrev: () => void;
  onQuit: () => void;
}

const TAB = '\t';
const SHIFT_TAB = '[Z';
const CTRL_C = '';

/**
 * Pure key → action dispatch. Returns nothing — calls the relevant handler
 * (if any) and lets unknown keys fall through silently.
 *
 * Bindings:
 *   Tab / n / N           → onNext
 *   Shift+Tab (ESC [ Z) / p / P → onPrev
 *   Ctrl-C / q / Q        → onQuit
 */
export function dispatchKey(key: string, handlers: KeyHandlers): void {
  if (key === CTRL_C || key === 'q' || key === 'Q') {
    handlers.onQuit();
    return;
  }
  if (key === TAB || key === 'n' || key === 'N') {
    handlers.onNext();
    return;
  }
  if (key === SHIFT_TAB || key === 'p' || key === 'P') {
    handlers.onPrev();
    return;
  }
}

/**
 * Install stdin keyboard handlers for an interactive watch. No-op when
 * stdin is not a TTY (caller's SIGINT cleanup still runs).
 *
 * Handlers are passed as a `{ onNext, onPrev, onQuit }` bag so the caller
 * controls binding semantics. This matters because some callers declare
 * `let sessionManager!: SessionManager` and assign it later inside
 * `buildInteractiveState`; reading `.switchNext` at install time would
 * capture `undefined`. Wrapping the read inside an arrow (e.g.
 * `() => sessionManager.switchNext()`) defers the property access to key-
 * press time, after assignment. Const-bound callers (the workflow watch)
 * are unaffected and may use the same shape.
 *
 * Restoring terminal state (`setRawMode(false)`) is the caller's
 * responsibility — keeps a single source of truth in each watch's
 * `cleanup`, which must already run on SIGINT in non-TTY environments.
 */
export function installInteractiveKeyboard(handlers: KeyHandlers): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    dispatchKey(key, handlers);
  });
}
