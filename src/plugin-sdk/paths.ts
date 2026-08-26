import type {
  ResolvedRuntimeToolPath,
  RuntimePluginLoadContext,
  RuntimeToolPathError,
  RuntimeToolPathErrorCode,
  RuntimeToolPathLocation,
} from "../plugin-contract/entrypoint.js";

export type ResolvePluginPathOptions = Readonly<{
  defaultPath?: string;
  requirePath?: boolean;
  allowedLocations?: readonly RuntimeToolPathLocation[];
}>;

export function resolvePluginPath(
  context: Pick<RuntimePluginLoadContext, "runtimePathResolver">,
  rawPath: unknown,
  options: ResolvePluginPathOptions = {},
): ResolvedRuntimeToolPath {
  return context.runtimePathResolver.resolve(rawPath, options);
}

export function runtimeToolPathErrorCode(
  error: unknown,
): RuntimeToolPathErrorCode | undefined {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !error.code.startsWith("runtime_tool_path_")
  ) {
    return undefined;
  }
  return error.code as RuntimeToolPathErrorCode;
}

export function isRuntimeToolPathError(
  error: unknown,
): error is RuntimeToolPathError {
  return runtimeToolPathErrorCode(error) !== undefined;
}
