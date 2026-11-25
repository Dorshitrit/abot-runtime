import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createEmptyAgentState, type AgentMissionLimits, type AgentState } from "../agents/agent-records.js";
import type { AgentControllerCommand } from "../agents/controller-commands.js";
import type { AgentDecisionConfiguration } from "../agents/decision-records.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentInvocationUsage } from "../agents/invocation-records.js";
import { reduceAgentCommand } from "../agents/state-reducer.js";
import { readAgentState } from "../agents/state-validation.js";
import type { AgentStateCommand } from "../agents/state-commands.js";
import { AGENT_FOUNDATION_TIME, agentDefinition, startAgentMission } from "./support/agents-foundation-fixture.js";

type Reserve = Extract<AgentControllerCommand, { kind: "reserve_invocation" }>;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const apply = (state: AgentState, command: AgentStateCommand) => reduceAgentCommand(state, command, AGENT_FOUNDATION_TIME);
function initial(policy: "supervisor-worker-v1" | "execution-agent-v1" = "supervisor-worker-v1", limits: Partial<AgentMissionLimits> = {}) {
  const registered = apply(createEmptyAgentState(), {
    kind: "register_agent", agentId: "agent-a", definition: { ...agentDefinition(), executionPolicy: policy },
  });
  const mission = startAgentMission();
  return apply(registered, { ...mission, limits: { ...mission.limits, ...limits } });
}
function reservation(state: AgentState, overrides: Partial<Reserve> = {}): Reserve {
  const agent = state.agents[0], mission = state.missions[0];
  const configuration: AgentDecisionConfiguration = {
    schemaVersion: 1, fingerprint: `sha256:${"a".repeat(64)}`, modelProfileId: agent.definition.modelProfileId,
    baseProfileId: agent.definition.modelProfileId, toolPermissionMode: agent.definition.toolPermissionMode,
    policy: { id: agent.definition.executionPolicy, source: "model_profile", version: 1, definitionHash: `sha256:${"b".repeat(64)}` },
  };
  return {
    kind: "reserve_invocation", agentId: agent.id, missionId: mission.id, invocationId: "call-a",
    agentRevision: agent.revision, missionRevision: mission.revision, configuration,
    stage: agent.definition.executionPolicy === "execution-agent-v1" ? "assessment_and_selection" : "selection",
    reservedTokens: 20, ...overrides,
  };
}
function settle(state: AgentState, usage: AgentInvocationUsage | null, invocationId = "call-a") {
  return apply(state, { kind: "settle_invocation", agentId: "agent-a", invocationId, usage });
}
const measured = (totalTokens: number): AgentInvocationUsage => ({ totalTokens, cost: { kind: "unknown" } });

test("reservation and settlement survive reload without duplicate charges or intent revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abot-invocation-ledger-"));
  directories.push(directory);
  const filename = join(directory, "state.json");
  const store = new FileAgentStateStore(filename, () => AGENT_FOUNDATION_TIME);
  const registered = await store.commit({ kind: "register_agent", agentId: "agent-a", definition: agentDefinition() }, 0);
  const before = await store.commit(startAgentMission(), registered.revision);
  const command = reservation(before);
  const reserved = await store.commit(command, before.revision);
  expect(reserved.missions[0]).toMatchObject({ revision: before.missions[0].revision, usage: { modelCalls: 1, totalTokens: 0 } });
  expect(reserved.invocations[0]).toMatchObject({ status: "reserved", reservedTokens: 20, usage: null, configuration: command.configuration });
  const bytes = await readFile(filename, "utf8");
  expect(await store.commit(command, reserved.revision)).toEqual(reserved);
  expect(await readFile(filename, "utf8")).toBe(bytes);
  const usage: AgentInvocationUsage = { totalTokens: 12, cost: { kind: "actual", amount: 0.001, currency: "USD", source: "provider-receipt-a" } };
  const settlement = { kind: "settle_invocation", agentId: "agent-a", invocationId: "call-a", usage } as const;
  const settled = await store.commit(settlement, reserved.revision);
  const reopened = new FileAgentStateStore(filename);
  expect(await reopened.read()).toEqual(settled);
  expect(settled.missions[0]).toMatchObject({ revision: before.missions[0].revision, usage: { modelCalls: 1, totalTokens: 12 } });
  expect(await reopened.commit(settlement, settled.revision)).toEqual(settled);
  expect(await reopened.commit(command, settled.revision)).toEqual(settled);
  await expect(reopened.commit({ ...command, reservedTokens: 21 }, settled.revision))
    .rejects.toMatchObject({ code: "agents_invocation_identity_conflict" });
  await expect(reopened.commit({ ...settlement, usage: measured(13) }, settled.revision))
    .rejects.toMatchObject({ code: "agents_invocation_settlement_conflict" });
});

