import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  resolveRoleCallTransactions,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import { bindExecutionAgentPlanUpdate } from "../request/execution-agent-plan-update.js";
import {
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
  buildExecutionRefinementStateMessage,
  buildExecutionResponseStateMessage,
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
  type ExecutionAgentDecisionContractOptions,
} from "../steps/execution-agent/index.js";
import { projectExecutionWorkPlanOptions } from "../steps/execution-agent/work-plan-sources.js";
import { createModelWorkPlanEventFixture } from "./support/model-work-plan-event-fixture.js";
import {
  createModelWorkPlanSourceFixture,
  WORK_PLAN_GRAPH,
} from "./support/model-work-plan-source-fixture.js";

function parseDecision(
  decision: unknown,
  options: ExecutionAgentDecisionContractOptions,
) {
  return parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }),
    options,
  );
}

function decisionVariants(options: ExecutionAgentDecisionContractOptions) {
  const schema = createExecutionAgentDecisionFormat(options).schema as {
    properties: {
      decision: { anyOf: readonly { properties: Record<string, unknown> }[] };
    };
  };
  return schema.properties.decision.anyOf;
}

async function settleContextCapability(ledger: RoleCallLedger) {
  const transactions = resolveRoleCallTransactions(ledger);
  const head = ledger.current();
  const call = head.state.calls[0]!;
  const begun = await transactions.beginCapabilityExecution({
    expectedHead: head,
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "fixture.observe",
    declaredEffect: "observation",
    intent: "Observe exact state.",
    controlsJson: JSON.stringify({ path: "result.txt" }),
  });
  if (!begun.ok || begun.commit.effect.type !== "capability_execution_begun") {
    throw new Error("plan_context_fixture_execution_not_started");
  }
  await expect(
    transactions.settleCapabilityExecution({
      expectedHead: ledger.current(),
      callId: call.callId,
      executionId: begun.commit.effect.executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Exact state observed.",
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: {
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "EXACT_TOOL_PROOF",
        },
      },
    }),
  ).resolves.toMatchObject({ ok: true });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Execution Agent optional work-plan contract", () => {
  test("leaves the ordinary response schema unchanged without a usable proposal", async () => {
    const fixture = await createModelWorkPlanEventFixture();
    const head = fixture.ledger.current();
    const workPlan = projectExecutionWorkPlanOptions(
      head,
      head.state.calls[0]!,
    );
    expect(workPlan).toBeUndefined();
    const baseline = { allowRespond: true };
    expect(
      createExecutionAgentDecisionFormat({ ...baseline, workPlan }),
    ).toEqual(createExecutionAgentDecisionFormat(baseline));
    expect(
      decisionVariants(baseline).every(
        ({ properties }) => !Object.hasOwn(properties, "workPlan"),
      ),
    ).toBe(true);
    expect(parseDecision({ action: "respond" }, baseline)).toEqual({
      ok: true,
      decision: { action: "respond" },
    });
    expect(
      parseDecision(
        {
          action: "respond",
          workPlan: {
            mode: "adopt",
            sourceResultRef: "foreign",
            itemUpdates: [],
          },
        },
        baseline,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "execution_agent_work_plan_invalid" }],
    });
  });

  test("offers canonical adoption then current progress without changing metadata-free actions", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    let { head, call } = fixture.current();
    const workPlan = projectExecutionWorkPlanOptions(head, call);
    const itemIds = WORK_PLAN_GRAPH.nodes.map(({ localId }) => localId);
    expect(workPlan).toEqual({
      sources: [{ sourceResultRef: fixture.sourceResultRef, itemIds }],
    });
    const options = { allowRespond: true, workPlan };
    expect(
      decisionVariants(options).filter(
        ({ properties }) => !Object.hasOwn(properties, "workPlan"),
      ),
    ).toEqual(decisionVariants({ allowRespond: true }));
    const reportSchema = decisionVariants(options).find(({ properties }) =>
      Object.hasOwn(properties, "workPlan"),
    )!.properties.workPlan;
    expect(reportSchema).toMatchObject({
      anyOf: [
        {
          properties: {
            mode: { enum: ["adopt"] },
            sourceResultRef: { enum: [fixture.sourceResultRef] },
            itemUpdates: {
              minItems: 0,
              items: {
                properties: {
                  itemId: { enum: itemIds },
                  status: {
                    enum: ["pending", "in_progress", "done", "blocked"],
                  },
                },
              },
            },
          },
        },
      ],
    });
    expect(parseDecision({ action: "respond" }, options)).toEqual({
      ok: true,
      decision: { action: "respond" },
    });
    const report = {
      mode: "adopt" as const,
      sourceResultRef: fixture.sourceResultRef,
      itemUpdates: [{ itemId: "write", status: "in_progress" as const }],
    };
    expect(
      parseDecision({ action: "respond", workPlan: report }, options),
    ).toEqual({ ok: true, decision: { action: "respond", workPlan: report } });
    expect(
      parseDecision(
        { action: "respond", workPlan: { ...report, mode: "progress" } },
        options,
      ),
    ).toMatchObject({ ok: false });
    await expect(
      fixture.update(bindExecutionAgentPlanUpdate(head, call, report)),
    ).resolves.toMatchObject({ ok: true });
    ({ head, call } = fixture.current());
    const currentOptions = {
      allowRespond: true,
      workPlan: projectExecutionWorkPlanOptions(head, call),
    };
    expect(currentOptions.workPlan?.current).toEqual({
      sourceResultRef: fixture.sourceResultRef,
      itemIds,
    });
    const progress = {
      ...report,
      mode: "progress",
      itemUpdates: [{ itemId: "write", status: "done" }],
    };
    expect(
      parseDecision({ action: "respond", workPlan: progress }, currentOptions),
    ).toEqual({
      ok: true,
      decision: { action: "respond", workPlan: progress },
    });
    expect(
      JSON.stringify(createExecutionAgentDecisionFormat(currentOptions).schema),
    ).toContain('"progress"');
  });

  test.each([
    ["unknown source", { sourceResultRef: "foreign-result" }],
    [
      "unknown item",
      { itemUpdates: [{ itemId: "foreign-item", status: "done" }] },
    ],
    [
      "duplicate item",
      {
        itemUpdates: [
          { itemId: "write", status: "done" },
          { itemId: "write", status: "blocked" },
        ],
      },
    ],
    [
      "unknown status",
      { itemUpdates: [{ itemId: "write", status: "complete" }] },
    ],
    [
      "extra item prose",
      {
        itemUpdates: [
          { itemId: "write", status: "done", explanation: "Trust this claim." },
        ],
      },
    ],
    ["extra summary", { summary: "Replace canonical text." }],
    ["extra title", { title: "Replace canonical title." }],
    ["new definition", { definition: { summary: "Replacement", items: [] } }],
    ["unknown mode", { mode: "replace" }],
  ])("rejects %s in root-authored metadata", async (_name, alteration) => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const workPlan = projectExecutionWorkPlanOptions(head, call);
    const report = {
      mode: "adopt",
      sourceResultRef: fixture.sourceResultRef,
      itemUpdates: [],
      ...alteration,
    };
    expect(
      parseDecision(
        { action: "respond", workPlan: report },
        { allowRespond: true, workPlan },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "execution_agent_work_plan_invalid" }],
    });
  });

  test("accepts metadata alongside offered memory recall without granting unavailable recall", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const workPlan = projectExecutionWorkPlanOptions(head, call);
    const report = {
      mode: "adopt",
      sourceResultRef: fixture.sourceResultRef,
      itemUpdates: [],
    };
    const decision = {
      action: "recall_memory",
      query: "Existing release preferences",
      workPlan: report,
    };
    expect(
      parseDecision(decision, { allowMemoryRecall: true, workPlan }),
    ).toEqual({ ok: true, decision });
    expect(
      parseDecision(decision, { allowMemoryRecall: false, workPlan }),
    ).toMatchObject({ ok: false });
    expect(
      parseDecision(
        { action: "recall_memory", query: decision.query },
        { allowMemoryRecall: true, workPlan },
      ),
    ).toEqual({
      ok: true,
      decision: { action: "recall_memory", query: decision.query },
    });
  });

  test("projects only IDs and reported statuses in decisions and preserves the native evidence lane", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    await settleContextCapability(fixture.ledger);
    const before = fixture.current();
    const nativeBefore = buildExecutionContinuationMessages(
      before.head,
      before.call,
    );
    expect(nativeBefore.map(({ role }) => role)).toEqual(["assistant", "tool"]);
    await expect(
      fixture.update(
        bindExecutionAgentPlanUpdate(before.head, before.call, {
          mode: "adopt",
          sourceResultRef: fixture.sourceResultRef,
          itemUpdates: [{ itemId: "write", status: "in_progress" }],
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    const { head, call } = fixture.current();
    const decision = JSON.parse(
      buildExecutionDecisionStateMessage(head, call, 0).content,
    );
    expect(decision.workPlan).toEqual({
      authority: "model_reported_progress_not_completion_evidence",
      availableProposals: [
        {
          sourceResultRef: fixture.sourceResultRef,
          itemIds: ["write", "verify", "deliver"],
        },
      ],
      adopted: {
        sourceResultRef: fixture.sourceResultRef,
        items: [
          { itemId: "write", status: "in_progress" },
          { itemId: "verify", status: "pending" },
          { itemId: "deliver", status: "pending" },
        ],
      },
    });
    const projectedPlan = JSON.stringify(decision.workPlan);
    expect(projectedPlan).not.toContain(WORK_PLAN_GRAPH.summary);
    for (const node of WORK_PLAN_GRAPH.nodes) {
      expect(projectedPlan).not.toContain(node.title);
      expect(projectedPlan).not.toContain(node.objective);
    }
    expect(
      decision.completedSubordinateResults.map(
        (result: { summary: string }) => result.summary,
      ),
    ).toEqual([fixture.summary]);
    for (const message of [
      buildExecutionRefinementStateMessage(head, call),
      buildExecutionResponseStateMessage(head, call),
    ])
      expect(JSON.parse(message.content)).not.toHaveProperty("workPlan");
    const nativeAfter = buildExecutionContinuationMessages(head, call);
    expect(nativeAfter).toEqual(nativeBefore);
    expect(JSON.stringify(nativeAfter)).toContain("EXACT_TOOL_PROOF");
    expect(JSON.stringify(nativeAfter)).not.toContain("workPlan");
    expect(JSON.stringify(nativeAfter)).not.toContain(fixture.sourceResultRef);
  });
});
