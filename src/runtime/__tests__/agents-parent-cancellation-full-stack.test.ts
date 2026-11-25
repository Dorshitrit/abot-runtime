import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentApplicationService } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { agentApplicationFixture, applicationPlan, completedAgentWork } from "./support/agents-application-fixture.js";
import { agentFullStackFixture } from "./support/agents-full-stack-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });

async function interruptedDelegationFixture() {
  const f = await agentFullStackFixture("execution-agent-v1", true); releases.push(() => f.dispose());
  const definition = (await f.source.store.read()).agents[0]!.definition;
  await f.source.store.commitApplication({ kind: "register_agent", agentId: "abot", definition: { ...definition, name: "ABot" } });
  let application!: AgentApplicationService;
  application = createAgentApplication({ ...f.source.dependencies, work: f.ordinary.port, async coordinate(request) {
    await application.receive(request.recipientAgentId, { messageId: `peer:${request.correlationId}`, text: request.assignment, intent: "task", limits: request.limits },
      { agentId: request.senderAgentId, missionId: request.missionId, correlationId: request.correlationId });
    await application.whenIdle(request.recipientAgentId);
    // The child receipt is durable; the parent loses its coordinating return before settlement.
    throw new Error("Injected coordination transport interruption after child admission");
  } });
  releases.push(() => application.shutdown());
  f.source.invoke.mockImplementation(async (input) => {
    const capsule = JSON.parse((input.messages as ChatMessage[])[1]!.content);
    const state = await f.source.store.read(); const mission = state.missions.find((entry) => entry.id === capsule.mission.id)!;
    const plan = mission.agentId === "abot" ? applicationPlan("delegate_agent", { recipientAgentId: "agent-a" }) : applicationPlan("start_session");
    return { text: input.format ? JSON.stringify({decision:plan}) : "Perform the fictional mutation after approval.", meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
  });
  await application.send("abot", { messageId: "parent-task", text: "Delegate this fictional mutation to Research.", intent: "task" });
  await application.whenIdle();
  expect((await application.detail("abot")).status).toBe("awaiting_user_decision");
  const child = await application.detail("agent-a"); expect(child.status).toBe("awaiting_approval");
  const restore = async () => {
    await application.shutdown();
    const restored = createAgentApplication({ ...f.source.dependencies, work: f.ordinary.port });
    releases.push(() => restored.shutdown()); await restored.recover(); return restored;
  };
  return { ...f, application, child, restore };
}

test("a replacement controller and side conversation survive cleanup of the cancelled child", async () => {
  const f = await interruptedDelegationFixture();
  const restored = await f.restore();
  const childId = f.child.mission!.id;
  let resumeCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { resumeCleanup = resolve; });
  let childCancelled = false;
  const commit = f.source.store.commitApplication.bind(f.source.store);
  vi.spyOn(f.source.store,"commitApplication").mockImplementation(async (command) => {
    const result = await commit(command);
    if (command.kind === "cancel_mission" && command.missionId === childId) {
      childCancelled = true;
      await cleanupGate;
    }
    return result;
  });
  let resumeNewTask!: () => void;
  const taskGate = new Promise<void>((resolve) => { resumeNewTask = resolve; });
  let newSignal: AbortSignal | undefined;
  const invoke = f.source.invoke.getMockImplementation()!;
  f.source.invoke.mockImplementationOnce(async (call) => {
    newSignal = call.abortSignal;
    await taskGate;
    return invoke(call);
  });
  const pending = restored.cancel("abot");
  try {
    await vi.waitFor(() => expect(childCancelled).toBe(true), {timeout:5000});
    await restored.send("agent-a",{messageId:"replacement-task",text:"Do a different job",intent:"task"});
    await vi.waitFor(() => expect(newSignal).toBeDefined(), {timeout:5000});
    await restored.send("agent-a",{messageId:"new-chat",text:"How is the new job going?",intent:"message"});
    resumeCleanup();
    await pending;
    const replacement = await restored.detail("agent-a");
    expect(replacement.mission?.id).not.toBe(childId);
    expect(replacement.mission?.status).toBe("active");
    expect(newSignal!.aborted).toBe(false);
    expect(replacement.replyingToMessageIds).toContain("new-chat");
  } finally {
    resumeCleanup();
    resumeNewTask();
    await pending;
  }
}, 20_000);

