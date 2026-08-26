import { describe, expect, test, vi } from "vitest";

import type {
  ChatMessage,
  ModelGatewayPolicyConfig,
} from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import {
  REQUEST_INVOKED_STEP_IDS,
  type RequestStepInstructionBlock,
} from "../config/runner/contracts.js";
import { invokeRepairableRawModelStep } from "../model/invoke-raw-step.js";
import { RequestModelStepInvoker } from "../model/invoke-step.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  BOUND_REQUEST_MODEL_INVOCATION,
  type BoundRequestModelInvocationContext,
  type RequestModelInvocationView,
} from "../request/contracts.js";

const MODEL_STEP = "worker.decision" as const;

describe("final model context admission", () => {
  test("does not compact below 70 percent and emits the admitted snapshot", async () => {
    const harness = createHarness();

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(68)],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).resolves.toBe("ok");

    expect(harness.invoke).toHaveBeenCalledTimes(1);
    expect(harness.events).toContainEqual([
      "context.window.snapshot",
      expect.objectContaining({
        invocationId: "request-context-admission:worker.decision:1",
        estimatedInputTokens: 69,
        contextWindowTokens: 100,
        usedContextPercent: 69,
        compactionTriggerInputTokens: 70,
        admissionOutcome: "accepted",
      }),
    ]);
  });

  test("compacts at 70 percent before provider dispatch and commits only the reduced projection", async () => {
    const harness = createHarness({
      providerMeta: {
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
      },
    });
    const commit = vi.fn();
    let currentCompactionScope: ModelStepContextCompactionController["compactionScope"] =
      "session_history";
    const controller = createController({
      compactedMessages: [asciiMessage(5)],
      commit() {
        commit();
        currentCompactionScope = "active_request";
      },
      resolveCompactionScope: () => currentCompactionScope,
    });

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(69)],
        timeoutReason: "test_timeout",
        contextCompaction: controller,
        accept: (text) => text,
      }),
    ).resolves.toBe("ok");

    expect(controller.prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(harness.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [asciiMessage(5)] }),
    );
    expect(harness.events).toContainEqual([
      "context.compaction.started",
      expect.objectContaining({ compactionScope: "session_history" }),
    ]);
    expect(harness.events).toContainEqual([
      "context.compaction.completed",
      expect.objectContaining({
        beforeInputTokens: 70,
        beforeUsedContextPercent: 70,
        afterInputTokens: 6,
        afterUsedContextPercent: 6,
        compactionScope: "session_history",
      }),
    ]);
    expect(harness.events).toContainEqual([
      "context.window.provider_usage",
      expect.objectContaining({
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
        source: "provider_reported",
      }),
    ]);
  });

  test("fails closed at the trigger when no compaction controller is available", async () => {
    const harness = createHarness();

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(69)],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).rejects.toThrow("request_context_compaction_required");

    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual([
      "context.compaction.failed",
      expect.objectContaining({
        reason: "context_compaction_controller_unavailable",
      }),
    ]);
  });

  test("uses an authoritative provider count for the compaction trigger", async () => {
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async () => ({
      inputTokens: 70,
      profileId: "test",
      provider: "ollama",
      model: "test-model",
      contextWindowTokens: 100,
      source: "provider_input_token_count",
    }));
    const harness = createHarness({ countInputTokens });

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(1)],
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).rejects.toThrow("request_context_compaction_required");

    expect(harness.invoke).not.toHaveBeenCalled();
    expect(countInputTokens).toHaveBeenCalledOnce();
    expect(harness.events).toContainEqual([
      "context.compaction.started",
      expect.objectContaining({
        beforeInputTokens: 70,
        beforeUsedContextPercent: 70,
      }),
    ]);
  });

  test("counts calibration instructions and the effective schema before dispatch", async () => {
    const harness = createHarness({
      calibrationInstructions: ["c".repeat(45)],
    });
    const format = {
      type: "json_schema",
      name: "large_schema",
      strict: true,
      schema: {
        type: "object",
        description: "s".repeat(80),
      },
    } as const;

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(5)],
        format,
        timeoutReason: "test_timeout",
        accept: (text) => text,
      }),
    ).rejects.toThrow("request_context_compaction_required");

    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test("does not commit or dispatch when the prepared projection is not reduced", async () => {
    const harness = createHarness();
    const commit = vi.fn();
    const controller = createController({
      compactedMessages: [asciiMessage(69)],
      commit,
    });

    await expect(
      harness.invoker.invoke({
        modelStep: MODEL_STEP,
        messages: [asciiMessage(69)],
        timeoutReason: "test_timeout",
        contextCompaction: controller,
        accept: (text) => text,
      }),
    ).rejects.toThrow("context_compaction_projection_not_reduced");

    expect(commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test("reassesses a repair hint before the second provider dispatch", async () => {
    const harness = createHarness();
    harness.invoke
      .mockResolvedValueOnce({ text: "bad", meta: {} })
      .mockResolvedValueOnce({ text: "good", meta: {} });
    const commit = vi.fn();
    const prepare = vi.fn(async (messages: readonly ChatMessage[]) =>
      Object.freeze({
        messages: [asciiMessage(5), messages.at(-1)!],
        commit,
        scopeId: "role:worker:call-1:continuation",
        sourceRevision: 1,
        coveredSourceCount: 1,
      }),
    );
    const controller: ModelStepContextCompactionController = Object.freeze({
      project: (messages: readonly ChatMessage[]) => [...messages],
      prepare,
    });

    await expect(
      invokeRepairableRawModelStep({
        request: harness.boundRequest,
        modelStep: MODEL_STEP,
        messages: [asciiMessage(20)],
        timeoutReason: "test_timeout",
        contextCompaction: controller,
        maxRepairAttempts: 1,
        validate: (text) =>
          text === "good"
            ? { ok: true, value: text }
            : {
                ok: false,
                stage: "test",
                issues: [
                  { code: "bad_output", path: "output", message: "Fix it." },
                ],
                reason: "bad_output",
              },
        buildRepairHint: () => "r".repeat(55),
      }),
    ).resolves.toBe("good");

    expect(harness.invoke).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(harness.invoke.mock.calls[1]?.[0].messages).toEqual([
      asciiMessage(5),
      { role: "system", content: "r".repeat(55) },
    ]);
  });

  test("automatically projects configured methodology exactly once for every model step", async () => {
    for (const modelStep of REQUEST_INVOKED_STEP_IDS) {
      const sentinel = `CONFIGURED_METHODOLOGY_FOR_${modelStep}`;
      const ref = `./methodologies/${modelStep}.md`;
      const contentHash = `hash-${modelStep}`;
      const harness = createHarness({
        modelStep,
        contextWindowTokens: 10_000,
        instructionBlocks: [
          {
            ref,
            content: sentinel,
            contentHash,
          },
        ],
      });

      await expect(
        harness.invoker.invoke({
          modelStep,
          messages: [{ role: "system", content: "BUILT_IN_CONTRACT" }],
          timeoutReason: "test_timeout",
          accept: (text) => text,
        }),
      ).resolves.toBe("ok");

      const providerInput = harness.invoke.mock.calls[0]![0];
      const serializedMessages = JSON.stringify(providerInput.messages);
      expect(serializedMessages.split(sentinel)).toHaveLength(2);
      expect(serializedMessages).toContain(
        "## Configured operating methodology",
      );
      expect(serializedMessages).not.toContain(ref);
      expect(serializedMessages).not.toContain(contentHash);
    }
  });

  test("does not alter provider messages when the step has no instruction refs", async () => {
    const harness = createHarness();
    const messages: ChatMessage[] = [
      { role: "system", content: "SYSTEM_SENTINEL" },
      { role: "user", content: "USER_SENTINEL" },
    ];

    await harness.invoker.invoke({
      modelStep: MODEL_STEP,
      messages,
      timeoutReason: "test_timeout",
      accept: (text) => text,
    });

    expect(harness.invoke.mock.calls[0]![0].messages).toEqual(messages);
  });

  test("reserves configured methodology before early context projection", () => {
    const harness = createHarness({
      contextWindowTokens: 10_000,
      instructionBlocks: [
        {
          ref: "./methodologies/reserved.md",
          content: "RESERVED_CONFIGURED_METHODOLOGY",
          contentHash: "reserved-methodology-hash",
        },
      ],
    });

    const budget = resolveModelContextBudget({
      runnerConfig: harness.request.runnerConfig,
      agentMode: harness.request.agentMode,
      modelStep: MODEL_STEP,
      ...(harness.request.modelPolicy
        ? { modelPolicy: harness.request.modelPolicy }
        : {}),
    });

    expect(budget.configuredInstructionReserveTokens).toBeGreaterThan(0);
  });

  test("reprojects configured methodology once on each repair attempt", async () => {
    const sentinel = "REPAIR_ATTEMPT_METHODOLOGY_SENTINEL";
    const harness = createHarness({
      contextWindowTokens: 10_000,
      instructionBlocks: [
        {
          ref: "./methodologies/repair.md",
          content: sentinel,
          contentHash: "repair-methodology-hash",
        },
      ],
    });
    harness.invoke
      .mockResolvedValueOnce({ text: "bad", meta: {} })
      .mockResolvedValueOnce({ text: "good", meta: {} });

    await expect(
      invokeRepairableRawModelStep({
        request: harness.boundRequest,
        modelStep: MODEL_STEP,
        messages: [{ role: "system", content: "BUILT_IN_CONTRACT" }],
        timeoutReason: "test_timeout",
        maxRepairAttempts: 1,
        validate: (text) =>
          text === "good"
            ? { ok: true, value: text }
            : {
                ok: false,
                stage: "test",
                issues: [
                  { code: "bad_output", path: "output", message: "Fix it." },
                ],
                reason: "bad_output",
              },
        buildRepairHint: () => "REPAIR_HINT",
      }),
    ).resolves.toBe("good");

    expect(harness.invoke).toHaveBeenCalledTimes(2);
    for (const [providerInput] of harness.invoke.mock.calls) {
      expect(
        JSON.stringify(providerInput.messages).split(sentinel),
      ).toHaveLength(2);
    }
  });
});

function asciiMessage(contentLength: number): ChatMessage {
  return Object.freeze({
    role: "system" as const,
    content: "x".repeat(contentLength),
  });
}

function createController(params: {
  compactedMessages: ChatMessage[];
  commit: () => void;
  compactionScope?: ModelStepContextCompactionController["compactionScope"];
  resolveCompactionScope?: () =>
    ModelStepContextCompactionController["compactionScope"];
}): ModelStepContextCompactionController & {
  prepare: ReturnType<typeof vi.fn>;
} {
  const prepare = vi.fn(async () =>
    Object.freeze({
      messages: params.compactedMessages,
      commit: params.commit,
      scopeId: "role:worker:call-1:continuation",
      sourceRevision: 1,
      coveredSourceCount: 1,
    }),
  );
  return Object.freeze({
    get compactionScope() {
      return (
        params.resolveCompactionScope?.() ??
        params.compactionScope ??
        "active_request"
      );
    },
    project: (messages: readonly ChatMessage[]) => [...messages],
    prepare,
  });
}

function createHarness(
  options: Readonly<{
    modelStep?: ModelStep;
    contextWindowTokens?: number;
    instructionBlocks?: readonly RequestStepInstructionBlock[];
    calibrationInstructions?: readonly string[];
    providerMeta?: Record<string, unknown>;
    countInputTokens?: ModelGatewayClient["countInputTokens"];
  }> = {},
) {
  const modelStep = options.modelStep ?? MODEL_STEP;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: "ok",
    meta: options.providerMeta ?? {},
  }));
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: {
      test: { type: "ollama" },
    },
    profiles: {
      test: {
        provider: "test",
        model: "test-model",
        contextWindowTokens: options.contextWindowTokens ?? 100,
        context: {
          tokenEstimation: {
            asciiCharactersPerToken: 1,
            nonAsciiBytesPerToken: 1,
            messageOverheadTokens: 1,
          },
        },
        ...(options.calibrationInstructions
          ? {
              calibration: {
                [modelStep]: {
                  instructions: [...options.calibrationInstructions],
                },
              },
            }
          : {}),
      },
    },
    defaults: {
      profileId: "test",
      steps: { [modelStep]: modelStep },
    },
  };
  const request: RequestModelInvocationView = Object.freeze({
    requestId: "request-context-admission",
    runnerConfig: {
      models: {
        defaults: {
          profileId: "test",
          steps: { [modelStep]: modelStep },
        },
      },
      context: {
        outputReserveTokens: 10,
        safetyReserveTokens: 10,
        attachmentReserveTokens: 1,
      },
      steps: {
        [modelStep]: {
          timeoutMs: 20_000,
          ...(options.instructionBlocks
            ? { instructionBlocks: options.instructionBlocks }
            : {}),
        },
      },
    },
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: {
      invoke,
      invokeRaw: vi.fn(),
      ...(options.countInputTokens
        ? { countInputTokens: options.countInputTokens }
        : {}),
    },
    abortSignal: new AbortController().signal,
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
  });
  const invoker = new RequestModelStepInvoker(request, (name, extra) => {
    events.push([name, extra]);
  });
  const boundRequest = {
    ...request,
    modelSteps: invoker,
  } as BoundRequestModelInvocationContext;
  Object.defineProperty(boundRequest, BOUND_REQUEST_MODEL_INVOCATION, {
    value: true,
  });
  return {
    invoke,
    events,
    invoker,
    boundRequest,
    request,
  };
}
