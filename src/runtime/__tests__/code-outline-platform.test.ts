import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import createSource from "../../../plugins/code-outline/source/index.js";
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
>("code-outline");
afterEach(removePortablePluginFixtures);

describe.each([
  ["source", createSource],
  ["bundle", createBundle],
] as const)("code-outline platform contract (%s)", (_name, create) => {
  async function fixture() {
    const context = await createPortablePluginFixture("code-outline");
    await mkdir(context.runtimePaths.agentWorkDir);
    await mkdir(context.runtimePaths.workspaceDir);
    const inspect = create(context).handlers.inspect_code_outline!;
    return { context, inspect, root: context.runtimePaths.agentWorkDir };
  }

  test.each(["relative", "backslashes", "absolute"])(
    "reads a %s path with spaces and Unicode",
    async (form) => {
      const { root, inspect } = await fixture();
      const directory = join(root, "source files");
      await mkdir(directory);
      const path = join(directory, "שלום.ts");
      const content =
        'import { value } from "./dependency";\r\nexport function greet() { return value; }\r\nexport class Service {}';
      await writeFile(path, content);
      const inputs = {
        absolute: path,
        backslashes: "source files\\\\שלום.ts",
        relative: "source files/שלום.ts",
      };
      const input = inputs[form as keyof typeof inputs];
      const result = await inspect({ path: input });
      expect(result).toMatchObject({
        ok: true,
        data: {
          location: "agent_work",
          path: "source files/שלום.ts",
          lineCount: 3,
          imports: ["./dependency"],
          symbols: [
            { kind: "function", name: "greet", line: 2 },
            { kind: "class", name: "Service", line: 3 },
          ],
          truncation: { symbolsTruncated: false, importsTruncated: false },
          observationMeta: { kind: "volatile_external", carryPolicy: "never" },
        },
      });
      expect(await readFile(path, "utf8")).toBe(content);
      expect(result.output).not.toContain("return value");
    },
    20_000,
  );

  test("uses workspace and request-scoped roots without reading the installation root", async () => {
    const { context, inspect } = await fixture();
    await writeFile(
      join(context.rootDir, "app.py"),
      "def installation_only(): pass",
    );
    await writeFile(
      join(context.runtimePaths.workspaceDir, "app.py"),
      "import os\r\ndef workspace_only(): pass",
    );
    const requestRoot = join(context.rootDir, "request work");
    await mkdir(requestRoot);
    await writeFile(join(requestRoot, "app.py"), "def request_only(): pass");
    expect(await inspect({ path: "workspace/app.py" })).toMatchObject({
      ok: true,
      data: {
        location: "workspace",
        symbols: [{ name: "workspace_only" }],
        imports: ["os"],
      },
    });
    const result = await inspect(
      { path: "app.py" },
      {
        runtimePathResolver: createRuntimeToolPathResolver({
          ...context.runtimePaths,
          agentWorkDir: requestRoot,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      data: { symbols: [{ name: "request_only" }] },
    });
    expect(
      await inspect({ path: join(context.rootDir, "app.py") }),
    ).toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
  }, 30_000);

  test("rejects traversal and a symlink or junction escaping the authorized root", async () => {
    const { context, root, inspect } = await fixture();
    const outside = join(context.rootDir, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, "secret.ts"),
      "export function privateSymbol() {}",
    );
    await symlink(
      outside,
      join(root, "redirect"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of ["../outside/secret.ts", "redirect/secret.ts"]) {
      const result = await inspect({ path });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toMatch(/^runtime_tool_path_/);
      expect(result.output).not.toContain("privateSymbol");
    }
  });

  test("bounds file input and symbol output without changing the source", async () => {
    const { root, inspect } = await fixture();
    const oversized = Buffer.alloc(512 * 1024 + 1, 32);
    await writeFile(join(root, "large.ts"), oversized);
    expect(await inspect({ path: "large.ts" })).toMatchObject({
      ok: false,
      errorCode: "code_outline_file_too_large",
    });
    await writeFile(
      join(root, "bounded.ts"),
      "export function first() {}\nexport function second() {}",
    );
    expect(await inspect({ path: "bounded.ts", maxSymbols: 1 })).toMatchObject({
      ok: true,
      data: {
        symbols: [{ name: "first" }],
        truncation: {
          totalSymbols: 2,
          returnedSymbols: 1,
          symbolsTruncated: true,
        },
      },
    });
    expect((await readFile(join(root, "large.ts"))).equals(oversized)).toBe(
      true,
    );
  }, 30_000);

  test("distinguishes directories from empty regular files", async () => {
    const { root, inspect } = await fixture();
    await mkdir(join(root, "directory"));
    expect(await inspect({ path: "directory" })).toMatchObject({
      ok: false,
      errorCode: "code_outline_target_not_file",
    });
    await writeFile(join(root, "empty.ts"), "");
    expect(await inspect({ path: "empty.ts" })).toMatchObject({
      ok: true,
      data: { lineCount: 0, symbols: [], imports: [] },
    });
  }, 20_000);

  test("honors cancellation before a read and reports the interruption", async () => {
    const { root, inspect } = await fixture();
    await writeFile(join(root, "cancel.ts"), "export function cancelled() {}");
    const controller = new AbortController();
    controller.abort();
    expect(
      await inspect({ path: "cancel.ts" }, { abortSignal: controller.signal }),
    ).toMatchObject({
      ok: false,
      errorCode: "code_outline_cancelled",
      interruption: "aborted",
    });
  });
});
