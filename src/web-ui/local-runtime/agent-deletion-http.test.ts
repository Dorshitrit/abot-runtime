import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type WebSocket from "ws";
import { handleAgentsBridgeMessage } from "../../bridge/agents-access.js";
import { createLocalRuntimeApplication } from "../../runtime/local-application.js";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "../../runtime/__tests__/support/agents-application-fixture.js";
import { WebNotificationStore, notificationStorePath } from "../notifications/store.js";
import { WebReadStateStore } from "../session-read-state/store.js";
import { WebSessionReadStates } from "../session-read-state/service.js";
import { executeRemoteAgentCommand } from "../../runtime/agents/remote-workspace.js";
import type { AgentWorkspaceOperations } from "../../runtime/agents/workspace-client-contracts.js";
import { createAgentWorkspaceHost } from "../../runtime/agents/workspace-host.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, vi } from "vitest";
import { agentsWebBoundaryFixture } from "../../runtime/__tests__/support/agents-web-boundary-fixture.js";
import { agentMissionLimits } from "../../runtime/__tests__/support/agents-foundation-fixture.js";
import { createRuntimeWebClient } from "../app/services/runtime-web-client.js";
import { AGENT_DRAFT_PREFERENCE } from "../client-state/agent-draft-preference.js";
import { WebClientStateStore } from "../client-state/store.js";
import { LocalRuntimeWebBackend } from "../local-runtime-backend.js";
import type { RuntimeEnvironment } from "./contracts.js";

const host = vi.hoisted(() => ({ get: vi.fn<(id: string) => RuntimeEnvironment>() }));
vi.mock("./environment-registry.js", () => ({
  RuntimeEnvironmentRegistry: class {
    get = host.get;
    setupRequirement() { return null; }
    environmentConfig() { return { environments: [{ id: "dev" }] }; }
    async start() {}
    async stop() {}
  },
}));

test("the Web client permanently deletes a configured Agent through the local HTTP backend", async () => {
  const f = await agentsWebBoundaryFixture();
  const config = f.environment.services.config;
  const requestHandler = vi.fn();
  const services = {
    ...f.environment.services, config: { ...config, models: {
      profiles: { "fixture-super": { model: "scripted" } }, defaults: { profileId: "fixture-super" },
    } },
  };
  const agents = createAgentWorkspaceHost(services, { handle: requestHandler }, () => {});
  await agents.start();
  const operations: AgentWorkspaceOperations = { ...agents, isBusy: async () => agents.isBusy() };
  const environment = { ...f.environment, services, requests: { handle: requestHandler },
    agents: { ...operations, local: (command: Record<string, unknown>) => executeRemoteAgentCommand(operations, services.sessions, command, true) },
    subscribeAgentEvents: () => () => {} } as unknown as RuntimeEnvironment;
  host.get.mockImplementation(id => {
    if (id !== "dev") throw new Error("Unexpected environment");
    return environment;
  });
  const backend = new LocalRuntimeWebBackend({ rootDir: f.root, defaultEnvironmentId: "dev" });
  const server = createServer((req, res) => {
    void backend.handleHttp(req, res, new URL(req.url!, "http://localhost").pathname);
  });
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createRuntimeWebClient({
      origin, getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }),
      fetchImpl: (url, options) => fetch(new URL(String(url), origin), options),
    });
    const preferences = new WebClientStateStore(f.root);
    const key = JSON.stringify(["dev", "agent-a:onboarding"]);
    await preferences.transaction(state => {
      state.preferences[AGENT_DRAFT_PREFERENCE] = JSON.stringify({ [key]: { text: "Private draft", pendingId: "", intent: "auto", onboarding: "" } });
    });
    const schedule = await client.createAgentSchedule("agent-a", { id: "wake-up", title: "Later", text: "Research",
      startAt: new Date(Date.now() + 86_400_000).toISOString(), maxOccurrences: 1, intervalMs: null, limits: agentMissionLimits() });
    expect(schedule.schedule.agentId).toBe("agent-a");
    const catalog = await client.listAgents();
    expect(catalog.agents.find(agent => agent.id === "agent-a")).toMatchObject({ sessionCount: 2 });
    await expect(client.deleteAgent("agent-a", { expectedRevision: catalog.revision - 1 })).rejects.toThrow("agents_state_revision_conflict");
    expect(await client.deleteAgent("agent-a", { expectedRevision: catalog.revision })).toEqual({ ok: true });
    expect((await client.listAgents()).agents.map(item => item.id)).toEqual(["abot"]);
    await expect(client.getAgent("agent-a")).rejects.toThrow("agents_agent_not_found");
    expect((await preferences.transaction(state => state.preferences[AGENT_DRAFT_PREFERENCE])).result).toBeUndefined();
    for (const id of ["agent-new", "agent-old"]) expect(await f.sessions.getSessionById(id)).toBeNull();
    expect((await f.sessions.getSessionById("chat-new"))?.id).toBe("chat-new");
    expect(requestHandler).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await backend.stop();
    await agents.stop();
    await f.dispose();
  }
}, 20_000);

