import { describe, expect, test } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolAvailabilityOverviewGroup } from "../../plugin-sdk/tool-availability-overview.js";
import {
  isCapabilityBriefMessage,
  projectCapabilityBrief,
} from "../context/capability-brief.js";
import type { RequestContextBudget } from "../context/request-context-contracts.js";
import { projectRequestContext } from "../context/request-context.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../context/token-estimator.js";

type ContextInput = Parameters<typeof projectRequestContext>[0];
type Description = Pick<
  ToolAvailabilityEntry,
  "toolName" | "operationId" | "summary" | "catalogGroups"
>;

function entries(count = 70): ToolAvailabilityEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    toolName: `tool_${String(index).padStart(3, "0")}`,
    operationId: `operation_${String(index).padStart(3, "0")}`,
    summary: `Exact operation ${index}. Available targets for this request: linux, windows.`,
    catalogGroups: ["system", "custom"],
    effect: "mutating",
  }));
}

function groups(
  catalog: readonly ToolAvailabilityEntry[],
): ToolAvailabilityOverviewGroup[] {
  return ["custom", "system"].map((groupId) => ({
    groupId,
    memberCount: catalog.length,
    effects: ["mutation"],
  }));
}

function context(
  overrides: Partial<Omit<ContextInput, "budget">> & {
    budget?: Partial<RequestContextBudget>;
  } = {},
): ContextInput {
  return {
    instructions: "",
    prompt: "",
    historyMessages: [],
    ...overrides,
    budget: {
      contextWindowTokens: 32_768,
      outputReserveTokens: 100,
      safetyReserveTokens: 20,
      attachmentReserveTokens: 80,
      ...overrides.budget,
    },
  };
}

function project(
  catalog: readonly ToolAvailabilityEntry[],
  input = context(),
  extra: readonly ChatMessage[] = [],
) {
  return projectCapabilityBrief({
    entries: catalog,
    groups: groups(catalog),
    context: input,
    additionalBudgetMessages: extra,
  });
}

function descriptions(message: ChatMessage | undefined): Description[] {
  expect(message?.role).toBe("system");
  return JSON.parse(message!.content.split("\n").at(-1)!);
}

function expectedDescriptions(
  catalog: readonly ToolAvailabilityEntry[],
): Description[] {
  return catalog.map(({ toolName, operationId, summary, catalogGroups }) => ({
    toolName,
    operationId,
    summary,
    catalogGroups: [...new Set(catalogGroups)].sort(),
  }));
}

