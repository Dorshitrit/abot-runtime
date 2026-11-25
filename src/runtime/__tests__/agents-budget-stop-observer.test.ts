import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import type { AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentApplicationObserver } from "../agents/application-observer.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";

afterEach(async () => {
  await disposeAgentApplicationFixtures();
  vi.useRealTimers();
}, 20_000);
const running: AgentWorkResult = {...completedAgentWork,status:"running",output:null,usage:null,receiptId:"running"};
const stopped: AgentWorkResult = {...completedAgentWork,status:"cancelled",output:null,error:"request_cancelled",receiptId:"terminal"};
const budgetStops = [
  {reason:"agents_token_limit_reached",usage:{modelCalls:2,totalTokens:20_001}},
  {reason:"agents_model_call_limit_reached",usage:{modelCalls:22,totalTokens:100}},
] as const;

for (const {reason,usage} of budgetStops) for (const restart of [false,true]) {
  test(`${reason}: observer finishes a settled budget stop ${restart ? "after reopening durable state" : "between ticks"}`, {timeout:20_000}, async () => {
    vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
    const f = await agentApplicationFixture({result:running});
    const deps = {...f.dependencies,work:{...f.dependencies.work,inspectUsage:async () => usage}};
    const app = trackAgentApplication(createAgentApplication(deps));
    await app.send("agent-a",{messageId:"task",text:"Read the supplied notes",intent:"task"});
    await app.whenIdle();
    f.cancel.mockResolvedValue(running);
    const observer = createAgentApplicationObserver({application:app});
    try {
      await observer.start();
      const waiting = await app.detail("agent-a");
      expect(waiting.mission).toMatchObject({status:"awaiting_user_decision",waitingReason:reason});
      expect(f.cancel).toHaveBeenCalledOnce();
      // The ordinary dispatch can persist its terminal receipt before the next observer tick.
      await f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId:waiting.attempts[0]!.id,result:{...stopped,usage}});
      const retained = await app.detail("agent-a");
      expect(retained.mission!.status).toBe("awaiting_user_decision");
      expect(retained.attempts[0]!.status).toBe("settled");
      expect(retained.attempts[0]!.result!.usage).toEqual(usage);
      const calls = f.invoke.mock.calls.length;
      let observed = app;
      let restoredObserver: ReturnType<typeof createAgentApplicationObserver> | undefined;
      try {
        if (restart) {
          await observer.stop();
          await app.shutdown();
          const store = new FileAgentStateStore(join(deps.config.paths.runtimeDir,"agents","state.json"));
          observed = trackAgentApplication(createAgentApplication({...deps,store}));
          await observed.recover();
          expect((await observed.detail("agent-a")).mission!.status).toBe("awaiting_user_decision");
          restoredObserver = createAgentApplicationObserver({application:observed});
          await restoredObserver.start();
        } else {
          await observer.tick();
        }
        const terminal = await observed.detail("agent-a");
        expect(terminal.mission).toMatchObject({status:"exhausted",usage:retained.mission!.usage});
        expect(terminal.recovery).toMatchObject({budgetStopReason:reason,budgetStopping:false});
        expect(terminal.messages.filter(message => message.role === "assistant")).toEqual([]);
        await (restoredObserver ?? observer).tick();
        expect((await observed.detail("agent-a")).mission).toEqual(terminal.mission);
        expect(f.invoke).toHaveBeenCalledTimes(calls);
        expect(f.run).toHaveBeenCalledOnce();
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(readAgentState(await f.store.read())).toEqual(await f.store.read());
      } finally {
        await restoredObserver?.stop();
      }
    } finally {
      await observer.stop();
    }
  });
}

test("a settled request with an unrelated waiting reason remains parked by the observer", {timeout:20_000}, async () => {
  vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
  const f = await agentApplicationFixture({result:running});
  await f.app.send("agent-a",{messageId:"task",text:"Read the supplied notes",intent:"task"});
  await f.app.whenIdle();
  const working = await f.app.detail("agent-a");
  await f.store.commitApplication({kind:"mark_agent_waiting",agentId:"agent-a",missionId:working.mission!.id,reason:"Review the uncertain result before continuing."});
  await f.store.commitApplication({kind:"observe_agent_work",agentId:"agent-a",attemptId:working.attempts[0]!.id,result:stopped});
  const before = await f.app.detail("agent-a"), calls = f.invoke.mock.calls.length;
  const refresh = vi.fn(f.app.refresh);
  const observer = createAgentApplicationObserver({application:{snapshot:f.app.snapshot,refresh}});
  try {
    await observer.start(); await observer.tick();
    expect(refresh).not.toHaveBeenCalled();
    expect((await f.app.detail("agent-a")).mission).toEqual(before.mission);
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).not.toHaveBeenCalled();
  } finally {
    await observer.stop();
  }
});
