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
 * The matching `uninstallInteractiveKeyboard()` restores cooked mode and
 * should be invoked from each watch's `cleanup` (mirroring install).
 */
// Module-level listener ref so uninstall can `off()` what install registered.
// Safe because every interactive watch installs at most once per process
// lifetime (each watch reaches `cleanup → process.exit(0)` before returning,
// and we don't compose multiple interactive watches in one run).
let installedHandler: ((key: string) => void) | null = null;

export function installInteractiveKeyboard(handlers: KeyHandlers): void {
  if (!process.stdin.isTTY) return;

  // Defensive: if a prior install ran without uninstall (shouldn't happen
  // in current callers, but cheap insurance against double-install bugs),
  // remove the previous listener first so we don't leak it.
  if (installedHandler) {
    process.stdin.off('data', installedHandler);
    installedHandler = null;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  installedHandler = (key: string): void => dispatchKey(key, handlers);
  process.stdin.on('data', installedHandler);
}

/**
 * Restore the terminal to cooked mode and remove the `data` listener
 * registered by `installInteractiveKeyboard`. No-op when stdin is not a TTY
 * (or when no install ran) — safe to call unconditionally from `cleanup`
 * paths that also fire in non-interactive (piped) environments.
 */
export function uninstallInteractiveKeyboard(): void {
  if (installedHandler) {
    process.stdin.off('data', installedHandler);
    installedHandler = null;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

/**
 * Register a SIGINT handler whose cleanup body is supplied **later** via
 * the returned `setCleanup` callback. Solves the startup race window where
 * `displayController.init()` has already entered the terminal's alt
 * screen/scroll region but the watch's `cleanup` body isn't yet declared:
 * a Ctrl-C in that window would otherwise hit Node's default SIGINT
 * (`process.exit(1)` with no cleanup), leaving the terminal in scroll
 * region / status-line state.
 *
 * Call this at the top of each interactive watch (before any
 * `displayController.init()` or `await`), then call `setCleanup(...)` once
 * the body's dependencies (superFollow / detector / multiWatcher / etc.)
 * are bound.
 */
export function registerInteractiveCleanup(): {
  setCleanup: (fn: () => void) => void;
} {
  let cleanup: (() => void) | undefined;
  process.on('SIGINT', () => {
    cleanup?.();
    process.exit(0);
  });
  return {
    setCleanup: (fn: () => void) => {
      cleanup = fn;
    },
  };
}
