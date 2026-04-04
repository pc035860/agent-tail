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

  test('includes --with-nth 2..', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/usr/local/bin/agent-tail',
    });
    expect(args).toContain('--with-nth');
    const idx = args.indexOf('--with-nth');
    expect(args[idx + 1]).toBe('2..');
  });

  test('includes --preview with agent-tail command', () => {
    const args = buildFzfArgs({
      agentType: 'claude',
      agentTailPath: '/path/to/agent-tail',
    });
    expect(args).toContain('--preview');
    const previewIdx = args.indexOf('--preview');
    const previewCmd = args[previewIdx + 1]!;
    expect(previewCmd).toContain('/path/to/agent-tail');
    expect(previewCmd).toContain('claude');
    expect(previewCmd).toContain('{1}');
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

describe('parseSelection', () => {
  test('extracts shortId from tab-separated line', () => {
    const result = parseSelection('abc12345\t3m ago\tclaude\tmy-project\n');
    expect(result).toBe('abc12345');
  });

  test('returns null for empty output (user pressed Esc)', () => {
    expect(parseSelection('')).toBeNull();
    expect(parseSelection('\n')).toBeNull();
  });

  test('handles output with trailing newline', () => {
    const result = parseSelection('def67890\t1h ago\tcodex\tapi-server\n');
    expect(result).toBe('def67890');
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
