import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import * as durable from "../agents/durable-state-file.js";
import * as preparedFile from "../../sessions/prepared-session-replacement.js";
import { agentsScheduleFixture } from "./support/agents-schedule-fixture.js";
const fixtures: Awaited<ReturnType<typeof agentsScheduleFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
async function fixture(intervalMs: number | null = null, maxOccurrences = 1) { const f = await agentsScheduleFixture(intervalMs, maxOccurrences); fixtures.push(f); return f; }

test("one-time wakeup saves exact dispatch intent before a normal revision-bound Agent message", async () => {
  const f = await fixture(); await f.service.create(f.input);
  const send = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(async (agentId, input) => {
    const saved = JSON.parse(await readFile(f.filename, "utf8"));
    expect(saved.schedules[0].occurrences[0]).toMatchObject({ status: "claimed", messageId: input.messageId, missionId: null });
    return send(agentId, input);
  });
  f.advance(1000); await f.service.tick();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("agent-a", { messageId: "agent-schedule:schedule-a:1", text: f.input.text, intent: "task", limits: f.input.limits, expectedAgentRevision: 1 });
  expect((await f.service.list())[0]).toMatchObject({ status: "completed", nextRunAt: null,
    occurrences: [{ status: "accepted", missionId: "mission-1" }] });
  await f.service.tick(); expect(f.send).toHaveBeenCalledOnce();
});

test("explicit interval and finite occurrence allowance each produce a fresh bounded message", async () => {
  const f = await fixture(60_000, 3); await f.service.create(f.input);
  f.advance(1000); await f.service.tick();
  f.advance(60_000); await f.service.tick();
  f.advance(60_000); await f.service.tick();
  f.advance(60_000); await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(3);
  expect(f.send.mock.calls.map(([, input]) => input.messageId)).toEqual([1, 2, 3].map((ordinal) => `agent-schedule:schedule-a:${ordinal}`));
  expect(f.send.mock.calls.every(([, input]) => input.limits?.maxTotalTokens === f.input.limits.maxTotalTokens)).toBe(true);
  expect((await f.service.list())[0]?.status).toBe("completed");
});

test("concurrent service instances cannot claim one occurrence twice", async () => {
  const f = await fixture(); await f.service.create(f.input); const second = f.another();
  f.advance(1000); await Promise.all([f.service.tick(), second.tick(), f.service.tick()]);
  expect(f.send).toHaveBeenCalledOnce(); expect((await second.list())[0]?.occurrences).toHaveLength(1);
});

test("restart skips elapsed occurrences instead of backfilling work", async () => {
  const f = await fixture(60_000, 3); await f.service.create(f.input);
  f.advance(61_001); const restarted = f.another(); await restarted.start();
  expect(f.send).not.toHaveBeenCalled();
  const [record] = await restarted.list(); expect(record?.occurrences.map((entry) => entry.status)).toEqual(["skipped", "skipped"]);
  expect(record?.occurrences.every((entry) => entry.reason.includes("offline"))).toBe(true);
  f.advance(59_999); await restarted.tick(); expect(f.send).toHaveBeenCalledOnce();
});

test("online lateness over thirty seconds is visible and consumes its allowance", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(31_001); await f.service.tick();
  expect(f.send).not.toHaveBeenCalled(); expect((await f.service.list())[0]).toMatchObject({ status: "completed",
    occurrences: [{ status: "skipped", reason: expect.stringContaining("30-second") }] });
});

