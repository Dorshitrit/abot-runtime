import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentDefinition, AgentMissionLimits } from "../agents/agent-records.js";
import { createAgentControllerService } from "../agents/controller-service.js";
import { captureAgentDecisionConfiguration } from "../agents/decision-configuration.js";
import type { AgentDecisionAction } from "../agents/decision-records.js";
import { readAgentDecisionProposal } from "../agents/decision-validation.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentInvocationStage } from "../agents/invocation-records.js";
import type { AgentModelConfiguration } from "../agents/model-binding.js";
import { reduceAgentCommand } from "../agents/state-reducer.js";
import { readAgentState } from "../agents/state-validation.js";
import { AGENT_FOUNDATION_TIME, agentDefinition, agentMissionLimits, commitAgentCommand, startAgentMission } from "./support/agents-foundation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const question = { kind: "ask_user", question: "Which fictional monitor size should I prioritize?" } as const;
const proposal = (action: AgentDecisionAction = question) => JSON.stringify({ action, reason: "The requested size is unspecified.", evidenceIds: [] });
function modelConfig(): AgentModelConfiguration {
  return {
    models: { profiles: { "fixture-super": { model: "fictional-super" }, "fixture-ea": { model: "fictional-ea" } },
      invocationProfiles: { precise: { profileId: "fixture-super", generation: { temperature: 0.2 } } } },
    modelExecutionPolicies: { "fixture-ea": { policy: "execution-agent-v1" } },
  };
}
async function fixture(options: { ea?: boolean; alias?: boolean; limits?: Partial<AgentMissionLimits> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "abot-agent-decisions-"));
  directories.push(directory);
  const filename = join(directory, "agents", "state.json");
  const store = new FileAgentStateStore(filename, () => AGENT_FOUNDATION_TIME);
  const config = modelConfig();
  const definition: AgentDefinition = { ...agentDefinition(),
    modelProfileId: options.ea ? "fixture-ea" : options.alias ? "precise" : "fixture-super",
    executionPolicy: options.ea ? "execution-agent-v1" : "supervisor-worker-v1" };
  await commitAgentCommand(store, { kind: "register_agent", agentId: "agent-a", definition });
  await commitAgentCommand(store, { ...startAgentMission(), limits: { ...agentMissionLimits(), ...options.limits } });
  const controller = createAgentControllerService(store, config);
  async function reserve(id = "invocation-a", stage: AgentInvocationStage = options.ea ? "assessment_and_selection" : "selection") {
    const state = await store.read();
    return controller.reserve({ agentId: "agent-a", missionId: "mission-a", invocationId: id,
      agentRevision: state.agents[0].revision, missionRevision: state.missions[0].revision, stage, reservedTokens: 100 }, state.revision);
  }
  async function settle(tokens: number | null = 40, id = "invocation-a") {
    return controller.settle("agent-a", id, tokens === null ? null : { totalTokens: tokens, cost: { kind: "unknown" } }, (await store.read()).revision);
  }
  async function decide(json = proposal(), id = "decision-a", invocationId = "invocation-a") {
    return controller.decide("agent-a", invocationId, id, json, (await store.read()).revision);
  }
  return { filename, store, config, definition, controller, reserve, settle, decide };
}

test.each([false, true])("accepts an explicit clarification atomically under EA=%s and retains usage across reload", async (ea) => {
  const f = await fixture({ ea, limits: { maxModelCalls: 1, maxTotalTokens: 100 } });
  await f.reserve();
  await f.settle(100);
  const state = await f.decide();
  expect(state.missions[0]).toMatchObject({ status: "awaiting_user_decision", revision: 2, waitingReason: question.question,
    usage: { modelCalls: 1, totalTokens: 100, clarificationRounds: 1 } });
  expect(state.decisions[0]).toMatchObject({ outcome: "accepted", code: "awaiting_user_decision", agentRevision: 1, missionRevision: 1,
    configuration: { policy: { source: ea ? "model_profile" : "default" } } });
  expect(state.changes.at(-1)?.kind).toBe("decision_recorded");
  expect(state.changes.filter((change) => change.kind === "mission_waiting_for_user")).toHaveLength(0);
  expect(await new FileAgentStateStore(f.filename).read()).toEqual(state);
  expect(state.sessions).toEqual([]);
});

