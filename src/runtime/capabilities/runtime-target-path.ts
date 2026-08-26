import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  RuntimeToolPathErrorCode,
  RuntimeToolPathLocation,
  RuntimeToolPathResolver,
  ToolExecutionSharedState,
} from "../../capabilities/tool-types.js";

export const RUNTIME_TOOL_PATH_ERROR_CODES = Object.freeze({
  REQUIRED: "runtime_tool_path_required",
  NULL_BYTE: "runtime_tool_path_null_byte",
  LOCATION_REQUIRED: "runtime_tool_path_location_required",
  ROOT_UNAVAILABLE: "runtime_tool_path_root_unavailable",
  WORKSPACE_UNAVAILABLE: "runtime_tool_path_workspace_unavailable",
  OUTSIDE_CONFIGURED_ROOTS: "runtime_tool_path_outside_configured_roots",
  SYMLINK_ESCAPE: "runtime_tool_path_symlink_escape",
  CANONICALIZATION_FAILED: "runtime_tool_path_canonicalization_failed",
  TRAVERSAL: "runtime_tool_path_traversal",
  OUTSIDE_WORKING_DIRECTORY: "runtime_tool_path_outside_working_directory",
} as const satisfies Record<string, RuntimeToolPathErrorCode>);

/** A stable machine-readable path-policy failure with a compatible message. */
export class RuntimeToolPathError extends TypeError {
  readonly code: RuntimeToolPathErrorCode;

  constructor(code: RuntimeToolPathErrorCode, message: string = code) {
    super(message);
    this.name = "RuntimeToolPathError";
    this.code = code;
  }
}

function throwRuntimeToolPathError(
  code: RuntimeToolPathErrorCode,
  message: string = code,
): never {
  throw new RuntimeToolPathError(code, message);
}

function configuredRoot(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
}

function isWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Qualifies one manifest-owned operation target against the canonical Worker
 * call directory. Every ordinary relative target that is not already rooted
 * at that directory is prefixed; explicit workspace-relative and absolute
 * forms retain their current meaning only when they resolve inside that exact
 * physical directory. The returned value remains a logical tool target.
 */
export function scopeRuntimeTargetPath(
  params: Readonly<{
    rawPath: string;
    workingDirectory?: string;
    sharedState: ToolExecutionSharedState;
  }>,
): string {
  const workingDirectory = params.workingDirectory?.trim();
  if (!workingDirectory) {
    return params.rawPath;
  }

  const requested = params.rawPath.trim();
  if (!requested) {
    throwRuntimeToolPathError(
      RUNTIME_TOOL_PATH_ERROR_CODES.REQUIRED,
      "runtime_target_path_missing",
    );
  }
  const normalizedTarget = normalizeLogicalPath(requested);
  const normalizedWorkingDirectory = normalizeLogicalPath(workingDirectory);
  if (
    hasTraversalSegment(normalizedTarget) ||
    hasTraversalSegment(normalizedWorkingDirectory) ||
    isAbsolute(normalizedWorkingDirectory)
  ) {
    throwRuntimeToolPathError(
      RUNTIME_TOOL_PATH_ERROR_CODES.TRAVERSAL,
      "runtime_target_path_traversal",
    );
  }

  const normalized = posix.normalize(normalizedTarget);
  const scoped =
    isAbsolute(normalized) ||
    normalized === "workspace" ||
    normalized.startsWith("workspace/") ||
    normalized === normalizedWorkingDirectory ||
    normalized.startsWith(`${normalizedWorkingDirectory}/`)
      ? normalized
      : posix.join(normalizedWorkingDirectory, normalized);

  // Validate the exact logical value that every downstream consumer receives,
  // then enforce the call-owned physical scope for explicit forms as well.
  const resolvedWorkingDirectory = resolveRuntimeTargetPath(
    normalizedWorkingDirectory,
    params.sharedState,
  );
  const resolvedTarget = resolveRuntimeTargetPath(scoped, params.sharedState);
  if (!isWithinRoot(resolvedTarget, resolvedWorkingDirectory)) {
    throwRuntimeToolPathError(
      RUNTIME_TOOL_PATH_ERROR_CODES.OUTSIDE_WORKING_DIRECTORY,
      "runtime_target_path_outside_working_directory",
    );
  }
  return scoped;
}

function normalizeLogicalPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function hasTraversalSegment(value: string): boolean {
  return value.split("/").includes("..");
}

/**
 * Resolves a manifest-declared target parameter without knowing which plugin
 * owns it. Relative paths are rooted at agentWorkDir; the explicit
 * `workspace/...` namespace is rooted at workspaceDir when configured.
 */
export function resolveRuntimeTargetPath(
  rawPath: string,
  sharedState: ToolExecutionSharedState,
): string {
  const requested = rawPath.trim();
  if (!requested) {
    throwRuntimeToolPathError(
      RUNTIME_TOOL_PATH_ERROR_CODES.REQUIRED,
      "runtime_target_path_missing",
    );
  }
  try {
    return resolveRuntimeToolPath(requested, {
      roots: configuredRuntimeToolPathRoots(sharedState.runtimePaths),
      allowedLocations: DEFAULT_TOOL_PATH_LOCATIONS,
    }).absolutePath;
  } catch (error: unknown) {
    rethrowLegacyRuntimeTargetPathError(error);
  }
}

function resolveThroughExistingAncestor(target: string): string {
  let cursor = target;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missingSuffix);
    } catch {
      try {
        lstatSync(cursor);
      } catch (error: unknown) {
        if (!isMissingPathError(error)) {
          throwRuntimeToolPathError(
            RUNTIME_TOOL_PATH_ERROR_CODES.CANONICALIZATION_FAILED,
          );
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
          throwRuntimeToolPathError(
            RUNTIME_TOOL_PATH_ERROR_CODES.CANONICALIZATION_FAILED,
          );
        }
        missingSuffix.unshift(basename(cursor));
        cursor = parent;
        continue;
      }
      // The entry exists but cannot be canonicalized. This includes broken or
      // looping symlinks; never downgrade those cases to lexical containment.
      throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.SYMLINK_ESCAPE);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

const DEFAULT_TOOL_PATH_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace",
] as const);

type RootedRuntimeToolPathLocation = Exclude<
  RuntimeToolPathLocation,
  "host_system"
>;

type RuntimeToolPathRoots = Readonly<
  Record<RootedRuntimeToolPathLocation, string | undefined>
>;

function configuredRuntimeToolPathRoots(
  runtimePaths: ToolExecutionSharedState["runtimePaths"] = {},
): RuntimeToolPathRoots {
  return Object.freeze({
    agent_work: configuredRoot(runtimePaths.agentWorkDir),
    workspace: configuredRoot(runtimePaths.workspaceDir),
    runtime_root: configuredRoot(runtimePaths.rootDir),
  });
}

function rethrowLegacyRuntimeTargetPathError(error: unknown): never {
  if (!(error instanceof RuntimeToolPathError)) throw error;
  const legacyMessage: Partial<Record<RuntimeToolPathErrorCode, string>> = {
    [RUNTIME_TOOL_PATH_ERROR_CODES.REQUIRED]: "runtime_target_path_missing",
    [RUNTIME_TOOL_PATH_ERROR_CODES.NULL_BYTE]: "runtime_target_path_missing",
    [RUNTIME_TOOL_PATH_ERROR_CODES.ROOT_UNAVAILABLE]:
      "runtime_target_agent_work_dir_missing",
    [RUNTIME_TOOL_PATH_ERROR_CODES.WORKSPACE_UNAVAILABLE]:
      "runtime_target_path_workspace_unavailable",
    [RUNTIME_TOOL_PATH_ERROR_CODES.OUTSIDE_CONFIGURED_ROOTS]:
      "runtime_target_path_outside_configured_roots",
    [RUNTIME_TOOL_PATH_ERROR_CODES.SYMLINK_ESCAPE]:
      "runtime_target_path_symlink_escape",
    [RUNTIME_TOOL_PATH_ERROR_CODES.CANONICALIZATION_FAILED]:
      "runtime_target_path_canonicalization_failed",
  };
  throw new RuntimeToolPathError(
    error.code,
    legacyMessage[error.code] ?? error.message,
  );
}

