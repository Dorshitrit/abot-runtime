import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import {
  agentApplicationFixture, completedAgentWork,
  disposeAgentApplicationFixtures, trackAgentApplication,
} from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures, 20_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Policy = "execution-agent-v1" | "supervisor-worker-v1";
type ParkedStatus = "running" | "awaiting_approval";

async function terminalBeforeStaleReturn(
  policy: Policy,
  status: ParkedStatus,
  terminal: AgentWorkResult = completedAgentWork,
) {
  const entered = deferred<void>(), work = deferred<AgentWorkResult>();
  const f = await agentApplicationFixture({ policy, run: () => {
    entered.resolve();
    return work.promise;
  } });
  f.inspect.mockResolvedValue(terminal);
  await f.app.send("agent-a", { messageId: "request", text: "Verify the requested information", intent: "task" });
  await entered.promise;
  const before = await f.store.read();
  const calls = f.invoke.mock.calls.length;
  const observed = await f.app.refresh("agent-a", before.missions[0]!.id);
  expect(observed.mission?.status).toBe("active");
  expect(observed.attempts[0]).toMatchObject({ status: "settled", result: terminal });
  expect(f.app.isBusy()).toBe(true);
  expect(f.invoke).toHaveBeenCalledTimes(calls);

  work.resolve({ status, output: null, error: null, receiptId: null, usage: null });
  await f.app.whenIdle();
  const stranded = await f.store.read();
  expect(f.app.isBusy()).toBe(false);
  expect(stranded.missions[0]?.status).toBe("active");
  expect(stranded.attempts).toHaveLength(1);
  expect(stranded.attempts[0]).toMatchObject({ status: "settled", result: terminal });
  expect(stranded.responsibility.map(trace => trace.plan.action)).toEqual(["start_session"]);
  return { ...f, stranded, calls };
}

describe("settled work continuation after a stale live return", () => {
  for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
    test.each(["running", "awaiting_approval"] as const)(`${policy}: a late %s return resumes once on the next refresh`, { timeout: 20_000 }, async status => {
      const f = await terminalBeforeStaleReturn(policy, status);
      const missionId = f.stranded.missions[0]!.id;
      await Promise.all(Array.from({ length: 4 }, () => f.app.refresh("agent-a", missionId)));
      await f.app.whenIdle();
      const complete = await f.store.read();
      expect(complete.missions[0]?.status).toBe("completed");
      expect(complete.attempts).toEqual(f.stranded.attempts);
      expect(complete.responsibility.map(trace => trace.plan.action)).toEqual(["start_session", "answer_user"]);
      expect(complete.responsibility[1]).toMatchObject({ accepted: true, plan: { evidenceIds: [complete.attempts[0]!.id] } });
      expect(complete.messages.filter(message => message.purpose === "reply")).toHaveLength(1);
      const returnedDecisions = f.invoke.mock.calls.filter(([input]) =>
        typeof input.format === "object" && input.format?.name === "persistent_agent_work_result_v1");
      expect(returnedDecisions).toHaveLength(1);
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledOnce();

      const calls = f.invoke.mock.calls.length;
      await Promise.all([f.app.refresh("agent-a"), f.app.refresh("agent-a", missionId)]);
      await f.app.whenIdle();
      await f.app.refresh("agent-a", missionId);
      expect(await f.store.read()).toEqual(complete);
      expect(f.invoke).toHaveBeenCalledTimes(calls);
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledOnce();
    });
  }

  test.each(["wrong mission", "paused", "cancelled", "unmeasured"] as const)("does not resume %s work from the retained receipt", { timeout: 20_000 }, async guard => {
    const terminal = guard === "unmeasured" ? { ...completedAgentWork, usage: null } : completedAgentWork;
    const f = await terminalBeforeStaleReturn("execution-agent-v1", "running", terminal);
    if (guard === "paused") await f.app.pause("agent-a");
    if (guard === "cancelled") await f.app.cancel("agent-a");
    const before = await f.store.read();
    const expectedMission = guard === "wrong mission" ? "different-mission" : before.missions[0]!.id;
    await Promise.all([f.app.refresh("agent-a", expectedMission), f.app.refresh("agent-a", expectedMission)]);
    await f.app.whenIdle();
    expect(await f.store.read()).toEqual(before);
    expect(f.invoke).toHaveBeenCalledTimes(f.calls);
    expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
    if (guard === "unmeasured") expect((await f.app.detail("agent-a")).recovery.requiresNewBudget).toBe(true);
  });

  test("reopening retains the terminal receipt and preserves the existing interruption pause", { timeout: 20_000 }, async () => {
    const f = await terminalBeforeStaleReturn("execution-agent-v1", "awaiting_approval");
    await f.app.shutdown();
    const store = new FileAgentStateStore(join(f.dependencies.config.paths.runtimeDir, "agents", "state.json"));
    expect(await store.read()).toEqual(f.stranded);
    const restored = trackAgentApplication(createAgentApplication({ ...f.dependencies, store }));
    await restored.recover();
    const recovered = await store.read();
    expect(recovered.missions[0]?.status).toBe("awaiting_user_decision");
    expect(recovered.attempts).toEqual(f.stranded.attempts);
    expect(recovered.missions[0]?.usage).toEqual(f.stranded.missions[0]?.usage);
    await Promise.all([restored.refresh("agent-a"), restored.refresh("agent-a")]);
    await restored.whenIdle();
    expect(await store.read()).toEqual(recovered);
    expect(f.invoke).toHaveBeenCalledTimes(f.calls);
    expect(f.createSession).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  });
});
