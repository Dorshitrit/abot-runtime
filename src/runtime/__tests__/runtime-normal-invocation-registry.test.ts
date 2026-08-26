import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createToolRegistry } from "../../capabilities/registry.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createDefaultToolRegistry } from "../default-adapters.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../plugins/loader.js";
import type { RuntimeConfig } from "../ports.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function loadPublicPluginConfig(): RuntimeConfig {
  return loadPublicRuntimeConfig(["document-reader", "filesystem"]);
}

describe("manifest-derived ordinary invocation registry", () => {
  test("projects the configured plugin catalog without a second tool list", () => {
    const config = loadPublicPluginConfig();
    const plugins = loadConfiguredRuntimePlugins(config);
    const manifestOperations = plugins
      .flatMap((plugin) => plugin.capabilities)
      .flatMap((tool) =>
        (tool.normalInvocation?.operations ?? []).map((operation) => ({
          toolName: tool.definition.name,
          operationId: operation.operationId,
          effect: operation.effect,
          approval: operation.approval,
        })),
      )
      .sort(compareOperation);
    const registry = createDefaultToolRegistry(config);
    const registeredOperations = (registry.listNormalInvocations?.() ?? [])
      .flatMap((registration) =>
        registration.contract.operations.map((operation) => ({
          toolName: registration.toolName,
          operationId: operation.operationId,
          effect: operation.effect,
          approval: operation.approval,
        })),
      )
      .sort(compareOperation);

    expect(plugins.length).toBeGreaterThan(0);
    expect(manifestOperations.length).toBeGreaterThan(0);
    expect(registeredOperations).toEqual(manifestOperations);
    expect(
      registry
        .listDefinitions()
        .map(({ name }) => name)
        .sort(),
    ).toEqual(
      plugins
        .flatMap((plugin) => plugin.capabilities)
        .map(({ definition }) => definition.name)
        .sort(),
    );
  });

  test("scopes document-reader working paths exactly once through the full provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-reader-provider-"));
    roots.push(root);
    const agentWorkDir = join(root, "agent-work");
    const workspaceDir = join(root, "workspace");
    await Promise.all([
      mkdir(join(agentWorkDir, "Project"), { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);
    await writeFile(
      join(agentWorkDir, "Project", "report.txt"),
      "Provider-scoped document",
      "utf8",
    );

    const loadedConfig = loadPublicPluginConfig();
    const config: RuntimeConfig = {
      ...loadedConfig,
      paths: {
        ...loadedConfig.paths,
        agentWorkDir,
        workspaceDir,
      },
    };
    const registry = createDefaultToolRegistry(config);
    const events: Array<{
      name: string;
      payload: Record<string, unknown>;
    }> = [];
    const provider = createRegisteredToolWorkerCapabilityProvider<
      Record<string, never>
    >({
      getRequestToolRegistry: () => registry,
      requestId: "request-document-reader-provider",
      sessionId: "session-document-reader-provider",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: async () => ({
          status: "failed",
          code: "payload_model_unavailable",
        }),
      },
      nextApprovalId: () => "approval-unused",
      onEvent: (name, payload) => events.push({ name, payload }),
    });
    const descriptor = provider
      .getDescriptors()
      .find(({ capabilityId }) => capabilityId === "read_document");
    const adapter = provider
      .getAdapters()
      .find(({ descriptor }) => descriptor.capabilityId === "read_document");
    expect(descriptor).toMatchObject({ runtimePathControlIds: ["path"] });
    if (!adapter) throw new Error("document-reader adapter missing");

    const call: RoleCallFrame = Object.freeze({
      callId: "call-document-reader",
      parentCallId: "call-root",
      roleId: "worker",
      depth: 1,
      objective: "Read the current project document.",
      dependencyResultRefs: [],
      status: "active",
      childCallIds: Object.freeze([]),
      activationCount: 1,
      resultRef: null,
      workingDirectory: "Project",
    });
    const execute = (path: string, executionId: string) =>
      adapter.execute({
        context: {},
        call,
        executionId,
        intent: "Read the current project document.",
        controls: { source_mode: "working_path", path },
        settledCapabilityResults: [],
      });

    const relative = await execute("report.txt", "execution-relative");
    const alreadyQualified = await execute(
      "Project/report.txt",
      "execution-already-qualified",
    );
    for (const result of [relative, alreadyQualified]) {
      expect(result).toMatchObject({
        outcome: "succeeded",
        observedEffect: "observation",
      });
      expect(result.summary).toContain("Provider-scoped document");
    }
    const completedEvents = events.filter(
      ({ name }) => name === "tool.completed",
    );
    expect(completedEvents).toHaveLength(2);
    for (const event of completedEvents) {
      expect(event.payload).toMatchObject({
        tool: "document_reader",
        ok: true,
        meta: { path: "Project/report.txt" },
      });
      expect(JSON.stringify(event.payload)).not.toContain(root);
    }
  });

  test("preserves one manifest declaration through loading, packing and execution", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, { boundedQuery: true });
    config.plugins = { allow: ["host-tools.host_lookup"] };

    const loadedPlugins = loadConfiguredRuntimePlugins(config);
    const loadedTool = loadedPlugins[0]?.capabilities[0];
    expect(loadedTool?.definition).not.toHaveProperty("params");
    expect(loadedTool?.definition).not.toHaveProperty("executionEffect");

    const loadedModule = runtimePluginsToToolModules(loadedPlugins)[0];
    expect(loadedModule?.definition).not.toHaveProperty("params");
    expect(loadedModule?.definition).not.toHaveProperty("executionEffect");

    const projected = createToolRegistry({
      modules: runtimePluginsToToolModules(loadedPlugins),
    }).getByName("host_lookup");
    expect(projected).toMatchObject({
      params: { query: "string" },
      executionEffect: "read_only",
    });

    const registry = createDefaultToolRegistry(config);
    expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
      "host_lookup",
    ]);
    expect(registry.listNormalInvocations?.()).toMatchObject([
      {
        toolName: "host_lookup",
        contract: {
          version: 1,
          operations: [
            {
              operationId: "lookup",
              effect: "read_only",
              approval: "request_policy",
            },
          ],
        },
      },
    ]);
    await expect(
      registry.execute({ tool: "host_lookup", params: { query: "runtime" } }),
    ).resolves.toMatchObject({ ok: true, output: "result:runtime" });
  });

  test("fails at the exact invalid manifest operation path", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, { boundedQuery: false });
    config.plugins = { allow: ["host-tools"] };

    expect(() => createDefaultToolRegistry(config)).toThrow(
      "normalInvocation.operations.0.input.properties.query: unbounded string input must contain exactly type and minLength",
    );
  });
});

