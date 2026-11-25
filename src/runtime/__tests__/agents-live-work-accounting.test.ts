import { afterEach, expect, test, vi } from "vitest";
import { ordinarySessionUsage, ordinarySessionUsageLowerBound } from "../agents/ordinary-session-usage.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentApplicationObserver } from "../agents/application-observer.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures, trackAgentApplication } from "./support/agents-application-fixture.js";
import type { AgentWorkResult } from "../agents/application-contracts.js";

afterEach(disposeAgentApplicationFixtures, 20_000);
const snapshot = (id: string) => ({ requestId:"request", name:"context.window.snapshot", invocationId:id, admissionOutcome:"accepted" });
const usage = (id: string, totalTokens: number) => ({ requestId:"request", name:"context.window.provider_usage", invocationId:id, totalTokens, measurement:"actual", source:"provider_reported" });
const running: AgentWorkResult = { ...completedAgentWork, status:"running", output:null, usage:null, receiptId:"running-1" };
const cancelled: AgentWorkResult = { ...completedAgentWork, status:"cancelled", output:null, error:"request_cancelled", receiptId:"cancelled-1" };

test("live lower bounds retain confirmed spending while another call is unfinished, without claiming final accounting", () => {
  const events = [snapshot("done"), usage("done", 125), usage("done", 125), snapshot("pending")];
  expect(ordinarySessionUsageLowerBound("request", events)).toEqual({modelCalls:2,totalTokens:125});
  expect(ordinarySessionUsage("request", events)).toBeNull();
  expect(ordinarySessionUsageLowerBound("request", [snapshot("pending")])).toEqual({modelCalls:1,totalTokens:0});
  expect(ordinarySessionUsageLowerBound("request", [])).toBeNull();
});

test.each([
  [snapshot("a"), usage("foreign", 10)],
  [snapshot("a"), usage("a", 10), usage("a", 11)],
  [snapshot("a"), {...usage("a", 10), measurement:"estimated"}],
  [snapshot("a"), usage("a", -1)],
].map(events => ({events})))("conflicting or unbound measurements never become a trusted lower bound (%j)", ({events}) => {
  expect(ordinarySessionUsageLowerBound("request", events)).toBeNull();
});

test("an approval interval has the same lower bound and a late final receipt charges it only once", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  await f.app.send("agent-a",{messageId:"task",text:"Inspect supplied data",intent:"task"});
  await f.app.whenIdle();
  const before = (await f.app.detail("agent-a")).mission!.usage;
  f.cancel.mockResolvedValue(running);
  await f.app.cancel("agent-a");
  expect((await f.app.detail("agent-a")).attempts[0]!.status).toBe("running");
  f.inspect.mockResolvedValue(cancelled);
  await f.app.refresh("agent-a");
  const after = await f.app.detail("agent-a");
  expect(after.mission!.status).toBe("cancelled");
  expect(after.attempts[0]!.status).toBe("settled");
  expect(after.mission!.usage.totalTokens).toBe(before.totalTokens + cancelled.usage!.totalTokens);
  const revision = (await f.store.read()).revision;
  await f.app.refresh("agent-a");
  expect((await f.store.read()).revision).toBe(revision);
  expect(f.run).toHaveBeenCalledOnce();
});

test("restart reconciles cancelled work after its delayed terminal receipt without reopening or redispatching it", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  await f.app.send("agent-a",{messageId:"task",text:"Read notes",intent:"task"}); await f.app.whenIdle();
  f.cancel.mockResolvedValue(running); await f.app.cancel("agent-a");
  f.inspect.mockResolvedValue(cancelled);
  const count = f.invoke.mock.calls.length;
  const restored = trackAgentApplication(createAgentApplication(f.dependencies));
  await restored.recover();
  const detail = await restored.detail("agent-a");
  expect(detail.mission!.status).toBe("cancelled");
  expect(detail.attempts[0]!.status).toBe("settled");
  expect(f.run).toHaveBeenCalledOnce(); expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledTimes(count);
});

test("the observer reconciles an older cancelled attempt even after a newer conversation completed", {timeout:20_000}, async () => {
  const f = await agentApplicationFixture({result:running});
  await f.app.send("agent-a",{messageId:"work",text:"Read notes",intent:"task"}); await f.app.whenIdle();
  const old = (await f.app.detail("agent-a")).mission!;
  f.cancel.mockResolvedValue(running); await f.app.cancel("agent-a");
  await f.app.send("agent-a",{messageId:"chat",text:"Hello",intent:"message"}); await f.app.whenIdle();
  const latest = (await f.app.detail("agent-a")).mission!;
  f.inspect.mockResolvedValue(cancelled);
  const observer = createAgentApplicationObserver({application:f.app});
  await observer.start(); await observer.stop();
  const state = await f.store.read();
  expect(state.missions.find(m => m.id === old.id)!.status).toBe("cancelled");
  expect((await f.app.detail("agent-a")).mission).toEqual(latest);
  expect(state.attempts[0]!.status).toBe("settled"); expect(f.run).toHaveBeenCalledOnce();
});

test("a missing request replay while dispatch is admitted does not pause or replay the live mission", {timeout:20_000}, async () => {
  let release!: (value:AgentWorkResult) => void;
  const f = await agentApplicationFixture({run:() => new Promise(resolve => { release = resolve; })});
  f.inspect.mockResolvedValue({...running,status:"unknown",receiptId:null});
  await f.app.send("agent-a",{messageId:"work",text:"Read notes",intent:"task"});
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce(), {timeout:5000});
  await f.app.refresh("agent-a");
  expect((await f.app.detail("agent-a")).mission!.status).toBe("active");
  expect(f.run).toHaveBeenCalledOnce();
  release(completedAgentWork); await f.app.whenIdle();
});
