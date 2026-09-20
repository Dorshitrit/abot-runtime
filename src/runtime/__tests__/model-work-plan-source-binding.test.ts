import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelWorkPlanDefinition } from "../orchestration/role-calls/work-plan-contracts.js";
import { validateRoleCallCandidate } from "../orchestration/role-calls/reducer.js";
import { createModelWorkPlanSourceFixture } from "./support/model-work-plan-source-fixture.js";
import { EVENT_WORK_PLAN } from "./support/model-work-plan-event-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const alteredFields = [
  "summary",
  "itemId",
  "title",
  "objective",
  "order",
  "missing-item",
  "extra-item",
] as const;
function forgeDefinition(
  definition: ModelWorkPlanDefinition,
  field: (typeof alteredFields)[number],
): ModelWorkPlanDefinition {
  if (field === "summary")
    return { ...definition, summary: "Invented summary" };
  if (field === "order")
    return { ...definition, items: [...definition.items].reverse() };
  if (field === "missing-item")
    return { ...definition, items: definition.items.slice(1) };
  if (field === "extra-item")
    return {
      ...definition,
      items: [
        ...definition.items,
        { itemId: "extra", title: "Extra", objective: "Extra work" },
      ],
    };
  return {
    ...definition,
    items: definition.items.map((item, index) =>
      index === 0 ? { ...item, [field]: "invented" } : item,
    ),
  };
}
async function prepareAdoption(phase: "first" | "replacement") {
  const fixture = await createModelWorkPlanSourceFixture();
  if (phase === "first")
    return {
      fixture,
      sourceResultRef: fixture.sourceResultRef,
      definition: EVENT_WORK_PLAN,
    };
  await fixture.update({
    mode: "adopt",
    sourceResultRef: fixture.sourceResultRef,
    definition: EVENT_WORK_PLAN,
    itemUpdates: [{ itemId: "write", status: "done" }],
  });
  const definition = {
    ...EVENT_WORK_PLAN,
    summary: "Prepare the revised release.",
  };
  const sourceResultRef = await fixture.returnSource(definition);
  return { fixture, sourceResultRef, definition };
}

describe.each(["first", "replacement"] as const)(
  "%s canonical proposal adoption",
  (phase) => {
    test.each(alteredFields)(
      "rejects a forged %s before any commit or event",
      async (field) => {
        const { fixture, sourceResultRef, definition } =
          await prepareAdoption(phase);
        const head = fixture.ledger.current();
        const events = [...fixture.events];
        await expect(
          fixture.update({
            mode: "adopt",
            sourceResultRef,
            definition: forgeDefinition(definition, field),
            itemUpdates: [],
          }),
        ).resolves.toMatchObject({
          ok: false,
          issueCode: "model_work_plan_update_invalid",
        });
        expect(fixture.ledger.current()).toBe(head);
        expect(fixture.events).toEqual(events);
      },
    );

    test("accepts reordered JSON object keys and preserves progress semantics", async () => {
      const { fixture, sourceResultRef, definition } =
        await prepareAdoption(phase);
      const reordered = {
        items: definition.items.map(({ itemId, title, objective }) => ({
          objective,
          title,
          itemId,
        })),
        summary: definition.summary,
      };
      const before = fixture.ledger.current();
      await expect(
        fixture.update({
          mode: "adopt",
          sourceResultRef,
          definition: reordered,
          itemUpdates: [{ itemId: "verify", status: "in_progress" }],
        }),
      ).resolves.toMatchObject({ ok: true });
      const adopted = fixture.current().call.adoptedWorkPlan;
      expect(adopted).toEqual({
        sourceResultRef,
        definition,
        itemStates: [
          { itemId: "write", status: "pending" },
          { itemId: "verify", status: "in_progress" },
          { itemId: "deliver", status: "pending" },
        ],
      });
      expect(fixture.current().call.activationCount).toBe(
        before.state.calls[0]!.activationCount,
      );
      await expect(
        fixture.update({
          mode: "progress",
          sourceResultRef,
          itemUpdates: [{ itemId: "write", status: "done" }],
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(fixture.current().call.adoptedWorkPlan?.definition).toEqual(
        definition,
      );
      if (phase === "first") return;
      const head = fixture.ledger.current();
      await expect(
        fixture.update({
          mode: "progress",
          sourceResultRef: fixture.sourceResultRef,
          itemUpdates: [{ itemId: "write", status: "done" }],
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(fixture.ledger.current()).toBe(head);
    });
  },
);

describe("canonical work-plan provenance at the ledger boundary", () => {
  test.each([
    "plain-text",
    "decline",
    "wrong-kind",
    "foreign-producer",
    "invalid-graph",
    "extra-envelope-field",
  ])("rejects %s source without events", async (kind) => {
    const fixture = await createModelWorkPlanSourceFixture();
    const advisory = JSON.parse(fixture.summary);
    advisory.plannerCallId = "call-3";
    if (kind === "decline") {
      delete advisory.proposal;
      advisory.outcome = "decline";
      advisory.reason = "No plan needed";
    }
    if (kind === "wrong-kind") advisory.kind = "arbitrary_json";
    if (kind === "foreign-producer") advisory.plannerCallId = "another-call";
    if (kind === "invalid-graph")
      advisory.proposal.nodes[0].localId = advisory.proposal.nodes[1].localId;
    if (kind === "extra-envelope-field") advisory.extra = true;
    const sourceResultRef = await fixture.returnSource(
      kind === "plain-text" ? "Not a proposal" : JSON.stringify(advisory),
    );
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

  test.each(alteredFields)(
    "rejects a restored candidate with forged %s",
    async (field) => {
      const fixture = await createModelWorkPlanSourceFixture();
      await fixture.update({
        mode: "adopt",
        sourceResultRef: fixture.sourceResultRef,
        definition: EVENT_WORK_PLAN,
        itemUpdates: [],
      });
      const { head, call } = fixture.current();
      const definition = forgeDefinition(EVENT_WORK_PLAN, field);
      const state = {
        ...head.state,
        calls: head.state.calls.map((entry) =>
          entry.callId !== call.callId
            ? entry
            : {
                ...entry,
                adoptedWorkPlan: {
                  sourceResultRef: fixture.sourceResultRef,
                  definition,
                  itemStates: definition.items.map(({ itemId }) => ({
                    itemId,
                    status: "pending" as const,
                  })),
                },
              },
        ),
      };
      expect(
        validateRoleCallCandidate({ state, policy: head.policy }),
      ).toContainEqual(
        expect.objectContaining({ code: "invalid_role_call_frame" }),
      );
      expect(fixture.ledger.current()).toBe(head);
    },
  );
});