function compareOperation(
  left: Readonly<{ toolName: string; operationId: string }>,
  right: Readonly<{ toolName: string; operationId: string }>,
): number {
  return (
    left.toolName.localeCompare(right.toolName) ||
    left.operationId.localeCompare(right.operationId)
  );
}

async function createRuntimeConfig(): Promise<{
  rootDir: string;
  config: RuntimeConfig;
}> {
  const rootDir = join(tmpdir(), `normal-invocation-${randomUUID()}`);
  roots.push(rootDir);
  await mkdir(join(rootDir, "plugins"), { recursive: true });
  return {
    rootDir,
    config: {
      runtimeId: "normal-invocation-test",
      agentBridgeUrl: "ws://test",
      modelGatewayUrl: "http://model",
      requestRunner: {
        configPath: join(rootDir, "request-runner.config.json"),
      },
      paths: {
        rootDir,
        runtimeDir: join(rootDir, ".runtime"),
        agentWorkDir: join(rootDir, "agent-work"),
        sessionsDir: join(rootDir, "sessions"),
        attachmentsDir: join(rootDir, "attachments"),
        workspaceDir: join(rootDir, "workspace"),
        sharedDir: join(rootDir, "shared"),
        compiledDir: join(rootDir, "compiled"),
        traceFile: join(rootDir, "trace.jsonl"),
      },
    },
  };
}

async function writeManifestPlugin(
  rootDir: string,
  params: { boundedQuery: boolean },
): Promise<void> {
  const pluginRoot = join(rootDir, "plugins", "host-tools");
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "host-tools",
      version: "1.0.0",
      extensions: {
        "ai.abot.runtime": {
          version: 1,
          entrypoint: "./src/index.cjs",
          capabilities: {
            host_lookup: {
              description: "Look up host-owned information.",
              routingCapability: "semantic_lookup",
              skills: [],
              operations: {
                lookup: {
                  summary: "Look up host-owned information.",
                  input: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      query: params.boundedQuery
                        ? { type: "string", minLength: 1, maxLength: 128 }
                        : { type: "string" },
                    },
                    required: ["query"],
                  },
                  effect: "read_only",
                  approval: "request_policy",
                },
              },
            },
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "src", "index.cjs"),
    `module.exports = {
      handlers: {
        host_lookup: async ({ query }) => ({
          ok: true,
          output: "result:" + query,
          producedNewInformation: true
        })
      }
    };`,
    "utf8",
  );
}
