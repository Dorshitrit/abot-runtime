import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { FileAgentStateStore } from "../agents/file-store.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentDefinition, startAgentMission } from "./support/agents-foundation-fixture.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true, force:true}))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "abot-agent-delete-"));
  dirs.push(dir);
  const file = join(dir, "state.json");
  const reopen = () => new FileAgentStateStore(file);
  const store = reopen();
  await store.commitApplication({kind:"register_agent", agentId:"agent-a", definition:agentDefinition("PRIVATE_PROFILE")});
  await store.commitApplication({kind:"register_agent", agentId:"abot", definition:agentDefinition("Coordinator")});
  return {store, file, reopen};
}

test("deletion freezes admission across reopen, erases owned history and preserves other owners and revision order", async () => {
  const {store, file, reopen} = await fixture();
  await store.commitApplication({kind:"bind_session", agentId:"abot", sessionId:"retained-session", purpose:"Keep this"});
  await store.commitApplication({kind:"bind_session", agentId:"agent-a", sessionId:"private-session", purpose:"PRIVATE_PURPOSE"});
  await store.commitApplication(startAgentMission("agent-a", "private-mission"));
  const before = await store.commitApplication({kind:"cancel_mission", agentId:"agent-a", missionId:"private-mission", reason:"PRIVATE_REASON"});
  const pending = await store.beginDeletion("agent-a", before.revision);
  expect(pending.deletingAgentIds).toEqual(["agent-a"]);
  expect(pending.agents.find(agent => agent.id === "agent-a")!.status).toBe("archived");
  expect(pending.sessions).toEqual(before.sessions);
  const second = reopen();
  expect(await second.beginDeletion("agent-a", before.revision)).toEqual(pending);
  await expect(second.commitApplication({kind:"restore_agent", agentId:"agent-a"})).rejects.toThrow("agents_deletion_pending");
  await expect(second.commitApplication(startAgentMission("agent-a", "new-work"))).rejects.toThrow("agents_deletion_pending");
  const deleted = await second.finishDeletion("agent-a");
  expect(deleted.deletingAgentIds).toEqual([]);
  expect(deleted.agents.map(agent => agent.id)).toEqual(["abot"]);
  expect(deleted.sessions.map(session => session.sessionId)).toEqual(["retained-session"]);
  expect(deleted.missions).toEqual([]);
  expect(deleted.revision).toBe(before.revision + 2);
  expect(deleted.changes.filter(change => change.agentId === "abot")).toEqual(before.changes.filter(change => change.agentId === "abot"));
  expect(deleted.changes.map(change => change.sequence)).toEqual(Array.from({length:deleted.revision}, (_, i) => i + 1));
  const bytes = await readFile(file, "utf8");
  expect(bytes).not.toMatch(/PRIVATE_|private-session|private-mission/);
  expect(await reopen().finishDeletion("agent-a")).toEqual(deleted);
  expect(await second.beginDeletion("agent-a", before.revision)).toEqual(deleted);
  await expect(second.commitApplication({kind:"register_agent", agentId:"agent-a", definition:agentDefinition()})).rejects.toThrow("agents_agent_not_found");
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(() => readAgentState({...deleted, changes: deleted.changes.map(change => change.kind === "agent_history_erased" ? {...change,reason:"leaked"} : change)})).toThrow("agents_record_invalid");
});

test("rejects open or waiting missions, protected coordinator, a stale revision and completion without prior intent", async () => {
  const {store} = await fixture();
  const {revision} = await store.read();
  await expect(store.beginDeletion("abot", revision)).rejects.toThrow("agents_abot_required");
  await expect(store.beginDeletion("other", revision)).rejects.toThrow("agents_agent_not_found");
  await expect(store.beginDeletion("agent-a", revision - 1)).rejects.toThrow("agents_state_revision_conflict");
  await expect(store.finishDeletion("agent-a")).rejects.toThrow("agents_deletion_not_started");
  const active = await store.commitApplication(startAgentMission());
  await expect(store.beginDeletion("agent-a", active.revision)).rejects.toThrow("agents_agent_busy");
  const waiting = await store.commitApplication({kind:"wait_for_user", agentId:"agent-a", missionId:"mission-a", reason:"awaiting answer"});
  await expect(store.beginDeletion("agent-a", waiting.revision)).rejects.toThrow("agents_agent_busy");
  expect(await store.read()).toEqual(waiting);
});

test("an exhausted mission permits deletion and its private terminal reason is erased", async () => {
  const {store} = await fixture();
  const mission = startAgentMission();
  await store.commitApplication(mission);
  const terminal = await store.commitApplication({kind:"finish_agent_turn",agentId:"agent-a",missionId:mission.missionId,
    status:"exhausted",reason:"PRIVATE_TERMINAL_REASON"});
  await store.beginDeletion("agent-a", terminal.revision);
  const deleted = await store.finishDeletion("agent-a");
  expect(deleted.missions).toEqual([]);
  expect(JSON.stringify(deleted)).not.toContain("PRIVATE_TERMINAL_REASON");
});

test("schema five loads without changing bytes and upgrades on the first accepted deletion", async () => {
  const {store, file, reopen} = await fixture();
  const {deletingAgentIds: _, ...old} = await store.read();
  const bytes = JSON.stringify({...old, schemaVersion:5});
  await writeFile(file, bytes);
  expect((await reopen().read()).deletingAgentIds).toEqual([]);
  expect(await readFile(file, "utf8")).toBe(bytes);
  const pending = await store.beginDeletion("agent-a", old.revision);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(pending);
  expect(pending.schemaVersion).toBe(6);
});
