import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { onTestFinished } from "vitest";
import type { SessionRequestReplay } from "../../../sessions/types.js";
import type { ProjectChangesEnvironments } from "../access.js";
import { ProjectChangesService } from "../service.js";
import { isolateProjectChangesGit } from "./git-environment-fixture.js";
const execute = promisify(execFile);
export async function projectChangesFixture() {
  const artifacts = resolve(".codex/artifacts/project-git-diff-20261028/tests");
  await mkdir(artifacts, { recursive: true });
  const { executable, globalConfigPath } = await isolateProjectChangesGit(artifacts);
  const directory = await mkdtemp(join(artifacts, "repo-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repository");
  await mkdir(root);
  const git = async (...args: string[]) => (await execute(executable, args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } })).stdout;
  await git("init", "-b", "main");
  const write = async (path: string, content: string | Buffer) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  let project: { id: string; name: string; directory: string } | undefined = { id: "project-1", name: "Project", directory: root };
  let exists = true;
  let available = true;
  let replay: SessionRequestReplay | null = null;
  const environment = { services: { config: { paths: { agentWorkDir: root, workspaceDir: join(root, "workspace") } }, sessions: {
    getSessionById: async (id: string) => id === "session-1" && exists ? { id, project } : null,
    getRequestReplayById: async (id: string) => replay?.requestId === id ? replay : null,
  } } };
  const environments = { environmentConfig: () => undefined, setupRequirement: () => available ? null : {}, get: () => environment } as unknown as ProjectChangesEnvironments;
  const service = new ProjectChangesService(environments, () => "dev");
  const commit = async () => { await git("add", "--all"); await git("commit", "-m", "Fixture baseline"); };
  const hashes = async () => {
    const paths = [".git/index", ".git/config", ".git/HEAD"];
    return Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(join(root, path))).digest("hex")));
  };
  return { root, git, globalConfigPath, write, commit, hashes, service, environments, setReplay: (value: SessionRequestReplay | null) => { replay = value; },
    bind: (directory: string) => { project = { id: "project-1", name: "Project", directory }; },
    unbind: () => { project = undefined; }, remove: () => { exists = false; }, disable: () => { available = false; } };
}
