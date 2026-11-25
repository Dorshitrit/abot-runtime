import { afterEach, expect, test, vi } from "vitest";
import type { SessionRequestReplay } from "../../sessions/types.js";
import type { AgentWorkResult } from "../agents/application-contracts.js";
import { AGENT_WRAP_UP_GUIDANCE, createAgentWorkGuidance } from "../agents/work-guidance.js";
import { createOrdinaryAgentSessionPort } from "../agents/ordinary-session-port.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { agentReturnCallEstimate } from "../agents/work-budget-context.js";
import { agentApplicationFixture, completedAgentWork, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures);
const running: AgentWorkResult = { ...completedAgentWork, status: "running", output: null, usage: null };
async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1" = "execution-agent-v1") {
  const f = await agentApplicationFixture({ policy, result: running });
  await f.app.send("agent-a", { messageId: "work", text: "Compare the supplied notes", intent: "task" });
  await f.app.whenIdle();
  const detail = await f.app.detail("agent-a"), attempt = detail.attempts[0]!;
  const request = attempt.request, generation = "generation-a";
  const replay: SessionRequestReplay = { requestId: request.requestId, sessionId: request.sessionId, generation,
    finalState: null, events: [], lifecycle: { schemaVersion: 1, requestId: request.requestId, sessionId: request.sessionId,
      generation, revision: 1, status: "streaming", activation: { activationId: "active", ownerEpoch: "owner" }, decisionReceipts: [] } };
  const inbox = createRequestSteeringInbox({ requestId: request.requestId });
  const steer = vi.fn(async (_requestId: string, update: { steerId: string; text: string }) => inbox.append(update));
  const handle = vi.fn(async () => {});
  const port = createOrdinaryAgentSessionPort({ sessions: { getRequestReplayById: async () => replay,
    getSessionById: async () => null, getOrCreateSession: async () => { throw new Error("must not create work"); } }, requests: { handle, steer } });
  const usage = { value: { modelCalls: detail.mission!.limits.maxModelCalls - detail.mission!.usage.modelCalls - agentReturnCallEstimate(detail.agent), totalTokens: 10 } as AgentWorkResult["usage"] };
  const inspectUsage = vi.fn(async () => usage.value);
  const deps = { ...f.dependencies, work: { ...f.dependencies.work, inspectUsage, adviseWrapUp: port.adviseWrapUp! } };
  return { f, deps, detail, attempt, replay, inbox, steer, handle, usage, inspectUsage, guidance: createAgentWorkGuidance(deps) };
}

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) test(`${policy}: soft return guidance uses ordinary steering once without a new model call`, async () => {
  const t = await fixture(policy), before = t.f.invoke.mock.calls.length;
  await Promise.all([t.guidance.inspect("agent-a"), t.guidance.inspect("agent-a")]);
  await t.guidance.inspect("agent-a");
  expect(t.steer).toHaveBeenCalledExactlyOnceWith(t.attempt.request.requestId,
    { steerId: `agent-wrap-up:${t.attempt.id}`, text: AGENT_WRAP_UP_GUIDANCE });
  expect(t.f.invoke).toHaveBeenCalledTimes(before);
  expect(t.handle).not.toHaveBeenCalled(); expect(t.f.run).toHaveBeenCalledOnce(); expect(t.f.cancel).not.toHaveBeenCalled();
  expect((await t.f.store.read()).missions[0]!.usage).toEqual(t.detail.mission!.usage);
  expect((await t.f.store.read()).messages).toEqual(t.detail.messages);
});

test("reopening supervision retains the exact steering identity and the existing owner deduplicates it", async () => {
  const t = await fixture();
  await t.guidance.inspect("agent-a");
  await createAgentWorkGuidance(t.deps).inspect("agent-a");
  expect(t.steer).toHaveBeenCalledTimes(2);
  expect(t.steer.mock.calls[1]).toEqual(t.steer.mock.calls[0]);
  expect(t.inbox.snapshot().updates).toHaveLength(1);
});

test("a saved approval wait is deferred until the existing request resumes", async () => {
  const t = await fixture();
  t.replay.lifecycle = { ...t.replay.lifecycle!, status: "awaiting_approval" };
  await t.guidance.inspect("agent-a"); await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled();
  t.replay.lifecycle = { ...t.replay.lifecycle!, status: "streaming", revision: 3 };
  await t.guidance.inspect("agent-a");
  expect(t.steer).toHaveBeenCalledOnce();
});

