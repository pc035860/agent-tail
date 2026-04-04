/**
 * agent-pick: Interactive session browser for agent-tail
 *
 * Lists sessions via agent-tail --list, pipes to fzf with preview,
 * then launches agent-tail on the selected session.
 */
import { parseArgs } from '../cli/parser.ts';
import {
  checkFzfAvailable,
  buildFzfArgs,
  parseSelection,
  resolveAgentTailPath,
} from './fzf-helpers.ts';

function buildListArgs(
  agentTailPath: string,
  agentType: string,
  options: { project?: string; lines?: number }
): string[] {
  const args = [agentTailPath, agentType, '--list'];
  if (options.project) args.push('-p', options.project);
  if (options.lines) args.push('-n', String(options.lines));
  return args;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0]?.startsWith('-')) {
    console.error('Usage: agent-pick <agent-type> [-p project] [-n count]');
    console.error('Agent types: claude, codex, gemini, cursor');
    process.exit(1);
  }

  const agentType = rawArgs[0]!;
  const validTypes = ['claude', 'codex', 'gemini', 'cursor'];
  if (!validTypes.includes(agentType)) {
    console.error(
      `Error: Invalid agent type "${agentType}". Use: ${validTypes.join(', ')}`
    );
    process.exit(1);
  }

  const options = parseArgs(['node', 'agent-tail', ...rawArgs, '--list']);
  const agentTailPath = resolveAgentTailPath();
  const listArgs = buildListArgs(agentTailPath, agentType, options);

  if (!checkFzfAvailable()) {
    console.error(
      'fzf not found. Install it for interactive session browsing.'
    );
    console.error('Falling back to plain list output...\n');

    const proc = Bun.spawn(listArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    process.exit(await proc.exited);
  }

  const listProc = Bun.spawn(listArgs, {
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const fzfArgs = buildFzfArgs({
    agentType: options.agentType,
    agentTailPath,
    project: options.project,
    limit: options.lines,
  });

  const fzfProc = Bun.spawn(['fzf', ...fzfArgs], {
    stdin: listProc.stdout,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const fzfExitCode = await fzfProc.exited;

  // fzf exit 1 = Esc (no selection), 130 = Ctrl-C
  if (fzfExitCode === 1 || fzfExitCode === 130) process.exit(0);
  if (fzfExitCode === 2) {
    console.error('fzf encountered an error.');
    process.exit(2);
  }
  if (fzfExitCode !== 0) process.exit(fzfExitCode);

  const output = await new Response(fzfProc.stdout).text();
  const shortId = parseSelection(output);
  if (!shortId) process.exit(0);

  // Don't forward -p: shortId is already unique from the project-filtered list,
  // and Codex's findBySessionId filters on file path (not cwd), which would fail.
  const tailProc = Bun.spawn([agentTailPath, agentType, shortId], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(await tailProc.exited);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
