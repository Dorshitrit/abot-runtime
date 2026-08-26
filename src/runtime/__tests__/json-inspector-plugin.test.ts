import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import createJsonInspectorSource from "../../../plugins/json-inspector/source/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

type PluginToolResult = {
  ok: boolean;
  output: string;
  errorCode?: string;
  data?: { location?: string; path?: string; valid?: boolean };
};

const createPlugin = loadBundledPluginEntrypoint<
  Record<string, unknown>,
  {
    handlers: {
      inspect_json(params: Record<string, unknown>): Promise<PluginToolResult>;
    };
  }
>("json-inspector");

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

function handlerFor(roots: Awaited<ReturnType<typeof createRoots>>) {
  return createPlugin({
    rootDir: roots.rootDir,
    runtimePaths: roots,
    runtimePathResolver: createRuntimeToolPathResolver(roots),
    config: { defaultDepth: 3 },
  }).handlers.inspect_json;
}

function sourceHandlerFor(roots: Awaited<ReturnType<typeof createRoots>>) {
  const pluginRoot = join(process.cwd(), "plugins", "json-inspector");
  return createJsonInspectorSource({
    id: "json-inspector",
    path: join(pluginRoot, "plugin.json"),
    stateDir: join(roots.rootDir, ".runtime", "plugins", "json-inspector"),
    rootDir: roots.rootDir,
    runtimeId: "json-inspector-encoding-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    pluginRoot,
    runtimePaths: {
      rootDir: roots.rootDir,
      runtimeDir: join(roots.rootDir, ".runtime"),
      agentWorkDir: roots.agentWorkDir,
      sessionsDir: join(roots.rootDir, ".runtime", "sessions"),
      attachmentsDir: join(roots.rootDir, ".runtime", "attachments"),
      workspaceDir: roots.workspaceDir,
      sharedDir: join(roots.rootDir, "shared"),
      compiledDir: join(roots.rootDir, "compiled"),
      traceFile: join(roots.rootDir, ".runtime", "trace.ndjson"),
    },
    runtimePathResolver: createRuntimeToolPathResolver(roots),
    config: { defaultDepth: 3 },
  }).handlers.inspect_json;
}

describe("JSON inspector plugin", () => {
  test("uses an explicit dot path inside agentWorkDir", async () => {
    const roots = await createRoots("json-inspector");
    await writeFile(
      join(roots.rootDir, "package.json"),
      JSON.stringify({ runtime: true }),
      "utf8",
    );
    await writeFile(
      join(roots.agentWorkDir, "package.json"),
      JSON.stringify({ agentWork: true }),
      "utf8",
    );

    const result = await handlerFor(roots)({ path: "./package.json" });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      location: "agent_work",
      path: "package.json",
      valid: true,
    });
  });

  test("resolves bare project JSON paths relative to agentWorkDir", async () => {
    const roots = await createRoots("json-inspector");
    const projectDir = join(roots.agentWorkDir, "SampleProject");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "products.json"),
      JSON.stringify([{ id: 1, name: "Desk Lamp" }]),
      "utf8",
    );

    const result = await handlerFor(roots)({
      path: "SampleProject/products.json",
      maxDepth: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      location: "agent_work",
      path: "SampleProject/products.json",
      valid: true,
    });
  });

  test("resolves configured workspace JSON and rejects traversal", async () => {
    const roots = await createRoots("json-inspector");
    await writeFile(
      join(roots.workspaceDir, "settings.json"),
      JSON.stringify({ mode: "test" }),
      "utf8",
    );
    const handler = handlerFor(roots);

    const workspaceResult = await handler({ path: "workspace/settings.json" });
    const traversal = await handler({ path: "../settings.json" });
    const runtimeAbsolute = await handler({
      path: join(roots.rootDir, "settings.json"),
    });

    expect(workspaceResult.ok).toBe(true);
    expect(workspaceResult.data).toMatchObject({
      location: "workspace",
      path: "workspace/settings.json",
      valid: true,
    });
    expect(traversal.ok).toBe(false);
    expect(runtimeAbsolute.ok).toBe(false);
  });

  test("fails safely when a JSON file is not valid UTF-8", async () => {
    const roots = await createRoots("json-inspector-encoding");
    await writeFile(
      join(roots.agentWorkDir, "invalid-encoding.json"),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    );

    const result = await sourceHandlerFor(roots)({
      path: "invalid-encoding.json",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "json_invalid_encoding",
      output: "The requested JSON file must contain valid UTF-8 text.",
    });
    expect(result.data).toBeUndefined();
  });
});
