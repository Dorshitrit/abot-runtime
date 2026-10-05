import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";
import {
  createRuntimeToolPathResolver,
  scopeRuntimeTargetPath,
} from "../capabilities/runtime-target-path.js";

const temporaryRoots: string[] = [];
const namespaceError = "runtime_tool_path_namespace_invalid";

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const artifacts = join(
    process.cwd(),
    ".codex",
    "artifacts",
    "tool-path-context-phase1-20261003",
  );
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "f1-filesystem-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: join(root, "agent-work"),
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, ".runtime", "shared"),
    compiledDir: join(root, ".runtime", "compiled"),
    traceFile: join(root, ".runtime", "trace.jsonl"),
  };
  await Promise.all(
    [runtimePaths.agentWorkDir, runtimePaths.workspaceDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const runtimePathResolver = createRuntimeToolPathResolver(runtimePaths);
  const loadContext = {
    id: "filesystem",
    path: join(process.cwd(), "plugins", "filesystem"),
    pluginRoot: join(process.cwd(), "plugins", "filesystem"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "filesystem"),
    rootDir: root,
    runtimeId: "filesystem-path-namespace",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver,
  } satisfies RuntimePluginLoadContext & Readonly<{ pluginRoot: string }>;
  return {
    runtimePaths,
    runtimePathResolver,
    plugin: await createFilesystemPlugin(loadContext),
  };
}

describe.skipIf(process.platform === "win32")(
  "POSIX filesystem namespace boundary",
  () => {
    test.each([
      "C:/namespace-project/index.html",
      "temp/../C:/namespace-project/index.html",
      "temp\\..\\C:\\namespace-project\\index.html",
      "workspace/C:/namespace-project/index.html",
      "workspace/temp/../C:/namespace-project/index.html",
      "workspace/\\\\server\\share\\index.html",
      "workspace\\temp\\..\\C:\\namespace-project\\index.html",
    ])("rejects %s before creating a subtree or success receipt", async (path) => {
      const { plugin, runtimePaths } = await createFixture();
      const result = await plugin.handlers.write_file!({
        path,
        content: "<html>namespace boundary</html>",
      });

      expect(result).toMatchObject({ ok: false, errorCode: namespaceError });
      expect(result.actions ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "establish_target" }),
        ]),
      );
      await expect(readdir(runtimePaths.agentWorkDir)).resolves.toEqual([]);
      await expect(readdir(runtimePaths.workspaceDir)).resolves.toEqual([]);
    });

    test.each([
      "C:/project/index.html",
      "C:\\project\\index.html",
      "C:index.html",
      "\\\\server\\share\\index.html",
      "\\\\?\\C:\\index.html",
      "temp/../C:/project/index.html",
    ])(
      "rejects %s at common resolution and before working-directory prefixing",
      async (rawPath) => {
        const { runtimePathResolver, runtimePaths } = await createFixture();
        expect(() => runtimePathResolver.resolve(rawPath)).toThrow(
          namespaceError,
        );
        for (const workingDirectory of [undefined, ".", "Project"]) {
          expect(() =>
            scopeRuntimeTargetPath({
              rawPath,
              ...(workingDirectory ? { workingDirectory } : {}),
              sharedState: { runtimePaths },
            }),
          ).toThrow(namespaceError);
        }
      },
    );

    test("writes an ordinary relative target and preserves the workspace namespace", async () => {
      const { plugin, runtimePaths } = await createFixture();
      for (const path of ["Project/index.html", "workspace/reference.txt"]) {
        const result = await plugin.handlers.write_file!({
          path,
          content: "namespace parity",
        });
        expect(result).toMatchObject({ ok: true, data: { path } });
      }
      await expect(
        readFile(
          join(runtimePaths.agentWorkDir, "Project", "index.html"),
          "utf8",
        ),
      ).resolves.toBe("namespace parity");
      await expect(
        readFile(join(runtimePaths.workspaceDir, "reference.txt"), "utf8"),
      ).resolves.toBe("namespace parity");
    });

    test("preserves direct resolver filename whitespace but validates the trimmed operation target", async () => {
      const { runtimePathResolver, runtimePaths } = await createFixture();
      expect(
        runtimePathResolver.resolve(" C:/literal-name.txt ").logicalPath,
      ).toBe(" C:/literal-name.txt ");
      expect(() =>
        scopeRuntimeTargetPath({
          rawPath: " C:/literal-name.txt ",
          workingDirectory: "Project",
          sharedState: { runtimePaths },
        }),
      ).toThrow(namespaceError);
    });

    test.each([
      ["temp/../Project/index.html", "agentWorkDir", "Project/index.html"],
      ["temp/../workspace/index.html", "agentWorkDir", "workspace/index.html"],
      ["Project/C:/index.html", "agentWorkDir", "Project/C:/index.html"],
      ["temp/../notes:2026/file.txt", "agentWorkDir", "notes:2026/file.txt"],
      ["workspace/temp/../Project/index.html", "workspaceDir", "Project/index.html"],
      ["temp/../\\\\server\\share\\index.html", "agentWorkDir", "server/share/index.html"],
    ] as const)("preserves direct relative normalization for %s", async (path, root, relative) => {
      const { plugin, runtimePaths } = await createFixture();
      const result = await plugin.handlers.write_file!({ path, content: "normalized parity" });
      expect(result.ok).toBe(true);
      await expect(readFile(join(runtimePaths[root], relative), "utf8")).resolves.toBe("normalized parity");
    });

    test.each(["..\\outside.txt", "assets\\..\\..\\outside.txt"])(
      "does not hide traversal in relative backslashes: %s",
      async (rawPath) => {
        const { runtimePathResolver, runtimePaths } = await createFixture();
        expect(() => runtimePathResolver.resolve(rawPath)).toThrow(
          "runtime_tool_path_outside_configured_roots",
        );
        expect(() =>
          scopeRuntimeTargetPath({
            rawPath,
            workingDirectory: "Project",
            sharedState: { runtimePaths },
          }),
        ).toThrow("runtime_target_path_traversal");
      },
    );
  },
);
