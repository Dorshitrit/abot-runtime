import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentState } from "../agents/agent-records.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentStateCommand } from "../agents/state-commands.js";
import {
  AGENT_FOUNDATION_TIME, agentDefinition, commitAgentCommand, startAgentMission,
} from "./support/agents-foundation-fixture.js";

const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-agents-foundation-"));
  directories.add(directory);
  const filename = join(directory, "agents.json");
  const reopen = () => new FileAgentStateStore(filename, () => AGENT_FOUNDATION_TIME);
  return { filename, store: reopen(), reopen };
}

function register(agentId = "agent-a", name = "Research"): AgentStateCommand {
  return { kind: "register_agent", agentId, definition: agentDefinition(name) };
}

async function stateWithOwnedRecords(store: FileAgentStateStore) {
  await commitAgentCommand(store, register());
  await commitAgentCommand(store, register("agent-b", "Verification"));
  await commitAgentCommand(store, startAgentMission());
  return commitAgentCommand(store, {
    kind: "bind_session", agentId: "agent-a", sessionId: "work-a", purpose: "Research evidence",
  });
}

describe("persistent Agent state foundation", () => {
  it("persists definition revisions and explicit work policy across a new store", async () => {
    const { store, reopen } = await fixture();
    expect(await store.read()).toMatchObject({ revision: 0, agents: [], missions: [], sessions: [] });
    await commitAgentCommand(store, register());
    const definition = {
      ...agentDefinition("Verification"),
      basePrompt: "Verify the assigned evidence and report unresolved gaps.",
      modelProfileId: "fixture-ea",
      executionPolicy: "execution-agent-v1" as const,
      toolPermissionMode: "full_access" as const,
    };
    const committed = await commitAgentCommand(store, {
      kind: "update_definition", agentId: "agent-a", definition,
    });
    const restored = await reopen().read();
    expect(restored).toEqual(committed);
    expect(restored.agents[0]).toMatchObject({ id: "agent-a", revision: 2, definition });
    expect(restored.changes.map((entry) => entry.kind)).toEqual([
      "agent_registered", "agent_definition_updated",
    ]);
  });

  it("allows independent Agents to retain active missions at the same time", async () => {
    const { store, reopen } = await fixture();
    await commitAgentCommand(store, register());
    await commitAgentCommand(store, register("agent-b"));
    await commitAgentCommand(store, startAgentMission());
    await commitAgentCommand(store, startAgentMission("agent-b", "mission-b"));
    const restored = await reopen().read();
    expect(restored.missions.map(({ id, agentId, status }) => ({ id, agentId, status }))).toEqual([
      { id: "mission-a", agentId: "agent-a", status: "active" },
      { id: "mission-b", agentId: "agent-b", status: "active" },
    ]);
  });

  it("keeps the Agent occupied through a durable wait for a user decision", async () => {
    const { store, filename, reopen } = await fixture();
    await commitAgentCommand(store, register());
    await commitAgentCommand(store, startAgentMission());
    await expect(commitAgentCommand(store, startAgentMission("agent-a", "mission-second")))
      .rejects.toMatchObject({ code: "agents_agent_busy" });
    await commitAgentCommand(store, {
      kind: "wait_for_user", agentId: "agent-a", missionId: "mission-a",
      reason: "The previous result is unknown; the user must decide.",
    });
    const savedBytes = await readFile(filename, "utf8");
    const restored = reopen();
    await expect(commitAgentCommand(restored, startAgentMission("agent-a", "mission-second")))
      .rejects.toMatchObject({ code: "agents_agent_busy" });
    expect((await restored.read()).missions[0]).toMatchObject({
      status: "awaiting_user_decision",
      waitingReason: "The previous result is unknown; the user must decide.",
    });
    expect(await readFile(filename, "utf8")).toBe(savedBytes);
  });

  it("retains two Agent-owned sessions when a mission is cancelled and replaced", async () => {
    const { store, reopen } = await fixture();
    await commitAgentCommand(store, register());
    await commitAgentCommand(store, startAgentMission());
    for (const sessionId of ["work-research", "work-verification"]) {
      await commitAgentCommand(store, {
        kind: "bind_session", agentId: "agent-a", sessionId, purpose: sessionId,
      });
    }
    const retainedSessions = (await store.read()).sessions;
    await commitAgentCommand(store, {
      kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "User changed the assignment.",
    });
    await commitAgentCommand(store, startAgentMission("agent-a", "mission-next"));
    const restored = await reopen().read();
    expect(restored.sessions).toEqual(retainedSessions);
    expect(restored.sessions.map((entry) => entry.agentId)).toEqual(["agent-a", "agent-a"]);
    expect(restored.missions.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "mission-a", status: "cancelled" }, { id: "mission-next", status: "active" },
    ]);
  });

  it("admits only one mission across simultaneous stores, including a fresh-revision retry", async () => {
    const { store, reopen } = await fixture();
    const registered = await commitAgentCommand(store, register());
    const commands = [startAgentMission("agent-a", "first"), startAgentMission("agent-a", "second")];
    const results = await Promise.allSettled([
      store.commit(commands[0], registered.revision),
      reopen().commit(commands[1], registered.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.findIndex((result) => result.status === "rejected");
    expect(results[loser]).toMatchObject({ reason: { code: "agents_state_revision_conflict" } });
    const restored = await reopen().read();
    expect(restored.missions).toHaveLength(1);
    await expect(reopen().commit(commands[loser], restored.revision))
      .rejects.toMatchObject({ code: "agents_agent_busy" });
    expect(await store.read()).toEqual(restored);
  });

  it("preserves explicit zero allowances and rejects a zero no-progress ceiling", async () => {
    const { store, reopen } = await fixture();
    await commitAgentCommand(store, register());
    const command = { ...startAgentMission(), limits: {
      maxAttempts: 0, maxModelCalls: 0, maxTotalTokens: 0,
      maxConsecutiveNoProgress: 1, maxClarificationRounds: 0,
    } };
    const before = await store.read();
    await expect(store.commit({ ...command, limits: { ...command.limits, maxConsecutiveNoProgress: 0 } }, before.revision))
      .rejects.toMatchObject({ code: "agents_record_invalid" });
    const saved = await store.commit(command, before.revision);
    expect((await reopen().read()).missions[0].limits).toEqual(command.limits);
    expect(saved.missions[0].usage).toEqual({
      attempts: 0, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0,
    });
  });

  it("rejects a foreign Agent's mission actions and an already owned session", async () => {
    const { store, filename, reopen } = await fixture();
    const before = await stateWithOwnedRecords(store);
    const savedBytes = await readFile(filename, "utf8");
    for (const kind of ["wait_for_user", "cancel_mission"] as const) {
      await expect(store.commit({ kind, agentId: "agent-b", missionId: "mission-a", reason: "Foreign request" }, before.revision))
        .rejects.toMatchObject({ code: "agents_mission_owner_mismatch" });
    }
    await expect(store.commit({
      kind: "bind_session", agentId: "agent-b", sessionId: "work-a", purpose: "Take ownership",
    }, before.revision)).rejects.toMatchObject({ code: "agents_session_already_bound" });
    expect(await reopen().read()).toEqual(before);
    expect(await readFile(filename, "utf8")).toBe(savedBytes);
  });

  it("refuses to archive busy Agents, then archives without deleting retained records", async () => {
    const { store, reopen } = await fixture();
    await stateWithOwnedRecords(store);
    await expect(commitAgentCommand(store, { kind: "archive_agent", agentId: "agent-a" }))
      .rejects.toMatchObject({ code: "agents_agent_busy" });
    expect((await store.read()).missions[0]?.status).toBe("active");
    await commitAgentCommand(store, {
      kind: "wait_for_user", agentId: "agent-a", missionId: "mission-a", reason: "Needs a decision",
    });
    await expect(commitAgentCommand(store, { kind: "archive_agent", agentId: "agent-a" }))
      .rejects.toMatchObject({ code: "agents_agent_busy" });
    await commitAgentCommand(store, {
      kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "Explicitly cancelled",
    });
    const retained = await store.read();
    await commitAgentCommand(store, { kind: "archive_agent", agentId: "agent-a" });
    const restored = await reopen().read();
    expect(restored.agents.find((entry) => entry.id === "agent-a")?.status).toBe("archived");
    expect(restored.sessions).toEqual(retained.sessions);
    expect(restored.missions).toEqual(retained.missions);
    expect(restored.changes.slice(0, -1)).toEqual(retained.changes);
    await expect(commitAgentCommand(store, startAgentMission("agent-a", "mission-next")))
      .rejects.toMatchObject({ code: "agents_agent_archived" });
    await expect(commitAgentCommand(store, {
      kind: "bind_session", agentId: "agent-a", sessionId: "new-work", purpose: "New work",
    })).rejects.toMatchObject({ code: "agents_agent_archived" });
  });

  it("uses revision CAS across independent store instances without losing the winner", async () => {
    const { store, reopen } = await fixture();
    const other = reopen();
    const commands = [register("agent-a"), register("agent-b")] as const;
    const outcomes = await Promise.allSettled([
      store.commit(commands[0], 0), other.commit(commands[1], 0),
    ]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const loser = outcomes.findIndex((entry) => entry.status === "rejected");
    expect(outcomes[loser]).toMatchObject({
      status: "rejected", reason: { code: "agents_state_revision_conflict" },
    });
    const winningState = await reopen().read();
    expect(winningState.revision).toBe(1);
    expect(winningState.agents).toHaveLength(1);
    const result = await other.commit(commands[loser]!, winningState.revision);
    expect(result.agents.map((entry) => entry.id).sort()).toEqual(["agent-a", "agent-b"]);
    expect(result.agents.find((entry) => entry.id === winningState.agents[0]?.id))
      .toEqual(winningState.agents[0]);
    expect(await reopen().read()).toEqual(result);
  });

  const corruptions: ReadonlyArray<{
    name: string;
    corrupt: (state: AgentState) => unknown;
  }> = [
    { name: "unknown schema version", corrupt: (state) => ({ ...state, schemaVersion: Number.MAX_SAFE_INTEGER }) },
    { name: "unexpected authority field", corrupt: (state) => ({ ...state, fullAccess: true }) },
    { name: "missing mission owner", corrupt: (state) => ({ ...state,
      missions: state.missions.map((mission) => ({ ...mission, agentId: "missing-agent" })) }) },
    { name: "missing session owner", corrupt: (state) => ({ ...state,
      sessions: state.sessions.map((session) => ({ ...session, agentId: "missing-agent" })) }) },
    { name: "foreign owner in historical session reference", corrupt: (state) => ({ ...state,
      sessions: state.sessions.map((session) => ({ ...session, agentId: "agent-b" })) }) },
    { name: "missing mission identity in management history", corrupt: (state) => ({ ...state,
      changes: state.changes.map((change) => change.kind === "mission_started" ? { ...change, missionId: null } : change) }) },
    { name: "two unfinished missions after reload", corrupt: (state) => ({ ...state,
      missions: [...state.missions, { ...state.missions[0], id: "another-mission" }] }) },
  ];

  it.each(corruptions)("rejects loaded $name without repairing or overwriting the file", async ({ corrupt }) => {
    const { store, filename, reopen } = await fixture();
    const valid = await stateWithOwnedRecords(store);
    const damaged = JSON.stringify(corrupt(valid));
    await writeFile(filename, damaged);
    const restored = reopen();
    await expect(restored.read()).rejects.toMatchObject({ code: "agents_record_invalid" });
    await expect(restored.commit(register("agent-c"), valid.revision))
      .rejects.toMatchObject({ code: "agents_record_invalid" });
    expect(await readFile(filename, "utf8")).toBe(damaged);
  });

  it("leaves malformed persisted JSON untouched", async () => {
    const { store, filename, reopen } = await fixture();
    await commitAgentCommand(store, register());
    const damaged = '{"schemaVersion":1,"agents":[';
    await writeFile(filename, damaged);
    await expect(reopen().read()).rejects.toMatchObject({ code: "agents_state_invalid" });
    await expect(store.commit(register("agent-b"), 1)).rejects.toMatchObject({ code: "agents_state_invalid" });
    expect(await readFile(filename, "utf8")).toBe(damaged);
  });

  it.each([
    { name: "extra authority", invalid: { ...register("agent-b"), toolPermissionMode: "full_plus" } },
    { name: "unknown work policy", invalid: { kind: "register_agent", agentId: "agent-b",
      definition: { ...agentDefinition(), executionPolicy: "unrestricted-agent-v9" } } },
  ])("rejects command $name before changing durable state", async ({ invalid }) => {
    const { store, filename, reopen } = await fixture();
    const original = await commitAgentCommand(store, register());
    const savedBytes = await readFile(filename, "utf8");
    await expect(store.commit(invalid as AgentStateCommand, original.revision))
      .rejects.toMatchObject({ code: "agents_record_invalid" });
    expect(await reopen().read()).toEqual(original);
    expect(await readFile(filename, "utf8")).toBe(savedBytes);
  });

  it("detaches queued inputs and returned snapshots from caller mutation", async () => {
    const { store, reopen } = await fixture();
    const definition = agentDefinition("Original");
    const pending = store.commit({ kind: "register_agent", agentId: "agent-a", definition }, 0);
    definition.name = "Changed after submission";
    const returned = await pending;
    expect(returned.agents[0]?.definition.name).toBe("Original");
    Reflect.set(returned.agents[0]!.definition, "name", "Changed returned definition");
    Reflect.set(returned.agents, "length", 0);
    const firstRead = await store.read();
    expect(firstRead.agents[0]?.definition.name).toBe("Original");
    Reflect.set(firstRead.agents[0]!.definition, "basePrompt", "Caller-provided replacement authority");
    const restored = await reopen().read();
    expect(restored.agents[0]?.definition).toEqual(agentDefinition("Original"));
    expect(restored.revision).toBe(1);
  });
});

it("canonical management rejects editing active/waiting missions and archiving the coordinator", async () => {
  const { store } = await fixture();
  await commitAgentCommand(store, register("abot"));
  await expect(commitAgentCommand(store, { kind: "archive_agent", agentId: "abot" })).rejects.toThrow("agents_abot_required");
  await commitAgentCommand(store, register());
  await commitAgentCommand(store, startAgentMission());
  const edit = () => commitAgentCommand(store, { kind: "update_definition", agentId: "agent-a", definition: agentDefinition("Updated") });
  await expect(edit()).rejects.toThrow("agents_agent_busy");
  await commitAgentCommand(store, { kind: "wait_for_user", agentId: "agent-a", missionId: "mission-a", reason: "Paused" });
  await expect(edit()).rejects.toThrow("agents_agent_busy");
  await commitAgentCommand(store, { kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "End" });
  expect((await edit()).agents.find(agent => agent.id === "agent-a")?.definition.name).toBe("Updated");
});
