import { describe, expect, test, vi } from "vitest";

import type { ToolModelInvoker } from "../../capabilities/tool-types.js";
import { createRequestToolModelInvoker } from "../adapters/request-tool-model-invoker.js";
import type { ModelGatewayClient, ToolRegistry } from "../ports.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

describe("request-bound tool model", () => {
  test("keeps trusted tool instructions separate and forwards structured format", async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: '{"start_line":1}',
      meta: {},
    });
    const request = createToolModelRequest("request-structured-tool", invoke);
    const format = {
      type: "object",
      properties: { start_line: { type: "integer", minimum: 1 } },
      required: ["start_line"],
      additionalProperties: false,
    };

    await createRequestToolModelInvoker(request).invokeText({
      modelStep: "tool_payload.raw",
      instructions: "Select one bounded location.",
      prompt: "Untrusted draft reference.",
      timeoutReason: "tool_payload_timeout",
      format,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "Select one bounded location." },
          { role: "user", content: "Untrusted draft reference." },
        ],
        format,
      }),
    );
  });

  test("surfaces an output-limited tool model response without repair", async () => {
    const invoke = vi.fn().mockResolvedValueOnce({
      text: '{"start_line":',
      meta: { providerCompletionReason: "max_output_tokens" },
    });
    const request = createToolModelRequest("request-truncated-tool", invoke);
    const format = {
      type: "object",
      properties: { start_line: { type: "integer", minimum: 1 } },
      required: ["start_line"],
      additionalProperties: false,
    };

    await expect(
      createRequestToolModelInvoker(request).invokeText({
        modelStep: "tool_payload.raw",
        instructions: "Select one bounded location.",
        prompt: "Untrusted draft reference.",
        timeoutReason: "tool_payload_timeout",
        format,
      }),
    ).rejects.toMatchObject({
      name: "ModelOutputIncompleteError",
      code: "output_incomplete",
      stage: "provider_completion",
      providerCompletionReason: "max_output_tokens",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("injects the opaque model port into every registry execution", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      tool: "sample",
      output: "ok",
      progress: true,
      producedNewInformation: true,
    });
    const registry = {
      listDefinitions: () => [],
      getDefinition: () => undefined,
      hasToolsAvailable: () => true,
      getImplementations: () => ({}),
      execute,
    } satisfies ToolRegistry;
    const modelInvoker: ToolModelInvoker = Object.freeze({
      invokeText: vi.fn(),
    });
    const bound = bindRequestToolRegistry({ registry, modelInvoker });
    const sharedState = { currentSessionId: "session-1" };

    await bound.execute({ tool: "sample", params: {} }, { sharedState });

    expect(execute).toHaveBeenCalledWith(
      { tool: "sample", params: {} },
      { sharedState, modelInvoker },
    );
  });

  test("injects only current-request attachment handles into prepared tool state", () => {
    const prepareSharedState = vi.fn((state = {}) => ({
      ...state,
      runtimePaths: { agentWorkDir: "/agent", workspaceDir: "/workspace" },
    }));
    const registry = {
      listDefinitions: () => [],
      getDefinition: () => undefined,
      hasToolsAvailable: () => true,
      getImplementations: () => ({}),
      prepareSharedState,
      execute: vi.fn(),
    } satisfies ToolRegistry;
    const modelInvoker: ToolModelInvoker = Object.freeze({
      invokeText: vi.fn(),
    });
    const requestAttachments = [
      {
        id: "att-current",
        kind: "file" as const,
        mimeType: "application/pdf",
        absolutePath: "/private/request/brief.pdf",
        name: "brief.pdf",
      },
    ];

    const bound = bindRequestToolRegistry({
      registry,
      modelInvoker,
      requestAttachments,
    });
    const state = bound.prepareSharedState?.({ currentSessionId: "session-1" });

    expect(prepareSharedState).toHaveBeenCalledWith({
      currentSessionId: "session-1",
      requestAttachments,
    });
    expect(state?.requestAttachments).toBe(requestAttachments);
  });

  test("projects a frozen config-filtered tool brief to plugin execution state", () => {
    const prepareSharedState = vi.fn((state = {}) => state);
    const registry = {
      listDefinitions: () => [],
      listNormalInvocations: () => [
        {
          toolName: "sample_tool",
          definition: {
            name: "sample_tool",
            routingCapability: "semantic_lookup" as const,
            catalogGroups: ["sample"],
            params: {},
          },
          contract: {
            version: 1 as const,
            operations: [
              {
                operationId: "inspect_sample",
                summary: "Inspect one sample.",
                input: {
                  type: "object" as const,
                  additionalProperties: false as const,
                  properties: {
                    secret: {
                      type: "string" as const,
                      minLength: 1,
                      maxLength: 20,
                    },
                  },
                  required: ["secret"],
                },
                effect: "read_only" as const,
                approval: "request_policy" as const,
              },
            ],
          },
        },
      ],
      getDefinition: () => undefined,
      hasToolsAvailable: () => true,
      getImplementations: () => ({}),
      prepareSharedState,
      execute: vi.fn(),
    } satisfies ToolRegistry;
    const bound = bindRequestToolRegistry({
      registry,
      modelInvoker: Object.freeze({ invokeText: vi.fn() }),
    });

    const state = bound.prepareSharedState?.({
      currentSessionId: "session-brief",
    });

    expect(state?.availableTools).toEqual([
      {
        toolName: "sample_tool",
        operationId: "inspect_sample",
        summary: "Inspect one sample.",
        catalogGroups: ["sample"],
        effect: "read_only",
      },
    ]);
    expect(Object.isFrozen(state?.availableTools)).toBe(true);
    expect(Object.isFrozen(state?.availableTools?.[0]?.catalogGroups)).toBe(
      true,
    );
    expect(JSON.stringify(state?.availableTools)).not.toContain("secret");
    expect(JSON.stringify(state?.availableTools)).not.toContain("approval");
  });

  test("reads passive availability lazily from the same snapshot as Worker descriptors", () => {
    const listNormalInvocations = vi
      .fn()
      .mockReturnValueOnce([
        {
          toolName: "configured_sample",
          definition: {
            name: "configured_sample",
            routingCapability: "semantic_lookup",
            catalogGroups: ["custom_group"],
            params: {},
          },
          contract: {
            version: 1,
            operations: [
              {
                operationId: "inspect_sample",
                summary: "Inspect the configured sample.",
                input: {
                  type: "object",
                  additionalProperties: false,
                  properties: {},
                  required: [],
                },
                effect: "read_only",
                approval: "request_policy",
              },
            ],
          },
        },
      ])
      .mockReturnValue([]);
    const prepareSharedState = vi.fn((state = {}) => state);
    const execute = vi.fn();
    const invoke = vi.fn();
    const provider = createRequestWorkerCapabilityProvider({
      request: createToolModelRequest("request-passive-availability", invoke),
      toolRegistryOverride: {
        listDefinitions: () => [],
        listNormalInvocations,
        getDefinition: () => undefined,
        hasToolsAvailable: () => true,
        getImplementations: () => ({}),
        prepareSharedState,
        execute,
      },
    });

    expect(listNormalInvocations).not.toHaveBeenCalled();
    const availability = provider.getAvailableTools();
    expect(availability).toEqual([
      {
        toolName: "configured_sample",
        operationId: "inspect_sample",
        summary: "Inspect the configured sample.",
        catalogGroups: ["custom_group"],
        effect: "read_only",
      },
    ]);
    expect(
      provider.getDescriptors().map(({ capabilityId }) => capabilityId),
    ).toEqual(["inspect_sample"]);
    expect(provider.getAvailableTools()).toEqual(availability);
    expect(listNormalInvocations).toHaveBeenCalledTimes(1);
    expect(prepareSharedState).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(availability)).toBe(true);
    expect(Object.isFrozen(availability?.[0])).toBe(true);
    expect(Object.isFrozen(availability?.[0]?.catalogGroups)).toBe(true);
  });

  test("keeps unavailable registry metadata distinct from an empty tool catalog", () => {
    const provider = createRequestWorkerCapabilityProvider({
      request: createToolModelRequest("request-unavailable-catalog", vi.fn()),
      toolRegistryOverride: {
        listDefinitions: () => [],
        getDefinition: () => undefined,
        hasToolsAvailable: () => false,
        getImplementations: () => ({}),
        execute: vi.fn(),
      },
    });

    expect(provider.getAvailableTools()).toBeUndefined();
  });
});

function createToolModelRequest(
  requestId: string,
  invoke: ModelGatewayClient["invoke"],
) {
  return createTestRequestExecutionScope({
    requestId,
    sessionId: `${requestId}-session`,
    prompt: "Invoke the request-bound tool model.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    agentMode: "reasoning",
    modelPolicy: {
      defaults: {
        profileId: "default",
        steps: { "tool_payload.raw": "toolPayload.raw" },
      },
      providers: { ollama: { type: "ollama" } },
      profiles: {
        default: {
          provider: "ollama",
          model: "test-model",
          contextWindowTokens: 8_000,
        },
      },
    },
    abortSignal: new AbortController().signal,
    runnerConfig: {
      models: {
        defaults: {
          profileId: "default",
          steps: { "tool_payload.raw": "toolPayload.raw" },
        },
      },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: { "tool_payload.raw": { timeoutMs: 5_000 } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}