test.each(["busy", "archived"])("an Agent that is %s does not receive a second task", async (condition) => {
  const f = await fixture(); await f.service.create(f.input);
  const detail = f.detail();
  if (condition === "archived") f.setDetail({ ...detail, agent: { ...detail.agent, status: "archived" } });
  else f.setDetail({ ...detail, mission: { id: "existing", agentId: "agent-a", revision: 1, objective: "Other task", successCriteria: [],
    status: "active", waitingReason: null, limits: f.input.limits, usage: { attempts: 0, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: f.input.startAt, updatedAt: f.input.startAt } });
  f.advance(1000); await f.service.tick(); expect(f.send).not.toHaveBeenCalled();
  expect((await f.service.list())[0]?.occurrences[0]?.status).toBe("skipped");
});

test("changed model or permissions require explicit schedule update before dispatch", async () => {
  const f = await fixture(); const created = await f.service.create(f.input);
  f.setDetail({ ...f.detail(), agent: { ...f.detail().agent, revision: 2, definition: { ...f.detail().agent.definition, toolPermissionMode: "full_plus" } } });
  f.advance(1000); await f.service.tick(); expect(f.send).not.toHaveBeenCalled();
  const [paused] = await f.service.list(); expect(paused?.status).toBe("awaiting_user_decision");
  await expect(f.service.update(created.id, created.revision, { ...f.input, startAt: new Date(f.now() + 1000).toISOString() })).rejects.toThrow("agents_schedule_revision_conflict");
  await f.service.update(created.id, paused!.revision, { ...f.input, startAt: new Date(f.now() + 1000).toISOString() });
  f.advance(1000); await f.service.tick(); expect(f.send.mock.calls[0]?.[1]).toMatchObject({ expectedAgentRevision: 2 });
});

test("cancel prevents future occurrences while retaining accepted receipts", async () => {
  const f = await fixture(60_000, 3); await f.service.create(f.input); f.advance(1000); await f.service.tick();
  const [record] = await f.service.list(); await f.service.cancel(record!.id, record!.revision);
  f.advance(60_000); await f.service.tick(); expect(f.send).toHaveBeenCalledOnce();
  expect((await f.service.list())[0]).toMatchObject({ status: "cancelled", nextRunAt: null, occurrences: [{ status: "accepted" }] });
});

test("restart reconciles an accepted durable message and never resends its claim", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(1000); await f.claim();
  f.setDetail({ ...f.detail(), messages: [{ id: "agent-schedule:schedule-a:1", agentId: "agent-a", missionId: "accepted-mission", role: "user", source: null, text: f.input.text, createdAt: f.input.startAt }] });
  const restarted = f.another(); await restarted.start(); expect(f.send).not.toHaveBeenCalled();
  expect((await restarted.list())[0]).toMatchObject({ status: "completed", occurrences: [{ status: "accepted", missionId: "accepted-mission" }] });
});

test("an uncertain crash claim belongs to the user, blocks edits, and is never retried", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(1000); await f.claim();
  const restarted = f.another(); await restarted.start(); await restarted.tick();
  const [record] = await restarted.list(); expect(record).toMatchObject({ status: "awaiting_user_decision", occurrences: [{ status: "unknown" }] });
  await expect(restarted.update(record!.id, record!.revision, { ...f.input, startAt: new Date(f.now() + 1000).toISOString() })).rejects.toThrow("agents_schedule_requires_cancel_and_replace");
  await restarted.cancel(record!.id, record!.revision); expect(f.send).not.toHaveBeenCalled();
});

test("delivery error after acceptance recovers the message receipt without another send", async () => {
  const f = await fixture(); await f.service.create(f.input); const send = f.send.getMockImplementation()!;
  f.send.mockImplementationOnce(async (agent, input) => { await send(agent, input); throw new Error("connection lost"); });
  f.advance(1000); await f.service.tick(); expect(f.send).toHaveBeenCalledOnce();
  expect((await f.service.list())[0]?.occurrences[0]?.status).toBe("accepted");
});

test("malformed persisted schedule data fails closed without dispatch", async () => {
  const f = await fixture(); await f.service.create(f.input);
  const state = JSON.parse(await readFile(f.filename, "utf8")); state.schedules[0].maxOccurrences = Infinity;
  await writeFile(f.filename, JSON.stringify(state)); await expect(f.service.tick()).rejects.toThrow("agents_schedule_invalid"); expect(f.send).not.toHaveBeenCalled();
});

test.each([{ maxOccurrences: 0 }, { maxOccurrences: 1001 }, { intervalMs: 1 }, { maxOccurrences: 2 }, { limits: { maxAttempts: -1 } }])("rejects unbounded or invalid creation %j", async (change) => {
  const f = await fixture(); await expect(f.service.create({ ...f.input, ...change } as typeof f.input)).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
});

test("cancel returning before the admission recheck prevents a later Agent call", async () => {
  const f = await fixture(); await f.service.create(f.input);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.get.mockImplementation(async () => { if (f.get.mock.calls.length === 3) { entered(); await blocked; } return structuredClone(f.detail()); });
  f.advance(1000); const running = f.service.tick(); await reached;
  const [claimed] = await f.service.list(); await f.service.cancel(claimed!.id, claimed!.revision);
  release(); await running;
  expect(f.send).not.toHaveBeenCalled(); expect((await f.service.list())[0]).toMatchObject({ status: "cancelled", occurrences: [{ status: "skipped" }] });
});

