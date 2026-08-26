import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import type { RuntimeLogRotationConfig } from "../ports.js";

const ROTATED_LOG_TIMESTAMP_PATTERN =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2})-(?<millisecond>\d{3})Z$/;

type RotatedLogFile = {
  path: string;
  rotatedAtMs: number;
};

type LogRotationFileOps = {
  appendFile: typeof appendFile;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
};

export type LogRotationWarning = {
  traceFile: string;
  event: "cleanup.failed";
  error: string;
  paths: string[];
};

const DEFAULT_FILE_OPS: LogRotationFileOps = {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
};

function isMissingFileError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function buildRotationTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

function buildRotatedLogPath(traceFile: string, date: Date): string {
  const parsed = parse(traceFile);
  return join(
    parsed.dir,
    `${parsed.name}.${buildRotationTimestamp(date)}${parsed.ext}`,
  );
}

function parseRotationTimestamp(value: string): number | null {
  const match = ROTATED_LOG_TIMESTAMP_PATTERN.exec(value);
  if (!match?.groups) {
    return null;
  }
  const isoTimestamp = `${match.groups.date}T${match.groups.hour}:${match.groups.minute}:${match.groups.second}.${match.groups.millisecond}Z`;
  const rotatedAtMs = Date.parse(isoTimestamp);
  return Number.isFinite(rotatedAtMs) ? rotatedAtMs : null;
}

function readRotatedTimestampFromName(
  traceFile: string,
  entryName: string,
): number | null {
  const parsed = parse(traceFile);
  const prefix = `${parsed.name}.`;
  if (!entryName.startsWith(prefix) || !entryName.endsWith(parsed.ext)) {
    return null;
  }
  const timestamp = entryName.slice(
    prefix.length,
    entryName.length - parsed.ext.length,
  );
  return parseRotationTimestamp(timestamp);
}

async function rotateActiveLogIfNeeded(
  traceFile: string,
  rotation: RuntimeLogRotationConfig,
  fileOps: LogRotationFileOps,
): Promise<void> {
  let fileStat: Awaited<ReturnType<LogRotationFileOps["stat"]>>;
  try {
    fileStat = await fileOps.stat(traceFile);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  const maxBytes = rotation.maxFileSizeMb * 1024 * 1024;
  if (fileStat.size < maxBytes) {
    return;
  }

  await fileOps.rename(traceFile, buildRotatedLogPath(traceFile, new Date()));
}

async function listRotatedLogs(
  traceFile: string,
  fileOps: LogRotationFileOps,
): Promise<RotatedLogFile[]> {
  const parsed = parse(traceFile);
  let entries: string[];
  try {
    entries = await fileOps.readdir(parsed.dir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const rotatedFiles: RotatedLogFile[] = [];
  for (const entryName of entries) {
    const rotatedAtMs = readRotatedTimestampFromName(traceFile, entryName);
    if (rotatedAtMs === null) {
      continue;
    }
    const path = join(parsed.dir, entryName);
    try {
      const fileStat = await fileOps.stat(path);
      if (!fileStat.isFile()) {
        continue;
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    rotatedFiles.push({ path, rotatedAtMs });
  }

  return rotatedFiles;
}

async function cleanupRotatedLogs(
  traceFile: string,
  rotation: RuntimeLogRotationConfig,
  fileOps: LogRotationFileOps,
  onWarning?: (warning: LogRotationWarning) => void,
): Promise<void> {
  const rotatedFiles = await listRotatedLogs(traceFile, fileOps);
  if (rotatedFiles.length === 0) {
    return;
  }

  const maxAgeMs = rotation.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - maxAgeMs;
  const expiredPaths = rotatedFiles
    .filter((file) => file.rotatedAtMs < cutoffMs)
    .map((file) => file.path);
  const retainedCandidates = rotatedFiles
    .filter((file) => file.rotatedAtMs >= cutoffMs)
    .sort((left, right) => right.rotatedAtMs - left.rotatedAtMs);
  const overflowPaths = retainedCandidates
    .slice(rotation.maxFiles)
    .map((file) => file.path);
  const pathsToDelete = [...new Set([...expiredPaths, ...overflowPaths])];
  if (pathsToDelete.length === 0) {
    return;
  }

  const failedPaths: string[] = [];
  for (const path of pathsToDelete) {
    try {
      await fileOps.unlink(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      failedPaths.push(path);
    }
  }

  if (failedPaths.length > 0) {
    onWarning?.({
      traceFile,
      event: "cleanup.failed",
      error: `Failed to prune ${failedPaths.length} rotated runtime log file(s)`,
      paths: failedPaths,
    });
  }
}

export async function appendTraceLineWithRotation(options: {
  traceFile: string;
  line: string;
  rotation: RuntimeLogRotationConfig;
  onWarning?: (warning: LogRotationWarning) => void;
  fileOps?: LogRotationFileOps;
}): Promise<void> {
  const fileOps = options.fileOps ?? DEFAULT_FILE_OPS;
  await fileOps.mkdir(dirname(options.traceFile), { recursive: true });
  await rotateActiveLogIfNeeded(options.traceFile, options.rotation, fileOps);
  await fileOps.appendFile(options.traceFile, `${options.line}\n`, "utf-8");
  await cleanupRotatedLogs(
    options.traceFile,
    options.rotation,
    fileOps,
    options.onWarning,
  );
}
