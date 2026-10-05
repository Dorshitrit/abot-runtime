import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import type { RequestContextConfig } from "../config/runner/contracts.js";
import { invalidateRequestRunnerConfig } from "../config/runner/loader.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const reserves: readonly (keyof RequestContextConfig)[] = [
  "outputReserveTokens", "safetyReserveTokens", "attachmentReserveTokens",
];

test.each(reserves)("changing %s requires republish before normal or replay Agent admission", async (reserve) => {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Pinned context budget");
  let draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Summarize", onFailure: "stop", modelProfileId: "scheduled-model",
      agentMode: "reasoning", roleInstructions: "Summarize.", prompt: "Return a result.",
      inputs: {}, tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(created.automationId, draft.revision);
  const first = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(first.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  fixture.invoke.mockClear();
  fixture.invokeRaw.mockClear();

  const configPath = fixture.config.requestRunner.configPath;
  const runner = JSON.parse(await readFile(configPath, "utf8")) as { context: RequestContextConfig };
  runner.context[reserve] += 100;
  await writeFile(configPath, JSON.stringify(runner));
  invalidateRequestRunnerConfig({ configPath });
  const changed = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(changed.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("failed");
  expect(await studio.getRun(changed.id)).toMatchObject({ error: "automation_contract_changed" });
  await expect(studio.rerun(first.id, `repeat-after-${reserve}`, true))
    .rejects.toThrow("automation_contract_changed");
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();

  draft = await studio.updateDraft(created.automationId, draft.revision, {
    kind: "update_definition", patch: { title: "Republished context budget" },
  });
  await studio.publish(created.automationId, draft.revision);
  const republished = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(republished.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(fixture.invoke).toHaveBeenCalled();
}, 30_000); // Three sequential 8-second polls, plus fixture setup and persistence.
