import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentApplicationService } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { applicationPlan, returnedWorkDecision } from "./support/agents-application-fixture.js";
import { agentFullStackFixture } from "./support/agents-full-stack-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });

test.each(["recipient_changed", "parent_cancelled"])("%s after peer eligibility was checked prevents admission", async (race) => {
  const f = await agentFullStackFixture("execution-agent-v1");
  releases.push(() => f.dispose());
  const store = f.source.store;
  const definition = (await store.read()).agents[0]!.definition;
  await store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot"}});
  const admit = store.admitMessage.bind(store);
  vi.spyOn(store,"admitMessage").mockImplementation(async (command) => {
    if (command.source) {
      if (race === "recipient_changed") await store.commitApplication({kind:"update_definition",agentId:command.agentId,definition:{...definition,toolPermissionMode:"full_plus"}});
      else await store.commitApplication({kind:"cancel_mission",agentId:"abot",missionId:command.source.missionId,reason:"Cancelled before child admission."});
    }
    return admit(command);
  });
  let app!: AgentApplicationService;
  const coordination = createAgentCoordinationPort({store,application:() => app});
  app = createAgentApplication({...f.source.dependencies,work:f.ordinary.port,...coordination});
  releases.push(() => app.shutdown());
  f.source.invoke.mockImplementation(async (call) => ({
    text:call.format ? JSON.stringify({decision:applicationPlan("delegate_agent",{recipientAgentId:"agent-a"})}) : "Check the fictional source.",
    meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}},
  }));
  await app.send("abot",{messageId:"delegate",text:"Delegate a source check.",intent:"task"});
  await app.whenIdle();
  const state = await store.read();
  expect(state.mailbox).toHaveLength(1);
  if (race === "recipient_changed") expect(state.agents.find((agent) => agent.id === "agent-a")?.definition.toolPermissionMode).toBe("full_plus");
  else expect(state.missions.find((mission) => mission.agentId === "abot")?.status).toBe("cancelled");
  expect(state.missions.filter((mission) => mission.agentId === "agent-a")).toEqual([]);
  expect(state.messages.some((message) => message.source)).toBe(false);
  expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(0);
}, 20_000);

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy}: child asks ABot, receives one bounded answer, then completes ordinary work`, async () => {
    const f = await agentFullStackFixture(policy); releases.push(() => f.dispose());
    const definition = (await f.source.store.read()).agents[0]!.definition;
    await f.source.store.commitApplication({ kind: "register_agent", agentId: "abot", definition: { ...definition,
      name: "ABot", basePrompt: "Coordinate the Agents and answer their clarification questions within the accepted task.",
      defaultLimits: { ...definition.defaultLimits!, maxModelCalls: 80, maxTotalTokens: 40_000 } } });
    let application!: AgentApplicationService;
    const coordination = createAgentCoordinationPort({ store: f.source.store, application: () => application });
    application = createAgentApplication({ ...f.source.dependencies, work: f.ordinary.port, ...coordination });
    releases.push(() => application.shutdown());
    const question = "Which fictional source should I inspect?";
    const answer = "Use fictional source A for this assignment.";
    const privateFact = "PRIVATE_CHILD_CONVERSATION_FACT";
    const objective = "Ask Research to verify fictional source A and report its result.";
    const clarificationCalls: ChatMessage[][] = [];
    f.source.invoke.mockImplementation(async (input) => {
      const messages = input.messages as ChatMessage[];
      const capsule = JSON.parse(messages[1]!.content);
      const state = await f.source.store.read();
      const mission = state.missions.find((entry) => entry.id === capsule.mission.id)!;
      const parent = mission.agentId === "abot";
      const isClarificationReply = input.format && JSON.stringify(input.format).includes('"needs_user"');
      if (isClarificationReply) {
        expect(parent).toBe(true); expect(JSON.stringify(messages)).toContain(question);
        expect(JSON.stringify(messages)).toContain(objective); expect(JSON.stringify(messages)).not.toContain(privateFact);
        clarificationCalls.push(messages);
        return { text: JSON.stringify({ action: "answer", text: answer }), meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
      }
      if (parent) expect(JSON.stringify(messages)).not.toContain(privateFact);
      const attempt = state.attempts.find((entry) => entry.missionId === mission.id);
      const exchange = state.mailbox.find((entry) => entry.missionId === mission.id);
      const receivedAnswer = state.messages.some((entry) => entry.agentId === "agent-a" && entry.missionId === mission.id && entry.text === answer);
      const plan = mission.objective === privateFact ? applicationPlan("answer_user") : parent ?
        exchange ? applicationPlan("complete", { evidenceIds: [exchange.id], metCriteriaIds: ["request"] }) : applicationPlan("delegate_agent", { recipientAgentId: "agent-a" }) :
        attempt ? returnedWorkDecision() :
        receivedAnswer ? applicationPlan("start_session") : applicationPlan("ask_user");
      let text = "Perform the exact fictional fixture task.";
      if (plan.action === "ask_user") text = question;
      if (parent && plan.action === "delegate_agent") text = "Inspect the assigned fictional source; ask ABot which source to use.";
      if (plan.action === "complete" || (attempt && plan.action === "answer_user")) text = parent ? "Research verified the assigned fictional task." : "The assigned fictional task is verified.";
      return { text: input.format ? JSON.stringify({decision:plan}) : text, meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
    });
    await application.send("agent-a", { messageId: "private-child-context", text: privateFact, intent: "message" });
    await application.whenIdle("agent-a");
    await application.send("abot", { messageId: "team-task", text: objective, intent: "task" });
    await application.whenIdle("abot");
    const state = await f.source.store.read();
    const parent = state.missions.find((entry) => entry.agentId === "abot")!;
    const exchange = state.mailbox.find((entry) => entry.missionId === parent.id)!;
    const assignment = state.messages.find((entry) => entry.source?.correlationId === exchange.id)!;
    const child = state.missions.find((entry) => entry.id === assignment.missionId)!;
    expect(parent.status).toBe("completed"); expect(child.status).toBe("completed");
    expect(clarificationCalls).toHaveLength(1);
    expect(state.messages.filter((entry) => entry.missionId === child.id && entry.text === question)).toHaveLength(1);
    expect(state.messages.filter((entry) => entry.missionId === child.id && entry.text === answer)).toHaveLength(1);
    expect(exchange).toMatchObject({ status: "answered", outcome: "completed" });
    const parentCalls = state.invocations.filter((entry) => entry.missionId === parent.id);
    expect(parent.usage.modelCalls).toBe(parentCalls.length + child.usage.modelCalls);
    expect(parent.usage.totalTokens).toBe(parentCalls.length * 10 + child.usage.totalTokens);
    expect(child.usage.clarificationRounds).toBe(1);
    expect(parent.usage.clarificationRounds).toBeLessThanOrEqual(parent.limits.maxClarificationRounds);
    expect(state.attempts.filter((entry) => entry.missionId === child.id)).toHaveLength(1);
    expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
    expect(f.ordinary.invoke.mock.calls.every(([input]) => input.modelPreference?.profileId === "scheduled-model")).toBe(true);
  }, 25_000);
}
