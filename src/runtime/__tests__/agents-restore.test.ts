import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FileAgentStateStore } from "../agents/file-store.js";
import type { AgentStateCommand } from "../agents/state-commands.js";
import {
  AGENT_FOUNDATION_TIME, agentDefinition, commitAgentCommand, startAgentMission,
} from "./support/agents-foundation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-agents-restore-"));
  directories.push(directory);
  const filename = join(directory, "state.json");
  const reopen = () => new FileAgentStateStore(filename, () => AGENT_FOUNDATION_TIME);
  const store = reopen();
  await commitAgentCommand(store, {
    kind: "register_agent", agentId: "agent-a", definition: agentDefinition(),
  });
  return { filename, store, reopen };
}

async function archiveWithRetainedWork(store: FileAgentStateStore) {
  await commitAgentCommand(store, {
    kind: "register_agent", agentId: "agent-b", definition: agentDefinition("Verifier"),
  });
  await commitAgentCommand(store, startAgentMission("agent-b", "mission-b"));
  await commitAgentCommand(store, startAgentMission());
  for (const sessionId of ["research", "verification"])
    await commitAgentCommand(store, {
      kind: "bind_session", agentId: "agent-a", sessionId, purpose: sessionId,
    });
  await commitAgentCommand(store, {
    kind: "wait_for_user", agentId: "agent-a", missionId: "mission-a", reason: "Need a user decision.",
  });
  await commitAgentCommand(store, {
    kind: "cancel_mission", agentId: "agent-a", missionId: "mission-a", reason: "User cancelled before archive.",
  });
  return commitAgentCommand(store, { kind: "archive_agent", agentId: "agent-a" });
}

test("restores archived identity after reload while preserving prior work, authority and history", async () => {
  const f = await fixture();
  const archived = await archiveWithRetainedWork(f.store);
  expect(archived.schemaVersion).toBe(6);
  const restoreTime = "2026-11-17T10:05:00.000Z";
  const store = new FileAgentStateStore(f.filename, () => restoreTime);
  expect(await store.read()).toEqual(archived);
  const restored = await store.commit({ kind: "restore_agent", agentId: "agent-a" }, archived.revision);
  const previous = archived.agents.find((agent) => agent.id === "agent-a")!;
  const current = restored.agents.find((agent) => agent.id === "agent-a")!;
  expect(current).toEqual({
    ...previous, status: "active", revision: previous.revision + 1, updatedAt: restoreTime,
  });
  expect(restored.revision).toBe(archived.revision + 1);
  expect(restored.sessions).toEqual(archived.sessions);
  expect(restored.missions).toEqual(archived.missions);
  expect(restored.agents.find((agent) => agent.id === "agent-b"))
    .toEqual(archived.agents.find((agent) => agent.id === "agent-b"));
  expect(restored.changes.slice(0, -1)).toEqual(archived.changes);
  expect(restored.changes.at(-1)).toMatchObject({
    kind: "agent_restored", agentId: "agent-a", missionId: null, sessionId: null, at: restoreTime,
  });
  expect(await f.reopen().read()).toEqual(restored);
  const next = await commitAgentCommand(store, startAgentMission("agent-a", "mission-next"));
  expect(next.missions.find((mission) => mission.id === "mission-a")?.status).toBe("cancelled");
  expect(next.missions.find((mission) => mission.id === "mission-next")?.status).toBe("active");
  expect(next.sessions).toEqual(archived.sessions);
});

test("rejects missing, active and already restored targets without changing durable state", async () => {
  const f = await fixture();
  const before = await readFile(f.filename, "utf8");
  await expect(commitAgentCommand(f.store, { kind: "restore_agent", agentId: "missing" }))
    .rejects.toMatchObject({ code: "agents_agent_not_found" });
  await expect(commitAgentCommand(f.store, { kind: "restore_agent", agentId: "agent-a" }))
    .rejects.toMatchObject({ code: "agents_agent_not_archived" });
  expect(await readFile(f.filename, "utf8")).toBe(before);
  await commitAgentCommand(f.store, { kind: "archive_agent", agentId: "agent-a" });
  await commitAgentCommand(f.store, { kind: "restore_agent", agentId: "agent-a" });
  const restored = await readFile(f.filename, "utf8");
  await expect(commitAgentCommand(f.reopen(), { kind: "restore_agent", agentId: "agent-a" }))
    .rejects.toMatchObject({ code: "agents_agent_not_archived" });
  expect(await readFile(f.filename, "utf8")).toBe(restored);
});

test("restore cannot smuggle a new definition, authority or mission through its command", async () => {
  const f = await fixture();
  const archived = await commitAgentCommand(f.store, { kind: "archive_agent", agentId: "agent-a" });
  for (const extra of [
    { definition: { ...agentDefinition(), toolPermissionMode: "full_plus" } },
    { missionId: "invented" },
    { approved: true },
  ]) {
    const command = { kind: "restore_agent", agentId: "agent-a", ...extra } as AgentStateCommand;
    await expect(f.store.commit(command, archived.revision)).rejects.toMatchObject({ code: "agents_record_invalid" });
  }
  expect(await f.reopen().read()).toEqual(archived);
});

test("concurrent restores admit one revision and reject a stale or repeated restoration", async () => {
  const f = await fixture();
  const archived = await commitAgentCommand(f.store, { kind: "archive_agent", agentId: "agent-a" });
  const command = { kind: "restore_agent", agentId: "agent-a" } as const;
  const results = await Promise.allSettled([
    f.store.commit(command, archived.revision),
    f.reopen().commit(command, archived.revision),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected"))
    .toMatchObject({ reason: { code: "agents_state_revision_conflict" } });
  const restored = await f.reopen().read();
  expect(restored.revision).toBe(archived.revision + 1);
  expect(restored.changes.filter((change) => change.kind === "agent_restored")).toHaveLength(1);
  await expect(f.store.commit(command, restored.revision))
    .rejects.toMatchObject({ code: "agents_agent_not_archived" });
  expect(await f.reopen().read()).toEqual(restored);
});