test("a stopped service cannot submit an occurrence already selected for dispatch", async () => {
  const f = await fixture(); await f.service.create(f.input);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.get.mockImplementation(async () => { if (f.get.mock.calls.length === 3) { entered(); await blocked; } return structuredClone(f.detail()); });
  f.advance(1000); const running = f.service.tick(); await reached;
  const stopping = f.service.stop(); release(); await Promise.all([stopping, running]);
  expect(f.send).not.toHaveBeenCalled(); expect((await f.service.list())[0]?.occurrences[0]?.status).toBe("skipped");
});

test("an explicit edit preserves earlier occurrence bindings and renews only future authority", async () => {
  const f = await fixture(60_000, 3); await f.service.create(f.input); f.advance(1000); await f.service.tick();
  f.setDetail({ ...f.detail(), agent: { ...f.detail().agent, revision: 2, definition: { ...f.detail().agent.definition, modelProfileId: "changed-model" } } });
  const [record] = await f.service.list();
  await f.service.update(record!.id, record!.revision, { ...f.input, title: "Updated", startAt: new Date(f.now() + 1000).toISOString() });
  f.advance(1000); await f.service.tick();
  const [updated] = await f.service.list();
  expect(updated?.occurrences.map((entry) => entry.binding.agentRevision)).toEqual([1, 2]);
  expect(updated?.occurrences.map((entry) => entry.messageId)).toEqual(["agent-schedule:schedule-a:1", "agent-schedule:schedule-a:2"]);
});

test("a conflicting accepted mission does not become a successful schedule receipt", async () => {
  const f = await fixture(); await f.service.create(f.input);
  f.send.mockImplementationOnce(async (agentId, input) => ({ ...f.detail(), messages: [{ id: input.messageId, agentId, text: input.text,
    role: "user", source: null, missionId: "conflict", createdAt: f.input.startAt }], mission: { id: "conflict", agentId, revision: 1,
    objective: "Different task", status: "active", successCriteria: [], waitingReason: null, limits: input.limits!,
    usage: { attempts: 0, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: f.input.startAt, updatedAt: f.input.startAt } }));
  f.advance(1000); await f.service.tick();
  expect((await f.service.list())[0]).toMatchObject({ status: "awaiting_user_decision", occurrences: [{ status: "unknown" }] });
  expect(f.send).toHaveBeenCalledOnce();
});

test("a repeated create preserves its original identity even after its deadline", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(1000); await f.service.tick();
  const [completed] = await f.service.list(); expect(await f.service.create(f.input)).toEqual(completed);
  await expect(f.service.create({ ...f.input, text: "Changed purpose" })).rejects.toThrow("agents_schedule_identity_conflict");
  expect(f.send).toHaveBeenCalledOnce();
});


test("a claim whose directory durability is unknown is never dispatched or blindly retried", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(1000);
  const sync = durable.syncAgentStateDirectoryPath;
  let count = 0;
  const fault = vi.spyOn(durable, "syncAgentStateDirectoryPath").mockImplementation(async (directory) => {
    if (++count === 3) throw new Error("simulated directory sync failure");
    return sync(directory);
  });
  await expect(f.service.tick()).rejects.toThrow("agents_schedule_commit_unknown");
  expect(f.send).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.filename, "utf8")).schedules[0].occurrences[0].status).toBe("claimed");
  fault.mockRestore(); const restarted = f.another(); await restarted.start(); await restarted.tick();
  expect((await restarted.list())[0]?.status).toBe("awaiting_user_decision"); expect(f.send).not.toHaveBeenCalled();
});

test("failed intent publication prevents dispatch and leaves the original schedule intact", async () => {
  const f = await fixture(); await f.service.create(f.input); f.advance(1000);
  vi.spyOn(preparedFile, "replacePreparedSessionFile").mockRejectedValueOnce(new Error("simulated replacement failure"));
  await expect(f.service.tick()).rejects.toThrow("agents_schedule_write_failed");
  expect(f.send).not.toHaveBeenCalled(); expect((await f.service.list())[0]?.occurrences).toEqual([]);
});
