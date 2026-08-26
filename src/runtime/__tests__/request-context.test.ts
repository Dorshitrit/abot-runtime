import { describe, expect, test, vi } from "vitest";

import type {
  ChatMessage,
  ModelGatewayAttachment,
  ModelGatewayJsonSchemaFormat,
  ModelGatewayPolicyConfig,
} from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import type {
  RequestContextBudget,
  RequestHistoryMessage,
} from "../context/request-context-contracts.js";
import { projectRequestContext } from "../context/request-context.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "../context/token-estimator.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";

const TEST_FORMAT: ModelGatewayJsonSchemaFormat = {
  type: "json_schema",
  name: "request_context_test",
  strict: true,
  schema: {
    type: "object",
    properties: {
      decision: { type: "string" },
    },
    required: ["decision"],
    additionalProperties: false,
  },
};

const DEFAULT_BUDGET: RequestContextBudget = {
  contextWindowTokens: 4_000,
  outputReserveTokens: 200,
  safetyReserveTokens: 200,
  attachmentReserveTokens: 256,
};

function historyMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  options: {
    requestId?: string;
    grounding?: "conversation" | "tool_observation";
  } = {},
): RequestHistoryMessage {
  return {
    id,
    role,
    content,
    createdAt: `2026-07-13T00:00:0${id.length}.000Z`,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.grounding ? { grounding: options.grounding } : {}),
  };
}

function projectContext(
  overrides: Partial<Parameters<typeof projectRequestContext>[0]> = {},
) {
  return projectRequestContext({
    instructions: "Follow the decision contract.",
    format: TEST_FORMAT,
    historyMessages: [],
    prompt: "Current request",
    budget: DEFAULT_BUDGET,
    ...overrides,
  });
}

