import { afterEach, expect, test } from "vitest";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import {
  addAgent, operation, probeTools, scriptToolUsingAgent,
} from "./support/automation-agent-tool-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

test.each([
  ["execution-agent-v1", "supervisor-worker-v1"],
  ["supervisor-worker-v1", "execution-agent-v1"],
] as const)(
  "%s rejects an incompatible published tool route before model or tool execution",
  async (policy, incompatiblePolicy) => {
    const tools = probeTools();
    const definition = tools.registry.listNormalInvocations!()[0]!.definition;
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(fixture);
    scriptToolUsingAgent(fixture, policy);
    const studio = fixture.application.services.automations!;
    const created = await studio.create("Published route contract");
    const draft = await addAgent(studio, created, "Observe the granted operation");
    await studio.replaceGrant({
      automationId: draft.automationId, expectedGrantRevision: 0,
      mode: "full_access", operations: [operation], actionId: "explicit-route-test-grant",
    });
    await studio.publish(draft.automationId, draft.revision);

    // Introducing an explicit declaration must preserve an already compatible publication.
    definition.executionPolicies = [policy];
    expect((await studio.catalog(draft.automationId)).operations).toEqual([
      expect.objectContaining({ ...operation, executionPolicies: [policy] }),
    ]);
    const first = await studio.runNow(draft.automationId);
    await expect.poll(async () => (await studio.getRun(first.id)).status,
      { timeout: 8_000, interval: 10 }).toBe("succeeded");
    expect(fixture.invoke).toHaveBeenCalled();
    expect(tools.execute).toHaveBeenCalledOnce();
    fixture.invoke.mockClear();
    fixture.invokeRaw.mockClear();
    tools.execute.mockClear();

    // The same saved revision cannot silently lose its selected operation.
    definition.executionPolicies = [incompatiblePolicy];
    const changed = await studio.runNow(draft.automationId);
    await expect.poll(async () => (await studio.getRun(changed.id)).status,
      { timeout: 8_000, interval: 10 }).toBe("failed");
    expect(await studio.getRun(changed.id)).toMatchObject({
      error: "automation_contract_changed", report: { outcome: "failed" },
    });
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    expect(tools.execute).not.toHaveBeenCalled();

    const routeIssue = expect.objectContaining({ code: "automation_operation_unavailable" });
    await expect(studio.rerun(first.id, "replay-with-incompatible-route", true))
      .rejects.toMatchObject({ issues: expect.arrayContaining([routeIssue]) });
    const revised = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "update_definition", patch: { title: "Republish with changed route" },
    });
    await expect(studio.publish(draft.automationId, revised.revision))
      .rejects.toMatchObject({ issues: expect.arrayContaining([routeIssue]) });
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    expect(tools.execute).not.toHaveBeenCalled();
  },
  20_000,
);
