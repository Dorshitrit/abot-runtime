import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { InformationBasketError, type BasketFilePage } from "./contracts.js";
import { isBasketSupportedPath } from "./source-reader.js";

async function directoryAvailable(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function selectBasketDirectory(defaultDirectory: string, requested?: string): Promise<string> {
  const path = requested ?? (await directoryAvailable(defaultDirectory) ? defaultDirectory : homedir());
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 4_096)
    throw new InformationBasketError("basket_directory_absolute_required");
  try {
    const canonical = await realpath(path);
    if (!await directoryAvailable(canonical)) throw new Error("directory_required");
    return canonical;
  } catch { throw new InformationBasketError("basket_directory_not_found", undefined, 404); }
}

export async function browseBasketFiles(
  defaultDirectory: string,
  input: Readonly<{ path?: string; cursor?: string }> = {},
): Promise<BasketFilePage> {
  const directory = await selectBasketDirectory(defaultDirectory, input.path);
  const entries: BasketFilePage["entries"][number][] = [];
  try {
    const stream = await opendir(directory);
    let visited = 0;
    for await (const entry of stream) {
      if (++visited > 20_000) throw new InformationBasketError("basket_directory_entry_limit");
      const path = join(directory, entry.name);
      const info = entry.isSymbolicLink() ? await stat(path).catch(() => undefined) : entry;
      if (!info || (!info.isFile() && !info.isDirectory())) continue;
      const kind = info.isDirectory() ? "directory" as const : "file" as const;
      entries.push(Object.freeze({ name: entry.name, path, kind,
        supported: kind === "directory" || isBasketSupportedPath(path) }));
    }
  } catch (error) {
    if (error instanceof InformationBasketError) throw error;
    throw new InformationBasketError("basket_directory_unreadable", undefined, 403);
  }
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  let start = 0;
  if (input.cursor) {
    const previous = entries.findIndex(entry => entry.name === input.cursor);
    if (previous < 0) throw new InformationBasketError("basket_directory_cursor_stale", undefined, 409);
    start = previous + 1;
  }
  const page = entries.slice(start, start + 100);
  const candidates = [
    { label: "Default workspace", path: defaultDirectory },
    { label: "Home", path: homedir() },
    { label: "Filesystem", path: parse(directory).root },
  ];
  const roots = [];
  for (const root of candidates) if (await directoryAvailable(root.path)) roots.push(root);
  const parent = dirname(directory);
  return Object.freeze({
    directory, parent: parent === directory ? null : parent, entries: Object.freeze(page),
    nextCursor: start + page.length < entries.length ? page.at(-1)!.name : null,
    roots: Object.freeze(roots), hostPlatform: process.platform,
  });
}
