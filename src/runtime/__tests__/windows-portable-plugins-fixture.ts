import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const roots: string[] = [];

export async function createPortablePluginFixture(name: string) {
  const artifacts = join(process.cwd(), ".codex", "artifacts", "windows-portable-plugins-tests");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "fixture-"));
  roots.push(rootDir);
  const runtimeDir = join(rootDir, ".runtime");
  const runtimePaths = {
    rootDir,
    runtimeDir,
    agentWorkDir: join(rootDir, "agent work"),
    sessionsDir: join(runtimeDir, "sessions"),
    attachmentsDir: join(runtimeDir, "attachments"),
    workspaceDir: join(rootDir, "workspace"),
    sharedDir: join(runtimeDir, "shared"),
    compiledDir: join(runtimeDir, "compiled"),
    traceFile: join(runtimeDir, "trace.jsonl"),
  };
  const pluginRoot = join(process.cwd(), "plugins", name);
  const context = {
    id: name,
    path: join(pluginRoot, "src", "index.cjs"),
    pluginRoot,
    stateDir: join(runtimeDir, "plugins", name),
    rootDir,
    runtimeId: "windows-portable-plugin-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    config: { retryBaseMs: 0 },
    secrets: { get: () => undefined },
  } satisfies RuntimePluginLoadContext & Readonly<{ pluginRoot: string }>;
  await mkdir(context.stateDir, { recursive: true });
  return context;
}

export async function removePortablePluginFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
