import { win32 } from "node:path";
import type {
  SystemApplication,
  SystemApplicationExecutableResolution,
  SystemProcessRunner,
  SystemTarget,
} from "./contracts.js";
import { powershellArguments, powershellLiteral } from "./targets.js";

const SOURCE = "windows_apps_folder_target" as const;
const CATALOG_LIMIT = 2_000;

/** Read the Shell's exact catalog identity; neither names nor executable search bind apps. */
export async function observeWindowsApplicationExecutables(
  target: SystemTarget,
  applications: readonly SystemApplication[],
  run: SystemProcessRunner,
  abortSignal?: AbortSignal,
): Promise<readonly SystemApplicationExecutableResolution[]> {
  abortSignal?.throwIfAborted();
  if (applications.length === 0) return [];
  const ids = [...new Set(applications.map(({ id }) => id))];
  const result = await run({
    executable: target.shell,
    args: powershellArguments(windowsApplicationExecutableScript(ids)),
    timeoutMs: 15_000,
    outputMaxChars: 512_000,
    ...(abortSignal ? { abortSignal } : {}),
  }).catch((error: unknown) => {
    abortSignal?.throwIfAborted();
    if (isWindowsExecutableObservationAbort(error)) throw error;
    return undefined;
  });
  abortSignal?.throwIfAborted();
  if (result?.status === "aborted")
    throw new DOMException("Application executable observation aborted.", "AbortError");
  if (!hasCompleteResolutionOutput(result))
    return applications.map(() => unresolved("source_unavailable"));
  let rows: unknown;
  try { rows = JSON.parse(result!.stdout); }
  catch { return applications.map(() => unresolved("source_invalid")); }
  if (!Array.isArray(rows))
    return applications.map(() => unresolved("source_invalid"));
  return applications.map(({ id }) => readExactApplicationResolution(id, rows));
}

function windowsApplicationExecutableScript(ids: readonly string[]): string {
  return `$selected=[string[]](ConvertFrom-Json -InputObject ${powershellLiteral(JSON.stringify(ids))});
$shell=New-Object -ComObject Shell.Application;
$folder=$shell.NameSpace('shell:AppsFolder');
if($null -eq $folder){throw 'apps_folder_unavailable'};
$items=$folder.Items();
$rows=[System.Collections.Generic.List[object]]::new();
if($items.Count -gt ${CATALOG_LIMIT}){throw 'apps_folder_budget_exceeded'};
foreach($id in $selected){
  $paths=[System.Collections.Generic.List[string]]::new();
  $matched=$false;
  $incomplete=$false;
  foreach($item in $items){
    if(-not [string]::Equals([string]$item.Path,[string]$id,[StringComparison]::Ordinal)){continue};
    $matched=$true;
    try {
      $path=[string]$item.ExtendedProperty('System.Link.TargetParsingPath');
      if([string]::IsNullOrWhiteSpace($path)){continue};
      if($path.Length -gt 4096){$incomplete=$true;continue};
      if(-not [IO.Path]::IsPathRooted($path)){continue};
      if(-not [string]::Equals([IO.Path]::GetExtension($path),'.exe',[StringComparison]::OrdinalIgnoreCase)){continue};
      $file=Get-Item -LiteralPath $path -Force -ErrorAction Stop;
      if($file.PSIsContainer){continue};
      if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$incomplete=$true;continue};
      if(-not $paths.Contains($file.FullName)){$paths.Add($file.FullName)};
    } catch {$incomplete=$true}
  };
  $status='unresolved';$reason='registered_executable_unavailable';$resolved=$null;
  if(-not $matched){$reason='catalog_identity_unavailable'};
  if($incomplete){$reason='registered_target_unavailable'};
  if($paths.Count -gt 1){$status='ambiguous';$reason='multiple_registered_targets'};
  if($paths.Count -eq 1 -and -not $incomplete){$status='resolved';$resolved=$paths[0];$reason=$null};
  $rows.Add([pscustomobject]@{id=[string]$id;status=$status;path=$resolved;reason=$reason});
};
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 3`;
}

function hasCompleteResolutionOutput(
  result: Awaited<ReturnType<SystemProcessRunner>> | undefined,
): boolean {
  if (!result) return false;
  if (result.status !== "completed") return false;
  if (result.exitCode !== 0) return false;
  return !result.outputTruncated;
}

function readExactApplicationResolution(
  id: string,
  rows: unknown[],
): SystemApplicationExecutableResolution {
  const matches = rows.filter((row) => hasExactWindowsExecutableIdentity(row, id));
  if (matches.length !== 1) return unresolved("source_invalid");
  const row = matches[0] as Record<string, unknown>;
  if (row.status === "ambiguous")
    return { status: "ambiguous", source: SOURCE, reason: "multiple_registered_targets" };
  if (row.status === "unresolved") {
    const reasons = ["registered_executable_unavailable", "catalog_identity_unavailable", "registered_target_unavailable"];
    return unresolved(reasons.includes(String(row.reason)) ? String(row.reason) : "source_invalid");
  }
  if (!hasAbsoluteExecutablePath(row)) return unresolved("source_invalid");
  return { status: "resolved", source: SOURCE, path: row.path as string };
}

function hasAbsoluteExecutablePath(row: Record<string, unknown>): boolean {
  if (row.status !== "resolved") return false;
  if (typeof row.path !== "string") return false;
  if (row.path.length > 4096) return false;
  if (row.path.includes("\0")) return false;
  if (!hasExplicitWindowsFilePath(row.path)) return false;
  return win32.extname(row.path).toLowerCase() === ".exe";
}

function hasExplicitWindowsFilePath(path: string): boolean {
  if (/^[a-z]:[\\/]/iu.test(path)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/u.test(path);
}

function hasExactWindowsExecutableIdentity(value: unknown, id: string): boolean {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (!("id" in value)) return false;
  return value.id === id;
}

function isWindowsExecutableObservationAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function unresolved(reason: string): SystemApplicationExecutableResolution {
  return { status: "unresolved", source: SOURCE, reason };
}