test.each(["reserved", "usage_unknown"] as const)("terminal deletion after a restart releases private %s accounting and fences late writes", async (status) => {
  const directory = await mkdtemp(join(tmpdir(), "abot-deleted-invocation-"));
  directories.push(directory);
  const filename = join(directory, "state.json");
  const store = new FileAgentStateStore(filename);
  await store.commitApplication({kind:"register_agent", agentId:"agent-a", definition:agentDefinition()});
  const started = await store.commitApplication(startAgentMission());
  await store.commitApplication(reservation(started));
  const settlement = {kind:"settle_invocation", agentId:"agent-a", invocationId:"call-a", usage:measured(5)} as const;
  if (status === "usage_unknown") await store.commitApplication({...settlement, usage:null});
  const closed = await store.commitApplication({kind:"cancel_mission", agentId:"agent-a", missionId:"mission-a", reason:"Cancelled."});
  expect(closed.invocations[0]?.status).toBe(status);
  const reopened = new FileAgentStateStore(filename);
  await reopened.beginDeletion("agent-a", closed.revision);
  await expect(store.commitApplication(settlement)).rejects.toThrow("agents_deletion_pending");
  const deleted = await reopened.finishDeletion("agent-a");
  await expect(store.commitApplication(settlement)).rejects.toThrow("agents_agent_not_found");
  expect(deleted.invocations).toEqual([]);
  expect(await store.read()).toEqual(deleted);
});

test("unknown usage retains the allowance until a factual settlement and does not become zero", () => {
  const before = initial("supervisor-worker-v1", { maxTotalTokens: 30 });
  const reserved = apply(before, reservation(before));
  expect(() => apply(reserved, reservation(reserved, { invocationId: "call-b" }))).toThrow("agents_invocation_pending");
  const unknown = settle(reserved, null);
  expect(unknown.invocations[0]).toMatchObject({ status: "usage_unknown", usage: null, reservedTokens: 20 });
  expect(settle(unknown, null)).toEqual(unknown);
  expect(readAgentState(JSON.parse(JSON.stringify(unknown)))).toEqual(unknown);
  expect(() => apply(unknown, reservation(unknown, { invocationId: "call-b" }))).toThrow("agents_invocation_usage_unknown");
  const settled = settle(unknown, measured(25));
  expect(() => apply(settled, reservation(settled, { invocationId: "call-b", reservedTokens: 6 }))).toThrow("agents_token_limit_reached");
  const next = apply(settled, reservation(settled, { invocationId: "call-b", reservedTokens: 5 }));
  expect(next.missions[0].usage).toMatchObject({ modelCalls: 2, totalTokens: 25 });
});

test("actual overruns are retained fully and prevent further admission", () => {
  const before = initial("supervisor-worker-v1", { maxTotalTokens: 20 });
  const reserved = apply(before, reservation(before, { reservedTokens: 5 }));
  const settled = settle(reserved, measured(35));
  expect(settled.missions[0].usage.totalTokens).toBe(35);
  expect(readAgentState(settled)).toEqual(settled);
  expect(() => apply(settled, reservation(settled, { invocationId: "call-b", reservedTokens: 1 }))).toThrow("agents_token_limit_reached");
});

test("late factual usage survives cancellation and model changes without restarting old intent", () => {
  const before = initial();
  const reserved = apply(before, reservation(before));
  const cancelled = apply(reserved, { kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "Cancelled explicitly." });
  const changed = apply(cancelled, {
    kind: "update_definition", agentId: "agent-a", definition: { ...agentDefinition(), modelProfileId: "different-model" },
  });
  const unknown = settle(changed, null);
  const settled = settle(unknown, measured(23));
  expect(settled.missions[0]).toMatchObject({ status: "cancelled", revision: cancelled.missions[0].revision, usage: { modelCalls: 1, totalTokens: 23 } });
  expect(settled.invocations[0].configuration.modelProfileId).toBe("fixture-super");
  expect(settled.agents[0]).toEqual(changed.agents[0]);
  expect(readAgentState(settled)).toEqual(settled);
});

test("a new explicit mission keeps old unknown usage in its original accounting scope", () => {
  const state = initial();
  const unknown = settle(apply(state, reservation(state)), null);
  const cancelled = apply(unknown, { kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "User ends this mission." });
  const next = apply(cancelled, startAgentMission("agent-a", "mission-next"));
  const accepted = apply(next, reservation(next, { invocationId: "call-next", missionId: "mission-next", missionRevision: 1 }));
  expect(accepted.invocations.map(({ missionId, status }) => ({ missionId, status }))).toEqual([
    { missionId: "mission-a", status: "usage_unknown" }, { missionId: "mission-next", status: "reserved" },
  ]);
  expect(accepted.missions[0]).toEqual(cancelled.missions[0]);
  expect(accepted.missions[1].usage.modelCalls).toBe(1);
  expect(readAgentState(accepted)).toEqual(accepted);
});

test.each([
  ["supervisor-worker-v1", "assessment"], ["supervisor-worker-v1", "selection"], ["supervisor-worker-v1", "authoring"], ["supervisor-worker-v1", "repair"],
  ["execution-agent-v1", "assessment_and_selection"], ["execution-agent-v1", "authoring"], ["execution-agent-v1", "repair"],
] as const)("permits the %s stage %s", (policy, stage) => {
  const state = initial(policy);
  expect(apply(state, reservation(state, { stage })).invocations[0].stage).toBe(stage);
});

