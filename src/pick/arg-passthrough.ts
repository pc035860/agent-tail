const LIST_OPTS_WITH_VALUE = ['-n', '--lines', '-p', '--project'] as const;
const STRIP_WITH_VALUE = new Set<string>(LIST_OPTS_WITH_VALUE);
const STRIP_FLAGS = new Set(['-l', '--list']);
const STRIP_INLINE_PREFIXES = LIST_OPTS_WITH_VALUE.map((o) => `${o}=`);

function hasInlineListOptionValue(arg: string): boolean {
  return STRIP_INLINE_PREFIXES.some((prefix) => arg.startsWith(prefix));
}

export function extractTailPassthroughArgs(rawArgs: string[]): string[] {
  if (rawArgs.length <= 1) return [];

  const passthrough: string[] = [];

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;

    if (STRIP_FLAGS.has(arg) || hasInlineListOptionValue(arg)) continue;

    if (STRIP_WITH_VALUE.has(arg)) {
      if (rawArgs[i + 1] !== undefined) i += 1;
      continue;
    }

    passthrough.push(arg);
  }

  return passthrough;
}

export function extractPickListArgs(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) return [];

  const listArgs = [rawArgs[0]!];

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;

    if (hasInlineListOptionValue(arg)) {
      listArgs.push(arg);
      continue;
    }

    if (!STRIP_WITH_VALUE.has(arg)) continue;

    listArgs.push(arg);
    const next = rawArgs[i + 1];
    if (next !== undefined) {
      listArgs.push(next);
      i += 1;
    }
  }

  return listArgs;
}
