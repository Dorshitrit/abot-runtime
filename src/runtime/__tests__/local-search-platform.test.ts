import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createSource from "../../../plugins/local-search/source/index.js";
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
>("local-search");
afterEach(removePortablePluginFixtures);

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("local search platform contract (%s)", (_name, create) => {
  async function fixture() {
    const context = await createPortablePluginFixture("local-search");
    const root = context.runtimePaths.agentWorkDir;
    await mkdir(root);
    await mkdir(context.runtimePaths.workspaceDir);
    return { context, root, search: create(context).handlers.local_search! };
  }

  test.each(["relative", "backslashes", "absolute"] as const)(
    "searches %s paths with Unicode and spaces",
    async (form) => {
      const { root, search } = await fixture();
      const project = join(root, "projects", "שלום project");
      await mkdir(project, { recursive: true });
      const file = join(project, "needle שלום.txt");
      await writeFile(file, "first line\nneedle content\n");
      const paths = {
        relative: "projects/שלום project",
        backslashes: "projects\\שלום project",
        absolute: project,
      };
      const result = await search({
        path: paths[form],
        query: "needle",
        mode: "both",
      });
      expect(result).toMatchObject({
        ok: true,
        data: { itemCount: 2, logicalRoot: "projects/שלום project" },
      });
      expect(result.output).toContain(
        "projects/שלום project/needle שלום.txt:2:needle content",
      );
      expect(result.output).not.toContain(root);
      expect(await readFile(file, "utf8")).toBe("first line\nneedle content\n");
    },
    30_000,
  );

  test("searches an individual file literally without shell expansion", async () => {
    const { root, search } = await fixture();
    const query = 'needle "quoted" & $literal \\';
    await writeFile(join(root, "one file.txt"), query + "\n");
    const result = await search({
      path: "one file.txt",
      query,
      mode: "content",
    });
    expect(result).toMatchObject({ ok: true, data: { itemCount: 1 } });
    expect(result.output).toContain("one file.txt:1:");
    expect(result.output).toContain(query);
  }, 20_000);

  test("preserves workspace and request-specific authority", async () => {
    const { context, root, search } = await fixture();
    await writeFile(join(root, "needle-default.txt"), "default");
    await writeFile(
      join(context.runtimePaths.workspaceDir, "needle-workspace.txt"),
      "workspace",
    );
    const workspace = await search({
      path: "workspace",
      query: "needle",
      mode: "names",
    });
    expect(workspace).toMatchObject({ ok: true, data: { itemCount: 1 } });
    expect(workspace.output).toContain("workspace/needle-workspace.txt");
    const requestRoot = join(context.rootDir, "request");
    await mkdir(requestRoot);
    await writeFile(join(requestRoot, "needle-request.txt"), "request");
    const request = await search(
      { query: "needle", mode: "names" },
      {
        runtimePathResolver: createRuntimeToolPathResolver({
          ...context.runtimePaths,
          agentWorkDir: requestRoot,
        }),
      },
    );
    expect(request).toMatchObject({ ok: true, data: { itemCount: 1 } });
    expect(request.output).toContain("needle-request.txt");
    expect(request.output).not.toContain("needle-default.txt");
    for (const path of [requestRoot, "../request"]) {
      expect(await search({ query: "needle", path })).toMatchObject({
        ok: false,
        errorCode: expect.stringMatching(/^runtime_tool_path_/),
      });
    }
  }, 30_000);

  test("excludes ignored folders and junctions from content search", async () => {
    const { context, root, search } = await fixture();
    for (const folder of [".git", "node_modules", ".runtime"]) {
      await mkdir(join(root, folder));
      await writeFile(join(root, folder, "needle-secret.txt"), "needle secret");
    }
    const outside = join(context.rootDir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "needle-outside.txt"), "needle outside");
    await symlink(
      outside,
      join(root, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await search({ query: "needle", mode: "content" });
    expect(result).toMatchObject({ ok: true, data: { itemCount: 0 } });
    expect(result.output).not.toContain("secret");
    expect(result.output).not.toContain("outside");
    expect(await search({ path: "redirect", query: "needle" })).toMatchObject({
      ok: false,
      errorCode: expect.stringMatching(/^runtime_tool_path_/),
    });
  }, 30_000);

  test("bounds streamed results and reports truncation", async () => {
    const { root, search } = await fixture();
    await writeFile(join(root, "large.txt"), "needle line\n".repeat(50_000));
    const result = await search({
      query: "needle",
      mode: "content",
      max_results: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { itemCount: 3, truncation: { sourceTruncated: true } },
    });
    expect(result.output).toContain("large.txt:3:needle line");
    expect(result.output).not.toContain("large.txt:4:needle line");
  }, 20_000);

  test("does not start a search after cancellation", async () => {
    const { search } = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await search({ query: "needle" }, { abortSignal: controller.signal }),
    ).toMatchObject({ ok: false, errorCode: "local_search_failed" });
  });
});
