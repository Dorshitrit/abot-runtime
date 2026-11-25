import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectAgentAttention, type AgentAttentionCursor } from "../../runtime/agents/attention.js";
import { afterEach, expect, test, vi } from "vitest";
import { agentApplicationFixture, applicationPlan, disposeAgentApplicationFixtures } from "../../runtime/__tests__/support/agents-application-fixture.js";
import { createFileAttachmentStore } from "../../runtime/attachments/store.js";
import { createFileSessionStore } from "../../runtime/adapters/file-session-store.js";
import { FileAgentStateStore } from "../../runtime/agents/file-store.js";
import { createSessionLifecycleStore } from "../../runtime/session/session-lifecycle-store.js";
import { createLocalServiceClients } from "../../runtime/local-host/client-services.js";
import { dispatchLocalServiceCall } from "../../runtime/local-host/app-service-dispatch.js";
import type { RuntimeEnvironmentServices } from "../../runtime/composition.js";
import { readAgentSessionIds } from "../../runtime/agents/session-association.js";
import { createAgentDeletion } from "./agent-deletion.js";
import { WebAgentRegistry } from "./agents-registry.js";
import type { RuntimeEnvironment } from "./contracts.js";

afterEach(disposeAgentApplicationFixtures);

test("recovery after physical deletion keeps ownership concealed until every cleanup completes", async () => {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a", {messageId:"request-1", text:"First job", intent:"task"}); await f.app.whenIdle();
  await f.app.send("agent-a", {messageId:"request-2", text:"Second job", intent:"task"}); await f.app.whenIdle();
  const before = await f.store.read();
  const owned = before.sessions.filter(binding => binding.agentId === "agent-a").map(binding => binding.sessionId);
  expect(owned).toHaveLength(2);
  const {runtimeDir, sessionsDir} = f.dependencies.config.paths;
  const directory = join(runtimeDir, "agents");
  const files = createFileSessionStore({sessionsDir});
  const attachments = createFileAttachmentStore({attachmentsDir:join(runtimeDir,"attachments")});
  const lifetime = createSessionLifecycleStore(files, receipt => attachments.deleteSessionAttachments(receipt.sessionId));
  const owner = {sessions:lifetime.store, attachments} as RuntimeEnvironmentServices;
  const client = createLocalServiceClients((method, args) => dispatchLocalServiceCall(owner, method, args));
  const sessions = client.sessions;
  // The second owned session only has an upload. Ordinary Chats can share the same environment.
  await sessions.getOrCreateSession(owned[0]!);
  await sessions.getOrCreateSession("ordinary-chat");
  for (const sessionId of [...owned, "ordinary-chat"]) {
    await attachments.saveAttachment({sessionId, requestId:"upload", kind:"image", mimeType:"image/png", bytes:Buffer.from([1,2,3])});
  }
  const detachedMetadata = join(sessionsDir, ".metadata", owned[1] + ".json");
  const detachedSource = detachedMetadata + ".source";
  const continuation = (owner: string) => join(sessionsDir, ".request-continuations", owner);
  await writeFile(detachedMetadata, "old private metadata");
  await writeFile(detachedSource, "old private source receipt");
  for (const id of [owned[1]!, "ordinary-chat"]) {
    await mkdir(continuation(id), {recursive:true});
    await writeFile(join(continuation(id), "request.blob"), id);
  }
  const forgetSession = vi.fn(async (_id: string) => {});
  forgetSession.mockRejectedValueOnce(new Error("Read-state write unavailable"));
  const forgetAgent = vi.fn(async (_id: string) => {}), removeSchedules = vi.fn(async (_id: string) => {});
  const deps = {directory, store:f.store, sessions, attachments:client.attachments, removeSchedules, forgetSession, forgetAgent, onRecoveryError:vi.fn()};
  await expect(sessions.purgeDeletedSessionSidecars!("ordinary-chat")).rejects.toThrow("session_deletion_required");
  await expect(files.purgeDeletedSessionSidecars!("ordinary-chat")).rejects.toThrow("session_still_exists");
  // A terminal Agent ledger alone cannot release a live ordinary session or approval.
  await sessions.startRequestStream(owned[0]!, "still-running");
  await expect(createAgentDeletion(deps).remove("agent-a", before.revision)).rejects.toThrow("agents_deletion_unresolved");
  expect((await f.store.read()).deletingAgentIds).toEqual([]);
  expect(removeSchedules).not.toHaveBeenCalled();
  await sessions.appendRequestEvent(owned[0]!, "still-running", {type:"completed", requestId:"still-running", output:"done"});
  await expect(createAgentDeletion(deps).remove("agent-a", before.revision)).rejects.toThrow("agents_deletion_cleanup_failed");
  expect(await sessions.getSessionById(owned[0]!)).toBeNull();
  expect(await readAgentSessionIds(runtimeDir)).toEqual(new Set(owned));
  expect(await f.store.read()).toMatchObject({deletingAgentIds:["agent-a"]});
  const recovered = createAgentDeletion({...deps, store:new FileAgentStateStore(join(directory,"state.json"))});
  await recovered.recover();
  expect(deps.onRecoveryError).not.toHaveBeenCalled();
  expect(await readAgentSessionIds(runtimeDir)).toEqual(new Set());
  expect((await f.store.read()).agents.some(agent => agent.id === "agent-a")).toBe(false);
  expect(await attachments.listSessionAttachmentOwners!()).toEqual(["ordinary-chat"]);
  for (const path of [detachedMetadata, detachedSource, continuation(owned[1]!)])
    await expect(stat(path)).rejects.toMatchObject({code:"ENOENT"});
  expect(await readFile(join(continuation("ordinary-chat"), "request.blob"), "utf8")).toBe("ordinary-chat");
  expect(await sessions.deleteSessionWithStats(owned[1]!)).toMatchObject({deleted:false, deletedMessages:0, deletedRequests:0});
  expect((await sessions.getSessionById("ordinary-chat"))?.id).toBe("ordinary-chat");
  expect(forgetSession.mock.calls.map(([id]) => id)).toEqual([owned[0], ...owned]);
  expect(forgetAgent).toHaveBeenCalledExactlyOnceWith("agent-a");
  await recovered.remove("agent-a", before.revision);
  expect(forgetAgent).toHaveBeenCalledOnce();
}, 20_000);

