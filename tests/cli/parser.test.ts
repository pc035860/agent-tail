import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { parseArgs } from '../../src/cli/parser';

describe('parseArgs', () => {
  // 保存原始 process.exit，在測試後恢復
  const originalExit = process.exit;
  let exitCode: number | undefined;

  afterEach(() => {
    process.exit = originalExit;
    exitCode = undefined;
  });

  describe('basic agent type parsing', () => {
    test('parses claude agent type', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude']);
      expect(options.agentType).toBe('claude');
    });

    test('parses codex agent type', () => {
      const options = parseArgs(['node', 'agent-tail', 'codex']);
      expect(options.agentType).toBe('codex');
    });

    test('parses gemini agent type', () => {
      const options = parseArgs(['node', 'agent-tail', 'gemini']);
      expect(options.agentType).toBe('gemini');
    });
  });

  describe('subagent option', () => {
    test('--subagent without value sets true', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--subagent']);
      expect(options.subagent).toBe(true);
    });

    test('--subagent with value sets string', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--subagent',
        'abc1234',
      ]);
      expect(options.subagent).toBe('abc1234');
    });

    test('--subagent combined with --project', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--subagent',
        '-p',
        'myproject',
      ]);
      expect(options.subagent).toBe(true);
      expect(options.project).toBe('myproject');
    });

    test('--subagent with id combined with --project', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--subagent',
        'abc1234',
        '-p',
        'myproject',
      ]);
      expect(options.subagent).toBe('abc1234');
      expect(options.project).toBe('myproject');
    });

    test('--subagent with non-claude agent exits with error', () => {
      // Mock process.exit to capture exit code
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      // Mock console.error to suppress error message
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        parseArgs(['node', 'agent-tail', 'codex', '--subagent'])
      ).toThrow('process.exit called');
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });

    test('--subagent with gemini agent exits with error', () => {
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        parseArgs(['node', 'agent-tail', 'gemini', '--subagent'])
      ).toThrow('process.exit called');
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });
  });

  describe('sleep-interval option', () => {
    test('--sleep-interval sets custom interval', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--sleep-interval',
        '1000',
      ]);
      expect(options.sleepInterval).toBe(1000);
    });

    test('-s sets sleep interval', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '-s', '2000']);
      expect(options.sleepInterval).toBe(2000);
    });

    test('defaults to 500ms', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude']);
      expect(options.sleepInterval).toBe(500);
    });

    test('rejects interval below 100ms', () => {
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        parseArgs(['node', 'agent-tail', 'claude', '--sleep-interval', '50'])
      ).toThrow('process.exit called');
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });

    test('rejects interval above 60000ms', () => {
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        parseArgs(['node', 'agent-tail', 'claude', '-s', '70000'])
      ).toThrow('process.exit called');
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });

    test('--subagent without -s still works', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--subagent']);
      expect(options.subagent).toBe(true);
      expect(options.sleepInterval).toBe(500);
    });
  });

  describe('other options', () => {
    test('--raw sets raw to true', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--raw']);
      expect(options.raw).toBe(true);
    });

    test('--verbose sets verbose to true', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '-v']);
      expect(options.verbose).toBe(true);
    });

    test('--no-follow sets follow to false', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--no-follow',
      ]);
      expect(options.follow).toBe(false);
    });

    // Note: Commander.js uses global state, which makes testing default values
    // unreliable after other tests have run. Default value behavior is implicitly
    // tested through the explicit option tests above.
  });

  describe('auto-switch option', () => {
    test('--auto-switch with --interactive sets autoSwitch to true', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--interactive',
        '--auto-switch',
      ]);
      expect(options.interactive).toBe(true);
      expect(options.autoSwitch).toBe(true);
    });

    test('--auto-switch without --interactive is allowed', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--auto-switch',
      ]);
      expect(options.autoSwitch).toBe(true);
      expect(options.interactive).toBe(false);
    });

    test('--auto-switch with non-claude agent exits with error', () => {
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        parseArgs([
          'node',
          'agent-tail',
          'codex',
          '--interactive',
          '--auto-switch',
        ])
      ).toThrow('process.exit called');
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });
  });

  describe('all preset option', () => {
    test('--all expands to verbose, with-subagents, and auto-switch', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--all']);
      expect(options.verbose).toBe(true);
      expect(options.withSubagents).toBe(true);
      expect(options.autoSwitch).toBe(true);
    });

    test('-a is alias for --all', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '-a']);
      expect(options.verbose).toBe(true);
      expect(options.withSubagents).toBe(true);
      expect(options.autoSwitch).toBe(true);
    });

    test('--all with non-claude agent exits with error', () => {
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error('process.exit called');
      }) as typeof process.exit;

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(() => parseArgs(['node', 'agent-tail', 'codex', '--all'])).toThrow(
        'process.exit called'
      );
      expect(exitCode).toBe(1);

      consoleSpy.mockRestore();
    });
  });

  describe('lines option', () => {
    test('--lines sets custom line count', () => {
      const options = parseArgs([
        'node',
        'agent-tail',
        'claude',
        '--lines',
        '10',
      ]);
      expect(options.lines).toBe(10);
    });

    test('-n sets line count', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '-n', '20']);
      expect(options.lines).toBe(20);
    });

    test('defaults to undefined', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude']);
      expect(options.lines).toBeUndefined();
    });
  });

  describe('quiet option', () => {
    test('--quiet sets quiet to true', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--quiet']);
      expect(options.quiet).toBe(true);
    });

    test('-q sets quiet to true', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '-q']);
      expect(options.quiet).toBe(true);
    });

    test('--no-quiet sets quiet to false', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude', '--no-quiet']);
      expect(options.quiet).toBe(false);
    });

    test('quiet defaults to false', () => {
      const options = parseArgs(['node', 'agent-tail', 'claude']);
      expect(options.quiet).toBe(false);
    });
  });
});
