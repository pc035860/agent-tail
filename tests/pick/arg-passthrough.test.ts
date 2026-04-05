import { describe, test, expect } from 'bun:test';
import {
  extractPickListArgs,
  extractTailPassthroughArgs,
} from '../../src/pick/arg-passthrough';

describe('extractTailPassthroughArgs', () => {
  test('forwards supported tail flags', () => {
    const result = extractTailPassthroughArgs([
      'claude',
      '-v',
      '--with-subagents',
      '--raw',
      '-q',
      '--auto-switch',
      '-s',
      '200',
    ]);

    expect(result).toEqual([
      '-v',
      '--with-subagents',
      '--raw',
      '-q',
      '--auto-switch',
      '-s',
      '200',
    ]);
  });

  test('strips project and lines options with values', () => {
    const result = extractTailPassthroughArgs([
      'codex',
      '-p',
      'myproject',
      '-n',
      '50',
      '-v',
    ]);

    expect(result).toEqual(['-v']);
  });

  test('strips long options with inline values', () => {
    const result = extractTailPassthroughArgs([
      'claude',
      '--project=myproject',
      '--lines=20',
      '--with-subagents',
    ]);

    expect(result).toEqual(['--with-subagents']);
  });

  test('strips short options with inline values', () => {
    const result = extractTailPassthroughArgs([
      'codex',
      '-p=myproject',
      '-n=20',
      '--raw',
    ]);

    expect(result).toEqual(['--raw']);
  });

  test('keeps value-carrying options that should pass through', () => {
    const result = extractTailPassthroughArgs([
      'cursor',
      '--project',
      'workspace',
      '--sleep-interval',
      '300',
      '--pane',
    ]);

    expect(result).toEqual(['--sleep-interval', '300', '--pane']);
  });

  test('strips list flags from passthrough args', () => {
    const result = extractTailPassthroughArgs(['claude', '--list', '-l', '-v']);

    expect(result).toEqual(['-v']);
  });

  test('greedily consumes next token for required-value options', () => {
    const result = extractTailPassthroughArgs(['claude', '-p', '-v']);
    expect(result).toEqual([]);
  });
});

describe('extractPickListArgs', () => {
  test('keeps only list-related options for parser', () => {
    const result = extractPickListArgs([
      'claude',
      '-v',
      '--with-subagents',
      '-p',
      'proj',
      '--lines=30',
      '--raw',
    ]);

    expect(result).toEqual(['claude', '-p', 'proj', '--lines=30']);
  });

  test('keeps inline short list options', () => {
    const result = extractPickListArgs([
      'codex',
      '-p=myproject',
      '-n=10',
      '-a',
    ]);

    expect(result).toEqual(['codex', '-p=myproject', '-n=10']);
  });

  test('keeps option-like token as required option value', () => {
    const result = extractPickListArgs(['claude', '-p', '-v', '--raw']);
    expect(result).toEqual(['claude', '-p', '-v']);
  });
});
