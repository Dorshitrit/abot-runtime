/** Self-contained trusted task, run with an already verified directory cwd. */
export async function sampleDirectoryTask(
  input: Readonly<{ maxEntries: number }>,
): Promise<
  Readonly<{
    entries: readonly string[];
    truncated: boolean;
  }>
> {
  const { opendir } =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const entries: string[] = [];
  const directory = await opendir(".");
  for await (const entry of directory) {
    if (entries.length >= input.maxEntries) {
      entries.sort((left, right) => left.localeCompare(right));
      return { entries, truncated: true };
    }
    entries.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }
  entries.sort((left, right) => left.localeCompare(right));
  return { entries, truncated: false };
}
