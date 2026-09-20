import { spawnSync } from "node:child_process";
import { directoryAuthorityScript } from "../../shared/directory-authority/bootstrap.js";
import {
  authorityEnvironment,
  decodeAuthorityResult,
  encodeAuthorityRequest,
} from "../../shared/directory-authority/protocol.js";

/** Serialized trusted task; cwd is verified against the inherited root fd. */
function createMarkerInHeldDirectory(): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const { randomBytes } =
    require("node:crypto") as typeof import("node:crypto");
  const name = ".abot-file-output-root";
  const { constants } = fs;

  function isExistingMarker(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (!("code" in error)) return false;
    return error.code === "EEXIST";
  }

  let handle: number;
  try {
    handle = fs.openSync(
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isExistingMarker(error)) return;
    throw error;
  }
  try {
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(handle, `abot-file-output-root-v1\n${token}\n`, "ascii");
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * The isolated process pins cwd to the inherited directory authority before
 * creating the fixed marker name. No pathname-based write happens in the host.
 */
export function initializeFileOutputRootMarker(
  canonicalRoot: string,
  rootHandle: number,
): void {
  const outputLimit = 4096;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      directoryAuthorityScript(
        "task",
        outputLimit,
        createMarkerInHeldDirectory,
      ),
    ],
    {
      cwd: canonicalRoot,
      env: authorityEnvironment(),
      stdio: ["pipe", "pipe", "pipe", rootHandle],
      input: encodeAuthorityRequest({}),
      encoding: "utf8",
      maxBuffer: outputLimit,
      timeout: 5000,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Root marker creation failed.");
  decodeAuthorityResult<void>(result.stdout);
}
