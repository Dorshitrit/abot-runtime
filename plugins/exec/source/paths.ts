import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, sep } from "node:path";

import {
  readRequiredString,
  resolvePluginPath,
  type RuntimePluginLoadContext,
  type ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";
import { ExecPluginError } from "./errors.js";
import type { ExecWorkingDirectory } from "./types.js";

function resolveContextualDirectory(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
  requestedPath: string,
): Readonly<{ absolutePath: string; base?: ExecWorkingDirectory }> {
  if (isAbsolute(requestedPath)) return { absolutePath: requestedPath };
  const isWorkspaceAlias =
    requestedPath === "workspace" || requestedPath.startsWith("workspace/");
  const base = resolvePluginPath(
    {
      runtimePathResolver:
        executionContext?.runtimePathResolver ??
        pluginContext.runtimePathResolver,
    },
    isWorkspaceAlias ? "workspace" : ".",
    { allowedLocations: [isWorkspaceAlias ? "workspace" : "agent_work"] },
  );
  const relativePath = isWorkspaceAlias
    ? requestedPath.slice("workspace".length + 1) || "."
    : requestedPath;
  return { absolutePath: `${base.absolutePath}${sep}${relativePath}`, base };
}

function isOutsideExecContextBase(relativePath: string): boolean {
  if (relativePath === "..") return true;
  if (relativePath.startsWith(`..${sep}`)) return true;
  return isAbsolute(relativePath);
}

function logicalDirectory(
  absolutePath: string,
  base: ExecWorkingDirectory | undefined,
): string {
  if (!base) return absolutePath;
  const fromBase = relative(base.absolutePath, absolutePath);
  if (isOutsideExecContextBase(fromBase)) return absolutePath;
  return posix.join(base.logicalPath, fromBase.split(sep).join("/") || ".");
}

export async function resolveExecWorkingDirectory(
  pluginContext: RuntimePluginLoadContext,
  executionContext: ToolExecutionContext | undefined,
  rawPath: unknown,
): Promise<ExecWorkingDirectory> {
  const requestedPath = readRequiredString(rawPath, {
    name: "cwd",
    trim: false,
    maxLength: 4_096,
  });
  if (requestedPath.includes("\0")) {
    throw new ExecPluginError(
      "exec_cwd_invalid",
      "The selected cwd contains NUL characters.",
    );
  }
  const target = resolveContextualDirectory(
    pluginContext,
    executionContext,
    requestedPath,
  );
  let absolutePath: string;
  let info;
  try {
    // The contextual base is not a permission boundary for raw shell execution.
    absolutePath = await realpath(target.absolutePath);
    info = await stat(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ExecPluginError(
        "exec_cwd_not_found",
        "The selected cwd does not exist. Select an existing directory.",
      );
    }
    throw new ExecPluginError(
      "exec_cwd_inaccessible",
      "The selected cwd cannot be accessed by the runtime.",
    );
  }
  if (!info.isDirectory()) {
    throw new ExecPluginError(
      "exec_cwd_not_directory",
      "The selected cwd is not a directory.",
    );
  }
  return Object.freeze({
    absolutePath,
    logicalPath: logicalDirectory(absolutePath, target.base),
  });
}
