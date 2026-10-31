import { afterEach, onTestFinished, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

let environment: ReturnType<typeof createIsolatedGitEnvironment> | undefined;
afterEach(() => {
  environment = undefined;
  vi.unstubAllEnvs();
});

function shellPath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The real reader clears inherited GIT_* variables, so isolate at the executable boundary. */
export async function isolateProjectChangesGit(artifacts: string) {
  environment ??= createIsolatedGitEnvironment(artifacts);
  return environment;
}

async function createIsolatedGitEnvironment(artifacts: string) {
  const directory = await mkdtemp(join(artifacts, "git-environment-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const globalConfigPath = join(directory, "gitconfig");
  const executable = join(bin, "git");
  await mkdir(bin);
  await writeFile(globalConfigPath, "");
  await writeFile(executable, [
    "#!/bin/sh",
    "export GIT_CONFIG_NOSYSTEM=1",
    `export GIT_CONFIG_GLOBAL=${shellPath(globalConfigPath)}`,
    'exec /usr/bin/git "$@"',
    "",
  ].join("\n"));
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  return { executable, globalConfigPath };
}
