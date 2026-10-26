import {
  mkdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createSource from "../../../plugins/project-orientation/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const createBundle = loadBundledPluginEntrypoint<
  Parameters<RuntimePluginEntrypointFactory>[0],
  ReturnType<RuntimePluginEntrypointFactory>
>("project-orientation");
afterEach(removePortablePluginFixtures);

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("project orientation platform contract (%s)", (_name, create) => {
  async function fixture() {
    const context = await createPortablePluginFixture("project-orientation");
    await mkdir(context.runtimePaths.agentWorkDir);
    await mkdir(context.runtimePaths.workspaceDir);
    return {
      context,
      root: context.runtimePaths.agentWorkDir,
      inspect: create(context).handlers.inspect_project!,
    };
  }

  test.each(["relative", "backslashes", "absolute"] as const)(
    "inspects %s Unicode paths and bounded manifest metadata",
    async (form) => {
      const { root, inspect } = await fixture();
      const project = join(root, "projects", "שלום project");
      await mkdir(join(project, "src"), { recursive: true });
      await mkdir(join(project, "node_modules", "ignored"), {
        recursive: true,
      });
      await mkdir(join(project, ".git"), { recursive: true });
      await writeFile(
        join(project, "src", "index.ts"),
        "export const answer = 42;",
      );
      const original = JSON.stringify({
        name: "שלום project",
        version: "1.0.0",
        private: true,
        scripts: { test: "SECRET_COMMAND", build: "ANOTHER_SECRET_COMMAND" },
      });
      const packagePath = join(project, "package.json");
      await writeFile(packagePath, original);
      await writeFile(join(project, "pyproject.toml"), "PRIVATE_MANIFEST_BODY");
      const paths = {
        relative: "projects/שלום project",
        backslashes: "projects\\שלום project",
        absolute: project,
      };
      const result = await inspect({ path: paths[form], depth: 1 });
      expect(result).toMatchObject({
        ok: true,
        data: {
          target: "projects/שלום project",
          location: "agent_work",
          tree: {
            directories: ["src"],
            files: ["package.json", "pyproject.toml", "src/index.ts"],
          },
          manifests: [
            {
              file: "package.json",
              name: "שלום project",
              version: "1.0.0",
              private: true,
              scripts: ["build", "test"],
            },
            { file: "pyproject.toml" },
          ],
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(JSON.stringify(root).slice(1, -1));
      expect(serialized).not.toContain("SECRET_COMMAND");
      expect(serialized).not.toContain("PRIVATE_MANIFEST_BODY");
      expect(serialized.length).toBeLessThanOrEqual(4_000);
      expect(result.output).not.toContain("src/index.ts");
      expect(result.output).not.toContain("Package scripts:");
      expect(await readFile(packagePath, "utf8")).toBe(original);
    },
    20_000,
  );

  test("preserves dot, configured workspace and request-specific authority", async () => {
    const { context, root, inspect } = await fixture();
    await writeFile(join(root, "root-only.txt"), "body");
    await writeFile(
      join(context.runtimePaths.workspaceDir, "workspace-only.txt"),
      "body",
    );
    expect(await inspect({})).toMatchObject({
      ok: true,
      data: {
        target: ".", depth: 0, maxEntries: 40,
        tree: { files: ["root-only.txt"], truncatedPathCount: 0 },
        pagination: { hasMore: false, nextCursor: null },
      },
    });
    expect(await inspect({ path: "workspace" })).toMatchObject({
      ok: true,
      data: { location: "workspace", tree: { files: ["workspace-only.txt"] } },
    });
    const requestRoot = join(context.rootDir, "request");
    await mkdir(requestRoot);
    await writeFile(join(requestRoot, "request-only.txt"), "body");
    expect(
      await inspect(
        {},
        {
          runtimePathResolver: createRuntimeToolPathResolver({
            ...context.runtimePaths,
            agentWorkDir: requestRoot,
          }),
        },
      ),
    ).toMatchObject({
      ok: true,
      data: { target: ".", tree: { files: ["request-only.txt"] } },
    });
    for (const path of ["../request", requestRoot]) {
      const refused = await inspect({ path });
      expect(refused.ok).toBe(false);
      expect(refused.errorCode).toMatch(/^runtime_tool_path_/);
    }
  });

  test("rejects a junction outside the root while traversing the tree", async () => {
    const { context, root, inspect } = await fixture();
    const outside = join(context.rootDir, "private");
    await mkdir(outside);
    await writeFile(join(outside, "private-name.txt"), "private body");
    await symlink(
      outside,
      join(root, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const refused = await inspect({ path: "." });
    expect(refused.ok).toBe(false);
    expect(refused.errorCode).toMatch(/^runtime_tool_path_/);
    expect(refused.data).toBeUndefined();
    expect(refused.output).not.toContain("private-name");
  });

  test("retains oversized and malformed package summary semantics", async () => {
    const { root, inspect } = await fixture();
    const packagePath = join(root, "package.json");
    await writeFile(packagePath, "{invalid");
    expect(await inspect({})).toMatchObject({
      ok: true,
      data: { manifests: [{ file: "package.json", status: "invalid_json" }] },
    });
    await truncate(packagePath, 256 * 1024 + 1);
    expect(await inspect({})).toMatchObject({
      ok: true,
      data: { manifests: [{ file: "package.json", status: "too_large" }] },
    });
  }, 30_000);

  test("bounds directory depth and entry counts", async () => {
    const { root, inspect } = await fixture();
    await mkdir(join(root, "src", "deep"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "body");
    await writeFile(join(root, "src", "deep", "hidden.txt"), "body");
    expect(await inspect({ depth: 0 })).toMatchObject({
      ok: true,
      data: {
        tree: { directories: ["src"], files: [], entries: 1, truncated: false },
      },
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(join(root, "file-" + index + ".txt"), "body"),
      ),
    );
    expect(await inspect({ maxEntries: 5 })).toMatchObject({
      ok: true,
      data: {
        maxEntries: 5,
        tree: { entries: 5, truncated: true, truncatedPathCount: 0 },
        pagination: { hasMore: true, nextCursor: expect.any(String) },
      },
    });
  });

  test("cancels before inspecting a project", async () => {
    const { inspect } = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await inspect({}, { abortSignal: controller.signal })).toMatchObject(
      {
        ok: false,
        errorCode: "project_inspection_cancelled",
        interruption: "aborted",
      },
    );
  });
});
