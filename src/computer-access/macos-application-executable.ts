import { basename, join } from "node:path";
import type {
  SystemApplication,
  SystemApplicationExecutableResolution,
  SystemProcessResult,
  SystemProcessRunner,
} from "./contracts.js";
import { isObservedRegularExecutable } from "./application-executable-file.js";

const SOURCE = "macos_bundle_executable" as const;
const PLIST_METADATA_LIMIT = 128_000;

// NSDictionary reads the exact bundle plist. No bundle code is loaded or executed.
const BUNDLE_EXECUTABLE_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  return JSON.stringify(JSON.parse(argv[0]).map(function(id) {
    try {
      var metadataPath = $(id + '/Contents/Info.plist');
      var attributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError(metadataPath, null);
      if (!attributes) return {id:id};
      if (ObjC.unwrap(attributes.objectForKey('NSFileType')) !== 'NSFileTypeRegular') return {id:id};
      if (Number(ObjC.unwrap(attributes.objectForKey('NSFileSize'))) > ${PLIST_METADATA_LIMIT}) return {id:id};
      var info = $.NSDictionary.dictionaryWithContentsOfFile(metadataPath);
      if (!info) return {id:id};
      var value = info.objectForKey('CFBundleExecutable');
      return {id:id, executable:value ? ObjC.unwrap(value) : null};
    } catch (_) { return {id:id}; }
  }));
}`;

export async function observeMacApplicationExecutables(
  applications: readonly SystemApplication[],
  run: SystemProcessRunner,
  abortSignal?: AbortSignal,
): Promise<readonly SystemApplicationExecutableResolution[]> {
  abortSignal?.throwIfAborted();
  if (applications.length === 0) return [];
  const result = await run({
    executable: "/usr/bin/osascript",
    args: ["-l", "JavaScript", "-e", BUNDLE_EXECUTABLE_SCRIPT,
      JSON.stringify(applications.map(({ id }) => id))],
    timeoutMs: 15_000,
    outputMaxChars: 512_000,
    ...(abortSignal ? { abortSignal } : {}),
  }).catch((error: unknown) => {
    abortSignal?.throwIfAborted();
    if (isMacExecutableObservationAbort(error)) throw error;
    return undefined;
  });
  abortSignal?.throwIfAborted();
  if (result?.status === "aborted")
    throw new DOMException("Application executable observation aborted.", "AbortError");
  if (!hasCompleteMacExecutableSource(result))
    return applications.map(() => unavailableMacExecutable("source_unavailable"));
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); }
  catch { return applications.map(() => unavailableMacExecutable("source_invalid")); }
  if (!Array.isArray(rows)) return applications.map(() => unavailableMacExecutable("source_invalid"));
  const sourceRows = rows;
  return Promise.all(applications.map(({ id }) => resolveMacExecutable(id, sourceRows, abortSignal)));
}

async function resolveMacExecutable(
  id: string,
  rows: readonly unknown[],
  abortSignal?: AbortSignal,
): Promise<SystemApplicationExecutableResolution> {
  abortSignal?.throwIfAborted();
  const matches = rows.filter((row) => hasExactBundleExecutableIdentity(row, id));
  if (matches.length > 1)
    return { status: "ambiguous", source: SOURCE, reason: "multiple_registered_targets" };
  if (matches.length === 0) return unavailableMacExecutable("source_invalid");
  const name = (matches[0] as Record<string, unknown>).executable;
  if (!isBundleExecutableBasename(name)) return unavailableMacExecutable("bundle_executable_unavailable");
  const path = join(id, "Contents", "MacOS", name);
  if (!await isObservedRegularExecutable(path, abortSignal)) return unavailableMacExecutable("registered_target_unavailable");
  return { status: "resolved", source: SOURCE, path };
}

function isBundleExecutableBasename(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > 4096) return false;
  if (value === ".") return false;
  if (value === "..") return false;
  if (value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  return basename(value) === value;
}

function hasExactBundleExecutableIdentity(value: unknown, id: string): boolean {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (!("id" in value)) return false;
  return value.id === id;
}

function hasCompleteMacExecutableSource(result: SystemProcessResult | undefined): result is SystemProcessResult {
  if (!result) return false;
  if (result.status !== "completed") return false;
  if (result.exitCode !== 0) return false;
  return !result.outputTruncated;
}

function isMacExecutableObservationAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function unavailableMacExecutable(reason: string): SystemApplicationExecutableResolution {
  return { status: "unresolved", source: SOURCE, reason };
}