test("a delayed cancellation command cannot cancel a new mission admitted after its snapshot", async () => {
  const f = await agentApplicationFixture({result:{...completedAgentWork,status:"awaiting_approval",usage:null}});
  releases.push(() => f.app.shutdown());
  await f.app.send("agent-a",{messageId:"old",text:"Do the old task.",intent:"task"});
  await f.app.whenIdle();
  const old = (await f.app.detail("agent-a")).mission!;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {resume = resolve;});
  let cancelling = false;
  const commit = f.store.commitApplication.bind(f.store);
  vi.spyOn(f.store,"commitApplication").mockImplementation(async (command) => {
    if (command.kind === "cancel_mission" && command.missionId === old.id) {
      cancelling = true;
      await gate;
    }
    return commit(command);
  });
  const pending = f.app.cancel("agent-a",old.id);
  try {
    await vi.waitFor(() => expect(cancelling).toBe(true), {timeout:5000});
    await commit({kind:"cancel_mission",agentId:"agent-a",missionId:old.id,reason:"Another caller cancelled."});
    await f.app.send("agent-a",{messageId:"new",text:"Do a different task.",intent:"task"});
    await f.app.whenIdle();
    const replacement = (await f.app.detail("agent-a")).mission!;
    resume();
    await pending;
    expect((await f.app.detail("agent-a")).mission).toMatchObject({id:replacement.id,status:"active"});
    expect(f.cancel).not.toHaveBeenCalled();
  } finally {
    resume();
    await pending;
  }
}, 20_000);

test("direct cancellation of a newer mission proceeds while old cancellation cleanup is pending", async () => {
  const f = await agentApplicationFixture({result:{...completedAgentWork,status:"awaiting_approval",usage:null}});
  releases.push(() => f.app.shutdown());
  await f.app.send("agent-a",{messageId:"old",text:"Do the old task.",intent:"task"});
  await f.app.whenIdle();
  const old = (await f.app.detail("agent-a")).mission!;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {resume = resolve;});
  f.cancel.mockImplementationOnce(async () => {
    await gate;
    return {...completedAgentWork,status:"cancelled"};
  });
  const first = f.app.cancel("agent-a");
  try {
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce(), {timeout:5000});
    await f.app.send("agent-a",{messageId:"new",text:"Do a different task.",intent:"task"});
    await f.app.whenIdle();
    const replacement = (await f.app.detail("agent-a")).mission!;
    expect(replacement.id).not.toBe(old.id);
    const cancelled = await f.app.cancel("agent-a");
    expect(cancelled.mission).toMatchObject({id:replacement.id,status:"cancelled"});
    expect(f.cancel).toHaveBeenCalledTimes(2);
  } finally {
    resume();
    await first;
  }
}, 20_000);

test("after restart, parent cancellation follows the durable assignment and cancels its actual ordinary request once", async () => {
  const f = await interruptedDelegationFixture(); const restored = await f.restore();
  const request = f.child.attempts[0]!.request; f.ordinary.call.mockClear();
  await restored.cancel("abot"); await restored.cancel("abot");
  expect((await restored.detail("abot")).mission?.status).toBe("cancelled");
  expect((await restored.detail("agent-a")).mission).toMatchObject({ id: f.child.mission!.id, status: "cancelled" });
  expect(await f.ordinary.port.inspect(request)).toMatchObject({ status: "cancelled" });
  expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.cancel")).toHaveLength(1);
  expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(0);
  expect(f.ordinary.execute).not.toHaveBeenCalled();
}, 20_000);

test("after restart, parent cancellation preserves a newer unrelated child mission and its ordinary request", async () => {
  const f = await interruptedDelegationFixture();
  await f.application.cancel("agent-a");
  await f.application.send("agent-a", { messageId: "unrelated-task", text: "Perform a separate fictional mutation after approval.", intent: "task" });
  await f.application.whenIdle("agent-a"); const unrelated = await f.application.detail("agent-a");
  expect(unrelated.mission?.id).not.toBe(f.child.mission!.id); expect(unrelated.status).toBe("awaiting_approval");
  const restored = await f.restore(); f.ordinary.call.mockClear(); await restored.cancel("abot");
  const current = await restored.detail("agent-a");
  expect(current.mission).toMatchObject({ id: unrelated.mission!.id, status: "active" });
  expect(current.status).toBe("awaiting_approval");
  const request = unrelated.attempts.find((entry) => entry.missionId === unrelated.mission!.id)!.request;
  expect(await f.ordinary.port.inspect(request)).toMatchObject({ status: "awaiting_approval" });
  expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.cancel")).toHaveLength(0);
  expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(0);
  expect(f.ordinary.execute).not.toHaveBeenCalled();
}, 20_000);
