import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { directoryAuthorityScript } from "./bootstrap.js";
import {
  assertDirectoryAuthorityLocation,
  authorityEnvironment,
  AUTHORITY_MESSAGE_LIMIT,
  encodeAuthorityRequest,
  type DirectoryAuthorityLocation,
} from "./protocol.js";

export function spawnDirectoryAuthorityCommand(
  input: DirectoryAuthorityLocation &
    Readonly<{
      command: string;
      args: readonly string[];
      env?: NodeJS.ProcessEnv;
    }>,
): ChildProcessByStdio<null, Readable, Readable> {
  assertDirectoryAuthorityLocation(input);
  const request = encodeAuthorityRequest({
    command: input.command,
    args: input.args,
  });
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      directoryAuthorityScript("command", AUTHORITY_MESSAGE_LIMIT),
    ],
    {
      cwd: input.directoryPath,
      env: authorityEnvironment(input.env),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", input.directoryFd, "pipe"],
    },
  );
  const requestPipe = child.stdio[4] as Writable | null;
  // An early authority failure may close the request pipe before the parent
  // finishes writing. The process result remains the authoritative error.
  requestPipe?.on("error", () => undefined);
  requestPipe?.end(request);
  return child as ChildProcessByStdio<null, Readable, Readable>;
}
