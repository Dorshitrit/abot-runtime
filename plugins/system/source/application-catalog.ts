import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  SystemOperationError,
  type SystemApplication,
  type SystemProcessRunner,
  type SystemTarget,
} from "./contracts.js";
import { powershellArguments } from "./targets.js";

const CATALOG_ENTRY_LIMIT = 2_000;
export type SystemApplicationCatalogScope = Readonly<{
  source:
    | "windows_start_apps"
    | "macos_application_bundles"
    | "linux_desktop_entries";
  roots: readonly string[];
  includesExecutableSearch: false;
  includesOtherTargets: false;
}>;
export type SystemApplicationCatalog = Readonly<{
  applications: readonly SystemApplication[];
  complete: boolean;
  scope: SystemApplicationCatalogScope;
}>;

function isAbsentOptionalCatalogRoot(error: unknown, depth: number): boolean {
  if (depth !== 0 || !(error instanceof Error)) return false;
  return "code" in error && error.code === "ENOENT";
}

async function readApplicationDirectory(
  path: string,
  depth: number,
): Promise<{ entries: Dirent[]; complete: boolean }> {
  try {
    return {
      entries: await readdir(path, { withFileTypes: true }),
      complete: true,
    };
  } catch (error) {
    return { entries: [], complete: isAbsentOptionalCatalogRoot(error, depth) };
  }
}

async function collectApplicationPaths(
  roots: readonly string[],
  extension: string,
): Promise<{ paths: string[]; complete: boolean }> {
  const pending = roots.map((path) => ({ path, depth: 0 }));
  const paths: string[] = [];
  let scannedEntries = 0;
  let complete = true;
  while (
    pending.length > 0 &&
    scannedEntries < 20_000 &&
    paths.length < CATALOG_ENTRY_LIMIT
  ) {
    const current = pending.shift()!;
    const directory = await readApplicationDirectory(
      current.path,
      current.depth,
    );
    complete = complete && directory.complete;
    for (const entry of directory.entries) {
      scannedEntries += 1;
      if (scannedEntries >= 20_000 || paths.length >= CATALOG_ENTRY_LIMIT) {
        complete = false;
        break;
      }
      const absolute = join(current.path, entry.name);
      if (entry.name.endsWith(extension)) {
        paths.push(absolute);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (current.depth >= 4) {
        complete = false;
        continue;
      }
      pending.push({ path: absolute, depth: current.depth + 1 });
    }
  }
  return {
    paths: [...new Set(paths)].sort(),
    complete: complete && pending.length === 0,
  };
}

export function parseDesktopApplication(
  content: string,
  path: string,
): SystemApplication | undefined {
  const section = content
    .split(/^\[Desktop Entry\]\s*$/mu)[1]
    ?.split(/^\[/mu)[0];
  if (!section) return undefined;
  const fields = new Map(
    section.split(/\r?\n/u).map((line) => {
      const split = line.indexOf("=");
      return [
        line.slice(0, split).trim(),
        line.slice(split + 1).trim(),
      ] as const;
    }),
  );
  if (fields.get("Type") !== "Application") return undefined;
  if (fields.get("Hidden") === "true") return undefined;
  const name = fields.get("Name");
  if (!name) return undefined;
  return { id: path, name, target: "linux" };
}

async function windowsApplications(
  target: SystemTarget,
  run: SystemProcessRunner,
): Promise<SystemApplicationCatalog> {
  const result = await run({
    executable: target.shell,
    args: powershellArguments(
      "@(Get-StartApps | Sort-Object AppID | Select-Object -First 2001 Name,AppID) | ConvertTo-Json -Compress",
    ),
    timeoutMs: 15_000,
    outputMaxChars: 512_000,
  });
  if (
    result.status !== "completed" ||
    result.exitCode !== 0 ||
    result.outputTruncated
  )
    throw new SystemOperationError(
      "system_application_catalog_unavailable",
      "Windows Start application catalog could not be read completely within the observation budget.",
    );
  let entries: unknown;
  try {
    entries = JSON.parse(result.stdout || "[]");
  } catch {
    throw new SystemOperationError(
      "system_application_catalog_invalid",
      "Windows returned an unreadable application catalog.",
    );
  }
  const rows = Array.isArray(entries) ? entries : [entries];
  const applications = rows
    .slice(0, CATALOG_ENTRY_LIMIT)
    .flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      if (!("Name" in entry) || !("AppID" in entry)) return [];
      if (typeof entry.Name !== "string" || typeof entry.AppID !== "string")
        return [];
      return [
        { id: entry.AppID, name: entry.Name, target: "windows" as const },
      ];
    });
  return {
    applications,
    complete: rows.length <= CATALOG_ENTRY_LIMIT,
    scope: {
      source: "windows_start_apps",
      roots: [],
      includesExecutableSearch: false,
      includesOtherTargets: false,
    },
  };
}

export async function readSystemApplications(
  target: SystemTarget,
  run: SystemProcessRunner,
): Promise<SystemApplicationCatalog> {
  if (target.id === "windows") return windowsApplications(target, run);
  if (target.id === "macos") {
    const roots = [
      "/Applications",
      "/System/Applications",
      join(homedir(), "Applications"),
    ];
    const catalog = await collectApplicationPaths(roots, ".app");
    return {
      applications: catalog.paths.map((id) => ({
        id,
        name: basename(id, ".app"),
        target: "macos",
      })),
      complete: catalog.complete,
      scope: {
        source: "macos_application_bundles",
        roots,
        includesExecutableSearch: false,
        includesOtherTargets: false,
      },
    };
  }
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const dataDirs = (
    process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share"
  ).split(":");
  const roots = [dataHome, ...dataDirs].map((directory) =>
    join(directory, "applications"),
  );
  const catalog = await collectApplicationPaths(roots, ".desktop");
  const applications: SystemApplication[] = [];
  let complete = catalog.complete;
  for (const path of catalog.paths) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      complete = false;
      continue;
    }
    if (isDesktopEntryOverBudget(content)) {
      complete = false;
      continue;
    }
    const application = parseDesktopApplication(content, path);
    if (application) applications.push(application);
  }
  return {
    applications,
    complete,
    scope: {
      source: "linux_desktop_entries",
      roots,
      includesExecutableSearch: false,
      includesOtherTargets: false,
    },
  };
}

function isDesktopEntryOverBudget(content: string): boolean {
  return content.length > 128_000;
}
