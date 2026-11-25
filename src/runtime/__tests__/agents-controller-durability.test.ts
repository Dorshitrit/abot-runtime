import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentControllerService } from "../agents/controller-service.js";
import { createAgentManagementService } from "../agents/management-service.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentModelConfiguration } from "../agents/model-binding.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentDefinition, startAgentMission } from "./support/agents-foundation-fixture.js";

const publicationFault = vi.hoisted(() => ({ phase: "" as "" | "before" | "after" }));
vi.mock("../agents/durable-state-file.js", async (original) => {
  const actual = await original<typeof import("../agents/durable-state-file.js")>();
  return {
    ...actual,
    async writeDurableAgentState(...args: Parameters<typeof actual.writeDurableAgentState>) {
      if (publicationFault.phase === "before") throw new Error("injected_controller_before_publication");
      await actual.writeDurableAgentState(...args);
      if (publicationFault.phase === "after")
        throw new actual.AgentStateCommitUnknownError(args[1].revision, new Error("injected_controller_after_publication"));
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  publicationFault.phase = "";
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const config: AgentModelConfiguration = {
  models: { profiles: { "fixture-super": { model: "fictional-super" } } },
};
const proposal = JSON.stringify({
  action: { kind: "ask_user", question: "Which of the supplied acceptance criteria should be revised?" },
  reason: "The objective needs an explicit user decision.", evidenceIds: [],
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-controller-durability-"));
  directories.push(directory);
  const filename = join(directory, "state.json");
  const store = new FileAgentStateStore(filename);
  await store.commit({ kind: "register_agent", agentId: "agent-a", definition: agentDefinition() }, 0);
  const initial = await store.commit(startAgentMission(), 1);
  const controller = createAgentControllerService(store, config);
  const management = createAgentManagementService(store, config);
  const reservation = {
    agentId: "agent-a", missionId: "mission-a", invocationId: "invoke-a",
    agentRevision: 1, missionRevision: 1, stage: "selection" as const, reservedTokens: 200,
  };
  return { filename, store, controller, management, initial, reservation };
}

async function settleDecisionInvocation(f: Awaited<ReturnType<typeof fixture>>) {
  const reserved = await f.controller.reserve(f.reservation, f.initial.revision);
  return f.controller.settle("agent-a", "invoke-a", { totalTokens: 11, cost: { kind: "unknown" } }, reserved.revision);
}

test("loads legacy schema without a rewrite, then publishes the current schema on an explicit command", async () => {
  const f = await fixture();
  const { invocations: _, decisions: __, messages: _m, attempts: _a, responsibility: _r, mailbox: _b, deletingAgentIds: _d, ...legacyFields } = f.initial;
  const legacyBytes = JSON.stringify({ ...legacyFields, schemaVersion: 1 });
  await writeFile(f.filename, legacyBytes);
  const loaded = await f.controller.read();
  expect(loaded).toMatchObject({ schemaVersion: 6, invocations: [], decisions: [] });
  expect(await readFile(f.filename, "utf8")).toBe(legacyBytes);
  await f.controller.reserve(f.reservation, loaded.revision);
  expect(JSON.parse(await readFile(f.filename, "utf8"))).toMatchObject({ schemaVersion: 6, invocations: [{ id: "invoke-a" }] });
});

test("loading a schema 4 mission preserves its usage and leaves its original bytes on disk", async () => {
  const f = await fixture();
  const settled = await settleDecisionInvocation(f);
  const {deletingAgentIds: _, ...legacy} = settled;
  const bytes = JSON.stringify({ ...legacy, schemaVersion: 4 });
  await writeFile(f.filename, bytes);
  expect(await f.store.read()).toEqual(settled);
  expect(await readFile(f.filename, "utf8")).toBe(bytes);
});

test("does not allow a schema1 label to silently discard controller records", async () => {
  const f = await fixture();
  const reserved = await f.controller.reserve(f.reservation, f.initial.revision);
  expect(() => readAgentState({ ...reserved, schemaVersion: 1 })).toThrow("agents_record_invalid");
});

test("failed reservation publication leaves the mission budget and registry unchanged", async () => {
  const f = await fixture();
  const bytes = await readFile(f.filename, "utf8");
  publicationFault.phase = "before";
  await expect(f.controller.reserve(f.reservation, f.initial.revision)).rejects.toThrow("injected_controller_before_publication");
  publicationFault.phase = "";
  expect(await readFile(f.filename, "utf8")).toBe(bytes);
  expect(await f.controller.read()).toEqual(f.initial);
});

test("decision and waiting state commit together and cannot be replayed after an unknown response", async () => {
  const f = await fixture();
  const settled = await settleDecisionInvocation(f);
  publicationFault.phase = "after";
  await expect(f.controller.decide("agent-a", "invoke-a", "decision-a", proposal, settled.revision))
    .rejects.toMatchObject({ code: "agents_commit_outcome_unknown" });
  await expect(f.controller.read()).rejects.toMatchObject({ code: "agents_state_reconciliation_required" });
  await expect(f.management.read()).rejects.toMatchObject({ code: "agents_state_reconciliation_required" });
  publicationFault.phase = "";
  const recovered = await f.controller.reconcile();
  expect(recovered.decisions).toHaveLength(1);
  expect(recovered.decisions[0]).toMatchObject({ outcome: "accepted", code: "awaiting_user_decision" });
  expect(recovered.missions[0]).toMatchObject({ status: "awaiting_user_decision", usage: { modelCalls: 1, totalTokens: 11, clarificationRounds: 1 } });
  const bytes = await readFile(f.filename, "utf8");
  const replay = await f.controller.decide("agent-a", "invoke-a", "decision-a", proposal, recovered.revision);
  expect(replay).toEqual(recovered);
  expect(await readFile(f.filename, "utf8")).toBe(bytes);
  expect(await new FileAgentStateStore(f.filename).read()).toEqual(recovered);
  await expect(f.store.commit(startAgentMission("agent-a", "mission-b"), recovered.revision))
    .rejects.toMatchObject({ code: "agents_agent_busy" });
});

test("pre-publication decision failure leaves no phantom trace or waiting transition", async () => {
  const f = await fixture();
  const settled = await settleDecisionInvocation(f);
  publicationFault.phase = "before";
  await expect(f.controller.decide("agent-a", "invoke-a", "decision-a", proposal, settled.revision))
    .rejects.toThrow("injected_controller_before_publication");
  publicationFault.phase = "";
  expect(await f.controller.read()).toEqual(settled);
});

test("malformed output is charged, rejected and recorded without retaining raw reasoning", async () => {
  const f = await fixture();
  const settled = await settleDecisionInvocation(f);
  const result = await f.controller.decide("agent-a", "invoke-a", "decision-a", "private malformed model narrative", settled.revision);
  expect(result.decisions[0]).toMatchObject({ outcome: "rejected", code: "malformed_proposal", proposal: null });
  expect(result.missions[0]).toMatchObject({ status: "active", usage: { modelCalls: 1, totalTokens: 11 } });
  expect(await readFile(f.filename, "utf8")).not.toContain("private malformed model narrative");
});

test("missing token usage survives reload and a late factual receipt settles once after cancellation", async () => {
  const f = await fixture();
  const reserved = await f.controller.reserve(f.reservation, f.initial.revision);
  const unknown = await f.controller.settle("agent-a", "invoke-a", null, reserved.revision);
  expect(unknown.invocations[0]).toMatchObject({ status: "usage_unknown", usage: null, reservedTokens: 200 });
  expect(await new FileAgentStateStore(f.filename).read()).toEqual(unknown);
  const cancelled = await f.store.commit({ kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "User cancelled." }, unknown.revision);
  const receipt = { totalTokens: 57, cost: { kind: "estimated" as const, amount: 0.001, currency: "USD", source: "fixture-price-table-v1" } };
  const settled = await f.controller.settle("agent-a", "invoke-a", receipt, cancelled.revision);
  expect(settled.missions[0]).toMatchObject({ status: "cancelled", revision: cancelled.missions[0].revision, usage: { modelCalls: 1, totalTokens: 57 } });
  expect(await f.controller.settle("agent-a", "invoke-a", receipt, settled.revision)).toEqual(settled);
});

test("load rejects a corrupt decision reference without rewriting the damaged file", async () => {
  const f = await fixture();
  const settled = await settleDecisionInvocation(f);
  const decided = await f.controller.decide("agent-a", "invoke-a", "decision-a", proposal, settled.revision);
  const corrupt = JSON.stringify({ ...decided, decisions: [{ ...decided.decisions[0], invocationId: "foreign-missing" }] });
  await writeFile(f.filename, corrupt);
  await expect(f.controller.read()).rejects.toMatchObject({ code: "agents_record_invalid" });
  expect(await readFile(f.filename, "utf8")).toBe(corrupt);
});
