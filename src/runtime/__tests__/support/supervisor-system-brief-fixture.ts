import { mkdir, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type WebSocket from "ws";
import type {
  ToolAvailabilityEntry,
  ToolModuleRequestPreparation,
} from "../../../capabilities/tool-types.js";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { projectAvailableTools } from "../../capabilities/tool-availability.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../../plugins/loader.js";
import type { ModelGatewayClient } from "../../ports.js";
import { handleRunRequest } from "../../request/handler.js";
import type { ExecRequestPolicy } from "./exec-command-request-script.js";
import {
  createExecApprovalScript,
  EXEC_APPROVAL_FINAL,
} from "./exec-sensitive-approval-script.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";
import { systemRequestPluginFixture } from "./system-request-plugin-fixture.js";

export const SYSTEM_BRIEF_PROMPT =
  "Observe the configured system capability and report the fixture result.";
export const SYSTEM_BRIEF_CONTROLS = {
  target: "windows",
  command: "fixture-only-command",
  cwd: "C:\\Users\\owner",
} as const;

function responseOnlyModel() {
  return {
    invoke: vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (
        input.modelStep === "supervisor.decision" ||
        input.modelStep === "execution.decision"
      ) {
        return {
          text: JSON.stringify({
            decision: {
              action: "respond",
              acknowledgement: "I will report the fixture result.",
            },
          }),
          meta: {},
        };
      }
      const text =
        input.modelStep === "supervisor.response" && input.format
          ? JSON.stringify({ memoryCandidates: [] })
          : EXEC_APPROVAL_FINAL;
      return { text, meta: {} };
    }),
    invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
      throw new Error("System brief fixture must not call a raw or live model");
    }),
  };
}

export async function runSystemBriefRequest(
  options: {
    policy?: ExecRequestPolicy;
    connected?: boolean;
    enabled?: boolean;
    execute?: boolean;
  } = {},
) {
  const policy = options.policy ?? "supervisor-worker-v1";
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
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  const host = systemRequestPluginFixture();
  if (options.connected === false) {
    host.readHostStatus.mockResolvedValue({ paired: true, connected: false });
  }
  const loaded = loadConfiguredRuntimePlugins({
    ...initial,
    plugins: {
      allow: ["system"],
      deny: options.enabled === false ? ["system"] : [],
    },
  });
  let offered: readonly ToolAvailabilityEntry[] = [];
  const prepare = vi.fn<ToolModuleRequestPreparation>(async (modules) => {
    const prepared = await host.prepare(
      modules.map(({ definition }) => definition.name),
    );
    const registry = createConfiguredToolRegistry(initial, prepared);
    offered = projectAvailableTools(registry.listNormalInvocations!())!;
    return prepared;
  });
  const registry = createConfiguredToolRegistry(
    initial,
    runtimePluginsToToolModules(loaded).map((module) => ({
      ...module,
      prepareRequest: prepare,
      implementation: async () => {
        throw new Error("Unprepared system module executed");
      },
    })),
  );
  const model = options.execute
    ? createExecApprovalScript(
        policy,
        [
          {
            capabilityId: "run_system_command",
            controls: SYSTEM_BRIEF_CONTROLS,
          },
        ],
        "system",
      )
    : responseOnlyModel();
  const sessions = createInMemorySessionStore();
  const sessionId = "system-brief-session";
  await sessions.getOrCreateSession(sessionId);
  await sessions.updateSessionTitle(sessionId, "System brief fixture");
  const events: Record<string, unknown>[] = [];
  const ws = {
    send: (data: string) => events.push(JSON.parse(data)),
  } as unknown as WebSocket;
  await handleRunRequest(
    ws,
    {
      type: "run_request",
      requestId: "system-brief-request",
      sessionId,
      input: SYSTEM_BRIEF_PROMPT,
      agentMode: "reasoning",
      toolPermissionMode: "full_plus",
      modelPreference: { profileId: "fixture", scope: "all" },
    },
    {
      runtimeConfig: {
        ...initial,
        plugins: { enabled: false },
        longTermMemory: { enabled: false, emitClientEvents: false },
        models: {
          providers: { local: { type: "ollama" } },
          profiles: {
            fixture: {
              provider: "local",
              model: "injected-only",
              contextWindowTokens: 64_000,
            },
          },
        },
        modelExecutionPolicies: { fixture: { policy } },
      },
      sessionStore: sessions,
      modelGatewayClient: model,
      toolRegistry: registry,
    },
  );
  return {
    host,
    offered,
    model,
    events,
    prepare,
    session: await sessions.getSessionById(sessionId),
  };
}
