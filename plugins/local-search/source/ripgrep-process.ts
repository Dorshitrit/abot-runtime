import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { rgPath } from "@vscode/ripgrep";

import { spawnDirectoryAuthorityCommand } from "../../../src/shared/directory-authority/index.js";

export type SearchDirectoryAuthority = Readonly<{
  directoryPath: string;
  directoryFd: number;
}>;

function controlledRipgrepEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "RIPGREP_CONFIG_PATH") {
      delete environment[name];
    }
  }
  return environment;
}

function terminateAuthorityGroup(
  child: ChildProcessByStdio<null, Readable, Readable>,
): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    const groupAlreadyExited =
      (error as NodeJS.ErrnoException).code === "ESRCH";
    if (groupAlreadyExited) return;
    throw error;
  }
}

export function spawnRipgrepProcess(
  args: readonly string[],
  cwd: string,
  stdinFd?: number,
  directoryAuthority?: SearchDirectoryAuthority,
) {
  const commandArgs = ["--no-config", ...args];
  const env = controlledRipgrepEnvironment();
  if (directoryAuthority) {
    const child = spawnDirectoryAuthorityCommand({
      ...directoryAuthority,
      command: rgPath,
      args: commandArgs,
      env,
    });
    return { child, terminate: () => terminateAuthorityGroup(child) };
  }
  const child = spawn(rgPath, commandArgs, {
    cwd,
    env,
    stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessByStdio<null, Readable, Readable>;
  return {
    child,
    terminate: () => {
      child.kill("SIGKILL");
    },
  };
}
