import { readdir } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools, scriptToolUsingAgent } from "./support/automation-agent-tool-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
});

test("a blocked agent with an uncertain effect cannot skip into an independent successor", async () => {
  const tools = probeTools("mutating");
  tools.execute.mockRejectedValueOnce(new Error("mutation_response_lost"));
  const f = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
  fixtures.push(f);
  scriptToolUsingAgent(f, "execution-agent-v1");
  const invoke = f.invoke.getMockImplementation()!;
  let decisions = 0;
  f.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "execution.decision" && ++decisions === 3) return {
      text: JSON.stringify({ decision: { action: "blocked",
        response: "The mutation outcome is unknown; I cannot complete this step." } }),
      meta: {},
    };
    return invoke(input);
  });
  const studio = f.application.services.automations!;
  let draft = await studio.create("Uncertain blocked effect");
  draft = await addAgent(studio, draft, "Attempt a mutation");
  const nodeId = draft.definition.body.children[0]!.id;
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_node", nodeId, patch: { onFailure: "skip" },
  });
  // This successor does not depend on an output binding: only uncertainty stops its dispatch.
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
  await expect.poll(async () => {
    const status = (await studio.getRun(run.id)).status;
    return ["pending", "running", "stopping"].includes(status) ? "active" : status;
  }, { timeout: 5_000, interval: 10 }).not.toBe("active");

  const completed = await studio.getRun(run.id);
  expect(decisions).toBe(3);
  expect(completed).toMatchObject({ status: "failed", report: {
    outcome: "failed",
    nodeResults: [
      { nodeId, status: "failed", errorCode: "automation_effect_uncertain" },
      { nodeId: successorId, status: "cancelled" },
    ],
    uncertainEffects: [{ nodeId, attemptId: expect.any(String) }],
    effectSummary: { total: 1, unresolvedAttempts: 1 },
  } });
  expect(completed.report?.nodeResults[0]).not.toHaveProperty("resultRef");
  expect(tools.execute).toHaveBeenCalledOnce();
  const evidence = await studio.getStepEvidence(run.id, nodeId, true);
  expect(evidence).toMatchObject({ stepStatus: "failed",
    effects: [{ operation, outcome: "uncertain" }] });
  expect((await readdir(f.config.paths.sessionsDir)).filter((name) => name.endsWith(".json")))
    .toEqual(["session.json"]);
}, 10_000);
