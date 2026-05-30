/**
 * Interactive keyboard handler — shared by all interactive watch modes
 * (Claude main, Codex, Cursor, Claude workflow).
 *
 * Two-layer design:
 *   - dispatchKey(key, handlers): pure function — key string → action table
 *   - installInteractiveKeyboard(sessionManager, cleanup): wires process.stdin
 *     to dispatchKey + sessionManager + cleanup
 *
 * Tests focus on dispatchKey (the behavior); installInteractiveKeyboard is
 * a thin glue layer covered by a single smoke test.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  dispatchKey,
  installInteractiveKeyboard,
} from '../../src/interactive/keyboard';

// Use String.fromCharCode so the source is readable; the resulting byte
// sequence is exactly what an xterm-style TTY emits for these keys.
const TAB = '\t';
const SHIFT_TAB = String.fromCharCode(0x1b) + '[Z'; // ESC [ Z
const CTRL_C = String.fromCharCode(0x03);

interface MockHandlers {
  onNext: ReturnType<typeof mock>;
  onPrev: ReturnType<typeof mock>;
  onQuit: ReturnType<typeof mock>;
}

function makeHandlers(): MockHandlers {
  return {
    onNext: mock(() => undefined),
    onPrev: mock(() => undefined),
    onQuit: mock(() => undefined),
  };
}

describe('dispatchKey — next', () => {
  test('Tab → onNext', () => {
    const h = makeHandlers();
    dispatchKey(TAB, h);
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
  });

  test('lowercase n → onNext', () => {
    const h = makeHandlers();
    dispatchKey('n', h);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  test('uppercase N → onNext', () => {
    const h = makeHandlers();
    dispatchKey('N', h);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchKey — prev', () => {
  test('Shift+Tab (ESC [ Z) → onPrev', () => {
    const h = makeHandlers();
    dispatchKey(SHIFT_TAB, h);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
    expect(h.onNext).not.toHaveBeenCalled();
  });

  test('lowercase p → onPrev', () => {
    const h = makeHandlers();
    dispatchKey('p', h);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
  });

  test('uppercase P → onPrev', () => {
    const h = makeHandlers();
    dispatchKey('P', h);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchKey — quit', () => {
  test('Ctrl-C → onQuit', () => {
    const h = makeHandlers();
    dispatchKey(CTRL_C, h);
    expect(h.onQuit).toHaveBeenCalledTimes(1);
    expect(h.onNext).not.toHaveBeenCalled();
  });

  test('lowercase q → onQuit', () => {
    const h = makeHandlers();
    dispatchKey('q', h);
    expect(h.onQuit).toHaveBeenCalledTimes(1);
  });

  test('uppercase Q → onQuit', () => {
    const h = makeHandlers();
    dispatchKey('Q', h);
    expect(h.onQuit).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchKey — unhandled keys', () => {
  test('arbitrary printable key triggers nothing', () => {
    const h = makeHandlers();
    dispatchKey('x', h);
    dispatchKey('1', h);
    dispatchKey(' ', h);
    expect(h.onNext).not.toHaveBeenCalled();
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
  });

  test('empty string triggers nothing', () => {
    const h = makeHandlers();
    dispatchKey('', h);
    expect(h.onNext).not.toHaveBeenCalled();
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
  });

  test('other escape sequences (e.g. arrow keys) trigger nothing', () => {
    const h = makeHandlers();
    const ESC = String.fromCharCode(0x1b);
    dispatchKey(ESC + '[A', h); // Up arrow
    dispatchKey(ESC + '[B', h); // Down arrow
    expect(h.onNext).not.toHaveBeenCalled();
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onQuit).not.toHaveBeenCalled();
  });
});

describe('installInteractiveKeyboard — glue layer', () => {
  test('exports a function that accepts a single handlers bag', () => {
    // Smoke test: the glue layer exists with the documented signature.
    // Behavior (TTY raw mode + listener registration) is exercised via
    // integration when the actual interactive watches run; we don't try
    // to mock process.stdin globally here.
    expect(typeof installInteractiveKeyboard).toBe('function');
    expect(installInteractiveKeyboard.length).toBe(1);
  });
});
