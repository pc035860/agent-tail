import { describe, test, expect } from 'bun:test';
import {
  cwdToClaudeProjectFilter,
  deriveWorkflowDirs,
  getClaudeProjectsRoot,
  getWorkflowAgentPath,
  getWorkflowJournalPath,
  getWorkflowRunDir,
  getWorkflowSnapshotPath,
  getWorkflowSubagentsDir,
  getWorkflowsDir,
  isValidWorkflowAgentId,
  isValidWorkflowRunId,
  makeWorkflowJournalSessionId,
  parseWorkflowAgentFilename,
  parseWorkflowSnapshotFilename,
} from '../../src/claude-workflow/paths.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('paths — getClaudeProjectsRoot', () => {
  test('returns ~/.claude/projects', () => {
    expect(getClaudeProjectsRoot()).toBe(
      join(homedir(), '.claude', 'projects')
    );
  });
});

describe('paths — getWorkflowsDir', () => {
  test('appends /workflows', () => {
    expect(getWorkflowsDir('/a/b/c')).toBe('/a/b/c/workflows');
  });
});

describe('paths — getWorkflowSubagentsDir', () => {
  test('appends /subagents/workflows', () => {
    expect(getWorkflowSubagentsDir('/a/b/c')).toBe(
      '/a/b/c/subagents/workflows'
    );
  });
});

describe('paths — getWorkflowRunDir', () => {
  test('appends /subagents/workflows/{runId}', () => {
    expect(getWorkflowRunDir('/a/b/c', 'wf_abcd1234-ef0')).toBe(
      '/a/b/c/subagents/workflows/wf_abcd1234-ef0'
    );
  });
});

describe('paths — getWorkflowSnapshotPath', () => {
  test('appends /workflows/{runId}.json', () => {
    expect(getWorkflowSnapshotPath('/a/b/c', 'wf_abcd1234-ef0')).toBe(
      '/a/b/c/workflows/wf_abcd1234-ef0.json'
    );
  });
});

describe('paths — getWorkflowJournalPath', () => {
  test('appends /subagents/workflows/{runId}/journal.jsonl', () => {
    expect(getWorkflowJournalPath('/a/b/c', 'wf_abcd1234-ef0')).toBe(
      '/a/b/c/subagents/workflows/wf_abcd1234-ef0/journal.jsonl'
    );
  });
});

describe('paths — getWorkflowAgentPath', () => {
  test('appends /subagents/workflows/{runId}/agent-{id}.jsonl', () => {
    expect(
      getWorkflowAgentPath('/a/b/c', 'wf_abcd1234-ef0', '01234567890abcdef')
    ).toBe(
      '/a/b/c/subagents/workflows/wf_abcd1234-ef0/agent-01234567890abcdef.jsonl'
    );
  });

  test('does NOT validate agentId — string concatenation only', () => {
    // Path helpers don't validate IDs; caller must call isValidWorkflowAgentId.
    expect(() => getWorkflowAgentPath('/a/b/c', 'wf_x', 'bogus')).not.toThrow();
    expect(getWorkflowAgentPath('/a/b/c', 'wf_x', 'bogus')).toBe(
      '/a/b/c/subagents/workflows/wf_x/agent-bogus.jsonl'
    );
  });
});

describe('paths — cwdToClaudeProjectFilter', () => {
  test('replaces all slashes with dashes', () => {
    expect(cwdToClaudeProjectFilter('/Users/x/code/foo')).toBe(
      '-Users-x-code-foo'
    );
  });

  test('empty cwd returns empty', () => {
    expect(cwdToClaudeProjectFilter('')).toBe('');
  });

  test('trailing slash produces trailing dash', () => {
    expect(cwdToClaudeProjectFilter('/Users/x/code/foo/')).toBe(
      '-Users-x-code-foo-'
    );
  });

  test('root slash returns dash', () => {
    expect(cwdToClaudeProjectFilter('/')).toBe('-');
  });

  test('relative path (no leading slash) keeps original positions', () => {
    expect(cwdToClaudeProjectFilter('Users/x')).toBe('Users-x');
  });
});

describe('paths — isValidWorkflowRunId', () => {
  test('accepts canonical wf_{8hex}-{3hex}', () => {
    expect(isValidWorkflowRunId('wf_6f7d9da9-37e')).toBe(true);
  });

  test('accepts boundary hex values (all-zero and all-f)', () => {
    expect(isValidWorkflowRunId('wf_00000000-000')).toBe(true);
    expect(isValidWorkflowRunId('wf_ffffffff-fff')).toBe(true);
  });

  test('rejects short prefix', () => {
    expect(isValidWorkflowRunId('wf_short')).toBe(false);
  });

  test('rejects missing wf_ prefix', () => {
    expect(isValidWorkflowRunId('6f7d9da9-37e')).toBe(false);
  });

  test('rejects uppercase hex', () => {
    expect(isValidWorkflowRunId('wf_6F7D9DA9-37E')).toBe(false);
  });

  test('rejects wrong segment lengths', () => {
    expect(isValidWorkflowRunId('wf_6f7d9da9-37')).toBe(false); // 2-hex tail
    expect(isValidWorkflowRunId('wf_6f7d9da-37e')).toBe(false); // 7-hex head
  });
});

