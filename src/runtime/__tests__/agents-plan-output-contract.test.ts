import { afterEach, expect, test } from "vitest";
import { projectOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { projectOpenAIResponsesFormat } from "../../model-gateway/structured-output/openai-format.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { AGENT_PLAN_FORMAT, AGENT_WORK_RESULT_FORMAT, readAgentPlanOutput } from "../agents/plan-output-contract.js";
import { createAgentApplication } from "../agents/application-service.js";
import { agentApplicationFixture, applicationPlan, returnedWorkDecision, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);

const completed = applicationPlan("complete", { evidenceIds: ["attempt-with-result"], metCriteriaIds: ["request"] });
const wrongTarget = { ...completed, sessionId: "same-session-that-produced-the-result" };
test("provider schema rejects the observed completion with an execution target and remains native on OpenAI and Ollama", () => {
  const provider = projectOpenAIResponsesFormat(AGENT_PLAN_FORMAT);
  expect(provider.format).toMatchObject({ type: "json_schema", name: "persistent_agent_plan_v3" });
  expect(provider.instructions).toEqual([]);
  const ollama = projectOllamaFormat(AGENT_PLAN_FORMAT);
  for (const schema of [AGENT_PLAN_FORMAT.schema, provider.format!.schema as Record<string, unknown>, ollama.format as Record<string, unknown>]) {
    expect(validateJsonSchemaValue(schema, { decision: completed })).toBeUndefined();
    expect(validateJsonSchemaValue(schema, { decision: wrongTarget })).toBeDefined();
    expect(validateJsonSchemaValue(schema, { decision: applicationPlan("continue_session", { sessionId: "owned" }) })).toBeUndefined();
    expect(validateJsonSchemaValue(schema, { decision: applicationPlan("delegate_agent", { recipientAgentId: "peer" }) })).toBeUndefined();
    expect(validateJsonSchemaValue(schema, { decision: applicationPlan("answer_user", { recipientAgentId: "peer" }) })).toBeDefined();
  }
  const work = applicationPlan("start_session", { publicUpdate: "אבדוק את המקורות שביקשת." });
  expect(readAgentPlanOutput(JSON.stringify({ decision: work })).publicUpdate).toBe(work.publicUpdate);
  expect(() => readAgentPlanOutput(JSON.stringify({ decision: { ...completed, publicUpdate: work.publicUpdate } }))).toThrow();
  expect(() => readAgentPlanOutput(JSON.stringify({ decision: wrongTarget }))).toThrow();
  expect(() => readAgentPlanOutput(JSON.stringify({ decision: completed, permission: "full_plus" }))).toThrow();
  expect(() => readAgentPlanOutput(JSON.stringify({ decision: { ...completed, reason: "x".repeat(1001) } }))).toThrow();
});

test("returned work has the same two target-free choices in both provider projections", () => {
  const openai = projectOpenAIResponsesFormat(AGENT_WORK_RESULT_FORMAT);
  const ollama = projectOllamaFormat(AGENT_WORK_RESULT_FORMAT);
  expect(openai.instructions).toEqual([]);
  for (const schema of [AGENT_WORK_RESULT_FORMAT.schema, openai.format!.schema as Record<string, unknown>, ollama.format as Record<string, unknown>]) {
    for (const action of ["continue_session", "answer_user"] as const) {
      const decision = returnedWorkDecision(action);
      expect(validateJsonSchemaValue(schema, { decision })).toBeUndefined();
      expect(validateJsonSchemaValue(schema, { decision: { ...decision, sessionId: "foreign-session" } })).toBeDefined();
    }
    expect(validateJsonSchemaValue(schema, { decision: completed })).toBeDefined();
    expect(validateJsonSchemaValue(schema, { decision: { action: "ask_user", reason: "Pause" } })).toBeDefined();
  }
});

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy} returns the saved worker answer once if the result decision proposes its own target`, { timeout: 20_000 }, async () => {
    const f = await agentApplicationFixture({ policy, choose(state) {
      if (!state.attempts.length) return applicationPlan("start_session");
      return JSON.stringify({ decision: { action: "continue_session", reason: "Try another session.",
        publicUpdate: "I’ll try again.", sessionId: "other-session" } });
    } });
    await f.app.send("agent-a", { messageId: "work", text: "Check the supplied information.", intent: "auto" });
    await f.app.whenIdle();
    const detail = await f.app.detail("agent-a");
    expect(detail.mission?.status).not.toBe("awaiting_user_decision");
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", text: completedAgentWork.output });
    expect(detail.attempts).toHaveLength(1);
    const before = f.invoke.mock.calls.length;
    await f.app.shutdown(); const restarted = trackAgentApplication(createAgentApplication(f.dependencies));
    await restarted.recover(); await restarted.refresh("agent-a"); await restarted.whenIdle();
    expect(f.invoke).toHaveBeenCalledTimes(before);
    expect((await restarted.detail("agent-a")).messages).toEqual(detail.messages);
    expect(f.run).toHaveBeenCalledOnce();
  });
  test(`${policy} can select answer_user for an automatic greeting without a session`, async () => {
    const f = await agentApplicationFixture({ policy, choose: () => applicationPlan("answer_user") });
    await f.app.send("agent-a", { messageId: "greet", text: "היי", intent: "auto" }); await f.app.whenIdle();
    const result = await f.app.detail("agent-a");
    expect(result.mission?.status).toBe("completed"); expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(result.responsibility).toMatchObject([{ accepted: true, plan: { action: "answer_user", sessionId: null, recipientAgentId: null } }]);
    expect(f.run).not.toHaveBeenCalled();
  });
}
