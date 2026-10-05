import { afterEach, expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools, scriptToolUsingAgent, type Policy } from "./support/automation-agent-tool-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s journals selected agent tool invocations uniquely across steps and runs",
  async (policy: Policy) => {
    const tools = probeTools();
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(fixture);
    scriptToolUsingAgent(fixture, policy);
    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Repeated agent tool invocations");
    draft = await addAgent(studio, draft, "First agent");
    draft = await addAgent(studio, draft, "Second agent");
    await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
      mode: "full_access", operations: [operation], actionId: "test-grant" });
    await studio.publish(draft.automationId, draft.revision);

    const attemptIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const started = await studio.runNow(draft.automationId);
      await expect.poll(async () => {
        const status = (await studio.getRun(started.id)).status;
        return status === "pending" || status === "running" ? "running" : status;
      }, { timeout: 8_000, interval: 10 }).not.toBe("running");
      const run = await studio.getRun(started.id);
      expect(run.status, JSON.stringify(run.report?.nodeResults)).toBe("succeeded");
      expect(run.report?.effectSummary?.entries).toHaveLength(2);
      attemptIds.push(...(run.report?.effectSummary?.entries ?? []).map((entry) => entry.attemptId));
    }
    expect(tools.execute).toHaveBeenCalledTimes(4);
    expect(new Set(attemptIds).size).toBe(4);
  },
  20_000,
);
