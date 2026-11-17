import { lstat, readFile } from "node:fs/promises";
import type { SystemApplication, SystemApplicationExecutableResolution } from "./contracts.js";
import { isObservedRegularExecutable } from "./application-executable-file.js";

const SOURCE = "linux_desktop_exec" as const;
const DESKTOP_METADATA_LIMIT = 128_000;

export async function observeLinuxApplicationExecutable(
  application: SystemApplication,
  abortSignal?: AbortSignal,
): Promise<SystemApplicationExecutableResolution> {
  abortSignal?.throwIfAborted();
  let content: string;
  try {
    const file = await lstat(application.id);
    abortSignal?.throwIfAborted();
    if (!canReadDesktopExecutableMetadata(file))
      return unavailableLinuxExecutable("desktop_entry_unavailable");
    content = await readFile(application.id, { encoding: "utf8", ...(abortSignal ? { signal: abortSignal } : {}) });
    abortSignal?.throwIfAborted();
  } catch (error) {
    abortSignal?.throwIfAborted();
    if (isLinuxExecutableObservationAbort(error)) throw error;
    return unavailableLinuxExecutable("desktop_entry_unavailable");
  }
  if (Buffer.byteLength(content, "utf8") > DESKTOP_METADATA_LIMIT)
    return unavailableLinuxExecutable("desktop_entry_unavailable");
  const source = readDirectDesktopExecutable(content);
  if (source.status !== "resolved") return source;
  if (!await isObservedRegularExecutable(source.path, abortSignal))
    return unavailableLinuxExecutable("registered_target_unavailable");
  return source;
}

/** Conservative subset: one absolute executable and at most one file/URL placeholder. */
export function readDirectDesktopExecutable(content: string): SystemApplicationExecutableResolution {
  const sections = content.split(/^\[Desktop Entry\]\s*$/mu);
  if (sections.length !== 2) return unavailableLinuxExecutable("desktop_entry_invalid");
  const lines = sections[1]!.split(/^\[/mu)[0]!.split(/\r?\n/u);
  const commands = lines.filter((line) => /^Exec\s*=/u.test(line));
  if (commands.length > 1)
    return { status: "ambiguous", source: SOURCE, reason: "multiple_registered_targets" };
  if (commands.length === 0) return unavailableLinuxExecutable("desktop_exec_unavailable");
  const command = commands[0]!.slice(commands[0]!.indexOf("=") + 1).trim();
  const quoted = command.match(/^"(\/[^"\\%$`\0]+)"(?: +%[fFuU])?$/u);
  const simple = command.match(/^(\/[^\s"'\\%$`=<>~|&;*?#()\0]+)(?: +%[fFuU])?$/u);
  const path = quoted?.[1] ?? simple?.[1];
  if (!isDirectDesktopExecutablePath(path)) return unavailableLinuxExecutable("desktop_exec_requires_interpretation");
  return { status: "resolved", source: SOURCE, path };
}

function canReadDesktopExecutableMetadata(file: Awaited<ReturnType<typeof lstat>>): boolean {
  if (!file.isFile()) return false;
  if (file.isSymbolicLink()) return false;
  return file.size <= DESKTOP_METADATA_LIMIT;
}

function isDirectDesktopExecutablePath(path: string | undefined): path is string {
  if (!path) return false;
  return !path.includes("=");
}

function isLinuxExecutableObservationAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function unavailableLinuxExecutable(reason: string): SystemApplicationExecutableResolution {
  return { status: "unresolved", source: SOURCE, reason };
}
