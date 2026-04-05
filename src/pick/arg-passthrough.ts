const STRIP_WITH_VALUE = new Set(['-n', '--lines', '-p', '--project']);
const STRIP_FLAGS = new Set(['-l', '--list']);
const STRIP_INLINE_PREFIXES = ['-n=', '--lines=', '-p=', '--project='];

function hasInlineValue(arg: string): boolean {
  return STRIP_INLINE_PREFIXES.some((prefix) => arg.startsWith(prefix));
}

function hasNextToken(nextArg: string | undefined): boolean {
  return nextArg !== undefined;
}

export function extractTailPassthroughArgs(rawArgs: string[]): string[] {
  if (rawArgs.length <= 1) return [];

  const passthrough: string[] = [];

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;

    if (STRIP_FLAGS.has(arg) || hasInlineValue(arg)) continue;

    if (STRIP_WITH_VALUE.has(arg)) {
      if (hasNextToken(rawArgs[i + 1])) i += 1;
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

    if (hasInlineValue(arg)) {
      listArgs.push(arg);
      continue;
    }

    if (!STRIP_WITH_VALUE.has(arg)) continue;

    listArgs.push(arg);
    if (hasNextToken(rawArgs[i + 1])) {
      listArgs.push(rawArgs[i + 1]!);
      i += 1;
    }
  }

  return listArgs;
}
