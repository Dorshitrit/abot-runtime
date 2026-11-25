import type { IncomingMessage } from "node:http";
import { RuntimeMaintenanceRoutes } from "../../web-ui/local-runtime/runtime-maintenance-routes.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../ports.js";
import { afterEach, expect, test, vi } from "vitest";
import { assertOrdinaryWebSession, readAgentSessionIds } from "../agents/session-association.js";
import { acceptOrdinaryChatSession } from "../../web-ui/local-runtime/agent-session-scope.js";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { validateRuntimeQueueTarget } from "../../web-ui/client-state/queue-target.js";
import { agentsWebBoundaryFixture, boundaryResponse } from "./support/agents-web-boundary-fixture.js";
const fixtures: Awaited<ReturnType<typeof agentsWebBoundaryFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function fixture() { const f = await agentsWebBoundaryFixture(); fixtures.push(f); return f; }

test("Agent-owned sessions are filtered before pagination, ordering, archive counts and overview", async () => {
  const f = await fixture();
  const query = { pinnedSessionIds: ["agent-new"], archivedSessionIds: ["agent-old"] };
  const page = await f.reads.list("dev", query);
  expect(page.sessions.map((entry) => entry.id)).toEqual(["chat-new", "chat-middle"]);
  expect(page).toMatchObject({ total: 3, archivedCount: 0, overview: { unreadCount: 3 } });
  expect(page.overview?.sessions.map((entry) => entry.id)).toEqual(["chat-new", "chat-middle", "chat-old"]);
  expect(page.nextCursor).toBeTruthy();
  const next = await f.reads.list("dev", { ...query, cursor: page.nextCursor });
  expect(next.sessions.map((entry) => entry.id)).toEqual(["chat-old"]);
  expect(next.nextCursor).toBeNull();
  expect((await f.reads.list("dev", { query: "agent" })).sessions).toEqual([]);
  expect((await f.reads.list("dev")).sessions).toHaveLength(3);
});

test("sidebar grouping also receives only ordinary sessions", async () => {
  const f = await fixture();
  const result = await f.reads.list("dev", { sidebar: true, pinnedSessionIds: ["agent-new"] },
    { projects: [], deletedProjectIds: [] });
  expect(result.sessions.map((entry) => entry.id)).toEqual(["chat-new", "chat-middle"]);
  expect(result.overview?.unreadCount).toBe(3);
});

test.each([
  ["GET", "messages"], ["POST", "read"], ["DELETE", "messages"], ["DELETE", undefined],
] as const)("Chat %s %s refuses an Agent session without touching the ordinary service", async (method, action) => {
  const f = await fixture(); const output = boundaryResponse();
  const snapshot = vi.spyOn(f.sessions, "getSessionSnapshot");
  const clear = vi.spyOn(f.sessions, "clearSessionMessages");
  const remove = vi.spyOn(f.sessions, "deleteSessionWithStats");
  const routes = new WebSessionRoutes(f.reads);
  expect(await routes.handle({ method, segments: ["chat", "sessions", "agent-new", ...(action ? [action] : [])],
    body: {}, environmentId: "dev", environment: f.environment, response: output.response })).toBe(true);
  expect(output.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(output.payload).toEqual({ ok: false, error: "agent_session_requires_agents_workspace" });
  expect(snapshot).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

test("ordinary Chat history remains accessible with the Agent index present", async () => {
  const f = await fixture(); const output = boundaryResponse();
  await new WebSessionRoutes(f.reads).handle({ method: "GET", segments: ["chat", "sessions", "chat-new", "messages"],
    body: null, environmentId: "dev", environment: f.environment, response: output.response });
  expect(output.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(output.payload).toMatchObject({ ok: true, sessionId: "chat-new" });
});

test("an unreadable Agent index fails closed, without turning its sessions into Chats", async () => {
  const f = await fixture(); await writeFile(join(f.root, "agents", "state.json"), "invalid JSON");
  await expect(f.reads.list("dev")).rejects.toThrow();
  await expect(assertOrdinaryWebSession(f.root, "chat-new")).rejects.toThrow();
  const output = boundaryResponse();
  await new WebSessionRoutes(f.reads).handle({ method: "GET", segments: ["chat", "sessions", "agent-new", "messages"],
    body: null, environmentId: "dev", environment: f.environment, response: output.response });
  expect(output.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
});

test("the independent index stays authoritative after reload and archive", async () => {
  const f = await fixture(); const before = await readAgentSessionIds(f.root);
  expect([...before].sort()).toEqual(["agent-new", "agent-old"]);
  await f.store.commit({ kind: "archive_agent", agentId: "agent-a" }, (await f.store.read()).revision);
  expect(await readAgentSessionIds(f.root)).toEqual(before);
  await expect(assertOrdinaryWebSession(f.root, "agent-new")).rejects.toThrow("agent_session_requires_agents_workspace");
  const output = boundaryResponse();
  expect(await acceptOrdinaryChatSession(f.root, "  agent-new\t", output.response)).toBe(false);
  expect(output.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(await acceptOrdinaryChatSession(f.root, "  chat-new\t", boundaryResponse().response)).toBe(true);
  await expect(assertOrdinaryWebSession(f.root, "chat-new")).resolves.toBeUndefined();
});

test("queue validation rejects Agent scope before replay or persistence and preserves ordinary targets", async () => {
  const f = await fixture();
  const replay = vi.fn(async (_request: string, _after: number, sessionId: string) => ({ sessionId, requestId: "active" }));
  const sessions = vi.fn(() => ({ getRequestReplayById: replay } as unknown as Pick<SessionStore, "getRequestReplayById">));
  const guard = (_environmentId: string, sessionId: string) => assertOrdinaryWebSession(f.root, sessionId);
  const input = { kind: "queue", action: "enqueue", scope: { environmentId: "dev", sessionId: "agent-new" }, item: { waitForRequestId: "active" } };
  await expect(validateRuntimeQueueTarget(input, sessions, guard)).rejects.toMatchObject({ code: "agent_session_requires_agents_workspace", status: 409 });
  expect(sessions).not.toHaveBeenCalled();
  await expect(validateRuntimeQueueTarget({ ...input, scope: { environmentId: "dev", sessionId: "chat-new" } }, sessions, guard)).resolves.toBeUndefined();
  expect(replay).toHaveBeenCalledExactlyOnceWith("active", 0, "chat-new");
});


test("bulk Runtime session reset cannot erase Agent work from the Chat maintenance surface", async () => {
  const f = await fixture(); const output = boundaryResponse(); Object.assign(output.response, { setHeader: vi.fn() }); const resetSessions = vi.fn(); const resetConversations = vi.fn();
  const environment = { ...f.environment, services: { ...f.environment.services, maintenance: { resetSessions } } } as unknown as typeof f.environment;
  const route = new RuntimeMaintenanceRoutes(() => environment, { resetConversations });
  await route.handle({ method: "POST", route: "runtime/maintenance/sessions", body: { confirmed: true }, environmentId: "dev",
    request: { headers: { "content-type": "application/json" } } as IncomingMessage, response: output.response });
  expect(output.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(output.payload).toMatchObject({ ok: false, error: "agents_sessions_prevent_bulk_reset" });
  expect(resetSessions).not.toHaveBeenCalled(); expect(resetConversations).not.toHaveBeenCalled();
  expect([...await readAgentSessionIds(f.root)].sort()).toEqual(["agent-new", "agent-old"]);
});