describe("runtime request context", () => {
  test("places the current prompt exactly once as the final message", () => {
    const prompt = "Unique current request";
    const projection = projectContext({
      prompt,
      historyMessages: [
        historyMessage("u1", "user", "Earlier request", {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "Earlier answer", {
          requestId: "req-1",
        }),
      ],
    });

    expect(projection.messages.at(-1)).toEqual({
      role: "user",
      content: prompt,
    });
    expect(
      projection.messages.filter((message) => message.content === prompt),
    ).toHaveLength(1);
  });

  test("keeps prior answers and unanswered user turns without inventing state", () => {
    const projection = projectContext({
      historyMessages: [
        historyMessage("u1", "user", "Old request", {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "Old answer", {
          requestId: "req-1",
        }),
        historyMessage("u2", "user", "Unanswered request", {
          requestId: "req-2",
        }),
        historyMessage("u3", "user", "Recent request", {
          requestId: "req-3",
        }),
        historyMessage("a3", "assistant", "Recent answer", {
          requestId: "req-3",
        }),
      ],
    });

    expect(projection.selectedHistoryMessageIds).toEqual([
      "u1",
      "a1",
      "u2",
      "u3",
      "a3",
    ]);
    expect(projection.messages.slice(1, -1)).toEqual([
      { role: "user", content: "Old request" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "Unanswered request" },
      { role: "user", content: "Recent request" },
      { role: "assistant", content: "Recent answer" },
    ]);
  });

  test("preserves a trailing failed request for a retry follow-up", () => {
    const projection = projectContext({
      historyMessages: [
        historyMessage("u1", "user", "Completed request", {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "Completed answer", {
          requestId: "req-1",
        }),
        historyMessage("u2", "user", "Still unanswered", {
          requestId: "req-2",
        }),
      ],
    });

    expect(projection.selectedHistoryMessageIds).toEqual(["u1", "a1", "u2"]);
    expect(projection.messages.slice(1, -1)).toEqual([
      { role: "user", content: "Completed request" },
      { role: "assistant", content: "Completed answer" },
      { role: "user", content: "Still unanswered" },
    ]);
  });

  test("reconstructs interleaved concurrent turns by request id", () => {
    const projection = projectContext({
      historyMessages: [
        historyMessage("u1", "user", "First request", {
          requestId: "req-1",
        }),
        historyMessage("u2", "user", "Second request", {
          requestId: "req-2",
        }),
        historyMessage("a1", "assistant", "First answer", {
          requestId: "req-1",
        }),
        historyMessage("a2", "assistant", "Second answer", {
          requestId: "req-2",
        }),
      ],
    });

    expect(projection.selectedHistoryMessageIds).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(projection.messages.slice(1, -1)).toEqual([
      { role: "user", content: "First request" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second request" },
      { role: "assistant", content: "Second answer" },
    ]);
  });

  test("drops older whole turns when the token budget only fits the newest pair", () => {
    const instructions = "rules";
    const prompt = "current";
    const recentMessages: ChatMessage[] = [
      { role: "user", content: "r".repeat(200) },
      { role: "assistant", content: "s".repeat(200) },
    ];
    const pinnedTokens = estimateMessagesTokens([
      { role: "system", content: instructions },
      { role: "user", content: prompt },
    ]);
    const formatTokens = estimateTextTokens(JSON.stringify(TEST_FORMAT.schema));
    const recentTokens = estimateMessagesTokens(recentMessages);

    const projection = projectContext({
      instructions,
      prompt,
      historyMessages: [
        historyMessage("u1", "user", "o".repeat(200), {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "p".repeat(200), {
          requestId: "req-1",
        }),
        historyMessage("u2", "user", recentMessages[0]!.content, {
          requestId: "req-2",
        }),
        historyMessage("a2", "assistant", recentMessages[1]!.content, {
          requestId: "req-2",
        }),
      ],
      budget: {
        contextWindowTokens: formatTokens + pinnedTokens + recentTokens,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
      },
    });

    expect(projection.selectedHistoryMessageIds).toEqual(["u2", "a2"]);
    expect(projection.omittedHistoryMessageIds).toEqual(["u1", "a1"]);
    expect(projection.budget.estimatedInputTokens).toBe(
      projection.budget.availableInputTokens,
    );
  });

  test("estimates Hebrew text more conservatively than same-length ASCII", () => {
    expect(estimateTextTokens("שלום")).toBeGreaterThan(
      estimateTextTokens("abcd"),
    );
  });

  test("uses the selected model token-estimation policy", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(40) },
    ];
    const conservative = projectContext({
      instructions: messages[0]!.content,
      prompt: messages[1]!.content,
      budget: {
        ...DEFAULT_BUDGET,
        formatTokenAccounting: { mode: "none" },
      },
    });
    const calibrated = projectContext({
      instructions: messages[0]!.content,
      prompt: messages[1]!.content,
      format: undefined,
      budget: {
        ...DEFAULT_BUDGET,
        formatTokenAccounting: { mode: "none" },
        tokenEstimation: {
          asciiCharactersPerToken: 4,
          nonAsciiBytesPerToken: 2,
          messageOverheadTokens: 6,
        },
      },
    });

    expect(calibrated.budget.estimatedInputTokens).toBe(
      estimateMessagesTokens(messages, {
        asciiCharactersPerToken: 4,
        nonAsciiBytesPerToken: 2,
        messageOverheadTokens: 6,
      }),
    );
    expect(calibrated.budget.estimatedInputTokens).toBeLessThan(
      conservative.budget.estimatedInputTokens,
    );
  });

  test("pins current attachments and reserves their configured token cost", () => {
    const attachment: ModelGatewayAttachment = {
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      storageRef: "session/request/image-1.png",
      data: "aW1hZ2U=",
    };
    const withoutAttachment = projectContext();
    const withAttachment = projectContext({ attachments: [attachment] });

    expect(withAttachment.messages.at(-1)).toEqual({
      role: "user",
      content: "Current request",
      attachments: [attachment],
    });
    expect(withAttachment.budget.attachmentReserveTokens).toBe(
      DEFAULT_BUDGET.attachmentReserveTokens,
    );
    expect(withAttachment.budget.estimatedInputTokens).toBe(
      withoutAttachment.budget.estimatedInputTokens +
        DEFAULT_BUDGET.attachmentReserveTokens,
    );
  });

  test("pins bounded continuation messages after the original current request", () => {
    const continuationMessages: ChatMessage[] = [
      {
        role: "assistant",
        content: '{"kind":"runtime.completed_child_result"}',
      },
      {
        role: "user",
        content: "Continue the same root request.",
      },
    ];
    const withoutContinuation = projectContext();
    const withContinuation = projectContext({ continuationMessages });

    expect(withContinuation.messages.slice(-3)).toEqual([
      { role: "user", content: "Current request" },
      ...continuationMessages,
    ]);
    expect(withContinuation.budget.estimatedInputTokens).toBe(
      withoutContinuation.budget.estimatedInputTokens +
        estimateMessagesTokens(continuationMessages),
    );
  });

  test("can keep the current request after bounded continuation evidence", () => {
    const continuationMessages: ChatMessage[] = [
      {
        role: "assistant",
        content: '{"action":"invoke_role","roleId":"worker"}',
      },
      {
        role: "user",
        content: '{"kind":"runtime_child_result","summary":"تم التنفيذ"}',
      },
    ];
    const defaultProjection = projectContext({ continuationMessages });
    const currentLastProjection = projectContext({
      continuationMessages,
      currentMessagePlacement: "after_continuation",
    });

    expect(currentLastProjection.messages.slice(-3)).toEqual([
      ...continuationMessages,
      { role: "user", content: "Current request" },
    ]);
    expect(currentLastProjection.budget.estimatedInputTokens).toBe(
      defaultProjection.budget.estimatedInputTokens,
    );
  });

  test("pins request source then tool results before the current role assignment", () => {
    const referenceMessages: ChatMessage[] = [
      {
        role: "user",
        content: '{"kind":"runtime_request_source_v1"}',
      },
      {
        role: "user",
        content: '{"kind":"runtime_request_tool_results_v1"}',
      },
    ];
    const withoutReference = projectContext();
    const withReference = projectContext({
      historyMessages: [
        historyMessage("u1", "user", "Earlier request", {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "Earlier answer", {
          requestId: "req-1",
        }),
      ],
      referenceMessages,
    });

    expect(withReference.messages.slice(-5)).toEqual([
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
      ...referenceMessages,
      { role: "user", content: "Current request" },
    ]);
    expect(withReference.budget.estimatedInputTokens).toBe(
      withoutReference.budget.estimatedInputTokens +
        estimateMessagesTokens(referenceMessages) +
        estimateMessagesTokens([
          { role: "user", content: "Earlier request" },
          { role: "assistant", content: "Earlier answer" },
        ]),
    );
  });

  test("classifies pinned and selected-history token pressure", () => {
    const instructions = "Use the runtime contract.";
    const prompt = "Complete the current task.";
    const referenceMessages: ChatMessage[] = [
      { role: "user", content: "Canonical request source" },
    ];
    const continuationMessages: ChatMessage[] = [
      { role: "assistant", content: "Completed child result" },
      { role: "user", content: "Resume the parent decision" },
    ];
    const attachment: ModelGatewayAttachment = {
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      storageRef: "session/request/image-1.png",
      data: "aW1hZ2U=",
    };
    const selectedHistoryMessages: ChatMessage[] = [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier answer" },
    ];

    const projection = projectContext({
      instructions,
      prompt,
      attachments: [attachment],
      referenceMessages,
      continuationMessages,
      historyMessages: [
        historyMessage("u1", "user", "Earlier request", {
          requestId: "req-1",
        }),
        historyMessage("a1", "assistant", "Earlier answer", {
          requestId: "req-1",
        }),
      ],
    });

    expect(projection.budget.parts).toEqual({
      instructionInputTokens: estimateMessagesTokens([
        { role: "system", content: instructions },
      ]),
      priorConversationInputTokens: 0,
      referenceInputTokens: estimateMessagesTokens(referenceMessages),
      currentPromptInputTokens: estimateMessagesTokens([
        { role: "user", content: prompt, attachments: [attachment] },
      ]),
      continuationInputTokens: estimateMessagesTokens(continuationMessages),
      selectedHistoryInputTokens: estimateMessagesTokens(
        selectedHistoryMessages,
      ),
      pinnedInputTokens:
        estimateMessagesTokens([
          { role: "system", content: instructions },
          ...referenceMessages,
          { role: "user", content: prompt, attachments: [attachment] },
          ...continuationMessages,
        ]) +
        DEFAULT_BUDGET.attachmentReserveTokens +
        projection.budget.formatReserveTokens,
    });
    expect(projection.budget.estimatedInputTokens).toBe(
      projection.budget.parts.pinnedInputTokens +
        projection.budget.parts.selectedHistoryInputTokens,
    );
  });

  test("excludes tool observations without breaking the surrounding pair", () => {
    const projection = projectContext({
      historyMessages: [
        historyMessage("u1", "user", "Inspect something", {
          requestId: "req-1",
        }),
        historyMessage("tool-1", "assistant", "Raw tool output", {
          requestId: "req-1",
          grounding: "tool_observation",
        }),
        historyMessage("a1", "assistant", "User-facing result", {
          requestId: "req-1",
          grounding: "conversation",
        }),
      ],
    });

    expect(projection.selectedHistoryMessageIds).toEqual(["u1", "a1"]);
    expect(projection.messages.map((message) => message.content)).not.toContain(
      "Raw tool output",
    );
  });

  test("rejects fixed content that cannot fit without truncation", () => {
    const instructions = "Pinned rules";
    const prompt = "Pinned current request";
    const requiredTokens =
      estimateMessagesTokens([
        { role: "system", content: instructions },
        { role: "user", content: prompt },
      ]) + estimateTextTokens(JSON.stringify(TEST_FORMAT.schema));

    expect(() =>
      projectContext({
        instructions,
        prompt,
        budget: {
          contextWindowTokens: requiredTokens - 1,
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
        },
      }),
    ).toThrow("request_context_required_content_exceeds_budget");
  });

  test("does not charge format tokens when accounting mode is none", () => {
    const instructions = "Pinned rules";
    const prompt = "Pinned current request";
    const pinnedTokens = estimateMessagesTokens([
      { role: "system", content: instructions },
      { role: "user", content: prompt },
    ]);

    const projection = projectContext({
      instructions,
      prompt,
      budget: {
        contextWindowTokens: pinnedTokens,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
      },
    });

    expect(projection.budget.formatReserveTokens).toBe(0);
    expect(projection.budget.availableInputTokens).toBe(pinnedTokens);
    expect(projection.budget.estimatedInputTokens).toBe(pinnedTokens);
  });

  test("adds fixed format overhead only when a format is present", () => {
    const fixedOverheadTokens = 37;
    const budget: RequestContextBudget = {
      ...DEFAULT_BUDGET,
      formatTokenAccounting: {
        mode: "estimate",
        fixedOverheadTokens,
      },
    };
    const withFormat = projectContext({ budget });
    const withoutFormat = projectContext({ budget, format: undefined });

    expect(withFormat.budget.formatReserveTokens).toBe(
      estimateTextTokens(JSON.stringify(TEST_FORMAT.schema)) +
        fixedOverheadTokens,
    );
    expect(withoutFormat.budget.formatReserveTokens).toBe(0);
  });

  test("rejects continuation content that cannot fit without truncation", () => {
    const continuationMessages: ChatMessage[] = [
      { role: "assistant", content: "x".repeat(400) },
      { role: "user", content: "Continue." },
    ];
    const requiredTokens =
      estimateMessagesTokens([
        { role: "system", content: "rules" },
        { role: "user", content: "current" },
        ...continuationMessages,
      ]) + estimateTextTokens(JSON.stringify(TEST_FORMAT.schema));

    expect(() =>
      projectContext({
        instructions: "rules",
        prompt: "current",
        continuationMessages,
        budget: {
          contextWindowTokens: requiredTokens - 1,
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
        },
      }),
    ).toThrow("request_context_required_content_exceeds_budget");
  });

  test("keeps compactable pinned parts byte-identical below the 70 percent trigger", () => {
    const fullMessages: ChatMessage[] = [
      { role: "assistant", content: "full delegated decision" },
      { role: "user", content: "full completed child result" },
    ];
    const compactMessages: ChatMessage[] = [
      { role: "user", content: "compact completed child result" },
    ];
    const onEvent = vi.fn();
    const fullEstimate = estimateMessagesTokens([
      { role: "system", content: "rules" },
      { role: "user", content: "current" },
      ...fullMessages,
    ]);

    const projection = projectContext({
      instructions: "rules",
      prompt: "current",
      format: undefined,
      continuationParts: [
        {
          sourceRef: "result:1",
          category: "role_continuation",
          retention: "compactable",
          messages: fullMessages,
          compactMessages,
        },
      ],
      budget: {
        contextWindowTokens: Math.ceil(fullEstimate / 0.7) + 10,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
      },
      onEvent,
    });

    expect(projection.messages.slice(-3)).toEqual([
      { role: "user", content: "current" },
      ...fullMessages,
    ]);
    expect(projection.compaction).toEqual({
      applied: false,
      compactedSourceRefs: [],
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("uses a supplied compact projection and emits its lifecycle", () => {
    const fullMessages: ChatMessage[] = [
      { role: "assistant", content: "a".repeat(300) },
      { role: "user", content: "b".repeat(300) },
    ];
    const compactMessages: ChatMessage[] = [
      { role: "user", content: "settled result:1" },
    ];
    const baseMessages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "current" },
    ];
    const fullEstimate = estimateMessagesTokens([
      ...baseMessages,
      ...fullMessages,
    ]);
    const compactEstimate = estimateMessagesTokens([
      ...baseMessages,
      ...compactMessages,
    ]);
    const onEvent = vi.fn();

    const projection = projectContext({
      instructions: "rules",
      prompt: "current",
      format: undefined,
      continuationParts: [
        {
          sourceRef: "result:1",
          category: "role_continuation",
          retention: "compactable",
          messages: fullMessages,
          compactMessages,
        },
      ],
      budget: {
        contextWindowTokens: Math.floor(fullEstimate / 0.7),
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
      },
      diagnostic: {
        requestId: "request-compact",
        modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
        callId: "call-1",
      },
      onEvent,
    });

    expect(projection.messages.slice(-2)).toEqual([
      { role: "user", content: "current" },
      ...compactMessages,
    ]);
    expect(projection.compaction).toEqual({
      applied: true,
      compactedSourceRefs: ["result:1"],
    });
    expect(projection.budget.estimatedInputTokens).toBe(compactEstimate);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      "context.compaction.started",
      expect.objectContaining({
        stage: "context_compaction",
        phase: "started",
        modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      "context.compaction.completed",
      expect.objectContaining({
        stage: "context_compaction",
        phase: "completed",
        compactedPartCount: 1,
      }),
    );
  });

  test("does not allow a per-step bypass of the relative compaction trigger", () => {
    const fullMessages: ChatMessage[] = [
      { role: "user", content: "x".repeat(300) },
    ];
    const fullEstimate = estimateMessagesTokens([
      { role: "system", content: "rules" },
      { role: "user", content: "current" },
      ...fullMessages,
    ]);
    const onEvent = vi.fn();

    const projection = projectContext({
      instructions: "rules",
      prompt: "current",
      format: undefined,
      continuationParts: [
        {
          sourceRef: "result:disabled",
          category: "role_continuation",
          retention: "compactable",
          messages: fullMessages,
          compactMessages: [{ role: "user", content: "compact" }],
        },
      ],
      budget: {
        contextWindowTokens: Math.floor(fullEstimate / 0.7),
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
      },
      diagnostic: {
        requestId: "request-disabled",
        modelStep: MODEL_STEPS.TOOL_PAYLOAD_RAW,
      },
      onEvent,
    });

    expect(projection.messages.at(-1)).toEqual({
      role: "user",
      content: "compact",
    });
    expect(projection.compaction).toEqual({
      applied: true,
      compactedSourceRefs: ["result:disabled"],
    });
    expect(onEvent).toHaveBeenCalledWith(
      "context.compaction.completed",
      expect.objectContaining({ phase: "completed" }),
    );
  });

  test("reports required pinned content that cannot fit after safe compaction", () => {
    const onEvent = vi.fn();

    expect(() =>
      projectContext({
        instructions: "rules",
        prompt: "current",
        format: undefined,
        referenceParts: [
          {
            sourceRef: "required:1",
            category: "request_reference",
            retention: "exact",
            messages: [{ role: "user", content: "x".repeat(500) }],
          },
        ],
        budget: {
          contextWindowTokens: 40,
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
          formatTokenAccounting: { mode: "none" },
        },
        diagnostic: {
          requestId: "request-required-overflow",
          modelStep: MODEL_STEPS.WORKER_DECISION,
        },
        onEvent,
      }),
    ).toThrow("request_context_required_content_exceeds_budget");
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      "context.compaction.failed",
      expect.objectContaining({
        stage: "context_compaction",
        phase: "failed",
        reason: "required_content_exceeds_budget",
      }),
    );
  });

  test("defers inner compaction failure without emitting client lifecycle events", () => {
    const onEvent = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const projection = projectContext({
      instructions: "rules",
      prompt: "current",
      format: undefined,
      referenceParts: [
        {
          sourceRef: "required:deferred",
          category: "request_reference",
          retention: "exact",
          messages: [{ role: "user", content: "x".repeat(500) }],
        },
      ],
      budget: {
        contextWindowTokens: 40,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
      },
      diagnostic: {
        requestId: "request-required-deferred",
        modelStep: MODEL_STEPS.WORKER_DECISION,
      },
      onEvent,
      deferCompactionFailure: true,
    });

    expect(projection.budget.estimatedInputTokens).toBeGreaterThan(
      projection.budget.availableInputTokens,
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "compaction.deferred"),
    ).toMatchObject({
      requestId: "request-required-deferred",
      phase: "request_projection",
      reason: "required_content_exceeds_budget",
    });

    log.mockRestore();
  });

  test("logs classified pressure before rejecting pinned content", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      projectContext({
        instructions: "rules",
        prompt: "current",
        continuationMessages: [{ role: "assistant", content: "x".repeat(400) }],
        budget: {
          contextWindowTokens: 100,
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
          formatTokenAccounting: { mode: "none" },
        },
        diagnostic: {
          requestId: "request-overflow",
          modelStep: "worker.decision",
          callId: "call-overflow",
        },
      }),
    ).toThrow("request_context_required_content_exceeds_budget");

    const event = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find(
        (entry) =>
          entry.scope === "runtime.context" &&
          entry.event === "budget.assessed",
      );
    expect(event).toMatchObject({
      requestId: "request-overflow",
      modelStep: "worker.decision",
      callId: "call-overflow",
      phase: "request_projection",
      outcome: "rejected",
      fits: false,
      issueCode: "required_content_exceeds_budget",
      selectedHistoryInputTokens: 0,
      selectedHistoryMessageCount: 0,
    });
    expect(event?.continuationInputTokens).toEqual(expect.any(Number));
    expect(event?.pinnedInputTokens).toEqual(expect.any(Number));

    log.mockRestore();
  });

  test("does not mutate history or current attachment inputs", () => {
    const history: RequestHistoryMessage[] = [
      historyMessage("u1", "user", "Earlier request", {
        requestId: "req-1",
      }),
      historyMessage("a1", "assistant", "Earlier answer", {
        requestId: "req-1",
      }),
    ];
    const attachments: ModelGatewayAttachment[] = [
      {
        id: "image-1",
        kind: "image",
        mimeType: "image/png",
        storageRef: "session/request/image-1.png",
        data: "aW1hZ2U=",
      },
    ];
    const historyBefore = structuredClone(history);
    const attachmentsBefore = structuredClone(attachments);

    projectContext({ historyMessages: history, attachments });

    expect(history).toEqual(historyBefore);
    expect(attachments).toEqual(attachmentsBefore);
  });

  test("keeps physical capacity profile-owned while calibrating projection", () => {
    const calibrationSlot = "supervisorDecision";
    const modelStep = MODEL_STEPS.SUPERVISOR_DECISION;
    const runnerConfig: RequestRunnerConfig = {
      models: {
        defaults: {
          profileId: "test-profile",
          steps: {
            [modelStep]: calibrationSlot,
          },
        },
      },
      context: {
        outputReserveTokens: 256,
        safetyReserveTokens: 500,
        attachmentReserveTokens: 700,
      },
      steps: {
        [modelStep]: {
          timeoutMs: 20_000,
        },
      },
    };
    const modelPolicy: ModelGatewayPolicyConfig = {
      providers: {
        ollama: {
          type: "ollama",
        },
      },
      profiles: {
        "test-profile": {
          provider: "ollama",
          model: "test-model",
          contextWindowTokens: 32_000,
          context: {
            formatTokenAccounting: { mode: "none" },
            tokenEstimation: {
              asciiCharactersPerToken: 4,
              nonAsciiBytesPerToken: 2,
              messageOverheadTokens: 6,
            },
          },
          calibration: {
            [calibrationSlot]: {
              context: {},
            },
          },
        },
      },
      defaults: {
        profileId: "test-profile",
        steps: {
          [modelStep]: calibrationSlot,
        },
      },
    };

    expect(
      resolveModelContextBudget({
        runnerConfig,
        agentMode: "reasoning",
        modelStep,
        modelPolicy,
      }),
    ).toEqual({
      contextWindowTokens: 32_000,
      outputReserveTokens: 256,
      safetyReserveTokens: 500,
      attachmentReserveTokens: 700,
      formatTokenAccounting: { mode: "none" },
      tokenEstimation: {
        asciiCharactersPerToken: 4,
        nonAsciiBytesPerToken: 2,
        messageOverheadTokens: 6,
      },
    });
  });

  test("reserves format tokens by default when calibration is omitted", () => {
    const modelStep = MODEL_STEPS.SUPERVISOR_DECISION;
    const runnerConfig: RequestRunnerConfig = {
      models: {
        defaults: {
          profileId: "test-openai",
          steps: {
            [modelStep]: "supervisorDecision",
          },
        },
      },
      context: {
        outputReserveTokens: 256,
        safetyReserveTokens: 500,
        attachmentReserveTokens: 700,
      },
      steps: {
        [modelStep]: {
          timeoutMs: 20_000,
        },
      },
    };

    expect(
      resolveModelContextBudget({
        runnerConfig,
        agentMode: "reasoning",
        modelStep,
        modelPolicy: {
          providers: {
            openai: {
              type: "openai",
            },
          },
          profiles: {
            "test-openai": {
              provider: "openai",
              model: "gpt-test",
              contextWindowTokens: 32_000,
            },
          },
          defaults: {
            profileId: "test-openai",
            steps: {
              [modelStep]: "supervisorDecision",
            },
          },
        },
      }),
    ).toMatchObject({ formatTokenAccounting: { mode: "estimate" } });
  });
});
