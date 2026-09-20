import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createToolPermissionModeController } from "../../web-ui/app/controllers/tool-permission-mode-controller.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { createSessionComposerQueue } from "../../web-ui/app/lib/session-composer-queue.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { parseRequestInput } from "../request/input.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createQueuedModeSelector() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const config = {
    backend: "runtime",
    supportedToolPermissionModes: ["ask", "full_access", "full_plus"],
  };
  const control = () => ({
    innerHTML: "",
    title: "",
    disabled: false,
    hidden: false,
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    querySelectorAll: () => [],
  });
  const controller = createToolPermissionModeController({
    state: { config, sessionModes: {}, permissionModeMenuOpen: false },
    dom: { permissionModeButton: control(), permissionModeMenu: control() },
    preferences: createClientPreferences(storage),
    recordControlEvent: vi.fn(),
    getComposerSessionId: () => "session-queued",
  });
  return { controller, storage, config };
}

function authorityObservationTool(
  name: string,
  restricted: boolean,
): ToolModuleDeclaration {
  return {
    definition: {
      name,
      routingCapability: "semantic_lookup",
      ...(restricted ? { requiredPermissionMode: "full_plus" as const } : {}),
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: name,
          summary: "Observe request authority.",
          effect: "read_only",
          approval: "request_policy",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    },
    implementation: vi.fn(async (_params, context) => ({
      ok: true,
      output: JSON.stringify(context?.sharedState?.requestContext),
      producedNewInformation: true,
    })),
  };
}

test.each([
  {
    captured: "full_plus",
    later: "ask",
    names: ["ordinary", "system"],
    dispatched: "system",
    approvals: 0,
  },
  {
    captured: "full_access",
    later: "full_plus",
    names: ["ordinary"],
    dispatched: "ordinary",
    approvals: 0,
  },
  {
    captured: "ask",
    later: "full_plus",
    names: ["ordinary"],
    dispatched: "ordinary",
    approvals: 1,
  },
] as const)(
  "queued $captured remains authoritative after the selector changes to $later",
  async ({ captured, later, names, dispatched, approvals }) => {
    const { controller, storage, config } = createQueuedModeSelector();
    const queueScope = { environmentId: "prod", sessionId: "session-queued" };
    controller.setToolPermissionMode(captured);
    createSessionComposerQueue({ storage }).enqueue(queueScope, {
      waitForRequestId: "previous",
      text: "Observe the captured request authority.",
      attachments: [],
      agentMode: "reasoning",
      toolPermissionMode: controller.currentToolPermissionMode(),
    });
    controller.setToolPermissionMode(later);
    const released = createSessionComposerQueue({ storage }).releaseForTerminal(
      queueScope,
      "previous",
    )!;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ requestId: "request-queued" }), {
          status: 200,
        }),
    );
    const client = createRuntimeWebClient({
      getConfig: () => config,
      getEnvironmentId: () => "prod",
      fetchImpl,
      origin: "http://localhost:5177",
    });
    await client.postChatMessage({
      ...released.item,
      sessionId: queueScope.sessionId,
    });
    const envelope = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    const parsed = parseRequestInput({
      ...envelope,
      type: "run_request",
      requestId: "request-queued",
    });
    const ordinary = authorityObservationTool("ordinary", false);
    const system = authorityObservationTool("system", true);
    const registry = createConfiguredToolRegistry(undefined, [
      ordinary,
      system,
    ]);
    const invoke = vi.fn(async () => {
      throw new Error("unexpected model invocation");
    });
    const requestToolApproval = vi.fn(async () => ({ approved: true }));
    const scope = createTestRequestExecutionScopeWithCapabilities(
      {
        requestId: parsed.requestId,
        sessionId: parsed.sessionId,
        prompt: parsed.prompt,
        toolPermissionMode: parsed.toolPermissionMode,
        historyMessages: [],
        shouldGenerateSessionTitle: false,
        agentMode: "reasoning",
        abortSignal: new AbortController().signal,
        modelGatewayClient: { invoke, invokeRaw: invoke },
        toolApprovalController: { requestToolApproval },
        runnerConfig: {
          models: { defaults: { profileId: "unused", steps: {} } },
          context: {
            outputReserveTokens: 1000,
            safetyReserveTokens: 200,
            attachmentReserveTokens: 100,
          },
          steps: {},
        },
        onAcknowledgement: vi.fn(),
        onSessionTitle: vi.fn(async () => undefined),
        onThinkingDelta: vi.fn(),
        onThinkingTrace: vi.fn(),
        onAnswerToken: vi.fn(),
        onEvent: vi.fn(),
      },
      (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          toolRegistryOverride: registry,
        }),
    );
    parsed.toolPermissionMode = later;
    expect(controller.currentToolPermissionMode()).toBe(later);
    expect(scope.toolPermissionMode).toBe(captured);
    const provider = scope.workerCapabilities.provider;
    expect(
      provider.getAvailableTools?.()?.map(({ toolName }) => toolName),
    ).toEqual(names);
    expect(
      provider.getDescriptors().map(({ capabilityId }) => capabilityId),
    ).toEqual(names);
    const adapters = provider.getAdapters();
    expect(adapters.map(({ descriptor }) => descriptor.capabilityId)).toEqual(
      names,
    );
    const result = await adapters
      .find(({ descriptor }) => descriptor.capabilityId === dispatched)!
      .execute({
        context: scope.workerCapabilities.executionContext,
        call: {
          callId: "root",
          parentCallId: null,
          roleId: "supervisor",
          depth: 0,
          objective: null,
          dependencyResultRefs: [],
          status: "active",
          childCallIds: [],
          activationCount: 1,
          resultRef: null,
        },
        executionId: "queued-execution",
        intent: "Observe authority.",
        controls: {},
        settledCapabilityResults: [],
      });
    expect(result.outcome).toBe("succeeded");
    const executed = dispatched === "system" ? system : ordinary;
    expect(executed.implementation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sharedState: expect.objectContaining({
          requestContext: expect.objectContaining({
            toolPermissionMode: captured,
          }),
          availableTools: names.map((toolName) =>
            expect.objectContaining({ toolName }),
          ),
        }),
      }),
    );
    expect(requestToolApproval).toHaveBeenCalledTimes(approvals);
    expect(invoke).not.toHaveBeenCalled();
    const unavailable = dispatched === "system" ? ordinary : system;
    expect(unavailable.implementation).not.toHaveBeenCalled();
  },
);
