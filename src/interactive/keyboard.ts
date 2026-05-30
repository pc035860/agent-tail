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

/** Subset of SessionManager surface used by the keyboard layer. */
export interface KeyboardSessionManager {
  switchNext(): void;
  switchPrev(): void;
}

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
 * stdin is not a TTY (cleanup is still expected to be invoked elsewhere
 * via SIGINT). Caller's `cleanup` should restore terminal state, including
 * `setRawMode(false)` — keep that behavior in cleanup, not here, so it
 * survives non-TTY environments and matches the pattern of the existing
 * interactive watches.
 */
export function installInteractiveKeyboard(
  sessionManager: KeyboardSessionManager,
  cleanup: () => void
): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    dispatchKey(key, {
      onNext: () => sessionManager.switchNext(),
      onPrev: () => sessionManager.switchPrev(),
      onQuit: () => {
        cleanup();
        process.exit(0);
      },
    });
  });
}
