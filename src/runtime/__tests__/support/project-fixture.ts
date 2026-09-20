import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../../ports.js";

export async function createProjectFixture() {
  const artifacts = resolve(".codex/artifacts/project-tests");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "run-"));
  const config: RuntimeConfig = {
    runtimeId: "projects-test",
    agentBridgeUrl: "ws://127.0.0.1:1",
    modelGatewayUrl: "http://127.0.0.1:1",
    requestRunner: { configPath: join(root, "request-runner.json") },
    paths: {
      rootDir: root,
      runtimeDir: join(root, "runtime"),
      agentWorkDir: join(root, "default"),
      workspaceDir: join(root, "workspace"),
      sessionsDir: join(root, "sessions"),
      attachmentsDir: join(root, "attachments"),
      sharedDir: join(root, "shared"),
      compiledDir: join(root, "compiled"),
      traceFile: join(root, "trace.jsonl"),
    },
  };
  const directories = [
    config.paths.agentWorkDir,
    config.paths.workspaceDir,
    join(root, "project-a"),
    join(root, "project-b"),
  ];
  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true })),
  );
  return {
    root,
    config,
    directories,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