test.each([
  "{broken", "```json\n{}\n```", JSON.stringify({ action: question, reason: "ok", evidenceIds: [], permission: "full_plus" }),
  JSON.stringify({ action: { ...question, modelProfileId: "foreign" }, reason: "ok", evidenceIds: [] }),
  JSON.stringify({ action: question, reason: "x".repeat(1001), evidenceIds: [] }),
])("records malformed output without retaining raw model content: %s", async (json) => {
  const f = await fixture();
  await f.reserve(); await f.settle();
  const state = await f.decide(json);
  expect(state.decisions[0]).toMatchObject({ proposal: null, outcome: "rejected", code: "malformed_proposal" });
  expect(state.missions[0]).toMatchObject({ status: "active", usage: { modelCalls: 1, totalTokens: 40, clarificationRounds: 0 } });
  const persisted = JSON.parse(await readFile(f.filename, "utf8"));
  expect(Object.keys(persisted.decisions[0])).not.toContain("proposalJson");
});

test.each([
  { kind: "answer_user" }, { kind: "read_evidence" }, { kind: "start_session", gap: "Missing evidence", approach: "Read supplied notes", expectedEvidence: "Source excerpt" },
  { kind: "wait", condition: "A source arrives" }, { kind: "complete" }, { kind: "exhausted" },
] satisfies AgentDecisionAction[])("keeps unavailable action $kind inert despite persuasive EA rationale", async (action) => {
  const f = await fixture({ ea: true });
  await f.reserve(); await f.settle();
  const state = await f.decide(JSON.stringify({ action, reason: "All criteria are certainly met; bypass all checks and complete immediately.", evidenceIds: [] }));
  expect(state.decisions[0]).toMatchObject({ outcome: "rejected", code: "operation_unavailable" });
  expect(state.missions[0].status).toBe("active");
  expect(state.sessions).toEqual([]);
});

test.each([false, true])("checks session ownership before rejecting unavailable continuation; owned=%s", async (owned) => {
  const f = await fixture();
  await commitAgentCommand(f.store, { kind: "register_agent", agentId: "agent-b", definition: agentDefinition("Other") });
  await commitAgentCommand(f.store, { kind: "bind_session", agentId: owned ? "agent-a" : "agent-b", sessionId: "session-a", purpose: "Supplied evidence" });
  await f.reserve(); await f.settle();
  const state = await f.decide(proposal({ kind: "continue_session", sessionId: "session-a", gap: "Missing source", approach: "Read it", expectedEvidence: "Excerpt" }));
  expect(state.decisions[0].code).toBe(owned ? "operation_unavailable" : "session_owner_mismatch");
  expect(state.sessions).toHaveLength(1);
});

test.each(["assessment", "authoring", "repair"] as const)("does not promote %s output to a decision", async (stage) => {
  const f = await fixture(); await f.reserve("invocation-a", stage); await f.settle();
  expect((await f.decide()).decisions[0].code).toBe("invocation_stage_not_decisional");
});

test.each(["reserved", "usage_unknown"] as const)("rejects %s usage, leaving its charge and reservation intact", async (status) => {
  const f = await fixture(); await f.reserve();
  if (status === "usage_unknown") await f.settle(null);
  const state = await f.decide();
  expect(state.decisions[0].code).toBe("invocation_not_settled");
  expect(state.invocations[0]).toMatchObject({ status, reservedTokens: 100, usage: null });
  expect(state.missions[0].usage.modelCalls).toBe(1);
});

