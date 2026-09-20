import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import {
  EXECUTION_AGENT_V1_EXECUTION_POLICY,
  SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
} from "../request/role-executor-composition.js";
import {
  createModelWorkPlanEventFixture,
  EVENT_WORK_PLAN,
  liveModelWorkPlanEvents,
  persistedModelWorkPlanEvents,
} from "./support/model-work-plan-event-fixture.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("model-reported work-plan client events", () => {
  test("emits only adopted work and deduplicates unchanged reported progress", async () => {
    const fixture = await createModelWorkPlanEventFixture();
    await fixture.returnSource(
      JSON.stringify({ outcome: "declined", reason: "No plan needed." }),
    );
    const sourceResultRef = await fixture.returnSource();
    expect(fixture.events).toEqual([]);
    expect(fixture.ledger.current().state.plans).toEqual([]);
    expect(fixture.ledger.current().state.calls[0]).not.toHaveProperty(
      "adoptedWorkPlan",
    );

    await expect(
      fixture.update({
        mode: "adopt",
        sourceResultRef,
        definition: EVENT_WORK_PLAN,
        itemUpdates: [{ itemId: "write", status: "in_progress" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.events.map(({ name }) => name)).toEqual([
      "planner.plan.created",
      "planner.plan.item.started",
      "planner.plan.item.planned",
      "planner.plan.item.planned",
    ]);
    expect(fixture.events[0]).toMatchObject({
      payload: {
        stage: "development_plan",
        phase: "created",
        plan: {
          summary: EVENT_WORK_PLAN.summary,
          total: 3,
          completed: 0,
          blocked: 0,
          pending: 2,
          inProgress: 1,
          items: [
            {
              id: `${sourceResultRef}:write`,
              title: "Write release",
              status: "in_progress",
              order: 1,
            },
            {
              id: `${sourceResultRef}:verify`,
              title: "Verify release",
              status: "pending",
              order: 2,
            },
            {
              id: `${sourceResultRef}:deliver`,
              title: "Deliver release",
              status: "pending",
              order: 3,
            },
          ],
        },
      },
    });
    const progress = {
      mode: "progress" as const,
      sourceResultRef,
      itemUpdates: [
        { itemId: "write", status: "done" as const },
        { itemId: "verify", status: "blocked" as const },
      ],
    };
    await expect(fixture.update(progress)).resolves.toMatchObject({ ok: true });
    expect(fixture.events.slice(4).map(({ name }) => name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.completed",
      "planner.plan.item.blocked",
    ]);
    expect(fixture.events[4]).toMatchObject({
      payload: {
        plan: { total: 3, completed: 1, blocked: 1, pending: 1, inProgress: 0 },
      },
    });
    const eventCount = fixture.events.length;
    await expect(fixture.update(progress)).resolves.toMatchObject({ ok: true });
    expect(fixture.events).toHaveLength(eventCount);
    expect(fixture.ledger.current().state.plans).toEqual([]);
    expect(fixture.ledger.current().state.phase).toBe("running");
    expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("projects reopening and replacement identically through live UI and persisted replay", async () => {
    const fixture = await createModelWorkPlanEventFixture();
    const live = createPlanLifecycleHarness();
    let delivered = 0;
    function deliverCommittedEvents() {
      for (const event of liveModelWorkPlanEvents(fixture.events).slice(
        delivered,
      )) {
        live.realtime.handle(event);
      }
      delivered = fixture.events.length;
    }
    const originalSource = await fixture.returnSource();
    await expect(
      fixture.update({
        mode: "adopt",
        sourceResultRef: originalSource,
        definition: EVENT_WORK_PLAN,
        itemUpdates: [
          { itemId: "write", status: "done" },
          { itemId: "verify", status: "blocked" },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    deliverCommittedEvents();
    expect(live.plan()).toMatchObject({
      completed: 1,
      total: 3,
      items: [
        { id: `${originalSource}:write`, status: "done" },
        { id: `${originalSource}:verify`, status: "blocked" },
        { id: `${originalSource}:deliver`, status: "pending" },
      ],
    });
    const beforeReopen = fixture.events.length;
    await expect(
      fixture.update({
        mode: "progress",
        sourceResultRef: originalSource,
        itemUpdates: [{ itemId: "write", status: "in_progress" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.events.slice(beforeReopen).map(({ name }) => name)).toEqual([
      "planner.plan.updated",
      "planner.plan.item.started",
    ]);
    deliverCommittedEvents();
    expect(live.plan()?.completed).toBe(0);
    expect(
      live.plan()?.items.find(({ id }) => id === `${originalSource}:write`),
    ).toMatchObject({ status: "active" });

    const replacementSource = await fixture.returnSource({
      ...EVENT_WORK_PLAN,
      summary: "Prepare the revised release.",
    });
    await expect(
      fixture.update({
        mode: "adopt",
        sourceResultRef: replacementSource,
        definition: {
          ...EVENT_WORK_PLAN,
          summary: "Prepare the revised release.",
        },
        itemUpdates: [],
      }),
    ).resolves.toMatchObject({ ok: true });
    deliverCommittedEvents();
    expect(live.plan()).toMatchObject({
      summary: "Prepare the revised release.",
      completed: 0,
      total: 3,
      items: EVENT_WORK_PLAN.items.map(({ itemId }) => ({
        id: `${replacementSource}:${itemId}`,
        status: "pending",
      })),
    });
    expect(
      live.plan()?.items.some(({ id }) => id.startsWith(`${originalSource}:`)),
    ).toBe(false);
    live.realtime.handle({
      type: "completed",
      requestId: "request-1",
      output: "Reported work remains pending.",
    });
    const restored = createPlanLifecycleHarness({
      messages: live.state.messages,
      requests: [
        {
          requestId: "request-1",
          status: "completed",
          events: persistedModelWorkPlanEvents(fixture.events).reverse(),
        },
      ],
    });
    await restored.conversationSession.openSession("session-1");
    expect(restored.plan()).toEqual(live.plan());
    expect(restored.plan()?.completed).toBe(0);
    expect(restored.state.lastSeqByRequest.get("request-1")).toBe(
      fixture.events.length,
    );
    expect(restored.client.fetchRequestEvents).not.toHaveBeenCalled();
    expect(
      buildConversationActivityModel({
        requestId: "request-1",
        taskProgress: restored.state.taskProgressByRequest.get("request-1"),
      }).progress,
    ).toMatchObject({
      summary: "Prepare the revised release.",
      total: 3,
      completed: 0,
    });
  });

  test("keeps the Supervisor authority snapshot unchanged and rejects forged root adoption", async () => {
    expect(SUPERVISOR_WORKER_V1_EXECUTION_POLICY.authority).toEqual({
      id: "supervisor-worker-v1",
      version: 2,
      definitionHash:
        "sha256:2ee79cee6dbb27ffaeb59f84c4c838cf9d16a965ca4f07e7d638e8589868e036",
      rootContractId: "supervisor",
      availableSubordinateContractIds: ["planner", "worker", "reviewer"],
      capabilityAuthorities: ["worker"],
    });
    const fixture = await createModelWorkPlanEventFixture(
      SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    );
    const sourceResultRef = await fixture.returnSource();
    const head = fixture.ledger.current();
    await expect(
      fixture.update({
        mode: "adopt",
        sourceResultRef,
        definition: EVENT_WORK_PLAN,
        itemUpdates: [],
      }),
    ).resolves.toMatchObject({
      ok: false,
      issueCode: "model_work_plan_update_invalid",
    });
    expect(fixture.ledger.current()).toBe(head);
    expect(fixture.events).toEqual([]);
    expect(head.state.calls[0]).not.toHaveProperty("adoptedWorkPlan");
  });

  test("keeps snapshots without model-work-plan authority valid and disabled", async () => {
    const { modelWorkPlanAuthority: _omitted, ...legacyAuthority } =
      EXECUTION_AGENT_V1_EXECUTION_POLICY.authority;
    const fixture = await createModelWorkPlanEventFixture(legacyAuthority);
    const sourceResultRef = await fixture.returnSource();
    const head = fixture.ledger.current();
    await expect(
      fixture.update({
        mode: "adopt",
        sourceResultRef,
        definition: EVENT_WORK_PLAN,
        itemUpdates: [],
      }),
    ).resolves.toMatchObject({
      ok: false,
      issueCode: "model_work_plan_update_invalid",
    });
    expect(fixture.ledger.current()).toBe(head);
    expect(fixture.events).toEqual([]);
  });
});
