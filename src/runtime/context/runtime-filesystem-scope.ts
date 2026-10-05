import { isAbsolute } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";

export const RUNTIME_FILESYSTEM_SCOPE_KIND =
  "runtime_filesystem_scope_v1" as const;

export type RuntimeFilesystemScope = Readonly<{
  agentWorkRoot: string;
  hostPathSyntax: "posix" | "win32";
}>;

type RuntimePathCapability = Readonly<{
  runtimePathControlIds?: readonly string[];
}>;

/** Uses the same frozen root supplied to the request-bound tool registry. */
export function captureRuntimeFilesystemScope(
  requestWorkingDirectory?: string,
): RuntimeFilesystemScope | undefined {
  if (requestWorkingDirectory === undefined) return undefined;
  if (!isAbsolute(requestWorkingDirectory)) {
    throw new Error("runtime_filesystem_scope_root_invalid");
  }
  return Object.freeze({
    agentWorkRoot: requestWorkingDirectory,
    hostPathSyntax: process.platform === "win32" ? "win32" : "posix",
  });
}

export function canEstablishRuntimeWorkingDirectory(
  workingDirectory: string | undefined,
  invocationAvailable: boolean,
): boolean {
  if (workingDirectory !== undefined) return false;
  return invocationAvailable;
}

export function needsRuntimeFilesystemScope(
  capabilities: readonly RuntimePathCapability[],
  canSelectWorkingDirectory = false,
): boolean {
  if (canSelectWorkingDirectory) return true;
  return capabilities.some(
    (descriptor) => (descriptor.runtimePathControlIds?.length ?? 0) > 0,
  );
}

/** Passive root meaning only; selected targets remain in their existing lane. */
export function buildRuntimeFilesystemScopeMessage(
  input: Readonly<{
    scope?: RuntimeFilesystemScope;
    workingDirectory?: string;
    capabilities?: readonly RuntimePathCapability[];
    canSelectWorkingDirectory?: boolean;
  }>,
): ChatMessage | undefined {
  if (!input.scope) return undefined;
  if (
    !needsRuntimeFilesystemScope(
      input.capabilities ?? [],
      input.canSelectWorkingDirectory,
    )
  )
    return undefined;
  return Object.freeze({
    role: "system" as const,
    content: JSON.stringify({
      kind: RUNTIME_FILESYSTEM_SCOPE_KIND,
      authority: "canonical_runtime_state",
      provenance: "request_bound_agent_work_directory",
      purpose: "interpret_runtime_filesystem_paths",
      hostPathSyntax: input.scope.hostPathSyntax,
      agentWorkRoot: input.scope.agentWorkRoot,
      workingDirectory: input.workingDirectory ?? null,
      applicability: {
        canSelectWorkingDirectory: input.canSelectWorkingDirectory === true,
        relativePathBase: "agentWorkRoot_plus_canonical_workingDirectory",
        absolutePathSyntax: "runtime_host",
        allowedLocations: "defined_and_validated_by_each_operation",
      },
      presenceEffect:
        "Reference only. Does not add user intent, authorization, a Desktop location, OS-target mapping, or completion evidence. SYSTEM target paths belong to the selected OS independently of this runtime filesystem root.",
      omissions:
        "Only agent-work is represented; no workspace root or file inventory.",
    }),
  });
}
