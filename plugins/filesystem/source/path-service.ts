import { posix } from "node:path";

import type {
  ResolvedRuntimeToolPath,
  RuntimeToolPathResolver,
  ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

const FILESYSTEM_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace",
] as const);

export type FilesystemPathService = Readonly<{
  resolve(
    rawPath: unknown,
    context?: ToolExecutionContext,
  ): ResolvedRuntimeToolPath;
  parent(
    target: ResolvedRuntimeToolPath,
    context?: ToolExecutionContext,
  ): ResolvedRuntimeToolPath;
  sibling(
    target: ResolvedRuntimeToolPath,
    name: string,
    context?: ToolExecutionContext,
  ): ResolvedRuntimeToolPath;
}>;

function resolverFor(
  fallback: RuntimeToolPathResolver,
  context?: ToolExecutionContext,
): RuntimeToolPathResolver {
  return context?.runtimePathResolver ?? fallback;
}

function resolveWith(
  resolver: RuntimeToolPathResolver,
  rawPath: unknown,
): ResolvedRuntimeToolPath {
  return resolver.resolve(rawPath, {
    requirePath: true,
    allowedLocations: FILESYSTEM_LOCATIONS,
  });
}

function logicalParent(logicalPath: string): string {
  if (logicalPath === "." || logicalPath === "workspace") {
    return logicalPath;
  }
  return posix.dirname(logicalPath);
}

export function createFilesystemPathService(
  fallbackResolver: RuntimeToolPathResolver,
): FilesystemPathService {
  return Object.freeze({
    resolve(rawPath, context) {
      return resolveWith(resolverFor(fallbackResolver, context), rawPath);
    },
    parent(target, context) {
      return resolveWith(
        resolverFor(fallbackResolver, context),
        logicalParent(target.logicalPath),
      );
    },
    sibling(target, name, context) {
      const parent = logicalParent(target.logicalPath);
      const logicalPath = parent === "." ? name : posix.join(parent, name);
      return resolveWith(resolverFor(fallbackResolver, context), logicalPath);
    },
  });
}
