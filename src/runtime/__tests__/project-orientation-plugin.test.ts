import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES } from "../orchestration/capability-adapters/result.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

type PluginToolResult = {
  ok: boolean;
  output: string;
  data?: {
    location?: string;
    target?: string;
    tree?: { files?: string[] };
    truncation?: { pathCount?: number };
    manifests?: Array<{ file?: string; scripts?: string[] }>;
  };
};

const createPlugin = loadBundledPluginEntrypoint<
  Record<string, unknown>,
  {
    handlers: {
      inspect_project(
        params: Record<string, unknown>,
      ): Promise<PluginToolResult>;
    };
  }
>("project-orientation");

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

describe("project orientation plugin", () => {
  test("treats dot as the configured agent work root", async () => {
    const roots = await createRoots("project-orientation");
    await writeFile(join(roots.rootDir, "runtime-only.txt"), "runtime", "utf8");
    await writeFile(
      join(roots.agentWorkDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", validate: "npm test" } }),
      "utf8",
    );
    await writeFile(join(roots.agentWorkDir, "generated.txt"), "work", "utf8");
    const handler = createPlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
      config: { defaultDepth: 3, maxEntries: 200 },
    }).handlers.inspect_project;

    const result = await handler({ path: ".", depth: 1, maxEntries: 20 });

    expect(result.ok).toBe(true);
    expect(result.data?.location).toBe("agent_work");
    expect(result.data?.target).toBe(".");
    expect(result.data?.tree?.files).toContain("package.json");
    expect(result.data?.tree?.files).toContain("generated.txt");
    expect(result.data?.tree?.files).not.toContain("runtime-only.txt");
    expect(result.data?.manifests?.[0]?.scripts).toEqual(["build", "validate"]);
    expect(result.output).toContain("Project target: .");
  });

  test("resolves bare project names relative to agentWorkDir", async () => {
    const roots = await createRoots("project-orientation");
    const projectDir = join(roots.agentWorkDir, "SampleProject");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "index.html"), "<main></main>", "utf8");
    const handler = createPlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
      config: { defaultDepth: 3, maxEntries: 200 },
    }).handlers.inspect_project;

    const result = await handler({
      path: "SampleProject",
      depth: 2,
      maxEntries: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.location).toBe("agent_work");
    expect(result.data?.target).toBe("SampleProject");
    expect(result.data?.tree?.files).toContain("index.html");
  });

  test("resolves configured workspace paths and rejects traversal", async () => {
    const roots = await createRoots("project-orientation");
    await writeFile(join(roots.workspaceDir, "AGENT.md"), "workspace", "utf8");
    const handler = createPlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
      config: { defaultDepth: 3, maxEntries: 200 },
    }).handlers.inspect_project;

    const workspaceResult = await handler({ path: "workspace" });
    const traversal = await handler({ path: "../outside" });
    const runtimeAbsolute = await handler({ path: roots.rootDir });

    expect(workspaceResult.ok).toBe(true);
    expect(workspaceResult.data?.location).toBe("workspace");
    expect(workspaceResult.data?.tree?.files).toContain("AGENT.md");
    expect(traversal.ok).toBe(false);
    expect(runtimeAbsolute.ok).toBe(false);
  });

  test("bounds every projected tree path and the complete tool result", async () => {
    const roots = await createRoots("project-orientation-result-bound");
    for (let index = 0; index < 500; index += 1) {
      await writeFile(
        join(
          roots.agentWorkDir,
          `${String(index).padStart(3, "0")}-${"long-segment-".repeat(9)}.txt`,
        ),
        "x",
        "utf8",
      );
    }
    const handler = createPlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
      config: { defaultDepth: 3, maxEntries: 250 },
    }).handlers.inspect_project;

    const result = await handler({ path: ".", depth: 0, maxEntries: 250 });

    expect(result.ok).toBe(true);
    expect(result.data?.truncation?.pathCount).toBeGreaterThan(0);
    expect(
      result.data?.tree?.files?.every((path) => [...path].length <= 64),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
    );
  });
});
