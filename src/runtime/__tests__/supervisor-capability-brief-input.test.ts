import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { WorkerCapabilityCatalogGroup } from "../orchestration/worker-capabilities/index.js";
import {
  buildSupervisorDecisionInput,
  type SupervisorDecisionInputRequest,
} from "../steps/supervisor-decision/input.js";
import {
  createSupervisorDecisionFormat,
  parseSupervisorDecisionOutput,
} from "../steps/supervisor-decision/index.js";

const catalog: readonly WorkerCapabilityCatalogGroup[] = [
  { groupId: "read", memberCount: 1, effects: ["observation"] },
  { groupId: "web", memberCount: 1, effects: ["observation"] },
];
const entries: readonly ToolAvailabilityEntry[] = [
  {
    toolName: "local_search",
    operationId: "search_local_files",
    catalogGroups: ["read"],
    effect: "read_only",
    summary:
      "Private operational instructions that must not enter a routing brief.",
  },
  {
    toolName: "weather_forecast",
    operationId: "get_forecast",
    catalogGroups: ["web"],
    effect: "read_only",
    summary: "Provide latitude and longitude and select the desired day count.",
  },
];
const toolResults = { sourceRevision: 1, results: [] };

function createRequest(): SupervisorDecisionInputRequest {
  return {
    requestId: "brief-input-request",
    prompt: "Explain why triangles have three sides.",
    historyMessages: [
      {
        id: "prior-user",
        role: "user",
        content: "Use a short explanation.",
        createdAt: "2026-09-04T00:00:00.000Z",
        requestId: "prior-request",
      },
      {
        id: "prior-assistant",
        role: "assistant",
        content: "I will keep it short.",
        createdAt: "2026-09-04T00:00:01.000Z",
        requestId: "prior-request",
      },
    ],
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: { "supervisor.decision": { timeoutMs: 20_000 } },
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: {
          provider: "local",
          model: "test",
          contextWindowTokens: 32_000,
        },
      },
      defaults: { profileId: "test", steps: {} },
    },
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Supervisor capability brief input boundaries", () => {
  test("adds only one passive reference without changing unrelated intent, history, or route schema", () => {
    const request = createRequest();
    const options = {
      toolResults,
      availableWorkerCapabilityCatalog: catalog,
      capabilityBriefEntries: entries,
    };
    const detailed = buildSupervisorDecisionInput(request, options);
    const omitted = buildSupervisorDecisionInput(request, {
      ...options,
      capabilityBriefBudgetMessages: [
        { role: "system", content: "x".repeat(100_000) },
      ],
    });
    const brief = detailed.context.messages.filter(isCapabilityBriefMessage);
    expect(brief).toHaveLength(1);
    expect(omitted.context.messages.filter(isCapabilityBriefMessage)).toEqual(
      [],
    );
    expect(
      detailed.context.messages.filter(
        (message) => !isCapabilityBriefMessage(message),
      ),
    ).toEqual(omitted.context.messages);
    expect(
      detailed.context.messages.filter(
        ({ role, content }) => role === "user" && content === request.prompt,
      ),
    ).toHaveLength(1);
    expect(detailed.format).toEqual(omitted.format);
    expect(detailed.format).toEqual(
      createSupervisorDecisionFormat({
        includeResponseRecommendation: true,
        availableWorkerCapabilityCatalog: catalog,
      }),
    );
    for (const entry of entries) {
      expect(brief[0]!.content).toContain(entry.toolName);
      expect(brief[0]!.content).toContain(entry.operationId);
      expect(brief[0]!.content).not.toContain(entry.summary);
    }
    expect(detailed.context.messages[0]!.content).not.toContain(
      JSON.stringify(catalog),
    );
    expect(omitted.context.messages[0]!.content).not.toContain(
      JSON.stringify(catalog),
    );
    expect(detailed.context.selectedHistoryMessageIds).toEqual(
      omitted.context.selectedHistoryMessageIds,
    );
  });

  test("retains the same legal group selections when metadata is detailed, group-only, or omitted", () => {
    const request = createRequest();
    const projections = [
      buildSupervisorDecisionInput(request, {
        toolResults,
        availableWorkerCapabilityCatalog: catalog,
        capabilityBriefEntries: entries,
      }),
      buildSupervisorDecisionInput(request, {
        toolResults,
        availableWorkerCapabilityCatalog: catalog,
      }),
      buildSupervisorDecisionInput(request, {
        toolResults,
        availableWorkerCapabilityCatalog: catalog,
        capabilityBriefEntries: entries,
        capabilityBriefBudgetMessages: [
          { role: "system", content: "x".repeat(100_000) },
        ],
      }),
    ];
    const groupMessages = projections[1]!.context.messages.filter(
      isCapabilityBriefMessage,
    );
    expect(groupMessages).toHaveLength(1);
    for (const entry of entries)
      expect(groupMessages[0]!.content).not.toContain(entry.toolName);
    for (const group of catalog)
      expect(groupMessages[0]!.content).toContain(group.groupId);
    for (const projection of projections) {
      expect(projection.availableWorkerCapabilityCatalog).toEqual(catalog);
      expect(projection.format).toEqual(projections[0]!.format);
      expect(
        parseSupervisorDecisionOutput(
          JSON.stringify({
            decision: {
              action: "invoke_role",
              roleId: "worker",
              objective: "Inspect the requested source.",
              workerCapabilityScope: { catalogGroupIds: ["read"] },
            },
          }),
          {
            availableWorkerCapabilityCatalog:
              projection.availableWorkerCapabilityCatalog,
          },
        ),
      ).toMatchObject({ ok: true });
      expect(
        parseSupervisorDecisionOutput(
          JSON.stringify({
            decision: {
              action: "invoke_role",
              roleId: "worker",
              objective: "Inspect the requested source.",
              workerCapabilityScope: { catalogGroupIds: ["disabled"] },
            },
          }),
          {
            availableWorkerCapabilityCatalog:
              projection.availableWorkerCapabilityCatalog,
          },
        ),
      ).toMatchObject({ ok: false });
    }
  });

  test("does not manufacture a capability catalog or change a role-limited input from availability entries alone", () => {
    const request = createRequest();
    const baseline = buildSupervisorDecisionInput(request, {
      toolResults,
      allowedRoleIds: ["reviewer"],
    });
    const offered = buildSupervisorDecisionInput(request, {
      toolResults,
      allowedRoleIds: ["reviewer"],
      availableWorkerCapabilityCatalog: catalog,
      capabilityBriefEntries: entries,
    });
    expect(offered.context.messages).toEqual(baseline.context.messages);
    expect(offered.format).toEqual(baseline.format);
    expect(offered.context.messages.filter(isCapabilityBriefMessage)).toEqual(
      [],
    );
  });
});