test("socket deletion removes work immediately and the next Web startup drains persisted cleanup after an owner restart", async () => {
  const f = await agentApplicationFixture();
  const { config } = f.dependencies;
  const { paths } = config;
  const owned = ["work-a", "work-b"];
  let runtime = createLocalRuntimeApplication(config);
  let web: LocalRuntimeWebBackend | undefined;
  try {
    for (const sessionId of owned) {
      await f.store.commitApplication({ kind: "bind_session", agentId: "agent-a", sessionId, purpose: "Private work" });
    }
    await runtime.start();
    expect(runtime.getOwnership()).toBe("owner");
    for (const sessionId of [...owned, "ordinary"]) {
      await runtime.services.sessions.getOrCreateSession(sessionId);
      await runtime.services.sessions.appendMessage(sessionId, "user", sessionId);
    }
    const ordinary = await runtime.services.sessions.getSessionById("ordinary");
    const preferences = new WebClientStateStore(paths.rootDir);
    const agentDraft = JSON.stringify(["dev", "agent-a"]), otherDraft = JSON.stringify(["dev", "abot"]);
    const draft = (text: string) => ({ text, pendingId: "", intent: "auto", onboarding: "" });
    await preferences.transaction(state => {
      state.preferences[AGENT_DRAFT_PREFERENCE] = JSON.stringify({ [agentDraft]: draft("Private draft"), [otherDraft]: draft("Keep") });
    });
    const drafts = async () => JSON.parse((await preferences.transaction(state => state.preferences[AGENT_DRAFT_PREFERENCE])).result!);
    const inbox = new WebNotificationStore(notificationStorePath({ ...paths, environmentId: "dev" }), "dev");
    const base = { kind: "reply" as const, title: "Reply", body: "Stored reply", environmentId: "dev",
      createdAt: Date.now(), readAt: null, delivery: { status: "disabled" as const } };
    await inbox.upsert({ ...base, id: "agent-notice", agentSource: { agentId: "agent-a", missionId: "mission", messageId: "reply" },
      sourceUrl: "/agents?environment=dev&agent=agent-a" });
    const ordinaryNotice = { ...base, id: "ordinary-notice", sessionId: "ordinary", sourceUrl: "/chat?environment=dev&session=ordinary" };
    await inbox.upsert(ordinaryNotice);
    const reads = new WebSessionReadStates(() => runtime);
    for (const id of [...owned, "ordinary"]) await reads.reset("dev", id);
    const readDirectory = join(paths.runtimeDir, "web-ui", "read-state");
    const [filename] = await readdir(readDirectory);
    const readStore = new WebReadStateStore(join(readDirectory, filename!), Date.now());
    const readIds = () => readStore.transaction(state => state.cursors.map(([id]) => id).sort());

    const send = vi.fn();
    const { revision } = await runtime.agents.application.snapshot();
    expect(await handleAgentsBridgeMessage({ send } as unknown as WebSocket, { type: "agents.delete.request", correlationId: "delete-1",
      targetAgentId: "agent-a", allowedModes: ["ask"], expectedRevision: revision }, runtime.agents)).toBe(true);
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ type: "agents.delete.response", ok: true, data: { deleted: true } });
    for (const id of owned) expect(await runtime.services.sessions.getSessionById(id)).toBeNull();
    expect(await runtime.services.sessions.getSessionById("ordinary")).toEqual(ordinary);
    expect((await runtime.agents.application.snapshot()).agents.map(detail => detail.agent.id)).toEqual(["abot"]);
    expect(await drafts()).toHaveProperty(agentDraft);
    expect(await inbox.get("agent-notice")).not.toBeNull();
    expect(await readIds()).toEqual(["ordinary", ...owned]);
    const receipt = [{ agentId: "agent-a", sessionIds: owned }];
    expect(await runtime.agents.projection.pending()).toEqual(receipt);

    await runtime.stop();
    runtime = createLocalRuntimeApplication(config);
    await runtime.start();
    expect(runtime.getOwnership()).toBe("owner");
    expect(await runtime.agents.projection.pending()).toEqual(receipt);
    // The previous device can retry the same committed mutation after a lost response and owner restart.
    const repeated = await runtime.agents.remote({ type: "agents.delete.request", targetAgentId: "agent-a",
      allowedModes: ["ask"], expectedRevision: revision });
    expect(repeated).toEqual({ deleted: true });
    expect(await runtime.agents.projection.pending()).toEqual(receipt);
    host.get.mockImplementation(() => runtime);
    web = new LocalRuntimeWebBackend({ rootDir: paths.rootDir, defaultEnvironmentId: "dev" });
    await web.start(["dev"]);
    expect(await runtime.agents.projection.pending()).toEqual([]);
    expect(await drafts()).toEqual({ [otherDraft]: draft("Keep") });
    expect(await inbox.get("agent-notice")).toBeNull();
    expect(await inbox.get("ordinary-notice")).toEqual(ordinaryNotice);
    expect(await readIds()).toEqual(["ordinary"]);
    expect(await runtime.services.sessions.getSessionById("ordinary")).toEqual(ordinary);
  } finally {
    await web?.stop();
    await runtime.stop();
    await disposeAgentApplicationFixtures();
  }
}, 20000);
