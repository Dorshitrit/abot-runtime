import { describe, expect, test } from "vitest";

import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolAvailabilityOverviewGroup } from "../../plugin-sdk/tool-availability-overview.js";
import {
  CAPABILITY_BRIEF_MAX_TOKENS,
  isCapabilityBriefMessage,
  projectCapabilityBrief,
} from "../context/capability-brief.js";
import type { RequestContextBudget } from "../context/request-context-contracts.js";
import { projectRequestContext } from "../context/request-context.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "../context/token-estimator.js";

type ContextInput = Parameters<typeof projectRequestContext>[0];
const GROUPS: readonly ToolAvailabilityOverviewGroup[] = [
  { groupId: "read", memberCount: 1, effects: ["observation"] },
];
const PASSIVE_MESSAGE: ChatMessage = {
  role: "system",
  content: "x".repeat(120),
};
const HISTORY_MESSAGE = {
  id: "history-1",
  role: "user" as const,
  content: PASSIVE_MESSAGE.content,
  createdAt: "2026-09-04T00:00:00Z",
};

describe("passive capability brief context", () => {
  test("admits a complete detailed brief within the cap including message overhead", () => {
    const context = createContext();
    const projection = projectCapabilityBrief({
      entries: [createEntry()],
      groups: GROUPS,
      context,
    });

    expect(projection.level).toBe("detailed");
    expect(projection.reason).toBe("complete_catalog");
    expect(projection.message?.role).toBe("system");
    expect(projection.message?.content).toContain("reader");
    expect(projection.message?.content).toContain("read_item");
    expect(projection.estimatedTokens).toBe(
      estimateMessageTokens(projection.message!),
    );
    expect(projection.estimatedTokens).toBeGreaterThan(
      estimateTextTokens("reader read_item read"),
    );
    expect(projection.estimatedTokens).toBeLessThanOrEqual(
      CAPABILITY_BRIEF_MAX_TOKENS,
    );
    expect(projection.budgetTokens).toBe(CAPABILITY_BRIEF_MAX_TOKENS);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.message)).toBe(true);
  });

  test("falls back to every tool title when complete operation detail is too large", () => {
    const entries = ["alpha", "beta", "gamma"].map((toolName) =>
      createEntry({
        toolName,
        operationId: `${toolName}_${"x".repeat(1_000)}`,
      }),
    );
    const projection = projectCapabilityBrief({
      entries,
      groups: [{ ...GROUPS[0]!, memberCount: entries.length }],
      context: createContext(),
    });

    expect(projection.level).toBe("titles");
    for (const entry of entries) {
      expect(projection.message?.content).toContain(entry.toolName);
      expect(projection.message?.content).not.toContain(entry.operationId);
    }
    expect(projection.estimatedTokens).toBeLessThanOrEqual(512);
  });

  test("uses complete group metadata for 1,000 synthetic entries without taking the first N", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) =>
      createEntry({
        toolName: `tool_${index}_${"x".repeat(100)}`,
        operationId: `operation_${index}_${"y".repeat(100)}`,
      }),
    );
    const projection = projectCapabilityBrief({
      entries,
      groups: [{ ...GROUPS[0]!, memberCount: entries.length }],
      context: createContext(),
    });

    expect(projection.level).toBe("groups");
    expect(projection.message?.content).toContain("memberCount=1000");
    expect(projection.message?.content).not.toContain(entries[0]!.toolName);
    expect(projection.message?.content).not.toContain(entries.at(-1)!.toolName);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(512);
  });

  test("omits the optional brief when even the complete group level exceeds the cap", () => {
    const groups = Array.from({ length: 1_000 }, (_, index) => ({
      ...GROUPS[0]!,
      groupId: `group_${index}`,
    }));
    expect(
      projectCapabilityBrief({ groups, context: createContext() }),
    ).toEqual({
      level: "none",
      estimatedTokens: 0,
      budgetTokens: 512,
      reason: "insufficient_budget",
    });
  });

  test.each([undefined, []])(
    "uses group metadata when tool metadata is unavailable: %s",
    (entries) => {
      const projection = projectCapabilityBrief({
        entries,
        groups: GROUPS,
        context: createContext(),
      });
      expect(projection.level).toBe("groups");
      expect(projection.message?.content).toContain("memberCount=1");
    },
  );

  test("does not claim complete tool coverage when entries omit a declared group member", () => {
    const projection = projectCapabilityBrief({
      entries: [createEntry()],
      groups: [{ ...GROUPS[0]!, memberCount: 2 }],
      context: createContext(),
    });
    expect(projection.level).toBe("groups");
    expect(projection.message?.content).toContain("memberCount=2");
    expect(projection.message?.content).not.toContain("reader");
  });

  test("omits an empty catalog and provides no model message", () => {
    const projection = projectCapabilityBrief({
      groups: [],
      context: createContext(),
    });
    expect(projection).toEqual({
      level: "none",
      estimatedTokens: 0,
      budgetTokens: 512,
      reason: "empty_catalog",
    });
  });

  test("stays strictly below the 70 percent admission threshold", () => {
    const cost = projectCapabilityBrief({
      groups: GROUPS,
      context: createContext(),
    }).estimatedTokens;
    const exactThresholdPrompt = "x".repeat((700 - cost - 12) * 2);
    const exactThreshold = createContext({
      instructions: "",
      prompt: exactThresholdPrompt,
      budget: { contextWindowTokens: 1_000 },
    });
    const rejected = projectCapabilityBrief({
      groups: GROUPS,
      context: exactThreshold,
    });
    expect(rejected.budgetTokens).toBe(cost - 1);
    expect(rejected.level).toBe("none");

    const accepted = projectCapabilityBrief({
      groups: GROUPS,
      context: { ...exactThreshold, prompt: exactThresholdPrompt.slice(2) },
    });
    expect(accepted.budgetTokens).toBe(cost);
    expect(accepted.level).toBe("groups");
  });

  test("reserves configured instructions against the compaction threshold", () => {
    const baseline = createContext({ budget: { contextWindowTokens: 600 } });
    const reserved = createContext({
      budget: {
        contextWindowTokens: 600,
        configuredInstructionReserveTokens: 80,
      },
    });
    expect(briefBudget(baseline) - briefBudget(reserved)).toBe(80);
  });

  test("respects output, safety, and configured-instruction reserves at the input ceiling", () => {
    const context = createContext({
      instructions: "",
      prompt: "",
      budget: {
        contextWindowTokens: 1_000,
        outputReserveTokens: 700,
        safetyReserveTokens: 100,
        configuredInstructionReserveTokens: 30,
      },
    });
    expect(briefBudget(context)).toBe(158);
  });

  test.each([
    ["all raw history", { historyMessages: [HISTORY_MESSAGE] }],
    ["prior conversation", { priorConversationMessages: [PASSIVE_MESSAGE] }],
    ["reference messages", { referenceMessages: [PASSIVE_MESSAGE] }],
    ["continuation messages", { continuationMessages: [PASSIVE_MESSAGE] }],
    [
      "full reference parts",
      {
        referenceParts: [
          {
            sourceRef: "reference",
            category: "request_reference",
            retention: "compactable",
            messages: [PASSIVE_MESSAGE],
            compactMessages: [],
          },
        ],
      },
    ],
    [
      "full continuation parts",
      {
        continuationParts: [
          {
            sourceRef: "continuation",
            category: "role_continuation",
            retention: "compactable",
            messages: [PASSIVE_MESSAGE],
            compactMessages: [],
          },
        ],
      },
    ],
  ] satisfies readonly [string, Partial<ContextInput>][])(
    "accounts for %s before context projection",
    (_, additions) => {
      const baseline = createContext({ budget: { contextWindowTokens: 600 } });
      expect(
        briefBudget(baseline) - briefBudget({ ...baseline, ...additions }),
      ).toBe(estimateMessageTokens(PASSIVE_MESSAGE));
    },
  );

  test("accounts for attachment reservations and format schema overhead", () => {
    const baseline = createContext({
      budget: { contextWindowTokens: 600, attachmentReserveTokens: 80 },
    });
    const withAttachment: ContextInput = {
      ...baseline,
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          mimeType: "text/plain",
          storageRef: "private-source",
        },
      ],
    };
    expect(briefBudget(baseline) - briefBudget(withAttachment)).toBe(80);
    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
    };
    const withFormat: ContextInput = {
      ...baseline,
      budget: {
        ...baseline.budget,
        formatTokenAccounting: { mode: "estimate", fixedOverheadTokens: 17 },
      },
      format: { type: "json_schema", name: "arbitrary_consumer", schema },
    };
    expect(briefBudget(baseline) - briefBudget(withFormat)).toBe(
      estimateTextTokens(JSON.stringify(schema)) + 17,
    );
  });

  test("budgets additional calibration and steering messages without projecting them", () => {
    const context = createContext({ budget: { contextWindowTokens: 600 } });
    const additionalBudgetMessages: ChatMessage[] = [
      { role: "system", content: "calibration".repeat(4) },
      { role: "user", content: "user steering".repeat(4) },
    ];
    const projection = projectCapabilityBrief({
      groups: GROUPS,
      context,
      additionalBudgetMessages,
    });
    expect(briefBudget(context) - projection.budgetTokens).toBe(
      estimateMessagesTokens(additionalBudgetMessages),
    );
    expect(projection.message?.content).not.toContain("calibration");
    expect(projection.message?.content).not.toContain("user steering");
  });

  test("adds nothing when the baseline already exceeds the compaction threshold", () => {
    const context = createContext({
      historyMessages: [{ ...HISTORY_MESSAGE, content: "x".repeat(2_000) }],
      historyRetention: "compaction_managed",
      budget: { contextWindowTokens: 1_000 },
    });
    expect(
      projectCapabilityBrief({
        entries: [createEntry()],
        groups: GROUPS,
        context,
      }),
    ).toEqual({
      level: "none",
      estimatedTokens: 0,
      budgetTokens: 0,
      reason: "insufficient_budget",
    });
  });

  test("uses the configured non-ASCII estimator and message overhead", () => {
    const tokenEstimation = {
      asciiCharactersPerToken: 3,
      nonAsciiBytesPerToken: 1,
      messageOverheadTokens: 19,
    };
    const projection = projectCapabilityBrief({
      entries: [createEntry({ toolName: "קריאה", operationId: "קובץ" })],
      groups: GROUPS,
      context: createContext({ budget: { tokenEstimation } }),
    });
    expect(projection.level).toBe("detailed");
    expect(projection.estimatedTokens).toBe(
      estimateMessageTokens(projection.message!, tokenEstimation),
    );
    expect(projection.estimatedTokens).toBeLessThanOrEqual(512);
    expect(estimateTextTokens("קריאה", tokenEstimation)).toBe(
      Buffer.byteLength("קריאה", "utf8"),
    );
  });

  test.each(["future.catalog_reader", "custom.follow_up"])(
    "can attach to %s without altering existing messages or history selection",
    (modelStep) => {
      const context = createContext({
        historyMessages: [HISTORY_MESSAGE],
        referenceMessages: [
          { role: "system", content: "Existing passive reference." },
        ],
        diagnostic: { requestId: "brief-neutral-consumer", modelStep },
      });
      const before = structuredClone(context);
      const baseline = projectRequestContext(context);
      const projection = projectCapabilityBrief({
        entries: [createEntry()],
        groups: GROUPS,
        context,
      });
      const attached = projectRequestContext({
        ...context,
        referenceMessages: [...context.referenceMessages!, projection.message!],
      });
      expect(context).toEqual(before);
      expect(attached.selectedHistoryMessageIds).toEqual(
        baseline.selectedHistoryMessageIds,
      );
      expect(attached.omittedHistoryMessageIds).toEqual(
        baseline.omittedHistoryMessageIds,
      );
      expect(
        attached.messages.filter(
          (message) => !isCapabilityBriefMessage(message),
        ),
      ).toEqual(baseline.messages);
      expect(
        attached.messages.filter(
          (message) =>
            message.role === "user" && message.content === context.prompt,
        ),
      ).toHaveLength(1);
      expect(
        isCapabilityBriefMessage({
          role: "user",
          content: projection.message!.content,
        }),
      ).toBe(false);
    },
  );
});

function createEntry(
  overrides: Partial<ToolAvailabilityEntry> = {},
): ToolAvailabilityEntry {
  return {
    toolName: "reader",
    operationId: "read_item",
    summary: "Read one configured item.",
    catalogGroups: ["read"],
    effect: "read_only",
    ...overrides,
  };
}

function createContext(
  overrides: Partial<Omit<ContextInput, "budget">> & {
    budget?: Partial<RequestContextBudget>;
  } = {},
): ContextInput {
  return {
    instructions: "Stable policy.",
    prompt: "Current user request.",
    historyMessages: [],
    ...overrides,
    budget: {
      contextWindowTokens: 8_000,
      outputReserveTokens: 100,
      safetyReserveTokens: 20,
      attachmentReserveTokens: 80,
      ...overrides.budget,
    },
  };
}

function briefBudget(context: ContextInput): number {
  return projectCapabilityBrief({ groups: GROUPS, context }).budgetTokens;
}
