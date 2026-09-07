import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import type {
  CompiledPluginCapability,
  CompiledRuntimePlugin,
} from "../plugins/compiled-catalog.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const FILESYSTEM_TOOL_NAMES = [
  "dev_view",
  "edit_file",
  "read_file",
  "write_file",
] as const;

function loadFilesystemCatalog(): CompiledRuntimePlugin {
  const baseline = loadPublicRuntimeConfig(["filesystem"]);
  const plugin = loadConfiguredRuntimePlugins({
    ...baseline,
    plugins: { enabled: true, allow: ["filesystem"] },
  }).find(({ id }) => id === "filesystem");
  if (!plugin) throw new Error("missing filesystem Agent Plugin");
  return plugin;
}

function catalogCapability(
  plugin: CompiledRuntimePlugin,
  name: string,
): CompiledPluginCapability {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.definition.name === name,
  );
  if (!capability) throw new Error(`missing filesystem capability ${name}`);
  return capability;
}

function createSourcePlugin(
  input: Readonly<{
    rootDir: string;
    agentWorkDir: string;
    workspaceDir: string;
  }>,
) {
  const runtimePaths: RuntimePluginLoadContext["runtimePaths"] = {
    rootDir: input.rootDir,
    runtimeDir: path.join(input.rootDir, ".runtime"),
    agentWorkDir: input.agentWorkDir,
    sessionsDir: path.join(input.rootDir, ".runtime", "sessions"),
    attachmentsDir: path.join(input.rootDir, ".runtime", "attachments"),
    workspaceDir: input.workspaceDir,
    sharedDir: path.join(input.rootDir, ".runtime", "shared"),
    compiledDir: path.join(input.rootDir, ".runtime", "compiled"),
    traceFile: path.join(input.rootDir, ".runtime", "trace.jsonl"),
  };
  return createFilesystemPlugin({
    id: "filesystem",
    path: path.join(process.cwd(), "plugins", "filesystem"),
    pluginRoot: path.join(process.cwd(), "plugins", "filesystem"),
    stateDir: path.join(input.rootDir, ".runtime", "plugins", "filesystem"),
    rootDir: input.rootDir,
    runtimeId: "filesystem-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
  });
}

const nativePlatform = process.platform;
const testBackends =
  nativePlatform === "linux" ? ["linux", "darwin"] : [nativePlatform];

