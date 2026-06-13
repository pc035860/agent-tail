import { describe, test, expect } from 'bun:test';
import {
  buildFzfArgs,
  parseSelection,
  resolveAgentTailPath,
  checkFzfAvailable,
} from '../../src/pick/fzf-helpers';

describe('checkFzfAvailable', () => {
  test('returns a boolean', () => {
    const result = checkFzfAvailable();
    expect(typeof result).toBe('boolean');
  });
});

describe('buildFzfArgs', () => {
  test('includes --ansi flag', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/usr/local/bin/agent-tail',
    });
    expect(args).toContain('--ansi');
  });

  test('includes --delimiter with tab', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/usr/local/bin/agent-tail',
    });
    expect(args).toContain('--delimiter');
    const delimIdx = args.indexOf('--delimiter');
    expect(args[delimIdx + 1]).toBe('\t');
  });

  test('includes --with-nth 1..5 (shows first 5 cols, hides col 6 = HIDDEN_ID)', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/usr/local/bin/agent-tail',
    });
    expect(args).toContain('--with-nth');
    const idx = args.indexOf('--with-nth');
    expect(args[idx + 1]).toBe('1..5');
  });

  test('includes ctrl-y copy bind that pipes {6} (HIDDEN_FULL_ID) to pbcopy', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    const binds = args.filter((_, i) => i > 0 && args[i - 1] === '--bind');
    const copyBind = binds.find((b) => b.startsWith('ctrl-y:'));
    expect(copyBind).toBeDefined();
    expect(copyBind).toContain('pbcopy');
    expect(copyBind).toContain('{6}');
  });

  test('includes --preview with agent-tail command using {6} (HIDDEN_FULL_ID)', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--preview');
    const previewIdx = args.indexOf('--preview');
    const previewCmd = args[previewIdx + 1]!;
    expect(previewCmd).toContain('/path/to/agent-tail');
    expect(previewCmd).toContain('claude');
    expect(previewCmd).toContain('{6}');
    expect(previewCmd).toContain('--summary');
  });

  test('includes --preview-window', () => {
    const args = buildFzfArgs({
      agentType: 'codex',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--preview-window');
  });

  test('includes --header', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--header');
  });

  test('includes --prompt', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--prompt');
  });

  test('includes ctrl-r reload bind', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--bind');
    const binds = args.filter((_, i) => i > 0 && args[i - 1] === '--bind');
    const hasReload = binds.some((b) => b.includes('ctrl-r:reload'));
    expect(hasReload).toBe(true);
  });

  test('includes project filter in preview when provided', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
      project: 'myproj',
    });
    // Reload bind should include -p myproj
    const binds = args.filter((_, i) => i > 0 && args[i - 1] === '--bind');
    const reloadBind = binds.find((b) => b.includes('ctrl-r:reload'));
    expect(reloadBind).toContain('-p');
    expect(reloadBind).toContain('myproj');
  });
});

describe('parseSelection (col 6 = HIDDEN_FULL_ID per SPEC §11.4)', () => {
  test('extracts full UUID from col 6 of a main session row', () => {
    // 6 cols: TYPE \t ID \t TIME \t NOTES \t TITLE \t HIDDEN_FULL_ID
    const line =
      'sess\tabc12345\t3m ago\tmy-project\t—\tabc12345-1234-1234-1234-123456789abc\n';
    expect(parseSelection(line)).toBe('abc12345-1234-1234-1234-123456789abc');
  });

  test('extracts full runId from col 6 of a workflow row', () => {
    // 6 cols: TYPE \t ID \t TIME \t NOTES \t TITLE \t HIDDEN_FULL_ID
    const line =
      'wf\twf_abcd1234-37e\t7m ago\tcompleted · in session 5fe53568\twf:briefshare-impl\twf_abcd1234-37e\n';
    expect(parseSelection(line)).toBe('wf_abcd1234-37e');
  });

  test('returns null for empty output (user pressed Esc)', () => {
    expect(parseSelection('')).toBeNull();
    expect(parseSelection('\n')).toBeNull();
  });

  test('returns null when col 6 is missing (defensive)', () => {
    // only 5 cols — no HIDDEN_ID
    const line = 'sess\tabc12345\t3m ago\t(no custom title)\tmy-project\n';
    expect(parseSelection(line)).toBeNull();
  });
});

describe('resolveAgentTailPath', () => {
  test('returns a non-empty string', () => {
    const result = resolveAgentTailPath();
    expect(result.length).toBeGreaterThan(0);
  });

  test('path contains agent-tail', () => {
    const result = resolveAgentTailPath();
    expect(result).toContain('agent-tail');
  });
});