test("an explicit inactive-owner rejection defers until resume, while unknown delivery is not retried", async () => {
  const t = await fixture();
  t.steer.mockResolvedValueOnce({ ok: false, reason: "request_not_active" });
  await t.guidance.inspect("agent-a");
  t.steer.mockRejectedValueOnce(new Error("reply lost after send"));
  await t.guidance.inspect("agent-a"); await t.guidance.inspect("agent-a");
  expect(t.steer).toHaveBeenCalledTimes(2);
  expect(t.steer.mock.calls[0]).toEqual(t.steer.mock.calls[1]);
});

test("token guidance uses a measured mean as an estimate before the hard token limit", async () => {
  const t = await fixture();
  t.usage.value = { modelCalls: 10, totalTokens: 17_000 };
  await t.guidance.inspect("agent-a");
  expect(t.steer).toHaveBeenCalledOnce();
});

test.each(["ample", "unknown", "zero_calls", "zero_tokens", "invalid"])("%s observation does not add steering or model work", async kind => {
  const t = await fixture();
  t.usage.value = kind === "unknown" ? null : kind === "zero_calls" ? { modelCalls: 24, totalTokens: 10 } :
    kind === "zero_tokens" ? { modelCalls: 1, totalTokens: 20_000 } : kind === "invalid" ? { modelCalls: -1, totalTokens: 100 } :
    { modelCalls: 1, totalTokens: 10 };
  const before = t.f.invoke.mock.calls.length;
  await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled(); expect(t.f.invoke).toHaveBeenCalledTimes(before);
});

test("a cancellation racing usage observation suppresses the stale instruction", async () => {
  const t = await fixture();
  t.inspectUsage.mockImplementationOnce(async () => { await t.f.app.cancel("agent-a"); return t.usage.value; });
  await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled();
  expect((await t.f.app.detail("agent-a")).mission!.status).toBe("cancelled");
});

test.each(["session", "request", "generation", "failed", "completed", "missing_lifecycle", "fork_event", "terminal_event"])("ordinary steering rejects %s target drift", async kind => {
  const t = await fixture();
  if (kind === "session") t.replay.sessionId = "foreign";
  if (kind === "request") t.replay.requestId = "foreign";
  if (kind === "generation") t.replay.generation = "different";
  if (kind === "failed") t.replay.lifecycle = { ...t.replay.lifecycle!, status: "failed" };
  if (kind === "completed") t.replay.finalState = { status: "completed", output: "Done", completedAt: 1 };
  if (kind === "missing_lifecycle") delete t.replay.lifecycle;
  if (kind === "fork_event") t.replay.events.push({ requestId: t.attempt.request.requestId, generation: "foreign" });
  if (kind === "terminal_event") t.replay.events.push({ requestId: t.attempt.request.requestId, type: "failed" });
  await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled(); expect(t.handle).not.toHaveBeenCalled();
});

test("normal application refresh invokes soft guidance before reaching hard limits", async () => {
  const t = await fixture();
  Object.assign(t.f.dependencies.work, { inspectUsage: t.inspectUsage, adviseWrapUp: t.deps.work.adviseWrapUp });
  await t.f.app.refresh("agent-a");
  expect(t.steer).toHaveBeenCalledOnce(); expect(t.f.cancel).not.toHaveBeenCalled();
});


test("a large management reservation does not replace an available live cost estimate", async () => {
  const t = await fixture();
  t.usage.value = { modelCalls: 1, totalTokens: 10 };
  await createAgentWorkGuidance({ ...t.deps, managementTokenReservation: 100_000 }).inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled();
});

test.each(["deleted", "archived", "settled", "unknown", "foreign_session"])("%s Agent ownership cannot steer existing work", async kind => {
  const t = await fixture();
  const state = structuredClone(await t.f.store.read());
  const changed = kind === "deleted" ? { ...state, deletingAgentIds: ["agent-a"] } : kind === "archived" ?
    { ...state, agents: state.agents.map(agent => ({ ...agent, status: "archived" as const })) } : kind === "foreign_session" ?
    { ...state, sessions: state.sessions.map(session => ({ ...session, agentId: "another-agent" })) } :
    { ...state, attempts: state.attempts.map(attempt => ({ ...attempt, status: kind as "settled" | "unknown" })) };
  vi.spyOn(t.f.store, "read").mockResolvedValueOnce(changed);
  await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled();
});

test("a changed mission revision during observation postpones guidance until a fresh inspection", async () => {
  const t = await fixture();
  t.inspectUsage.mockImplementationOnce(async () => {
    const state = await t.f.store.read();
    vi.spyOn(t.f.store, "read").mockResolvedValueOnce({ ...state, missions: state.missions.map(mission => ({ ...mission, revision: mission.revision + 1 })) });
    return t.usage.value;
  });
  await t.guidance.inspect("agent-a");
  expect(t.steer).not.toHaveBeenCalled();
  await t.guidance.inspect("agent-a");
  expect(t.steer).toHaveBeenCalledOnce();
});