describe("complete semantic capability descriptions", () => {
  test("retains all 70 operations once with full request-bound facts beyond the old token cap", () => {
    const catalog = entries();
    catalog[69] = {
      ...catalog[69]!,
      summary:
        'Exact final operation: "quoted"\nזמין 😀. Available targets for this request: windows.',
    };
    const projection = project(catalog);
    expect(projection.level).toBe("descriptions");
    expect(projection.reason).toBe("complete_catalog");
    expect(projection.estimatedTokens).toBeGreaterThan(512);
    expect(projection.estimatedTokens).toBeLessThanOrEqual(
      projection.budgetTokens,
    );
    const body = descriptions(projection.message);
    expect(body).toEqual(expectedDescriptions(catalog));
    expect(body).toHaveLength(70);
    expect(new Set(body.map(({ operationId }) => operationId)).size).toBe(70);
    expect(body[69]!.summary).toBe(catalog[69]!.summary);
  });

  test("orders entries stably without changing source arrays or context", () => {
    const catalog = entries(3);
    catalog[0] = {
      ...catalog[0]!,
      toolName: "zz_tool",
      catalogGroups: ["system", "custom", "system"],
    };
    catalog[1] = { ...catalog[1]!, toolName: "aa_tool" };
    const reversed = [...catalog].reverse();
    const input = context({ prompt: "Current request" });
    const before = structuredClone({ reversed, input });
    expect(project(reversed, input).message).toEqual(
      project(catalog, input).message,
    );
    expect({ reversed, input }).toEqual(before);
    expect(descriptions(project(reversed, input).message)).toEqual(
      expectedDescriptions(catalog),
    );
  });

  test("admits whole descriptions one token below 70 percent and falls back at the exact threshold", () => {
    const catalog = entries(2);
    const cost = project(catalog).estimatedTokens;
    const window = 4_000;
    const threshold = window * 0.7;
    const exactPrompt = "x".repeat((threshold - cost - 12) * 2);
    const input = context({
      prompt: exactPrompt,
      budget: { contextWindowTokens: window },
    });
    const accepted = project(catalog, {
      ...input,
      prompt: exactPrompt.slice(2),
    });
    expect(accepted.level).toBe("descriptions");
    expect(accepted.budgetTokens).toBe(cost);
    expect(descriptions(accepted.message)).toEqual(
      expectedDescriptions(catalog),
    );
    const rejected = project(catalog, input);
    expect(rejected.level).toBe("detailed");
    expect(rejected.budgetTokens).toBe(Math.min(512, cost - 1));
    expect(rejected.message!.content).not.toContain(catalog[0]!.summary);
    for (const entry of catalog)
      expect(rejected.message!.content).toContain(entry.operationId);
  });

  test("falls back to a complete old overview when exact summaries cannot fit", () => {
    const catalog = entries(2).map((entry) => ({
      ...entry,
      summary: "unique proof ".repeat(10_000),
    }));
    const projection = project(catalog);
    expect(projection.level).toBe("detailed");
    expect(projection.estimatedTokens).toBeLessThanOrEqual(512);
    expect(projection.message!.content).not.toContain("unique proof");
    for (const entry of catalog)
      expect(projection.message!.content).toContain(entry.operationId);
  });

  test("deducts configured instructions and full history before descriptions admission", () => {
    const catalog = entries(2);
    const history = {
      id: "h1",
      role: "user" as const,
      content: "Earlier fact ".repeat(8),
      createdAt: "2026-09-19T00:00:00Z",
    };
    const baseline = project(catalog);
    const withHistory = project(
      catalog,
      context({
        historyMessages: [history],
        budget: { configuredInstructionReserveTokens: 91 },
      }),
    );
    expect(withHistory.level).toBe("descriptions");
    expect(baseline.budgetTokens - withHistory.budgetTokens).toBe(
      91 + estimateMessageTokens(history),
    );
    expect(descriptions(withHistory.message)).toEqual(
      expectedDescriptions(catalog),
    );
  });

  test("deducts output and safety reserves when they own input headroom", () => {
    const catalog = entries(2);
    const baseline = project(
      catalog,
      context({ budget: { outputReserveTokens: 20_000 } }),
    );
    const reserved = project(
      catalog,
      context({
        budget: { outputReserveTokens: 20_100, safetyReserveTokens: 60 },
      }),
    );
    expect(reserved.level).toBe("descriptions");
    expect(baseline.budgetTokens - reserved.budgetTokens).toBe(140);
  });

  test("accounts for calibration and steering without copying their content into descriptions", () => {
    const catalog = entries(2);
    const extra: ChatMessage[] = [
      { role: "system", content: "Private calibration ".repeat(8) },
      { role: "user", content: "Current steering ".repeat(8) },
    ];
    const baseline = project(catalog);
    const reserved = project(catalog, context(), extra);
    expect(reserved.level).toBe("descriptions");
    expect(baseline.budgetTokens - reserved.budgetTokens).toBe(
      estimateMessagesTokens(extra),
    );
    expect(descriptions(reserved.message)).toEqual(
      expectedDescriptions(catalog),
    );
  });

  test("does not manufacture complete descriptions for incomplete metadata", () => {
    const catalog = entries(2);
    const projection = projectCapabilityBrief({
      entries: catalog.slice(0, 1),
      groups: groups(catalog),
      context: context(),
    });
    expect(projection.level).toBe("groups");
    expect(projection.message!.content).not.toContain(catalog[0]!.summary);
    expect(projection.message!.content).toContain("memberCount=2");
  });

  test("attaches exactly one passive reference and leaves unrelated context consumers unchanged", () => {
    const catalog = entries(2);
    const input = context({
      instructions: "Consumer policy",
      prompt: "Current request",
      referenceMessages: [{ role: "user", content: "Existing reference" }],
      diagnostic: {
        requestId: "descriptions-topology",
        modelStep: "future.consumer",
      },
    });
    const baseline = projectRequestContext(input);
    const projection = project(catalog, input);
    expect(projection.level).toBe("descriptions");
    const attached = projectRequestContext({
      ...input,
      referenceMessages: [...input.referenceMessages!, projection.message!],
    });
    expect(attached.messages.filter(isCapabilityBriefMessage)).toHaveLength(1);
    expect(
      attached.messages.filter((message) => !isCapabilityBriefMessage(message)),
    ).toEqual(baseline.messages);
    expect(projectRequestContext(input)).toEqual(baseline);
    expect(attached.selectedHistoryMessageIds).toEqual(
      baseline.selectedHistoryMessageIds,
    );
    expect(attached.omittedHistoryMessageIds).toEqual(
      baseline.omittedHistoryMessageIds,
    );
  });
});
