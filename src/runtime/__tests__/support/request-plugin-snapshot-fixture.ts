import { mkdir, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type WebSocket from "ws";
import type {
  ToolModuleDeclaration,
  ToolModuleRequestPreparation,
} from "../../../capabilities/tool-types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { handleRunRequest } from "../../request/handler.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";
import {
  createSnapshotModelScript,
  type SnapshotModelInput,
  type SnapshotPolicy,
} from "./request-plugin-model-script.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function createRequestPluginSnapshotFixture(
  onlyUnrelated = false,
) {
  const initial = await createRuntimeConfig();
  await mkdir(initial.paths.agentWorkDir, { recursive: true });
  await writeFile(
    initial.requestRunner.configPath!,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "fixture", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 1000 },
      steps: {},
    }),
  );
  const config = {
    ...initial,
    plugins: { enabled: false },
    longTermMemory: { enabled: false, emitClientEvents: false },
    models: {
      providers: { local: { type: "ollama" as const } },
      profiles: {
        fixture: {
          provider: "local",
          model: "fixture",
          contextWindowTokens: 32_000,
        },
      },
    },
  };
  let destination: string | undefined = "private-destination-alpha";
  let pause: Promise<void> | undefined;
  const preparationStarted = deferred();
  const executed = vi.fn<(destination: string, channel: unknown) => void>();
  const prepare = vi.fn<ToolModuleRequestPreparation>(async (modules) => {
    const selected = destination;
    preparationStarted.resolve();
    await pause;
    const isAvailable = (module: ToolModuleDeclaration) => {
      if (selected) return true;
      return module.definition.name !== "fixture_attached";
    };
    return modules.filter(isAvailable).map((module) => ({
      ...module,
      normalInvocation: {
        ...module.normalInvocation,
        operations: module.normalInvocation.operations.map((operation) => ({
          ...operation,
          input: {
            ...operation.input,
            properties: {
              channel: {
                type: "string" as const,
                enum: selected ? ["local", "attached"] : ["local"],
              },
            },
          },
        })),
      },
      adapter: {
        executionBinding: () => ({
          identity: selected ?? "fixture-local",
          metadata: { destinationLabel: selected ?? "local" },
        }),
      },
      implementation: async (params) => {
        executed(selected ?? "fixture-local", params.channel);
        return successResult({ output: "fixture observation" });
      },
    }));
  });
  const unrelated = fixtureModule("fixture_basic", async (params) => {
    executed("fixture-basic", params.channel);
    return successResult({ output: "fixture observation" });
  });
  const modules = onlyUnrelated
    ? [unrelated]
    : [
        { ...fixtureModule("fixture_dispatch"), prepareRequest: prepare },
        { ...fixtureModule("fixture_attached"), prepareRequest: prepare },
        unrelated,
      ];
  const registry = createConfiguredToolRegistry(config, modules);
  let requestIndex = 0;
  return {
    prepare,
    executed,
    registry,
    preparationStarted,
    setDestination(value: string | undefined) {
      destination = value;
    },
    pausePreparation(value: Promise<void>) {
      pause = value;
    },
    async run(
      policy: SnapshotPolicy,
      options: {
        capabilityId?: string;
        channel?: string;
        beforeModel?: (
          input: SnapshotModelInput,
          index: number,
        ) => Promise<void> | void;
      } = {},
    ) {
      const sessionId = `snapshot-session-${++requestIndex}`;
      const sessions = createInMemorySessionStore();
      await sessions.getOrCreateSession(sessionId);
      await sessions.updateSessionTitle(sessionId, "Fixture snapshot");
      const model = createSnapshotModelScript({
        policy,
        capabilityId: options.capabilityId ?? "fixture_dispatch",
        channel: options.channel ?? "attached",
        ...options,
      });
      const events: Record<string, unknown>[] = [];
      const ws = {
        send(data: string) {
          events.push(JSON.parse(data));
        },
      } as unknown as WebSocket;
      await handleRunRequest(
        ws,
        {
          type: "run_request",
          requestId: `snapshot-request-${requestIndex}`,
          sessionId,
          input: "Observe the requested fixture.",
          agentMode: "reasoning",
          toolPermissionMode: "full_plus",
          modelPreference: { profileId: "fixture", scope: "all" },
        },
        {
          runtimeConfig: {
            ...config,
            modelExecutionPolicies: { fixture: { policy } },
          },
          sessionStore: sessions,
          modelGatewayClient: model,
          toolRegistry: registry,
        },
      );
      return {
        model,
        events,
        session: await sessions.getSessionById(sessionId),
      };
    },
  };
}

function fixtureModule(
  name: string,
  implementation: ToolModuleDeclaration["implementation"] = async () => {
    throw new Error("unprepared fixture must never execute");
  },
): ToolModuleDeclaration {
  return {
    definition: {
      name,
      routingCapability: "semantic_lookup",
      catalogGroups: ["fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: name,
          summary: "Observe the requested fixture.",
          effect: "read_only",
          approval: "always",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: { type: "string", enum: ["local", "attached"] },
            },
            required: ["channel"],
          },
        },
      ],
    },
    implementation,
  };
}
