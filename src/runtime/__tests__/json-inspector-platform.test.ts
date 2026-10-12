import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createSource from "../../../plugins/json-inspector/source/index.js";
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
>("json-inspector");
afterEach(removePortablePluginFixtures);

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("JSON inspector platform contract (%s)", (_name, create) => {
  async function fixture() {
    const context = await createPortablePluginFixture("json-inspector");
    await mkdir(context.runtimePaths.agentWorkDir);
    await mkdir(context.runtimePaths.workspaceDir);
    return {
      context,
      root: context.runtimePaths.agentWorkDir,
      inspect: create(context).handlers.inspect_json!,
    };
  }

  test.each(["relative", "backslashes", "absolute"] as const)(
    "reads %s Unicode paths and UTF-8 BOM/CRLF",
    async (form) => {
      const { root, inspect } = await fixture();
      await mkdir(join(root, "data files"));
      const path = join(root, "data files", "שלום.json");
      const content =
        '\uFEFF{\r\n "items": [1,2,3,4],\r\n "secret": "private-value"\r\n}';
      await writeFile(path, content);
      const inputs = {
        relative: "data files/שלום.json",
        backslashes: "data files\\שלום.json",
        absolute: path,
      };
      const result = await inspect({ path: inputs[form] });
      expect(result).toMatchObject({
        ok: true,
        data: {
          location: "agent_work",
          path: "data files/שלום.json",
          valid: true,
          syntaxValid: true,
          structure: {
            type: "object",
            totalKeys: 2,
            keys: [
              {
                key: "items",
                value: {
                  type: "array",
                  length: 4,
                  returnedItems: 3,
                  truncated: true,
                },
              },
              {
                key: "secret",
                value: { type: "primitive", valueType: "string" },
              },
            ],
          },
          observationMeta: { kind: "volatile_external", carryPolicy: "never" },
        },
      });
      expect(result.output).not.toContain("private-value");
      expect(await readFile(path, "utf8")).toBe(content);
    },
    20_000,
  );

  test("preserves workspace and request-specific path authority", async () => {
    const { context, inspect } = await fixture();
    await writeFile(
      join(context.runtimePaths.workspaceDir, "settings.json"),
      '{"workspaceOnly":true}',
    );
    expect(await inspect({ path: "workspace/settings.json" })).toMatchObject({
      ok: true,
      data: {
        location: "workspace",
        structure: { keys: [{ key: "workspaceOnly" }] },
      },
    });
    const requestRoot = join(context.rootDir, "request");
    await mkdir(requestRoot);
    await writeFile(join(requestRoot, "settings.json"), '{"requestOnly":true}');
    expect(
      await inspect(
        { path: "settings.json" },
        {
          runtimePathResolver: createRuntimeToolPathResolver({
            ...context.runtimePaths,
            agentWorkDir: requestRoot,
          }),
        },
      ),
    ).toMatchObject({
      ok: true,
      data: { structure: { keys: [{ key: "requestOnly" }] } },
    });
    expect(
      await inspect({ path: join(requestRoot, "settings.json") }),
    ).toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
  }, 30_000);

  test("rejects traversal and junction or symlink escapes", async () => {
    const { root, context, inspect } = await fixture();
    const outside = join(context.rootDir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.json"), '{"private":true}');
    await symlink(
      outside,
      join(root, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of ["../outside/private.json", "redirect/private.json"]) {
      const result = await inspect({ path });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toMatch(/^runtime_tool_path_/);
      expect(result.data).toBeUndefined();
    }
  });

  test("keeps malformed JSON separate from invalid encoding and directories", async () => {
    const { root, inspect } = await fixture();
    await writeFile(join(root, "syntax.json"), '{"name":');
    expect(await inspect({ path: "syntax.json" })).toMatchObject({
      ok: true,
      data: { valid: false, syntaxValid: false },
    });
    await writeFile(
      join(root, "encoding.json"),
      Buffer.from([0xff, 0xfe, 0x7b]),
    );
    expect(await inspect({ path: "encoding.json" })).toMatchObject({
      ok: false,
      errorCode: "json_invalid_encoding",
    });
    await mkdir(join(root, "directory"));
    expect(await inspect({ path: "directory" })).toMatchObject({
      ok: false,
      errorCode: "json_target_not_file",
    });
  }, 30_000);

  test("bounds input size and structure depth", async () => {
    const { root, inspect } = await fixture();
    await writeFile(
      join(root, "large.json"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 32),
    );
    expect(await inspect({ path: "large.json" })).toMatchObject({
      ok: false,
      errorCode: "json_file_too_large",
    });
    await writeFile(join(root, "deep.json"), '{"nested":{"child":1}}');
    expect(await inspect({ path: "deep.json", maxDepth: 1 })).toMatchObject({
      ok: true,
      data: {
        structure: {
          keys: [{ key: "nested", value: "[object at depth limit]" }],
        },
        truncation: { maxDepth: 1, truncatedNodes: 1 },
      },
    });
  }, 30_000);

  test("returns an aborted result before reading", async () => {
    const { root, inspect } = await fixture();
    await writeFile(join(root, "cancel.json"), "{}");
    const controller = new AbortController();
    controller.abort();
    expect(
      await inspect(
        { path: "cancel.json" },
        { abortSignal: controller.signal },
      ),
    ).toMatchObject({
      ok: false,
      interruption: "aborted",
      errorCode: "json_inspection_cancelled",
    });
  });
});
