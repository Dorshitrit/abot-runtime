import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { RuntimePluginEntrypoint } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

type PluginToolResult = {
  ok: boolean;
  output: string;
  data?: {
    location?: string;
    path?: string;
    symbols?: Array<{ name?: string }>;
  };
};

const createCodeOutlinePlugin = loadBundledPluginEntrypoint<
  Record<string, unknown>,
  RuntimePluginEntrypoint
>("code-outline");

function handler(
  plugin: RuntimePluginEntrypoint,
  capabilityId: string,
): NonNullable<RuntimePluginEntrypoint["handlers"][string]> {
  const execute = plugin.handlers[capabilityId];
  if (!execute) throw new Error(`missing handler ${capabilityId}`);
  return execute;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRoots(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), `${prefix}-root-`));
  const agentWorkDir = await mkdtemp(join(tmpdir(), `${prefix}-agent-work-`));
  const workspaceDir = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
  temporaryRoots.push(rootDir, agentWorkDir, workspaceDir);
  return { rootDir, agentWorkDir, workspaceDir };
}

describe("agent work rooted plugins", () => {
  test("Code outline resolves relative paths beneath agentWorkDir", async () => {
    const roots = await createRoots("code-outline");
    await mkdir(join(roots.rootDir, "src"));
    await mkdir(join(roots.agentWorkDir, "src"));
    await writeFile(
      join(roots.rootDir, "src", "app.ts"),
      "export function runtimeOnly() {}\n",
      "utf8",
    );
    await writeFile(
      join(roots.agentWorkDir, "src", "app.ts"),
      "export function agentWorkOnly() {}\n",
      "utf8",
    );

    const plugin = createCodeOutlinePlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
    });
    const execute = handler(plugin, "inspect_code_outline");
    const result = (await execute({
      path: "./src/app.ts",
    })) as PluginToolResult;
    const runtimeResult = (await execute({
      path: join(roots.rootDir, "src", "app.ts"),
    })) as PluginToolResult;

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      location: "agent_work",
      path: "src/app.ts",
    });
    expect(result.data?.symbols?.map((symbol) => symbol.name)).toContain(
      "agentWorkOnly",
    );
    expect(result.data?.symbols?.map((symbol) => symbol.name)).not.toContain(
      "runtimeOnly",
    );
    expect(runtimeResult.ok).toBe(false);
  });
});
