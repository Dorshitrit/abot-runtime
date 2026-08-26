import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_PACKAGE_NAME = "@abot-ai/runtime";

function isRuntimePackageRoot(directory: string): boolean {
  const packagePath = join(directory, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }
  try {
    const value = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      name?: unknown;
    };
    return value.name === RUNTIME_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Resolve first-party plugin assets relative to the installed runtime package,
 * never relative to the consumer's current working directory.
 */
export function resolveBundledRuntimeRoot(
  startDirectory = dirname(fileURLToPath(import.meta.url)),
): string {
  let current = startDirectory;
  const filesystemRoot = parse(current).root;
  while (true) {
    if (isRuntimePackageRoot(current)) {
      return current;
    }
    if (current === filesystemRoot) {
      break;
    }
    current = dirname(current);
  }
  throw new Error(
    `Unable to locate ${RUNTIME_PACKAGE_NAME} package root from ${startDirectory}`,
  );
}