function resolveRuntimeToolPath(
  rawPath: unknown,
  options: Readonly<{
    roots: RuntimeToolPathRoots;
    defaultPath?: string;
    requirePath?: boolean;
    allowedLocations?: readonly RuntimeToolPathLocation[];
  }>,
) {
  const requested =
    typeof rawPath === "string"
      ? rawPath
      : options.requirePath === true
        ? undefined
        : options.defaultPath;
  if (!requested?.trim()) {
    throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.REQUIRED);
  }
  if (requested.includes("\0")) {
    throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.NULL_BYTE);
  }
  const allowed = Object.freeze(
    [...(options.allowedLocations ?? DEFAULT_TOOL_PATH_LOCATIONS)].filter(
      (location, index, values) => values.indexOf(location) === index,
    ),
  );
  if (allowed.length === 0) {
    throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.LOCATION_REQUIRED);
  }

  const availableRoots = allowed.flatMap((location) => {
    if (location === "host_system") return [];
    const root = options.roots[location];
    return root ? [{ location, root }] : [];
  });
  const normalized = normalizeLogicalPath(requested);
  const workspaceRelative =
    normalized === "workspace"
      ? ""
      : normalized.startsWith("workspace/")
        ? normalized.slice("workspace/".length)
        : undefined;
  let selected: Readonly<{
    location: RuntimeToolPathLocation;
    root: string;
  }>;
  let lexicalTarget: string;

  if (workspaceRelative !== undefined) {
    const workspace = availableRoots.find(
      ({ location }) => location === "workspace",
    );
    if (!workspace) {
      throwRuntimeToolPathError(
        RUNTIME_TOOL_PATH_ERROR_CODES.WORKSPACE_UNAVAILABLE,
      );
    }
    selected = workspace;
    lexicalTarget = resolve(workspace.root, workspaceRelative);
  } else if (isAbsolute(requested)) {
    lexicalTarget = resolve(requested);
    const rootedMatch = availableRoots
      .filter(({ root }) => isWithinRoot(lexicalTarget, root))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (rootedMatch) {
      selected = rootedMatch;
    } else if (allowed.includes("host_system")) {
      selected = { location: "host_system", root: parse(lexicalTarget).root };
    } else {
      throwRuntimeToolPathError(
        RUNTIME_TOOL_PATH_ERROR_CODES.OUTSIDE_CONFIGURED_ROOTS,
      );
    }
  } else {
    const rootedDefault =
      availableRoots.find(({ location }) => location === "agent_work") ??
      availableRoots[0];
    if (!rootedDefault) {
      throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.ROOT_UNAVAILABLE);
    }
    selected = rootedDefault;
    lexicalTarget = resolve(
      selected.root,
      normalized === "." ? "" : normalized,
    );
  }

  if (!isWithinRoot(lexicalTarget, selected.root)) {
    throwRuntimeToolPathError(
      RUNTIME_TOOL_PATH_ERROR_CODES.OUTSIDE_CONFIGURED_ROOTS,
    );
  }
  const absolutePath = resolveThroughExistingAncestor(lexicalTarget);
  const canonicalRoot = resolveThroughExistingAncestor(selected.root);
  if (!isWithinRoot(absolutePath, canonicalRoot)) {
    throwRuntimeToolPathError(RUNTIME_TOOL_PATH_ERROR_CODES.SYMLINK_ESCAPE);
  }
  const relativePath = relative(canonicalRoot, absolutePath).replaceAll(
    sep,
    "/",
  );
  const logicalPath =
    selected.location === "workspace"
      ? relativePath
        ? `workspace/${relativePath}`
        : "workspace"
      : selected.location === "host_system"
        ? absolutePath
        : relativePath || ".";
  return Object.freeze({
    location: selected.location,
    rootPath: canonicalRoot,
    absolutePath,
    relativePath,
    logicalPath,
  });
}

/**
 * Creates the single host-owned path authority injected into plugin handlers.
 * Plugins choose which declared roots they need; normalization, containment
 * and symlink handling remain identical for every plugin.
 */
export function createRuntimeToolPathResolver(
  runtimePaths: ToolExecutionSharedState["runtimePaths"] = {},
): RuntimeToolPathResolver {
  const roots = configuredRuntimeToolPathRoots(runtimePaths);
  return Object.freeze({
    resolve(rawPath, options = {}) {
      return resolveRuntimeToolPath(rawPath, {
        roots,
        ...options,
      });
    },
  });
}
