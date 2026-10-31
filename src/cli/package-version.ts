import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimePackageRoot } from "../../scripts/runtime-setup-files.js";

export function runtimePackageVersion(): string {
  const root = resolveRuntimePackageRoot(import.meta.dirname);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version)
    throw new Error("The installed ABot package has no version.");
  return manifest.version;
}
