import { vi } from "vitest";
import { join } from "node:path";
import type { ModelGatewayClient, ToolPermissionMode } from "../../ports.js";
import type { TestRequestSeed } from "./request-execution-scope.js";
import { CAPABILITY_CONTROLS_MODEL_STEP } from "../../orchestration/worker-capabilities/index.js";
import { loadPublicRuntimeConfig } from "../public-runtime-config-fixture.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createSystemHandlers } from "../../../computer-access/handlers.js";
import type { SystemHostConnection } from "../../../../plugins/system/source/host-dispatch.js";
import { prepareSystemRequestModules } from "../../../../plugins/system/source/request-system-modules.js";
import { observeSystemHost } from "../../../computer-access/host-observation.js";
import {
  successResult,
  type ToolModuleRequestPreparation,
} from "../../../plugin-sdk/index.js";
import { selectedSystemModules } from "./system-request-plugin-fixture.js";

export const selectedHost = "550e8400-e29b-41d4-a716-446655440000";
export const selectedConnection = "550e8400-e29b-41d4-a716-446655440001";
export const finalDispatchReport =
  "The launch request was dispatched to the selected computer. Window visibility is unverified.";

export function createTargetHandoffFixture(root: string) {
  const initial = loadPublicRuntimeConfig(["system"]);
  const config = {
    ...initial,
    paths: {
      ...initial.paths,
      agentWorkDir: join(root, "work"),
      runtimeDir: root,
    },
  };
  const run = vi.fn(async () => {
    throw new Error("unexpected native process");
  });
  const executeHostOperation = vi.fn<
    SystemHostConnection["executeHostOperation"]
  >(async (_root, input) => {
    if (input.operation === "system_applications")
      return successResult({
        output: JSON.stringify([
          { id: "Fixture.App", name: "Fixture", target: "windows" },
        ]),
        data: {
          transport: "host_companion",
          observedMatches: 1,
        },
      });
    return successResult({
      output: "Launch request dispatched; visible window not checked.",
      data: {
        transport: "host_companion",
        evidenceScope: "launch_request_dispatch",
        independentOutcomeCheck: "not_performed",
      },
    });
  });
  const readHostStatus = vi.fn<SystemHostConnection["readHostStatus"]>(
    async () => ({
      paired: true,
      connected: true,
      hostId: selectedHost,
      connectionId: selectedConnection,
      identity: {
        name: "Fixture computer",
        os: "windows",
        user: "owner",
        homeDir: "C:\\Users\\owner",
      },
    }),
  );
  const prepareRequest: ToolModuleRequestPreparation = (modules) =>
    prepareSystemRequestModules(root, modules, {
      connection: { readHostStatus, executeHostOperation },
      observeTargets: async () => ({
        host: observeSystemHost({
          platform: "linux",
          kernelRelease: "fixture",
          containerMarker: true,
        }),
        availabilityScope: "command_execution_only",
        targets: [
          {
            id: "linux",
            transport: "native",
            shell: "/bin/bash",
            available: true,
            commandExecutionAvailable: true,
            guiSessionStatus: "not_checked",
          },
        ],
      }),
      createNativeHandlers: () => createSystemHandlers(run),
    });
  const registry = createConfiguredToolRegistry(
    config,
    selectedSystemModules().map((entry) => ({
      ...entry,
      prepareRequest,
    })),
  );
  return { config, registry, run, executeHostOperation, readHostStatus };
}

export function targetHandoffSeed(
  invoke: ModelGatewayClient["invoke"],
  mode: ToolPermissionMode,
): Omit<TestRequestSeed, "workerCapabilityProvider"> {
  return {
    requestId: "host-selection-request",
    sessionId: "host-selection-session",
    prompt: "Launch Fixture on my Windows computer.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        [
          "supervisor.decision",
          "planner.decision",
          "worker.decision",
          CAPABILITY_CONTROLS_MODEL_STEP,
          "worker.result",
          "reviewer.decision",
          "supervisor.response",
        ].map((step) => [step, { timeoutMs: 20_000 }]),
      ),
    },
    agentMode: "reasoning",
    toolPermissionMode: mode,
    toolApprovalController: {
      requestToolApproval: vi.fn(async () => ({ approved: true })),
    },
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 64_000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  };
}