describe.each(testBackends)(
  "filesystem Agent Plugin (%s backend)",
  (platform) => {
    let tempRoot = "";
    let agentWorkDir = "";
    let workspaceDir = "";

    beforeEach(async () => {
      Object.defineProperty(process, "platform", { value: platform });
      vi.stubEnv("LLM_RUNTIME_TRACE", "0");
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "filesystem-plugin-"));
      agentWorkDir = path.join(tempRoot, "agent-work");
      workspaceDir = path.join(tempRoot, "workspace-source");
      await Promise.all([
        mkdir(agentWorkDir, { recursive: true }),
        mkdir(workspaceDir, { recursive: true }),
      ]);
    });

    afterEach(async () => {
      Object.defineProperty(process, "platform", { value: nativePlatform });
      vi.unstubAllEnvs();
      await rm(tempRoot, { recursive: true, force: true });
    });

    test("projects the canonical manifest, payload stages, adapters, and skills", () => {
      const raw = JSON.parse(
        readFileSync(
          path.join(process.cwd(), "plugins/filesystem/plugin.json"),
          "utf8",
        ),
      ) as unknown;
      const extension = parseAgentPluginManifest(raw, "filesystem").extensions[
        ABOT_RUNTIME_EXTENSION
      ];
      expect(Object.keys(extension.capabilities)).toEqual(
        FILESYSTEM_TOOL_NAMES,
      );

      const plugin = loadFilesystemCatalog();
      expect(
        plugin.capabilities.map(({ definition }) => definition.name),
      ).toEqual(FILESYSTEM_TOOL_NAMES);
      expect(
        catalogCapability(plugin, "edit_file").definition.payloadChannelSpec
          ?.stages,
      ).toHaveLength(2);
      expect(
        catalogCapability(plugin, "write_file").normalInvocation?.operations[0],
      ).toMatchObject({
        operationId: "write_complete_file",
        input: { required: ["path"] },
        payload: {
          kind: "raw_text",
          param: "content",
          minBytes: 1,
          maxBytes: 1_048_576,
        },
        effect: "mutating",
        approval: "request_policy",
      });
      expect(plugin.capabilitySkills).toEqual({
        edit_file: ["follow_up_existing_file_edit_skill", "edit_file_skill"],
        read_file: ["read_file_skill"],
      });
    });

    test("treats an extensionless target as a file and returns only logical paths", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      const writeResult = await plugin.handlers.write_file!({
        path: "Dockerfile",
        content: "FROM node:22\n",
      });
      expect(writeResult).toMatchObject({
        ok: true,
        producedNewInformation: true,
      });
      await expect(
        stat(path.join(agentWorkDir, "Dockerfile")),
      ).resolves.toMatchObject({});
      await expect(
        readFile(path.join(agentWorkDir, "Dockerfile"), "utf8"),
      ).resolves.toBe("FROM node:22\n");
      expect(writeResult.output).toContain("Path: Dockerfile");
      expect(writeResult.output).not.toContain(tempRoot);
      expect(writeResult.actions?.[0]?.target).toBe("Dockerfile");
    });

    test("reads agent-work and workspace files without exposing physical roots", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      await Promise.all([
        writeFile(path.join(agentWorkDir, "notes.txt"), "agent text"),
        writeFile(path.join(workspaceDir, "reference.txt"), "workspace text"),
      ]);
      const agentRead = await plugin.handlers.read_file!({ path: "notes.txt" });
      const workspaceRead = await plugin.handlers.read_file!({
        path: "workspace/reference.txt",
      });
      expect(agentRead.output).toContain("Path: notes.txt");
      expect(agentRead.output).toContain("Content:\nagent text");
      expect(workspaceRead.output).toContain("Path: workspace/reference.txt");
      expect(workspaceRead.output).toContain("Content:\nworkspace text");
      expect(`${agentRead.output}\n${workspaceRead.output}`).not.toContain(
        tempRoot,
      );
    });

    test("preserves canonical path-policy failures and never allows runtime_root", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      const rootOnly = path.join(tempRoot, "root-only.txt");
      await writeFile(rootOnly, "private root content");
      const traversal = await plugin.handlers.read_file!({
        path: "../../outside.txt",
      });
      const runtimeRoot = await plugin.handlers.read_file!({ path: rootOnly });
      expect(traversal).toMatchObject({
        ok: false,
        errorCode: "runtime_tool_path_outside_configured_roots",
      });
      expect(runtimeRoot).toMatchObject({
        ok: false,
        errorCode: "runtime_tool_path_outside_configured_roots",
      });
      expect(runtimeRoot.output).not.toContain(tempRoot);
    });

    test("blocks symlink escape with the canonical resolver code", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      const outside = await mkdtemp(
        path.join(os.tmpdir(), "filesystem-outside-"),
      );
      try {
        await writeFile(path.join(outside, "secret.txt"), "secret");
        await symlink(outside, path.join(agentWorkDir, "escape"));
        const result = await plugin.handlers.read_file!({
          path: "escape/secret.txt",
        });
        expect(result).toMatchObject({
          ok: false,
          errorCode: "runtime_tool_path_symlink_escape",
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    test("bounds file and directory observations with explicit metadata", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      await writeFile(path.join(agentWorkDir, "large.txt"), "x".repeat(80_000));
      const directory = path.join(agentWorkDir, "many");
      await mkdir(directory);
      await Promise.all(
        Array.from({ length: 170 }, (_, index) =>
          writeFile(
            path.join(directory, `entry-${String(index).padStart(3, "0")}.txt`),
            "x",
          ),
        ),
      );
      const fileResult = await plugin.handlers.read_file!({
        path: "large.txt",
      });
      const directoryResult = await plugin.handlers.dev_view!({ path: "many" });
      expect(fileResult.output.length).toBeLessThan(25_000);
      expect(fileResult.data?.truncation).toMatchObject({ truncated: true });
      expect(directoryResult.data?.itemCount).toBe(160);
      expect(directoryResult.data?.truncation).toMatchObject({
        truncated: true,
        returnedItems: 160,
      });
      expect(directoryResult.output).toContain("More entries: yes");
    });

    test("applies one scoped edit and refuses invalid structured drafts", async () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      await writeFile(
        path.join(agentWorkDir, "notes.txt"),
        "alpha\nbeta\ngamma",
      );
      const editResult = await plugin.handlers.edit_file!({
        path: "notes.txt",
        instruction: "Replace the second line.",
        selection: JSON.stringify({
          placement: "replace",
          start_line: 2,
          end_line: 2,
        }),
        content: "updated",
      });
      expect(editResult).toMatchObject({ ok: true });
      await expect(
        readFile(path.join(agentWorkDir, "notes.txt"), "utf8"),
      ).resolves.toBe("alpha\nupdated\ngamma");
      expect(editResult.output).not.toContain(tempRoot);

      const invalidJson = await plugin.handlers.write_file!({
        path: "broken.json",
        content: '{"missing":',
      });
      expect(invalidJson).toMatchObject({
        ok: false,
        errorCode: "file_syntax_invalid",
      });
      await expect(
        stat(path.join(agentWorkDir, "broken.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    test("keeps resolver and filesystem state isolated between plugin instances", async () => {
      const secondRoot = await mkdtemp(
        path.join(os.tmpdir(), "filesystem-second-"),
      );
      const secondAgent = path.join(secondRoot, "agent-work");
      const secondWorkspace = path.join(secondRoot, "workspace");
      await Promise.all([
        mkdir(secondAgent, { recursive: true }),
        mkdir(secondWorkspace, { recursive: true }),
      ]);
      try {
        const first = createSourcePlugin({
          rootDir: tempRoot,
          agentWorkDir,
          workspaceDir,
        });
        const second = createSourcePlugin({
          rootDir: secondRoot,
          agentWorkDir: secondAgent,
          workspaceDir: secondWorkspace,
        });
        await Promise.all([
          first.handlers.write_file!({ path: "same.txt", content: "first" }),
          second.handlers.write_file!({ path: "same.txt", content: "second" }),
        ]);
        await expect(
          readFile(path.join(agentWorkDir, "same.txt"), "utf8"),
        ).resolves.toBe("first");
        await expect(
          readFile(path.join(secondAgent, "same.txt"), "utf8"),
        ).resolves.toBe("second");
      } finally {
        await rm(secondRoot, { recursive: true, force: true });
      }
    });

    test("validates one write target before execution", () => {
      const plugin = createSourcePlugin({
        rootDir: tempRoot,
        agentWorkDir,
        workspaceDir,
      });
      expect(
        plugin.adapters?.write_file?.validateCall?.({
          tool: "write_file",
          params: { path: "project/data.json" },
        }),
      ).toBeNull();
      expect(
        plugin.adapters?.write_file?.validateCall?.({
          tool: "write_file",
          params: { path: "project/data.json|project/index.html" },
        }),
      ).toMatchObject({ error: "single_target_path_required" });
    });
  },
);
