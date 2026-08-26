import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeToolPathResolver,
  resolveRuntimeTargetPath,
  RuntimeToolPathError,
  scopeRuntimeTargetPath,
} from "../capabilities/runtime-target-path.js";

describe("runtime target working-directory scope", () => {
  let agentWorkDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    agentWorkDir = await mkdtemp(join(tmpdir(), "runtime-target-scope-"));
    workspaceDir = join(agentWorkDir, "workspace-root");
    await mkdir(join(agentWorkDir, "Project"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(agentWorkDir, { recursive: true, force: true });
  });

  test.each([
    ["index.html", "Project/index.html"],
    ["assets/app.js", "Project/assets/app.js"],
    ["./styles/site.css", "Project/styles/site.css"],
    ["Project/index.html", "Project/index.html"],
  ])("scopes %s to %s exactly once", (rawPath, expected) => {
    expect(
      scopeRuntimeTargetPath({
        rawPath,
        workingDirectory: "Project",
        sharedState: {
          runtimePaths: { agentWorkDir, workspaceDir },
        },
      }),
    ).toBe(expected);
  });

  test("allows explicit targets only inside the exact physical working-directory scope", () => {
    const absoluteInsideProject = join(agentWorkDir, "Project", "index.html");

    expect(
      scopeRuntimeTargetPath({
        rawPath: absoluteInsideProject,
        workingDirectory: "Project",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toBe(absoluteInsideProject);
    expect(() =>
      scopeRuntimeTargetPath({
        rawPath: "workspace/shared.css",
        workingDirectory: "Project",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toThrow("runtime_target_path_outside_working_directory");
    expect(() =>
      scopeRuntimeTargetPath({
        rawPath: join(agentWorkDir, "Other", "index.html"),
        workingDirectory: "Project",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toThrow("runtime_target_path_outside_working_directory");
  });

  test("allows the explicit workspace namespace when it is the working-directory scope", () => {
    expect(
      scopeRuntimeTargetPath({
        rawPath: "workspace/shared.css",
        workingDirectory: "workspace",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toBe("workspace/shared.css");
  });

  test.each(["../index.html", "assets/../../outside.js"])(
    "rejects traversal in %s",
    (rawPath) => {
      expect(() =>
        scopeRuntimeTargetPath({
          rawPath,
          workingDirectory: "Project",
          sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
        }),
      ).toThrow("runtime_target_path_traversal");
    },
  );

  test("rejects an absolute target outside configured roots", () => {
    expect(() =>
      scopeRuntimeTargetPath({
        rawPath: join(tmpdir(), "outside-runtime-target.txt"),
        workingDirectory: "Project",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toThrow("runtime_target_path_outside_configured_roots");
  });

  test.each([undefined, "."])(
    "preserves a root-relative target for workingDirectory=%s",
    (workingDirectory) => {
      expect(
        scopeRuntimeTargetPath({
          rawPath: "index.html",
          ...(workingDirectory ? { workingDirectory } : {}),
          sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
        }),
      ).toBe("index.html");
    },
  );

  test("still rejects traversal when the working directory is the agent root", () => {
    expect(() =>
      scopeRuntimeTargetPath({
        rawPath: "../index.html",
        workingDirectory: ".",
        sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
      }),
    ).toThrow("runtime_target_path_traversal");
  });

  test("rejects a missing leaf beneath a symlink that escapes the working directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "runtime-target-outside-"));
    try {
      await symlink(outside, join(agentWorkDir, "Project", "escape"), "dir");
      expect(() =>
        scopeRuntimeTargetPath({
          rawPath: "escape/new-file.txt",
          workingDirectory: "Project",
          sharedState: { runtimePaths: { agentWorkDir, workspaceDir } },
        }),
      ).toThrow("runtime_target_path_symlink_escape");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("preserves boundary whitespace for plugin-owned round-trip validation", () => {
    const resolver = createRuntimeToolPathResolver({
      agentWorkDir,
      workspaceDir,
    });

    expect(resolver.resolve(" trailing.txt ").logicalPath).toBe(
      " trailing.txt ",
    );
  });

  test("fails the explicit workspace namespace consistently when its root is missing", () => {
    const sharedState = { runtimePaths: { agentWorkDir } };
    const resolver = createRuntimeToolPathResolver(sharedState.runtimePaths);

    expect(() => resolver.resolve("workspace/reference.md")).toThrow(
      "runtime_tool_path_workspace_unavailable",
    );
    expect(() =>
      resolveRuntimeTargetPath("workspace/reference.md", sharedState),
    ).toThrow("runtime_target_path_workspace_unavailable");

    try {
      resolveRuntimeTargetPath("workspace/reference.md", sharedState);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeToolPathError);
      expect(error).toMatchObject({
        code: "runtime_tool_path_workspace_unavailable",
      });
    }
  });
});
