import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentScheduleService } from "../agents/schedule-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import * as gateways from "../default-environment-adapters.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import { createLocalAgentEvents, createLocalAgentsClient } from "../local-host/client-agents.js";
import type { LocalRuntimeOwner } from "../local-host/contracts.js";
import { createAgentOrdinaryOwnerFixture } from "./support/agents-ordinary-owner-fixture.js";
import { agentApplicationFixture, applicationPlan, disposeAgentApplicationFixtures, returnedWorkDecision } from "./support/agents-application-fixture.js";
import { agentMissionLimits, startAgentMission } from "./support/agents-foundation-fixture.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await disposeAgentApplicationFixtures();
  vi.restoreAllMocks();
});
function client(owner: LocalRuntimeOwner, id: string) {
  const { peer } = makeOwnerControlPeer(id);
  return createLocalAgentsClient((method, args) => owner.call(method, args, peer));
}

test("two views share one task and the ordinary owner's durable approval across a view disconnect", async () => {
  const f = await createAgentOrdinaryOwnerFixture("execution-agent-v1", true);
  cleanups.push(f.dispose);
  const manager = vi.fn<ReturnType<typeof gateways.createDefaultModelGatewayClient>["invoke"]>(async input => {
    const returned = typeof input.format === "object" && input.format.name === "persistent_agent_work_result_v1";
    const text = input.format ? JSON.stringify({ decision: returned ? returnedWorkDecision() : applicationPlan("start_session") })
      : "Perform the fixture task.";
    return { text, meta: { usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } } };
  });
  vi.spyOn(gateways, "createDefaultModelGatewayClient").mockReturnValue({ invoke: manager, invokeRaw: vi.fn(async () => { throw new Error("Unexpected raw invocation"); }) });
  const web = client(f.owner, "web"), remote = client(f.owner, "bridge");
  const events = createLocalAgentEvents(), changed = vi.fn();
  const detach = f.owner.subscribe(events.receive);
  const unsubscribe = events.subscribe(changed);
  const [first, second] = await Promise.all([web.application.snapshot(), remote.application.snapshot()]);
  expect(second).toEqual(first);
  expect(first.agents.map(detail => detail.agent.id)).toEqual(["abot"]);
  const command = { type: "agents.message.send.request", targetAgentId: "abot", clientMessageId: "mobile-message",
    intent: "task", text: "Perform the fixture task.", limits: agentMissionLimits(), allowedModes: ["ask"] };
  await remote.remote(command);
  await web.application.send("abot", { text: command.text, intent: "task", messageId: command.clientMessageId, limits: command.limits });
  expect(changed).toHaveBeenCalled();
  detach(); unsubscribe();
  await vi.waitFor(async () => {
    expect((await web.application.detail("abot")).attempts).toMatchObject([{ status: "awaiting_approval" }]);
  }, { timeout: 12000, interval: 100 });
  expect(f.execute).not.toHaveBeenCalled();
  const [attempt] = (await web.application.detail("abot")).attempts;
  const [approval] = await web.approvals.list("abot");
  expect(approval?.wait).toBeDefined();
  const decision = { ...approval!.wait!, approvalId: approval!.request.approvalId, commandId: "approved-after-disconnect", approved: true };
  await web.approvals.decide("abot", decision);
  await vi.waitFor(async () => {
    expect((await remote.application.refresh("abot")).attempts).toMatchObject([{ status: "settled" }]);
  }, { timeout: 12000, interval: 100 });
  expect(f.execute).toHaveBeenCalledOnce();
  expect((await web.application.detail("abot")).sessions).toHaveLength(1);
  const reopened = client(f.owner, "reconnected-bridge");
  const retry = { type: "agents.approval.decide.request", targetAgentId: "abot", allowedModes: ["ask"], ...decision };
  expect(await reopened.remote(retry)).toMatchObject({ agent: { id: "abot" } });
  await expect(reopened.remote({ ...retry, approved: false })).rejects.toThrow("approval_conflict");
  await expect(reopened.approvals.decide("abot", { ...decision, revision: decision.revision + 1 }, ["ask"])).rejects.toThrow("approval_conflict");
  expect(f.execute).toHaveBeenCalledOnce();
  const stored = await f.sessions.getSessionById(attempt!.request.sessionId);
  expect(stored?.requests).toHaveLength(1);
}, 30000);

