import { afterEach, expect, test } from "vitest";
import type { AgentNode } from "../automations/definition-contracts.js";
import { projectAutomationModelDependencies } from "../automations/model-dependency-projection.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
const preference = {
  profileId: "scheduled-model",
  mode: "budget",
  budgetTokens: 384,
} as const;
const agent = {
  kind: "agent",
  title: "Respond",
  onFailure: "stop",
  modelProfileId: "scheduled-model",
  agentMode: "fast",
  roleInstructions: "Answer the request.",
  prompt: "Answer briefly.",
  inputs: {},
  tools: [],
  result: { kind: "text" },
} as const;

async function fixture() {
  const current = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(current);
  current.config.models!.providers!.local.type = "llamacpp";
  current.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  return current;
}

test("agent budget persists through draft, saved agent, publication and canonical execution", async () => {
  const f = await fixture();
  const studio = f.application.services.automations!;
  let draft = await studio.create("Reasoning");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node",
    parentSequenceId: draft.definition.body.id,
    index: 0,
    nodeWithoutId: { ...agent, reasoningPreference: preference },
  });
  const nodeId = draft.definition.body.children[0].id;
  const saved = await studio.saveAgentFromDraft({
    automationId: draft.automationId,
    expectedDraftRevision: draft.revision,
    nodeId,
  });
  expect(saved.agent.reasoningPreference).toEqual(preference);
  expect(
    (await studio.getSavedAgent(saved.agentId))?.agent.reasoningPreference,
  ).toEqual(preference);
  await studio.replaceGrant({
    automationId: draft.automationId,
    expectedGrantRevision: 0,
    mode: "full_access",
    operations: [],
    actionId: "reasoning-test",
  });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect
    .poll(async () => (await studio.getRun(run.id)).status, {
      timeout: 8000,
      interval: 10,
    })
    .toBe("succeeded");
  expect(f.invoke).toHaveBeenCalled();
  for (const [input] of f.invoke.mock.calls)
    expect(input.reasoningPreference).toEqual(preference);
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_node",
    nodeId,
    patch: { title: "Retained" },
  });
  expect(
    (draft.definition.body.children[0] as AgentNode).reasoningPreference,
  ).toEqual(preference);
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_node",
    nodeId,
    patch: { reasoningPreference: null },
  });
  expect(draft.definition.body.children[0]).not.toHaveProperty(
    "reasoningPreference",
  );
  expect(
    (await studio.getSavedAgent(saved.agentId))?.agent.reasoningPreference,
  ).toEqual(preference);
});

test("dependency projection preserves old identities and separates captured reasoning choices", async () => {
  const f = await fixture();
  const node: AgentNode = { ...agent, id: "agent" };
  const old = projectAutomationModelDependencies(f.config, [node])!;
  expect(old.agents[0].key).toBe(
    JSON.stringify([node.modelProfileId, node.agentMode]),
  );
  const next = projectAutomationModelDependencies(f.config, [
    node,
    { ...node, reasoningPreference: preference },
  ])!;
  expect(next.agents).toHaveLength(2);
  expect(next.agents.find((item) => item.key === old.agents[0].key)).toEqual(
    old.agents[0],
  );
  const selected = next.agents.find((item) => item.key !== old.agents[0].key)!;
  expect(
    selected.invocations.find(
      (item) => item.modelStep === "execution.response",
    ),
  ).toMatchObject({
    think: "medium",
    reasoningBudget: { mode: "tokens", tokens: 384 },
  });
  expect(
    selected.invocations.find((item) => item.modelStep === "context.compact"),
  ).not.toHaveProperty("reasoningBudget");
});
