import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

type RuntimeFixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: RuntimeFixture[] = [];
const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;
const evidence = `${"A complete source finding. ".repeat(1_500)}\nFinal source: מקור אחרון 🧪`;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function runAgent(fixture: RuntimeFixture, source: string) {
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Complete evidence admission");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { inputs: { evidence: source } },
  });
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: {
      kind: "agent", title: "Summarize", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning",
      roleInstructions: "Summarize the supplied evidence.",
      prompt: "Return a short completion.",
      inputs: { evidence: { kind: "run_input", input: "evidence" } },
      tools: [], result: { kind: "text" },
    },
  });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 8_000, interval: 10 }).toMatch(/^(succeeded|failed)$/u);
  return studio.getRun(run.id);
}

function expectCompleteAssignment(messages: readonly ChatMessage[], source: string) {
  const active = messages.filter((message) => message.role === "user"
    && JSON.stringify(message.content).includes("automation_node_assignment_v2"));
  expect(active).toHaveLength(1);
  const content = active[0]!.content;
  expect(typeof content).toBe("string");
  const text = content as string;
  const serializedInputs = JSON.stringify({ evidence: source });
  expect(text.split(serializedInputs)).toHaveLength(2);
  expect(text.length).toBeGreaterThan(32_768);
}

test.each(policies)("%s admits complete >32K step evidence at decision and response", async (policy) => {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  const run = await runAgent(fixture, evidence);
  const expectedPhases = policy === "execution-agent-v1"
    ? ["execution.decision", "execution.response"]
    : ["supervisor_presentation", "supervisor_decision", "supervisor.response"];
  expect(run).toMatchObject({ status: "succeeded", report: { modelCalls: expectedPhases.length, toolCalls: 0 } });
  expect(fixture.invoke.mock.calls.map(([call]) => supervisorFormatName(call) ?? call.modelStep))
    .toEqual(expectedPhases);
  for (const [call] of fixture.invoke.mock.calls) {
    expectCompleteAssignment(call.messages as readonly ChatMessage[], evidence);
  }
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
});

test.each(policies)("%s rejects oversized evidence before ordinary inference while a small input fits", async (policy) => {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  fixture.config.models!.profiles!["scheduled-model"]!.contextWindowTokens = 16_384;
  const rejected = await runAgent(fixture, evidence);
  expect(rejected).toMatchObject({ status: "failed",
    error: expect.stringContaining("automation_agent_context_too_large"),
    report: { outcome: "failed", toolCalls: 0 } });
  const failureSteps = policy === "supervisor-worker-v1"
    ? ["degraded.finalization"] : [];
  // SUPER may explain an admission failure once. It must not attempt the
  // rejected agent decision/response; EA retains its provider-free failure.
  expect(fixture.invoke.mock.calls.map(([call]) => call.modelStep))
    .toEqual(failureSteps);
  expect(fixture.invokeRaw).not.toHaveBeenCalled();

  const admitted = await runAgent(fixture, "A small complete source finding.");
  const expectedPhases = policy === "execution-agent-v1"
    ? ["execution.decision", "execution.response"]
    : ["supervisor_presentation", "supervisor_decision", "supervisor.response"];
  expect(admitted).toMatchObject({ status: "succeeded", report: { modelCalls: expectedPhases.length } });
  expect(fixture.invoke.mock.calls.map(([call]) => supervisorFormatName(call) ?? call.modelStep))
    .toEqual([...failureSteps, ...expectedPhases]);
});
