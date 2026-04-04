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

async function main(): Promise<void> {
  // Reuse the existing CLI parser but force --list mode
  // agent-pick claude [-p project] [-n count]
  const rawArgs = process.argv.slice(2);

  // Validate: need at least agent-type
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

  // Parse remaining options
  const options = parseArgs(['node', 'agent-tail', ...rawArgs, '--list']);

  // Check fzf availability
  if (!checkFzfAvailable()) {
    console.error(
      'fzf not found. Install it for interactive session browsing.'
    );
    console.error('Falling back to plain list output...\n');

    // Fallback: run agent-tail --list directly
    const agentTailPath = resolveAgentTailPath();
    const listArgs = [agentTailPath, agentType, '--list'];
    if (options.project) listArgs.push('-p', options.project);
    if (options.lines) listArgs.push('-n', String(options.lines));

    const proc = Bun.spawn(listArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  }

  // Run agent-tail --list and pipe to fzf
  const agentTailPath = resolveAgentTailPath();

  // Build the list command
  const listArgs = [agentTailPath, agentType, '--list'];
  if (options.project) listArgs.push('-p', options.project);
  if (options.lines) listArgs.push('-n', String(options.lines));

  // Spawn agent-tail --list to get session data
  const listProc = Bun.spawn(listArgs, {
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  // Build fzf args
  const fzfArgs = buildFzfArgs({
    agentType: options.agentType,
    agentTailPath,
    project: options.project,
    limit: options.lines,
  });

  // Spawn fzf with agent-tail --list output as stdin
  const fzfProc = Bun.spawn(['fzf', ...fzfArgs], {
    stdin: listProc.stdout,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const fzfExitCode = await fzfProc.exited;

  // Handle fzf exit codes
  if (fzfExitCode === 1 || fzfExitCode === 130) {
    // User pressed Esc (1) or Ctrl-C (130) — clean exit
    process.exit(0);
  }
  if (fzfExitCode === 2) {
    console.error('fzf encountered an error.');
    process.exit(2);
  }
  if (fzfExitCode !== 0) {
    process.exit(fzfExitCode);
  }

  // Parse selection
  const output = await new Response(fzfProc.stdout).text();
  const shortId = parseSelection(output);

  if (!shortId) {
    process.exit(0);
  }

  // Launch agent-tail with the selected session (forward -p if present)
  const tailArgs = [agentTailPath, agentType, shortId];
  if (options.project) tailArgs.push('-p', options.project);
  const tailProc = Bun.spawn(tailArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const tailExitCode = await tailProc.exited;
  process.exit(tailExitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
