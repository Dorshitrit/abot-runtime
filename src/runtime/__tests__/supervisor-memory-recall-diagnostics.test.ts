import { afterEach, describe, expect, test, vi } from "vitest";
import { processDebugLogger } from "../observability/debug-logger.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import {
  createMemoryRecallHarness,
  RECALL_QUERY,
  responseDecision,
} from "./support/memory-recall-runner.js";

afterEach(() => vi.restoreAllMocks());

describe.each([true, false])(
  "Supervisor recall diagnostics with memory enabled=%s",
  (enabled) => {
    test.each([
      { allowedRoleIds: [] },
      { allowedRoleIds: ["worker"] },
    ] as const)(
      "matches the offered actions for $allowedRoleIds",
      async ({ allowedRoleIds }) => {
        const trace = vi
          .spyOn(processDebugLogger, "trace")
          .mockImplementation(() => {});
        const decision = enabled
          ? { action: "recall_memory", query: RECALL_QUERY }
          : responseDecision("supervisor-worker-v1");
        const harness = createMemoryRecallHarness({
          policy: "supervisor-worker-v1",
          enabled,
          decide: () => decision,
        });

        await expect(
          runSupervisorDecision(harness.request, {
            call: {
              rootCallId: "call-1",
              callId: "call-1",
              parentCallId: null,
              depth: 0,
              invocationAttempt: 1,
            },
            toolResults: { sourceRevision: 1, results: [] },
            allowedRoleIds,
          }),
        ).resolves.toMatchObject({ decision, steeringVersion: 0 });

        expect(harness.invoke).toHaveBeenCalledOnce();
        const format = harness.invoke.mock.calls[0]![0].format;
        if (typeof format !== "object" || format?.type !== "json_schema") {
          throw new Error("supervisor_decision_schema_missing");
        }
        const allowedActions = offeredSchemaActions(format.schema);
        expect(allowedActions.includes("recall_memory")).toBe(enabled);
        expect(allowedActions.includes("invoke_role")).toBe(
          allowedRoleIds.length > 0,
        );
        const actionEvents = trace.mock.calls
          .filter(
            ([scope, event]) =>
              scope === "runtime.supervisor" &&
              (event === "context.projected" || event === "model.started"),
          )
          .map(([, event, data]) => ({
            event,
            allowedActions: data?.allowedActions,
          }));
        expect(actionEvents).toEqual([
          { event: "context.projected", allowedActions },
          { event: "model.started", allowedActions },
        ]);
        expect(
          trace.mock.calls.filter(
            ([scope, event]) =>
              scope === "runtime.supervisor" && event.startsWith("decision."),
          ),
        ).toEqual([
          [
            "runtime.supervisor",
            "decision.accepted",
            expect.objectContaining({ selectedAction: decision.action }),
          ],
        ]);
      },
    );
  },
);

function offeredSchemaActions(schema: unknown): string[] {
  type DecisionVariant = { properties: { action: { enum: string[] } } };
  const { decision } = (
    schema as {
      properties: { decision: DecisionVariant & { anyOf?: DecisionVariant[] } };
    }
  ).properties;
  return [
    ...new Set(
      (decision.anyOf ?? [decision]).flatMap(
        ({ properties }) => properties.action.enum,
      ),
    ),
  ];
}

test.each([
  {
    name: "blank recall query",
    decision: {
      action: "recall_memory",
      query: "  ",
      acknowledgement: "PRIVATE_ACK",
    },
    allowMemoryRecall: true,
    issues: [{ code: "memory_recall_query_invalid", path: "decision.query" }],
  },
  {
    name: "missing recall acknowledgement",
    decision: { action: "recall_memory", query: "PRIVATE_QUERY" },
    allowMemoryRecall: true,
    issues: [
      { code: "memory_recall_shape_invalid", path: "decision" },
      {
        code: "memory_recall_acknowledgement_invalid",
        path: "decision.acknowledgement",
      },
    ],
  },
  {
    name: "disabled recall",
    decision: {
      action: "recall_memory",
      query: "PRIVATE_QUERY",
      acknowledgement: "PRIVATE_ACK",
    },
    allowMemoryRecall: false,
    issues: [{ code: "memory_recall_unavailable", path: "decision.action" }],
  },
  {
    name: "invalid ordinary response",
    decision: {
      action: "respond",
      query: "PRIVATE_QUERY",
      acknowledgement: "PRIVATE_ACK",
    },
    allowMemoryRecall: true,
    issues: [{ code: "supervisor_decision_shape_invalid", path: "decision" }],
  },
])(
  "traces bounded rejection issues for $name",
  ({ decision, allowMemoryRecall, issues }) => {
    const trace = vi
      .spyOn(processDebugLogger, "trace")
      .mockImplementation(() => {});
    const diagnostic = {
      requestId: "recall-rejection-request",
      modelStep: "supervisor.decision" as const,
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 1,
    };
    const text = JSON.stringify({ decision });
    const options = { allowMemoryRecall, includeAcknowledgement: true };
    const result = parseSupervisorDecisionOutput(text, {
      ...options,
      diagnostic,
    });
    expect(result).toMatchObject({ ok: false, stage: "domain_parser", issues });
    expect(trace.mock.calls.map(([scope, event]) => [scope, event])).toEqual([
      ["runtime.supervisor", "output.envelope.accepted"],
      ["runtime.supervisor", "decision.rejected"],
    ]);
    expect(trace.mock.calls[1]?.[2]).toMatchObject({
      ...diagnostic,
      validationStage: "domain_parser",
      selectedAction: decision.action,
      issueCount: issues.length,
      issues,
    });
    expect(trace.mock.calls[1]?.[2]?.issues).toEqual(issues);
    const serializedTrace = JSON.stringify(trace.mock.calls);
    expect(serializedTrace).not.toContain("PRIVATE_QUERY");
    expect(serializedTrace).not.toContain("PRIVATE_ACK");
    trace.mockClear();
    expect(parseSupervisorDecisionOutput(text, options)).toEqual(result);
    expect(trace).not.toHaveBeenCalled();
  },
);
