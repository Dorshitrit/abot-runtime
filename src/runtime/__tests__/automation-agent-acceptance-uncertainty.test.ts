import { afterEach, expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools, scriptToolUsingAgent } from "./support/automation-agent-tool-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

test("an acceptance rejection cannot skip an uncertain optional effect into an independent successor", async () => {
  const tools = probeTools("mutating");
  tools.execute.mockRejectedValueOnce(new Error("mutation_response_lost"));
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(fixture);
  scriptToolUsingAgent(fixture, "execution-agent-v1");
  const invoke = fixture.invoke.getMockImplementation()!;
  fixture.invoke.mockImplementation(async (input) => input.modelStep === "execution.response"
    ? { text: JSON.stringify({ ready: false }), meta: {} }
    : invoke(input));
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Rejected result with uncertain effect");
  draft = await addAgent(studio, draft, "Attempt optional mutation");
  const nodeId = draft.definition.body.children[0]!.id;
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_node", nodeId, patch: {
      onFailure: "skip", tools: [{ operation, usage: "available" }],
      result: { kind: "json", schema: { type: "object", additionalProperties: false,
        properties: { ready: { type: "boolean" } }, required: ["ready"] } },
      acceptance: [{ field: "ready", equals: true }],
    },
  });
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 1,
    nodeWithoutId: { kind: "tool", title: "Independent mutation", onFailure: "stop",
      operation, controls: {} },
  });
  const successorId = draft.definition.body.children[1]!.id;
  await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "test-grant" });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5_000, interval: 10 }).toBe("failed");

  expect(await studio.getRun(run.id)).toMatchObject({ report: {
    nodeResults: [
      { nodeId, status: "failed", errorCode: "automation_effect_uncertain" },
      { nodeId: successorId, status: "cancelled" },
    ],
    uncertainEffects: [{ nodeId, attemptId: expect.any(String) }],
    effectSummary: { total: 1, unresolvedAttempts: 1 },
  } });
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toContain("execution.response");
  expect(tools.execute).toHaveBeenCalledOnce();
  expect(await studio.getStepEvidence(run.id, nodeId, true)).toMatchObject({
    stepStatus: "failed", effects: [{ operation, outcome: "uncertain" }],
  });
}, 10_000);
