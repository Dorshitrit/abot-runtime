import type { MemoryEntry } from "./types.js";

const OUTPUT_MAX_CHARS = 20_000;

export function renderEntries(
  entries: readonly MemoryEntry[],
  options: Readonly<{ heading: string; totalEntries: number }>,
): Readonly<{
  output: string;
  returnedEntries: number;
  truncated: boolean;
  outputMaxChars: number;
}> {
  const lines = [options.heading];
  let returnedEntries = 0;
  for (const entry of entries) {
    const next = [
      `${returnedEntries + 1}. [${entry.id}] ${entry.content}`,
      `   createdAt: ${entry.createdAt}`,
    ];
    const candidate = [...lines, ...next].join("\n");
    if (candidate.length > OUTPUT_MAX_CHARS) break;
    lines.push(...next);
    returnedEntries += 1;
  }
  if (returnedEntries === 0 && entries.length === 0)
    lines.push("No entries found.");
  let truncated =
    returnedEntries < entries.length || returnedEntries < options.totalEntries;
  while (truncated) {
    const marker = `[memory output bounded; ${Math.max(options.totalEntries - returnedEntries, 0)} entry or entries remain]`;
    if ([...lines, marker].join("\n").length <= OUTPUT_MAX_CHARS) {
      lines.push(marker);
      break;
    }
    if (returnedEntries === 0) {
      lines.length = 1;
      lines.push(marker.slice(0, OUTPUT_MAX_CHARS - lines[0]!.length - 1));
      break;
    }
    lines.splice(-2, 2);
    returnedEntries -= 1;
    truncated = true;
  }
  return Object.freeze({
    output: lines.join("\n"),
    returnedEntries,
    truncated,
    outputMaxChars: OUTPUT_MAX_CHARS,
  });
}
