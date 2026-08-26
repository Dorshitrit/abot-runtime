import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

async function withRuntimeRoots(
  run: (roots: {
    rootDir: string;
    agentWorkDir: string;
    workspaceDir: string;
  }) => Promise<void> | void,
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "runtime-tool-path-"));
  const roots = {
    rootDir: join(fixtureRoot, "runtime"),
    agentWorkDir: join(fixtureRoot, "agent-work"),
    workspaceDir: join(fixtureRoot, "workspace"),
  };
  await Promise.all(Object.values(roots).map((path) => mkdir(path)));
  try {
    await run(roots);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("runtime tool path resolver", () => {
  test("projects agent-work and workspace targets through one logical contract", async () => {
    await withRuntimeRoots((roots) => {
      const resolver = createRuntimeToolPathResolver(roots);

      expect(resolver.resolve("project/new.txt")).toMatchObject({
        location: "agent_work",
        rootPath: roots.agentWorkDir,
        absolutePath: join(roots.agentWorkDir, "project", "new.txt"),
        relativePath: "project/new.txt",
        logicalPath: "project/new.txt",
      });
      expect(resolver.resolve("workspace/reference.md")).toMatchObject({
        location: "workspace",
        rootPath: roots.workspaceDir,
        absolutePath: join(roots.workspaceDir, "reference.md"),
        relativePath: "reference.md",
        logicalPath: "workspace/reference.md",
      });
    });
  });

  test("allows an explicit runtime-root target only when the plugin declares that location", async () => {
    await withRuntimeRoots((roots) => {
      const resolver = createRuntimeToolPathResolver(roots);
      const target = join(roots.rootDir, "package.json");

      expect(() => resolver.resolve(target)).toThrow(
        "runtime_tool_path_outside_configured_roots",
      );
      expect(
        resolver.resolve(target, { allowedLocations: ["runtime_root"] }),
      ).toMatchObject({
        location: "runtime_root",
        logicalPath: "package.json",
      });
    });
  });

  test("rejects lexical traversal and canonical symlink escapes", async () => {
    await withRuntimeRoots(async (roots) => {
      const resolver = createRuntimeToolPathResolver(roots);
      const outside = await mkdtemp(join(tmpdir(), "runtime-tool-outside-"));
      try {
        await symlink(outside, join(roots.agentWorkDir, "escape"), "dir");

        expect(() => resolver.resolve("../outside.txt")).toThrow(
          "runtime_tool_path_outside_configured_roots",
        );
        expect(() => resolver.resolve("escape/new.txt")).toThrow(
          "runtime_tool_path_symlink_escape",
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("fails explicitly when a requested namespace has no configured root", () => {
    const resolver = createRuntimeToolPathResolver({
      agentWorkDir: "/tmp/agent-work-only",
    });

    expect(() => resolver.resolve("workspace/reference.md")).toThrow(
      "runtime_tool_path_workspace_unavailable",
    );
  });

  test("allows arbitrary absolute host paths only through an explicit host-system grant", async () => {
    await withRuntimeRoots((roots) => {
      const resolver = createRuntimeToolPathResolver(roots);

      expect(() => resolver.resolve(tmpdir())).toThrow(
        "runtime_tool_path_outside_configured_roots",
      );
      expect(
        resolver.resolve(tmpdir(), { allowedLocations: ["host_system"] }),
      ).toMatchObject({
        location: "host_system",
        absolutePath: tmpdir(),
        logicalPath: tmpdir(),
      });
      expect(() =>
        resolver.resolve("relative.txt", {
          allowedLocations: ["host_system"],
        }),
      ).toThrow("runtime_tool_path_root_unavailable");
    });
  });
});