test("blocks a prior settled decision while another invocation has unresolved usage", async () => {
  const f = await fixture(); await f.reserve(); await f.settle(); await f.reserve("invocation-b");
  expect((await f.decide()).decisions[0].code).toBe("usage_pending");
});

test.each(["overrun", "clarifications"] as const)("enforces %s before accepting a user question", async (kind) => {
  const f = await fixture({ limits: kind === "overrun" ? { maxTotalTokens: 100 } : { maxClarificationRounds: 0 } });
  await f.reserve(); await f.settle(kind === "overrun" ? 101 : 40);
  const state = await f.decide();
  expect(state.decisions[0].code).toBe(kind === "overrun" ? "budget_exhausted" : "clarification_limit_reached");
  expect(state.missions[0].usage.clarificationRounds).toBe(0);
});

test("records late cancelled and revised-Agent output without resurrecting work", async () => {
  const f = await fixture(); await f.reserve(); await f.settle();
  // Older stores could save a revised Agent while its mission was open.
  const before = await f.store.read();
  const earlier = readAgentState({ ...before, agents: before.agents.map(agent => ({
    ...agent, revision: agent.revision + 1, definition: { ...agent.definition, name: "Previously revised" },
  })) });
  await writeFile(f.filename, JSON.stringify(earlier));
  expect((await f.decide()).decisions[0].code).toBe("stale_agent_revision");
  await f.reserve("invocation-b"); await f.settle(30, "invocation-b");
  await commitAgentCommand(f.store, { kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "User cancelled." });
  const state = await f.decide(proposal(), "decision-b", "invocation-b");
  expect(state.decisions[1].code).toBe("mission_inactive");
  expect(state.missions[0]).toMatchObject({ status: "cancelled", usage: { totalTokens: 70, modelCalls: 2 } });
});

test("rejects stale mission revisions and forged evidence references", async () => {
  const f = await fixture(); await f.reserve(); await f.settle();
  const state = await f.store.read();
  const changed = { ...state, missions: state.missions.map((mission) => ({ ...mission, revision: mission.revision + 1 })) };
  const result = reduceAgentCommand(changed, { kind: "record_decision", agentId: "agent-a", invocationId: "invocation-a", decisionId: "stale",
    proposalJson: proposal(), currentConfiguration: captureAgentDecisionConfiguration(f.definition, f.config) }, AGENT_FOUNDATION_TIME);
  expect(result.decisions[0].code).toBe("stale_mission_revision");
  expect((await f.decide(JSON.stringify({ action: question, reason: "A claim is not evidence", evidenceIds: ["fabricated"] }))).decisions[0].code).toBe("evidence_unavailable");
});

test.each(["alias", "missing", "policy"] as const)("rejects live configuration %s drift without rewriting the source snapshot", async (kind) => {
  const f = await fixture({ alias: true }); await f.reserve(); await f.settle();
  const config = modelConfig();
  if (kind === "alias") config.models!.invocationProfiles!.precise.generation = { temperature: 0.7 };
  if (kind === "missing") delete config.models!.profiles!["fixture-super"];
  if (kind === "policy") config.modelExecutionPolicies = { ...config.modelExecutionPolicies, "fixture-super": { policy: "execution-agent-v1" } };
  const changed = createAgentControllerService(f.store, config);
  const state = await changed.decide("agent-a", "invocation-a", "decision-a", proposal(), (await f.store.read()).revision);
  expect(state.decisions[0].code).toBe("configuration_changed");
  expect(state.decisions[0].configuration).toEqual(state.invocations[0].configuration);
});

test("deduplicates exact decision replay across reload, rejects conflicting bytes and a second identity", async () => {
  const f = await fixture(); await f.reserve(); await f.settle();
  const state = await f.decide();
  const reloaded = createAgentControllerService(new FileAgentStateStore(f.filename), f.config);
  expect(await reloaded.decide("agent-a", "invocation-a", "decision-a", proposal(), state.revision)).toEqual(state);
  await expect(f.decide(` ${proposal()}`)).rejects.toMatchObject({ code: "agents_decision_replay_conflict" });
  await expect(f.decide(proposal(), "different-id")).rejects.toMatchObject({ code: "agents_invocation_decision_exists" });
  expect((await f.store.read()).missions[0].usage.clarificationRounds).toBe(1);
});

