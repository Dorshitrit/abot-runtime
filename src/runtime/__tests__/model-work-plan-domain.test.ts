import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { validateRoleCallCandidate } from "../orchestration/role-calls/reducer.js";
import { projectAuditorInputState } from "../steps/auditor-decision/audit-input-state.js";
import { bindExecutionAgentPlanUpdate } from "../request/execution-agent-plan-update.js";
import {
  projectExecutionWorkPlanOptions,
  resolveExecutionWorkPlanDefinition,
} from "../steps/execution-agent/work-plan-sources.js";
import { createModelWorkPlanSourceFixture } from "./support/model-work-plan-source-fixture.js";
import { EVENT_WORK_PLAN } from "./support/model-work-plan-event-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("canonical model work-plan declarations", () => {
  test("binds exact proposal text and preserves activation, supervision and audit evidence", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const update = bindExecutionAgentPlanUpdate(head, call, {
      mode: "adopt",
      sourceResultRef: fixture.sourceResultRef,
      itemUpdates: [{ itemId: "write", status: "in_progress" }],
    });
    expect(update).toMatchObject({ definition: EVENT_WORK_PLAN });
    const auditBefore = projectAuditorInputState(head, call.callId, 0);
    await expect(fixture.update(update)).resolves.toMatchObject({ ok: true });
    const after = fixture.current();
    expect(after.call.activationCount).toBe(call.activationCount);
    expect(after.head.state.capabilitySelectionSupervision).toBe(
      head.state.capabilitySelectionSupervision,
    );
    expect(after.head.state.operationSupervision).toBe(
      head.state.operationSupervision,
    );
    expect(after.head.state.capabilityExecutions).toEqual([]);
    expect(after.head.state.rootResponse).toBeNull();
    expect(projectAuditorInputState(after.head, call.callId, 0)).toEqual(
      auditBefore,
    );
    expect(after.call.adoptedWorkPlan?.itemStates).toEqual([
      { itemId: "write", status: "in_progress" },
      { itemId: "verify", status: "pending" },
      { itemId: "deliver", status: "pending" },
    ]);
  });

  test.each([
    ["unknown item", [{ itemId: "missing", status: "done" }]],
    [
      "duplicate item",
      [
        { itemId: "write", status: "done" },
        { itemId: "write", status: "blocked" },
      ],
    ],
    ["invalid status", [{ itemId: "write", status: "completed" }]],
    ["overlong id", [{ itemId: "x".repeat(129), status: "done" }]],
    [
      "mixed valid and invalid",
      [
        { itemId: "write", status: "done" },
        { itemId: "foreign", status: "done" },
      ],
    ],
  ])("rejects %s atomically", async (_label, itemUpdates) => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const result = await fixture.ledger.apply({
      expectedHead: head,
      command: {
        authority: "active_role",
        type: "update_model_work_plan",
        callId: call.callId,
        invocationAttempt: call.activationCount,
        update: {
          mode: "adopt",
          sourceResultRef: fixture.sourceResultRef,
          definition: EVENT_WORK_PLAN,
          itemUpdates,
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fixture.ledger.current()).toBe(head);
    expect(fixture.events).toEqual([]);
  });

  test("rejects missing source, progress before adoption, stale attempt and stale head", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const update = {
      mode: "adopt" as const,
      sourceResultRef: fixture.sourceResultRef,
      definition: EVENT_WORK_PLAN,
      itemUpdates: [],
    };
    await expect(
      fixture.update({ ...update, sourceResultRef: "foreign-request-result" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      fixture.update({
        mode: "progress",
        sourceResultRef: fixture.sourceResultRef,
        itemUpdates: [{ itemId: "write", status: "done" }],
      }),
    ).resolves.toMatchObject({ ok: false });
    const transactions = fixture.ledger.transactions!;
    await expect(
      transactions.updateModelWorkPlan({
        expectedHead: head,
        callId: call.callId,
        invocationAttempt: call.activationCount + 1,
        update,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(fixture.update(update)).resolves.toMatchObject({ ok: true });
    await expect(
      transactions.updateModelWorkPlan({
        expectedHead: head,
        callId: call.callId,
        invocationAttempt: call.activationCount,
        update,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      transactions.updateModelWorkPlan({
        expectedHead: fixture.ledger.current(),
        callId: "call-2",
        invocationAttempt: 1,
        update,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  test("forbids redefining an adopted source and progress against a replaced source", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    const update = {
      mode: "adopt" as const,
      sourceResultRef: fixture.sourceResultRef,
      definition: EVENT_WORK_PLAN,
      itemUpdates: [],
    };
    await fixture.update(update);
    await expect(
      fixture.update({
        ...update,
        definition: { ...EVENT_WORK_PLAN, summary: "Forged replacement" },
      }),
    ).resolves.toMatchObject({ ok: false });
    const other = await fixture.returnSource();
    await fixture.update({ ...update, sourceResultRef: other });
    await expect(
      fixture.update({
        mode: "progress",
        sourceResultRef: fixture.sourceResultRef,
        itemUpdates: [{ itemId: "write", status: "done" }],
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  test("rejects restored unauthorized, foreign-owned or inconsistent optional records", async () => {
    const fixture = await createModelWorkPlanSourceFixture();
    await fixture.update({
      mode: "adopt",
      sourceResultRef: fixture.sourceResultRef,
      definition: EVENT_WORK_PLAN,
      itemUpdates: [],
    });
    const { head, call } = fixture.current();
    const { modelWorkPlanAuthority: _permission, ...oldAuthority } =
      head.policy.authority;
    expect(
      validateRoleCallCandidate({
        state: head.state,
        policy: { ...head.policy, authority: oldAuthority },
      }),
    ).not.toEqual([]);
    const foreignState = {
      ...head.state,
      calls: head.state.calls.map((entry) =>
        entry.callId === "call-2"
          ? { ...entry, adoptedWorkPlan: call.adoptedWorkPlan }
          : entry,
      ),
    };
    expect(
      validateRoleCallCandidate({ state: foreignState, policy: head.policy }),
    ).not.toEqual([]);
    const inconsistent = {
      ...head.state,
      calls: head.state.calls.map((entry) =>
        entry.callId === call.callId
          ? {
              ...entry,
              adoptedWorkPlan: { ...call.adoptedWorkPlan!, itemStates: [] },
            }
          : entry,
      ),
    };
    expect(
      validateRoleCallCandidate({ state: inconsistent, policy: head.policy }),
    ).not.toEqual([]);
    const foreignProducer = {
      ...head.state,
      calls: head.state.calls.map((entry) =>
        entry.callId === "call-2"
          ? { ...entry, parentCallId: "another-root" }
          : entry,
      ),
    };
    expect(
      validateRoleCallCandidate({
        state: foreignProducer,
        policy: head.policy,
      }),
    ).not.toEqual([]);
  });
});

describe("EA-only Planner proposal provenance", () => {
  test.each([
    "decline",
    "failed",
    "auditor",
    "foreign-producer",
    "wrong-kind",
    "invalid-graph",
    "foreign-parent",
  ])("does not offer or bind %s as an adoptable proposal", async (kind) => {
    const fixture = await createModelWorkPlanSourceFixture();
    const { head, call } = fixture.current();
    const result = head.state.results[0]!;
    const advisory = JSON.parse(result.summary);
    if (kind === "decline") {
      delete advisory.proposal;
      advisory.outcome = "decline";
      advisory.reason = "No plan required";
    }
    if (kind === "foreign-producer") advisory.plannerCallId = "other-call";
    if (kind === "wrong-kind") advisory.kind = "arbitrary_json";
    if (kind === "invalid-graph")
      advisory.proposal.nodes[0].localId = advisory.proposal.nodes[1].localId;
    const altered = {
      ...result,
      summary: JSON.stringify(advisory),
      ...(kind === "failed" ? { outcome: "failed" as const } : {}),
      ...(kind === "auditor" ? { roleId: "reviewer" as const } : {}),
    };
    const candidate = {
      ...head,
      state: {
        ...head.state,
        results: [altered],
        calls:
          kind === "foreign-parent"
            ? head.state.calls.map((entry) =>
                entry.callId === "call-2"
                  ? { ...entry, parentCallId: "other-root" }
                  : entry,
              )
            : head.state.calls,
      },
    };
    expect(
      resolveExecutionWorkPlanDefinition(
        candidate,
        call,
        fixture.sourceResultRef,
      ),
    ).toBeUndefined();
    expect(projectExecutionWorkPlanOptions(candidate, call)).toBeUndefined();
    expect(() =>
      bindExecutionAgentPlanUpdate(candidate, call, {
        mode: "adopt",
        sourceResultRef: fixture.sourceResultRef,
        itemUpdates: [],
      }),
    ).toThrow("execution_agent_work_plan_report_invalid");
  });
});
