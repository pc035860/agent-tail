/**
 * Minimal terminal-cell width helpers.
 *
 * Why hand-rolled:
 * - `string.length` counts JS code units, which over-counts surrogate pairs
 *   and under-counts wide CJK characters (1 char in JS = 2 cells in terminal).
 * - ANSI color escapes (`\x1b[…m`) are zero-width but count in `.length`.
 *
 * Scope is intentionally narrow: just the cases the `--list` formatter sees —
 * ASCII, common CJK (Han / Hiragana / Katakana / Hangul / fullwidth),
 * and chalk-style SGR escape sequences. Not a full Unicode width table.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI SGR escape sequences (chalk colors / dims / italics / etc.). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Wide (2-cell) code-point ranges covering common CJK + fullwidth + emoji.
 * Each entry is [start, end] inclusive. ORDERED BY START — `isWide` relies
 * on the order for early-exit short-circuit.
 */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals / Kangxi
  [0x3041, 0x33ff], // Hiragana / Katakana / CJK symbols
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f9ff], // Misc symbols / emoji
  [0x20000, 0x2fffd], // CJK Extension B–F
  [0x30000, 0x3fffd], // CJK Extension G
];

function isWide(codePoint: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (codePoint < lo) return false;
    if (codePoint <= hi) return true;
  }
  return false;
}

/** Visible (terminal-cell) width of a string, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Skip C0/C1 control chars except already-stripped escapes
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/**
 * Pad `s` with trailing spaces until its visible width reaches `targetWidth`.
 * If already at or beyond, returns the string unchanged (no truncation).
 */
export function padVisibleEnd(s: string, targetWidth: number): string {
  const w = visibleWidth(s);
  if (w >= targetWidth) return s;
  return s + ' '.repeat(targetWidth - w);
}

/**
 * Truncate `s` so its visible width is at most `maxWidth`, appending `ellipsis`
 * (default `…`, 1 cell) when truncation happens. Strips ANSI from the input
 * because mixing color + truncation safely is out of scope for this helper.
 */
export function truncateVisible(
  s: string,
  maxWidth: number,
  ellipsis = '…'
): string {
  const plain = stripAnsi(s);
  const fullW = visibleWidth(plain);
  if (fullW <= maxWidth) return plain;

  const ellipsisW = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisW);
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}