describe('paths — isValidWorkflowAgentId', () => {
  test('accepts canonical 17-hex lowercase', () => {
    expect(isValidWorkflowAgentId('adca0c33ebe734c2d')).toBe(true);
  });

  test('accepts boundary 17-hex (all-zero and all-f)', () => {
    expect(isValidWorkflowAgentId('00000000000000000')).toBe(true);
    expect(isValidWorkflowAgentId('fffffffffffffffff')).toBe(true);
  });

  test('rejects 16-hex (too short)', () => {
    expect(isValidWorkflowAgentId('adca0c33ebe734c2')).toBe(false);
  });

  test('rejects 18-hex (too long)', () => {
    expect(isValidWorkflowAgentId('adca0c33ebe734c2da')).toBe(false);
  });

  test('rejects uppercase 17-hex', () => {
    expect(isValidWorkflowAgentId('ADCA0C33EBE734C2D')).toBe(false);
  });

  test('rejects non-hex characters', () => {
    expect(isValidWorkflowAgentId('zzca0c33ebe734c2d')).toBe(false);
  });
});

describe('paths — parseWorkflowSnapshotFilename', () => {
  test('valid snapshot filename returns runId', () => {
    expect(parseWorkflowSnapshotFilename('wf_6f7d9da9-37e.json')).toBe(
      'wf_6f7d9da9-37e'
    );
  });

  test('parses distinct runIds (not a hardcoded constant)', () => {
    expect(parseWorkflowSnapshotFilename('wf_00000000-000.json')).toBe(
      'wf_00000000-000'
    );
    expect(parseWorkflowSnapshotFilename('wf_deadbeef-cab.json')).toBe(
      'wf_deadbeef-cab'
    );
  });

  test('non-.json extension returns null', () => {
    expect(parseWorkflowSnapshotFilename('wf_6f7d9da9-37e.txt')).toBeNull();
  });

  test('missing wf_ prefix returns null', () => {
    expect(parseWorkflowSnapshotFilename('something.json')).toBeNull();
  });

  test('uppercase hex returns null', () => {
    expect(parseWorkflowSnapshotFilename('wf_6F7D9DA9-37E.json')).toBeNull();
  });
});

describe('paths — parseWorkflowAgentFilename', () => {
  test('valid agent filename returns 17-hex id', () => {
    expect(parseWorkflowAgentFilename('agent-01234567890abcdef.jsonl')).toBe(
      '01234567890abcdef'
    );
  });

  test('parses distinct agentIds (not a hardcoded constant)', () => {
    expect(parseWorkflowAgentFilename('agent-fffffffffffffffff.jsonl')).toBe(
      'fffffffffffffffff'
    );
    expect(parseWorkflowAgentFilename('agent-adca0c33ebe734c2d.jsonl')).toBe(
      'adca0c33ebe734c2d'
    );
  });

  test('wrong prefix returns null', () => {
    expect(
      parseWorkflowAgentFilename('subagent-01234567890abcdef.jsonl')
    ).toBeNull();
  });

  test('wrong id length returns null', () => {
    expect(parseWorkflowAgentFilename('agent-deadbeef.jsonl')).toBeNull();
  });

  test('non-.jsonl extension returns null', () => {
    expect(
      parseWorkflowAgentFilename('agent-01234567890abcdef.json')
    ).toBeNull();
  });
});

describe('paths — deriveWorkflowDirs', () => {
  const RUN_ID = 'wf_12345678-abc';

  test('extracts sessionDir + transcriptDir from canonical path', () => {
    const path = `/home/x/.claude/projects/-x/abc/workflows/${RUN_ID}.json`;
    expect(deriveWorkflowDirs(path, RUN_ID)).toEqual({
      sessionDir: '/home/x/.claude/projects/-x/abc',
      transcriptDir: `/home/x/.claude/projects/-x/abc/subagents/workflows/${RUN_ID}`,
    });
  });

  test('uses LAST `workflows` segment (defensive against project names)', () => {
    const path = `/home/u/workflows/.claude/projects/-x/abc/workflows/${RUN_ID}.json`;
    expect(deriveWorkflowDirs(path, RUN_ID)).toEqual({
      sessionDir: '/home/u/workflows/.claude/projects/-x/abc',
      transcriptDir: `/home/u/workflows/.claude/projects/-x/abc/subagents/workflows/${RUN_ID}`,
    });
  });

  test('returns null when path has no workflows segment', () => {
    expect(
      deriveWorkflowDirs('/tmp/not-a-claude-path.json', RUN_ID)
    ).toBeNull();
  });
});

describe('paths — makeWorkflowJournalSessionId', () => {
  test('returns wf:{runId}:journal (no brackets)', () => {
    expect(makeWorkflowJournalSessionId('wf_12345678-abc')).toBe(
      'wf:wf_12345678-abc:journal'
    );
  });
});
