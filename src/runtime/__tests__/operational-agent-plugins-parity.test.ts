import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

type Handler = (
  params: Record<string, unknown>,
  executionContext?: Readonly<{ abortSignal?: AbortSignal }>,
) => Promise<ToolImplementationOutput>;

function loadManifest(pluginName: string) {
  const raw = JSON.parse(
    readFileSync(join(rootDir, "plugins", pluginName, "plugin.json"), "utf-8"),
  ) as unknown;
  return parseAgentPluginManifest(raw, pluginName);
}

function loadEntrypoint(pluginName: string) {
  return loadBundledPluginEntrypoint<
    Readonly<Record<string, unknown>>,
    Readonly<{ handlers: Readonly<Record<string, Handler>> }>
  >(pluginName);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("operational Agent Plugins parity", () => {
  test.each([
    {
      pluginName: "json-inspector",
      capabilityId: "inspect_json",
      skillName: "json_inspector_skill",
      settings: { defaultDepth: 3 },
      capability: {
        routingCapability: "semantic_lookup",
        runtimePathBindings: [
          {
            operationId: "inspect_json",
            param: "path",
            base: "worker_working_directory",
          },
        ],
        skills: ["json_inspector_skill"],
        operations: {
          inspect_json: {
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 1024 },
                maxDepth: { type: "integer", minimum: 0, maximum: 6 },
              },
              required: ["path"],
            },
            effect: "read_only",
            approval: "request_policy",
          },
        },
      },
    },
  ])(
    "$pluginName owns its bounded read-only declaration",
    ({ pluginName, capabilityId, settings, capability: expected }) => {
      const manifest = loadManifest(pluginName);
      const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
      const capability = extension.capabilities[capabilityId];

      expect(extension.settings?.defaults).toEqual(settings);
      expect(capability).toMatchObject(expected);
      expect(capability?.description).toEqual(expect.any(String));
      expect(capability?.operations.inspect_json?.summary).toEqual(
        expect.any(String),
      );

      const entrypoint = loadEntrypoint(pluginName)({
        config: extension.settings?.defaults,
        runtimePaths: {},
      });
      expect(Object.keys(entrypoint)).toEqual(["handlers"]);
      expect(Object.keys(entrypoint.handlers)).toEqual([capabilityId]);
    },
  );

  test("json-inspector preserves valid and invalid artifact results", async () => {
    const manifest = loadManifest("json-inspector");
    const config =
      manifest.extensions[ABOT_RUNTIME_EXTENSION].settings?.defaults;
    const tempRoot = await mkdtemp(join(tmpdir(), "json-inspector-parity-"));
    temporaryRoots.push(tempRoot);
    const agentWorkDir = join(tempRoot, "agent-work");
    const workspaceDir = join(tempRoot, "workspace");
    await Promise.all([
      mkdir(agentWorkDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);
    await writeFile(
      join(agentWorkDir, "valid.json"),
      JSON.stringify({ items: [{ id: 1, active: true }] }),
      "utf-8",
    );
    await writeFile(join(agentWorkDir, "invalid.json"), '{"id":1,}', "utf-8");
    await writeFile(
      join(agentWorkDir, "long-key.json"),
      JSON.stringify({ ["k".repeat(2_000)]: true }),
      "utf-8",
    );
    const runtimePaths = {
      rootDir: tempRoot,
      agentWorkDir,
      workspaceDir,
    };
    const context = {
      config,
      runtimePaths,
      runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    };
    const canonical = loadEntrypoint("json-inspector")(context);

    await expect(
      canonical.handlers.inspect_json?.({ path: "valid.json", maxDepth: 2 }),
    ).resolves.toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        location: "agent_work",
        path: "valid.json",
        valid: true,
        maxDepth: 2,
        structure: {
          type: "object",
          totalKeys: 1,
          returnedKeys: 1,
          truncated: false,
          keys: [
            {
              key: "items",
              value: {
                type: "array",
                length: 1,
                returnedItems: 1,
                truncated: false,
                sampledItems: ["[object at depth limit]"],
              },
            },
          ],
        },
      },
    });
    await expect(
      canonical.handlers.inspect_json?.({ path: "invalid.json" }),
    ).resolves.toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        location: "agent_work",
        path: "invalid.json",
        valid: false,
        syntaxValid: false,
      },
    });

    const longKey = await canonical.handlers.inspect_json?.({
      path: "long-key.json",
    });
    expect(longKey).toMatchObject({
      ok: true,
      data: {
        valid: true,
        truncation: {
          truncatedKeys: 1,
          objectKeyMaxChars: 64,
        },
      },
    });
    const longKeyShape = longKey?.data?.structure as {
      keys?: Array<{ key?: string }>;
    };
    expect(longKeyShape.keys?.[0]?.key).toHaveLength(64);
    expect(String(longKey?.output).length).toBeLessThanOrEqual(20_000);
  });
});
