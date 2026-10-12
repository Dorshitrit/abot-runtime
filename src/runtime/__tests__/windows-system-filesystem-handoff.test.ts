import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import createSystemPlugin from "../../../plugins/system/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { selectedSystemModules } from "./support/system-request-plugin-fixture.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const require = createRequire(import.meta.url);
afterEach(removePortablePluginFixtures);

describe.skipIf(process.platform !== "win32")(
  "native filesystem to SYSTEM script handoff",
  () => {
    test.each([false, true])(
      "runs the written script in the request root (bundle=%s)",
      async (bundled) => {
        const context = await createPortablePluginFixture("filesystem");
        const requestRoot = join(context.rootDir, "request root שלום");
        await mkdir(requestRoot, { recursive: true });
        await mkdir(context.runtimePaths.agentWorkDir, { recursive: true });
        const runtimePathResolver = createRuntimeToolPathResolver({
          ...context.runtimePaths,
          agentWorkDir: requestRoot,
        });
        const createFilesystem = bundled
          ? (require(join(process.cwd(), "plugins/filesystem/src/index.cjs"))
              .default as RuntimePluginEntrypointFactory)
          : createFilesystemPlugin;
        const filesystem = createFilesystem(context);
        expect(
          await filesystem.handlers.write_file!(
            {
              path: "generator.cmd",
              content: '@echo off\r\n>>"%~dp0result.txt" echo 1\r\n',
            },
            { runtimePathResolver },
          ),
        ).toMatchObject({ ok: true });
        const createSystem = bundled
          ? (require(join(process.cwd(), "plugins/system/src/index.cjs"))
              .default as RuntimePluginEntrypointFactory)
          : createSystemPlugin;
        const system = createSystem({
          ...context,
          id: "system",
          stateDir: join(context.rootDir, "system-state"),
        });
        const modules = await system.prepareRequest!(
          selectedSystemModules(["system_command"]),
          { runtimePathResolver },
        );
        const registry = createConfiguredToolRegistry(undefined, modules);
        const executor = createRegisteredToolNormalInvocationExecutor({
          registrations: registry.listNormalInvocations!(),
          toolRegistry: registry,
          requestId: "native-script-handoff",
          abortSignal: new AbortController().signal,
          nextApprovalId: () => "directory-approval",
          toolPermissionMode: "full_plus",
        });
        const result = await executor.execute({
          handle: executor.operations[0]!.handle,
          controls: {
            target: "windows",
            cwd: ".",
            command: "& '.\\generator.cmd'",
          },
          intent: "Run the generated test script in its own folder.",
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "executed",
          result: { ok: true, exitCode: 0 },
        });
        expect(
          (await readFile(join(requestRoot, "result.txt"), "utf8")).trim(),
        ).toBe("1");
        await expect(
          readFile(join(context.runtimePaths.agentWorkDir, "result.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      45_000,
    );
  },
);