test("a Web authority change and remote command admission are serialized at the environment owner", async () => {
  const f = await agentApplicationFixture();
  vi.spyOn(gateways, "createDefaultModelGatewayClient").mockReturnValue(f.dependencies.models);
  const owner = await createLocalRuntimeOwner(f.dependencies.config);
  cleanups.push(async () => { await owner.stop(); await owner.whenIdle?.(); });
  const web = client(owner, "web"), remote = client(owner, "remote");
  const { revision } = await web.store.read();
  const { executionPolicy: _derivedPolicy, ...definition } = (await web.application.detail("agent-a")).agent.definition;
  const started = createSchedulerTestGate(), release = createSchedulerTestGate();
  const commit = FileAgentStateStore.prototype.commit;
  vi.spyOn(FileAgentStateStore.prototype, "commit").mockImplementation(async function(this: FileAgentStateStore, command, version) {
    if (command.kind === "update_definition") { started.open(); await release.waiting; }
    return commit.call(this, command, version);
  });
  const updating = web.management.update("agent-a", { ...definition, toolPermissionMode: "full_access" }, revision);
  await Promise.race([started.waiting, updating.then(() => { throw new Error("Expected update to wait at commit"); })]);
  const denied = expect(remote.remote({ type: "agents.message.send.request", targetAgentId: "agent-a", clientMessageId: "race",
    intent: "auto", text: "Hello", allowedModes: ["ask"] })).rejects.toThrow("agents_permission_denied");
  try { expect(await web.isBusy()).toBe(true); }
  finally { release.open(); }
  await Promise.all([updating, denied]);
  expect((await web.application.detail("agent-a")).messages).toEqual([]);
}, 15000);

test("headless startup reconciles a retained mission once and corrupt Agents state leaves ordinary services usable", async () => {
  const f = await agentApplicationFixture();
  const { config } = f.dependencies;
  vi.spyOn(gateways, "createDefaultModelGatewayClient").mockReturnValue(f.dependencies.models);
  await f.store.commitApplication(startAgentMission());
  const owner = await createLocalRuntimeOwner(config);
  try {
    await vi.waitFor(async () => expect((await f.store.read()).missions[0]!.status).toBe("awaiting_user_decision"), { timeout: 12000, interval: 100 });
    const a = client(owner, "a"), b = client(owner, "b");
    const before = (await f.store.read()).revision;
    await Promise.all([a.application.snapshot(), b.application.snapshot()]);
    expect((await f.store.read()).revision).toBe(before);
  } finally { await owner.stop(); await owner.whenIdle?.(); }
  const file = join(config.paths.runtimeDir, "agents", "state.json");
  await writeFile(file, "invalid state");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const damaged = await createLocalRuntimeOwner(config);
  try {
    const { peer } = makeOwnerControlPeer("ordinary");
    expect(await damaged.call("sessions.getAllSessions", [], peer)).toEqual([]);
    await expect(client(damaged, "view").application.snapshot()).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("invalid state");
  } finally { await damaged.stop(); await damaged.whenIdle?.(); }
}, 15000);

test("a retained schedule wakes the Agent once on a headless owner", async () => {
  const f = await agentApplicationFixture({ choose: () => applicationPlan("answer_user") });
  const { config, models } = f.dependencies;
  vi.spyOn(gateways, "createDefaultModelGatewayClient").mockReturnValue(models);
  const now = Date.now;
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
  const schedule = createAgentScheduleService({ filename: join(config.paths.runtimeDir, "agents", "schedules.json"),
    application: f.app });
  await schedule.create({ id: "offline", agentId: "agent-a", title: "Reminder", text: "Summarize the conversation.",
    startAt: new Date(now() + 60_000).toISOString(), intervalMs: null, maxOccurrences: 1, limits: agentMissionLimits() });
  const owner = await createLocalRuntimeOwner(config);
  try {
    await vi.waitFor(() => expect(owner.isIdle?.()).toBe(true));
    offset = 60_000;
    await vi.waitFor(async () => {
      expect((await schedule.list("agent-a"))[0]?.occurrences).toMatchObject([{ status: "accepted" }]);
    }, { timeout: 8000, interval: 100 });
    const messages = (await f.store.read()).messages.filter(message => message.id === "agent-schedule:offline:1");
    expect(messages).toHaveLength(1);
  } finally { await owner.stop(); await owner.whenIdle?.(); }
}, 15000);
