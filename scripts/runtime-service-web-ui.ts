import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDotEnvFile } from "../src/shared/load-dotenv.js";
import {
  resolveRuntimeServiceWebUiSettings,
  runRuntimeServiceWebUiAutoOpen,
} from "../src/web-ui/runtime-service-auto-open.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runRuntimeServiceWebUiCommand(
  command: string | undefined,
  rootDir = ROOT_DIR,
): Promise<number> {
  loadDotEnvFile(join(rootDir, ".env"));
  const settings = resolveRuntimeServiceWebUiSettings({ rootDir });

  if (command === "condition") {
    return settings.enabled ? 0 : 1;
  }
  if (command !== "open") {
    console.error("Usage: runtime-service-web-ui.ts <condition|open>");
    return 2;
  }

  const result = await runRuntimeServiceWebUiAutoOpen({ settings });
  if (result.status === "opened") {
    console.log(
      `Opened ABot Web UI at ${result.url} after ${result.attempts} health check(s).`,
    );
  } else if (result.status === "disabled") {
    console.log("ABot Web UI auto-open is disabled.");
  } else {
    console.warn(
      `ABot Web UI auto-open skipped (${result.status}): ${result.error}`,
    );
  }

  // Browser/readiness failures are deliberately nonfatal to llm-runtime.service.
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  void runRuntimeServiceWebUiCommand(process.argv[2]).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = process.argv[2] === "open" ? 0 : 255;
    },
  );
}
