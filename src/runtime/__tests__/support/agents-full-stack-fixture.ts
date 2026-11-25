import { expect } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { createAgentApplication } from "../../agents/application-service.js";
import { createAgentApplicationObserver } from "../../agents/application-observer.js";
import { returnedWorkDecision, applicationPlan, agentApplicationFixture } from "./agents-application-fixture.js";
import { createAgentOrdinaryOwnerFixture } from "./agents-ordinary-owner-fixture.js";

export async function agentFullStackFixture(policy: "execution-agent-v1" | "supervisor-worker-v1", approval = false) {
  const ordinary = await createAgentOrdinaryOwnerFixture(policy, approval);
  const source = await agentApplicationFixture({ policy });
  const config = source.dependencies.config;
  const profile = config.models!.profiles!["fixture-super"]!;
  config.models = { ...config.models!, profiles: { "scheduled-model": profile }, defaults: { profileId: "scheduled-model" } };
  config.modelExecutionPolicies = { "scheduled-model": { policy } };
  const definition = (await source.store.read()).agents[0]!.definition;
  await source.store.commitApplication({ kind: "update_definition", agentId: "agent-a", definition: { ...definition,
    basePrompt: "AGENT_PRIVATE_CONTEXT_MARKER. Own the task and verify the ordinary work result.", modelProfileId: "scheduled-model",
    defaultLimits: { ...definition.defaultLimits!, maxModelCalls: 60 } } });
  source.invoke.mockImplementation(async (input) => {
    const state = await source.store.read();
    const attempt = state.attempts.at(-1);
    const completed = attempt?.status === "settled" && attempt.result?.status === "completed";
    const plan = completed ? returnedWorkDecision() : applicationPlan("start_session");
    const text = input.format ? JSON.stringify({decision:plan}) : completed ? `Agent verified the result: ${attempt.result!.output}` : "Perform the exact fictional fixture task.";
    return { text, meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
  });
  const executeModel = ordinary.invoke.getMockImplementation()!;
  ordinary.invoke.mockImplementation(async (input) => {
    const state = await source.store.read();
    const attempt = state.attempts.find((entry) => entry.request.requestId === input.debugRequestId);
    expect(attempt?.claimId).toEqual(expect.any(String));
    expect(["claimed", "running", "awaiting_approval"]).toContain(attempt?.status);
    expect(state.sessions).toContainEqual(expect.objectContaining({ agentId: "agent-a", sessionId: attempt!.request.sessionId }));
    expect(JSON.stringify(input.messages as ChatMessage[])).not.toContain("AGENT_PRIVATE_CONTEXT_MARKER");
    return executeModel(input);
  });
  const dependencies = { ...source.dependencies, work: ordinary.port };
  const app = createAgentApplication(dependencies);
  const apps = [app];
  const observers: ReturnType<typeof createAgentApplicationObserver>[] = [];
  return { ordinary, source, app, async restore() {
    await app.shutdown(); const restored = createAgentApplication(dependencies); apps.push(restored); await restored.recover();
    const observer = createAgentApplicationObserver({ application: restored }); observers.push(observer); await observer.start();
    return { app: restored, observer };
  }, async dispose() {
    for (const observer of observers) await observer.stop();
    for (const application of apps) await application.shutdown();
    await ordinary.dispose();
  } };
}