test("deleting drains an in-flight notification without asking the observer to refresh other agents", async () => {
  const f = await agentApplicationFixture({choose: () => applicationPlan("answer_user")});
  let changed: ((rev: number) => void) | undefined;
  const receipt = { agentId: "agent-a", sessionIds: [] };
  let deleted = false;
  const environment = {
    subscribeAgentEvents(listener: (rev: number) => void) { changed = listener; return () => { changed = undefined; }; },
    agents: { async local(command: Record<string, unknown>) {
        expect(command).toMatchObject({ type: "agents.delete.request", targetAgentId: "agent-a" });
        deleted = true;
        return { deleted: true };
      },
      projection: { attention: async (cursors: readonly AgentAttentionCursor[], since: number) => projectAgentAttention(await f.store.read(), cursors, since),
        pending: async () => deleted ? [receipt] : [], acknowledge: async () => { deleted = false; } },
    },
  } as unknown as RuntimeEnvironment;
  let writing!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const inbox = {
    recordAgentReply: vi.fn(async () => { writing(); await finish; }),
    forgetAgentReplies: vi.fn(async () => {}), readAgentReplies: vi.fn(async () => null),
    unreadAgentReplies: vi.fn(async () => []),
  };
  const registry = new WebAgentRegistry(() => environment, inbox, vi.fn(), vi.fn());
  try {
    const entry = await registry.get("dev");
    await f.app.send("agent-a", {messageId:"chat", text:"Hello", intent:"auto"});
    await f.app.whenIdle("agent-a");
    changed!((await f.store.read()).revision);
    await started;
    const removing = entry.local({ type: "agents.delete.request", targetAgentId: "agent-a",
      expectedRevision: (await f.store.read()).revision }).then(() => entry.sync());
    await vi.waitFor(() => expect(deleted).toBe(true));
    expect(inbox.forgetAgentReplies).not.toHaveBeenCalled();
    release();
    await removing;
    expect(inbox.forgetAgentReplies).toHaveBeenCalledExactlyOnceWith("dev", "agent-a");
  } finally {
    release();
    await registry.stop();
  }
},20_000);

test("a failed pending cleanup remains retryable while another pending agent finishes", async () => {
  const f = await agentApplicationFixture();
  const def = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"register_agent",agentId:"agent-b",definition:def});
  for (const agentId of ["agent-a", "agent-b"]) {
    const {revision} = await f.store.read();
    await f.store.beginDeletion(agentId,revision);
  }
  const {runtimeDir,sessionsDir} = f.dependencies.config.paths;
  const forgetAgent = vi.fn(async (id: string) => { if (id === "agent-a") throw new Error("Disk full"); });
  const onRecoveryError = vi.fn();
  const deletion = createAgentDeletion({directory:join(runtimeDir,"agents"),store:f.store,
    sessions:createFileSessionStore({sessionsDir}),attachments:undefined,removeSchedules:async()=>{},
    forgetSession:async()=>{},forgetAgent,onRecoveryError});
  await deletion.recover();
  expect((await f.store.read()).deletingAgentIds).toEqual(["agent-a"]);
  expect((await f.store.read()).agents.map(agent => agent.id)).toEqual(["agent-a"]);
  expect(onRecoveryError).toHaveBeenCalledExactlyOnceWith("agent-a");
  forgetAgent.mockResolvedValue(undefined);
  await deletion.remove("agent-a",0);
  expect((await f.store.read()).agents).toEqual([]);
},20_000);