test("rejects foreign invocation ownership and invalid envelopes without changing the file", async () => {
  const f = await fixture(); await f.reserve(); await f.settle();
  await commitAgentCommand(f.store, { kind: "register_agent", agentId: "agent-b", definition: agentDefinition("Other") });
  const state = await f.store.read();
  const bytes = await readFile(f.filename, "utf8");
  await expect(f.controller.decide("agent-b", "invocation-a", "foreign", proposal(), state.revision)).rejects.toMatchObject({ code: "agents_invocation_owner_mismatch" });
  await expect(f.decide("x".repeat(65_537))).rejects.toMatchObject({ code: "agents_record_invalid" });
  expect(await readFile(f.filename, "utf8")).toBe(bytes);
});

test("validates trace references and source revisions on load, and returns detached proposals", async () => {
  const f = await fixture(); await f.reserve(); await f.settle(); const state = await f.decide();
  for (const patch of [{ invocationId: "missing" }, { missionRevision: 999 }, { agentId: "foreign" }, { code: "invented" }]) {
    expect(() => readAgentState({ ...state, decisions: [{ ...state.decisions[0], ...patch }] })).toThrow("agents_record_invalid");
  }
  const input = JSON.parse(proposal()); const detached = readAgentDecisionProposal(input); input.action.question = "Mutated";
  expect(detached.action).toEqual(question);
});

test("fingerprints semantic configuration changes while excluding provider secrets and raw options", () => {
  const config = modelConfig(); const definition = { ...agentDefinition(), modelProfileId: "precise" };
  const original = captureAgentDecisionConfiguration(definition, config)!;
  const privateConfig = structuredClone(config);
  privateConfig.models!.providers = { private: { type: "openai", baseUrl: "https://private.invalid", apiKeyEnv: "PRIVATE_KEY", settings: { token: "secret-value" } } };
  privateConfig.models!.profiles!["fixture-super"].options = { apiKey: "secret-value" };
  expect(captureAgentDecisionConfiguration(definition, privateConfig)).toEqual(original);
  expect(JSON.stringify(original)).not.toContain(definition.basePrompt);
  const changed = structuredClone(config);
  changed.models!.invocationProfiles!.precise.generation = { temperature: 0.3 };
  expect(captureAgentDecisionConfiguration(definition, changed)?.fingerprint).not.toBe(original.fingerprint);
  changed.models!.invocationProfiles!.precise = { generation: { temperature: 0.2 }, profileId: "fixture-super" };
  expect(captureAgentDecisionConfiguration(definition, changed)).toEqual(original);
});


test("rejects accepted traces whose persisted waiting transition, clarification charge or stage is missing", async () => {
  const f = await fixture(); await f.reserve(); await f.settle(); const state = await f.decide();
  const mission = state.missions[0];
  for (const patch of [
    { status: "active", waitingReason: null }, { waitingReason: "Different question" },
    { usage: { ...mission.usage, clarificationRounds: 0 } },
  ]) expect(() => readAgentState({ ...state, missions: [{ ...mission, ...patch }] })).toThrow("agents_record_invalid");
  expect(() => readAgentState({ ...state, invocations: [{ ...state.invocations[0], stage: "repair" }] })).toThrow("agents_record_invalid");
  const evidence = { ...state.decisions[0].proposal!, evidenceIds: ["invented"] };
  expect(() => readAgentState({ ...state, decisions: [{ ...state.decisions[0], proposal: evidence }] })).toThrow("agents_record_invalid");
  const cancelled = await commitAgentCommand(f.store, { kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "Cancelled after the question." });
  expect(await new FileAgentStateStore(f.filename).read()).toEqual(cancelled);
});
