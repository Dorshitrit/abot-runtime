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
    tree?: { files?: string[]; entries?: number; truncatedPathCount?: number };
    pagination?: { hasMore: boolean; nextCursor: string | null };
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
    expect(result.output).not.toContain("generated.txt");
    expect(result.output).not.toContain("Package scripts:");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4_000);
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

  test("pages complete Unicode paths within the serialized result budget", async () => {
    const roots = await createRoots("project-orientation-result-bound");
    const filenames = Array.from(
      { length: 500 },
      (_, index) => `${String(index).padStart(3, "0")}-${"שלום-segment-".repeat(9)}.txt`,
    );
    for (const filename of filenames) {
      await writeFile(join(roots.agentWorkDir, filename), "x", "utf8");
    }
    const handler = createPlugin({
      rootDir: roots.rootDir,
      runtimePaths: roots,
      runtimePathResolver: createRuntimeToolPathResolver(roots),
      config: { defaultDepth: 3, maxEntries: 250 },
    }).handlers.inspect_project;

    const result = await handler({ path: ".", depth: 0, maxEntries: 250 });

    expect(result.ok).toBe(true);
    const files = result.data?.tree?.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual(filenames.slice(0, files.length));
    expect(result.data?.tree?.entries).toBeLessThanOrEqual(40);
    expect(result.data?.tree?.truncatedPathCount).toBe(0);
    expect(result.data?.pagination).toEqual({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4_000);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
    );
    const next = await handler({
      path: ".", depth: 0, maxEntries: 250,
      cursor: result.data?.pagination?.nextCursor,
    });
    expect(next.ok).toBe(true);
    const nextFiles = next.data?.tree?.files ?? [];
    expect(nextFiles.length).toBeGreaterThan(0);
    expect([...files, ...nextFiles]).toEqual(
      filenames.slice(0, files.length + nextFiles.length),
    );
    expect(next.data?.tree?.truncatedPathCount).toBe(0);
    expect(JSON.stringify(next).length).toBeLessThanOrEqual(4_000);
  });
});