test.each([
  ["supervisor-worker-v1", "assessment_and_selection"], ["execution-agent-v1", "assessment"], ["execution-agent-v1", "selection"],
] as const)("rejects incompatible %s stage %s", (policy, stage) => {
  const state = initial(policy);
  expect(() => apply(state, reservation(state, { stage }))).toThrow("agents_invocation_stage_invalid");
});

test("requires current owned intent and exact configured authority", () => {
  const state = initial();
  const command = reservation(state);
  const cases: Array<[Partial<Reserve>, string]> = [
    [{ agentRevision: 2 }, "agents_agent_revision_conflict"], [{ missionRevision: 2 }, "agents_mission_revision_conflict"],
    [{ configuration: { ...command.configuration, modelProfileId: "foreign-profile" } }, "agents_invocation_configuration_mismatch"],
    [{ configuration: { ...command.configuration, toolPermissionMode: "full_plus" } }, "agents_invocation_configuration_mismatch"],
  ];
  for (const [override, code] of cases) expect(() => apply(state, { ...command, ...override })).toThrow(code);
  const two = apply(state, { kind: "register_agent", agentId: "agent-b", definition: agentDefinition("Other") });
  expect(() => apply(two, { ...command, agentId: "agent-b" })).toThrow("agents_mission_owner_mismatch");
  const reserved = apply(state, command);
  expect(() => apply(reserved, { kind: "settle_invocation", agentId: "agent-b", invocationId: "call-a", usage: measured(1) }))
    .toThrow("agents_invocation_owner_mismatch");
  const waiting = apply(state, { kind: "wait_for_user", agentId: "agent-a", missionId: "mission-a", reason: "Needs input" });
  expect(() => apply(waiting, reservation(waiting))).toThrow("agents_mission_not_active");
});

test("enforces explicit budgets, positive reservations and the no-progress ceiling", () => {
  for (const [limits, code] of [
    [{ maxModelCalls: 0 }, "agents_model_call_limit_reached"], [{ maxTotalTokens: 0 }, "agents_token_limit_reached"],
  ] as const) {
    const state = initial("supervisor-worker-v1", limits);
    expect(() => apply(state, reservation(state))).toThrow(code);
  }
  const state = initial("supervisor-worker-v1", { maxModelCalls: 1 });
  expect(() => apply(state, reservation(state, { reservedTokens: 0 }))).toThrow("agents_record_invalid");
  const settled = settle(apply(state, reservation(state)), measured(0));
  expect(() => apply(settled, reservation(settled, { invocationId: "call-b" }))).toThrow("agents_model_call_limit_reached");
  const noProgress = { ...state, missions: state.missions.map((mission) => ({ ...mission,
    usage: { ...mission.usage, consecutiveNoProgress: mission.limits.maxConsecutiveNoProgress } })) };
  expect(() => apply(noProgress, reservation(noProgress))).toThrow("agents_no_progress_limit_reached");
});

test("load rejects corrupt ownership, future revisions, duplicate IDs and understated counters", () => {
  const state = initial();
  const reserved = apply(state, reservation(state));
  const record = reserved.invocations[0];
  const invalid = [
    { ...reserved, invocations: [record, record] },
    { ...reserved, invocations: [record, { ...record, id: "another-pending" }] },
    { ...reserved, invocations: [{ ...record, missionId: "missing" }] },
    { ...reserved, invocations: [{ ...record, agentRevision: 2 }] },
    { ...reserved, invocations: [{ ...record, missionRevision: 2 }] },
    { ...reserved, invocations: [{ ...record, status: "settled" }] },
    { ...reserved, invocations: [{ ...record, usage: measured(1) }] },
    { ...reserved, missions: reserved.missions.map((mission) => ({ ...mission, usage: { ...mission.usage, modelCalls: 0 } })) },
  ];
  for (const value of invalid) expect(() => readAgentState(value)).toThrow("agents_record_invalid");
  const settled = settle(reserved, measured(3));
  const undercharged = { ...settled, missions: settled.missions.map((mission) => ({ ...mission, usage: { ...mission.usage, totalTokens: 2 } })) };
  expect(() => readAgentState(undercharged)).toThrow("agents_record_invalid");
});

test("refuses imprecise token sums and invalid monetary receipts", () => {
  const state = initial("supervisor-worker-v1", { maxTotalTokens: Number.MAX_SAFE_INTEGER });
  const reserved = apply(state, reservation(state, { reservedTokens: 1 }));
  const nearLimit = { ...reserved, missions: reserved.missions.map((mission) => ({ ...mission,
    usage: { ...mission.usage, totalTokens: Number.MAX_SAFE_INTEGER - 1 } })) };
  expect(() => settle(nearLimit, measured(2))).toThrow("agents_invocation_usage_overflow");
  expect(() => settle(reserved, { totalTokens: 1, cost: { kind: "estimated", amount: Infinity, currency: "USD", source: "invalid" } }))
    .toThrow("agents_record_invalid");
});
