/**
 * Read the last custom-title from a Claude JSONL session file.
 * Scans from end for efficiency (last custom-title wins).
 *
 * @returns The customTitle string, or null if none found.
 */
export async function readCustomTitle(
  filePath: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    const content = await file.text();
    const lines = content.split('\n').filter(Boolean);

    // Scan from end — last custom-title is the current one
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      try {
        const data = JSON.parse(line);
        if (data.type === 'custom-title' && data.customTitle) {
          return data.customTitle as string;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return null;
  } catch {
    return null;
  }
}
