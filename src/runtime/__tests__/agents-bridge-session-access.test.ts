import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createBridgeAgentSessionAccess, isAgentSessionAccessError } from "../../bridge/agent-session-access.js";
import { publishRequestAdmissionFailure } from "../../bridge/request-admission-failure.js";
import type { SessionStore } from "../ports.js";
import { agentsWebBoundaryFixture } from "./support/agents-web-boundary-fixture.js";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0)) await release();
  await disposeAgentApplicationFixtures();
});
const ownedError = "agent_session_requires_agents_workspace";
const indexError = "agent_session_index_unavailable";
function socketFixture() {
  const send = vi.fn<(frame:string) => void>();
  return {socket:{send} as unknown as WebSocket,send,frame:() => JSON.parse(send.mock.calls.at(-1)![0])};
}
async function fixture() {
  const bound = await agentsWebBoundaryFixture();
  cleanup.push(bound.dispose);
  const getAllSessions = vi.fn(() => bound.sessions.getAllSessions());
  const getRequestReplayById = vi.fn<SessionStore["getRequestReplayById"]>(async id => ({
    sessionId:id === "old-agent-request" ? "agent-old" : "chat-new",requestId:id,
    events:[],finalState:null,
  }));
  const {handle} = createBridgeAgentSessionAccess(bound.root,{getAllSessions,getRequestReplayById});
  return {...bound,...socketFixture(),getAllSessions,getRequestReplayById,handle};
}

test("ordinary list pagination counts visible sessions, and the final page cannot disclose the size of private history", async () => {
  const f = await fixture();
  const list = {type:"session.list.request",correlationId:"page",limit:2};
  expect(await f.handle(f.socket,list)).toBe(true);
  expect(f.frame()).toMatchObject({type:"session.list.response",correlationId:"page",ok:true,
    sessions:[{id:"chat-new"},{id:"chat-middle"}],nextCursor:"2"});
  await f.handle(f.socket,{...list,cursor:"2"});
  expect(f.frame()).toMatchObject({sessions:[{id:"chat-old"}],nextCursor:null});
  expect(f.getAllSessions).toHaveBeenCalledTimes(2);
});

test("the managed bridge requests one page of ordinary summaries without moving full session histories over IPC", async () => {
  const f = await fixture();
  const page = { sessions: [], nextCursor: "3" };
  const listOrdinary = vi.fn(async () => page);
  const scoped = createBridgeAgentSessionAccess(f.root, { listOrdinary, getAllSessions: f.getAllSessions,
    getRequestReplayById: f.getRequestReplayById });
  await scoped.handle(f.socket, { type: "session.list.request", correlationId: "paged", limit: 1, cursor: "2" });
  expect(f.frame()).toMatchObject({ ok: true, ...page });
  expect(listOrdinary).toHaveBeenCalledWith({ limit: 1, cursor: "2" });
  expect(f.getAllSessions).not.toHaveBeenCalled();
});

test("ordinary session mutations, attachments and approval responses preserve their correlated failure contracts", async () => {
  const f = await fixture();
  const before = await f.sessions.getSessionSnapshot("agent-new",{includeRequests:true});
  const cases = [
    ["session.snapshot.request",{messages:[],requests:[],nextCursor:null}],
    ["session.delete.request",{deleted:false,deletedMessages:0,deletedRequests:0}],
    ["session.messages.clear.request",{cleared:false,deletedRequests:0,deletedMessages:0}],
    ["session.message.delete.request",{deleted:false,messageId:"7"}],
    ["attachment.fetch.request",{attachment:null}],["attachment.upload.request",{attachment:null}],
    ["request.approvals.request",{requestId:"req"}],["request.approval.decide.request",{requestId:"req"}],
  ] as const;
  for (const [type,shape] of cases) {
    const message = {type,correlationId:"same-client-id",sessionId:"agent-new",requestId:"req",messageId:7};
    expect(await f.handle(f.socket,message)).toBe(true);
    expect(f.frame()).toMatchObject({type:type.replace(/\.request$/u,".response"),correlationId:message.correlationId,
      sessionId:message.sessionId,ok:false,error:ownedError,...shape});
    expect(await f.handle(f.socket,{...message,sessionId:"chat-new"})).toBe(false);
  }
  expect(f.getAllSessions).not.toHaveBeenCalled();
  expect(f.getRequestReplayById).not.toHaveBeenCalled();
  expect(await f.sessions.getSessionSnapshot("agent-new",{includeRequests:true})).toEqual(before);
});

test("replay scopes the returned canonical record even when a legacy request has no indexed attempt or a forged public hint", async () => {
  const f = await fixture();
  const replay = {type:"request.events.request",correlationId:"events",requestId:"old-agent-request",afterSeq:17};
  for (const hint of [{},{sessionId:"chat-new"}]) {
    expect(await f.handle(f.socket,{...replay,...hint})).toBe(true);
    expect(f.frame()).toEqual({type:"request.events.response",correlationId:"events",ok:false,requestId:replay.requestId,
      events:[],finalState:null,error:ownedError});
  }
  await f.handle(f.socket,{...replay,requestId:"ordinary"});
  expect(f.frame()).toEqual({type:"request.events.response",correlationId:"events",ok:true,requestId:"ordinary",events:[],finalState:null});
  expect(f.getRequestReplayById).toHaveBeenLastCalledWith("ordinary",17);
  for (const type of ["request.approvals.request","request.approval.decide.request","steer_request"]) {
    expect(await f.handle(f.socket,{type,requestId:replay.requestId,correlationId:"legacy",steerId:"steer"})).toBe(true);
    if (type === "steer_request") expect(f.frame()).toMatchObject({type:"steer_ack",accepted:false,steerId:"steer",reason:ownedError});
    else expect(f.frame()).toMatchObject({correlationId:"legacy",requestId:replay.requestId,ok:false,error:ownedError});
  }
});

test("a persisted Agent attempt also protects request-only or mismatched ordinary run, approval and steering IDs", async () => {
  const app = await agentApplicationFixture();
  await app.app.send("agent-a",{messageId:"task",text:"Inspect current facts.",intent:"task"});
  await app.app.whenIdle();
  const {requestId} = (await app.store.read()).attempts[0]!.request;
  const f = socketFixture();
  const reads = {getAllSessions:vi.fn(),getRequestReplayById:vi.fn()};
  const {handle} = createBridgeAgentSessionAccess(app.dependencies.config.paths.runtimeDir,reads);
  for (const type of ["run_request","request.approvals.request","request.approval.decide.request","steer_request","request.events.request"]) {
    const msg = {type,requestId,sessionId:"unrelated",correlationId:"id",steerId:"s"};
    if (type === "run_request") {
      const failure = await handle(f.socket,msg).catch(error => error);
      expect(isAgentSessionAccessError(failure)).toBe(true);
      publishRequestAdmissionFailure(f.socket,msg,failure);
      expect(f.frame()).toEqual({type:"failed",sessionId:msg.sessionId,requestId,error:ownedError});
    } else {
      expect(await handle(f.socket,msg)).toBe(true);
      expect(f.frame()).toMatchObject(type === "steer_request" ? {accepted:false,reason:ownedError} : {ok:false,error:ownedError});
    }
  }
  const sent = f.send.mock.calls.length;
  expect(await handle(f.socket,{type:"tool_approval_response",approvalId:"old-legacy-id",requestId})).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(sent);
  expect(reads.getRequestReplayById).not.toHaveBeenCalled();
});

test("a corrupted ownership index fails closed with a public error while profile discovery remains available", async () => {
  const f = await fixture();
  await writeFile(join(f.root,"agents","state.json"),"not JSON");
  for (const type of ["session.list.request","session.snapshot.request","request.events.request","attachment.fetch.request","request.approvals.request"]) {
    expect(await f.handle(f.socket,{type,correlationId:"c",sessionId:"chat-old",requestId:"r"})).toBe(true);
    expect(f.frame()).toMatchObject({ok:false,error:indexError,correlationId:"c"});
  }
  expect(await f.handle(f.socket,{type:"runtime.models.request"})).toBe(false);
});

test.each([false, true])("standalone default store is protected with a separate runtime config: %s", async (useConfig) => {
  const f = await agentsWebBoundaryFixture();
  cleanup.push(f.dispose);
  const configured = useConfig ? await agentApplicationFixture() : undefined;
  await configured?.store.commitApplication({ kind: "bind_session", agentId: "agent-a", sessionId: "chat-old", purpose: "Configured owner" });
  const layout = "../config/layout.js";
  vi.resetModules();
  vi.doMock(layout, async () => ({
    ...await vi.importActual<typeof import("../config/layout.js")>(layout),
    getDefaultSessionsDir: () => join(f.root, "sessions"),
  }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let stop: (() => Promise<void>) | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test socket address");
    const { startAgentBridge } = await import("../../bridge/start-agent-bridge.js");
    const connected = once(server, "connection");
    const bridge = startAgentBridge({ url: `ws://127.0.0.1:${address.port}`, token: "test-token", runtimeConfig: configured?.dependencies.config });
    stop = bridge.stop;
    const [socket] = await connected as [WebSocket];
    const [register] = await once(socket, "message");
    expect(JSON.parse(register.toString()).type).toBe("register");
    socket.send(JSON.stringify({ type: "registered", ok: true }));
    async function request(message: object) {
      const response = once(socket, "message", { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ correlationId: "standalone", ...message }));
      const [frame] = await response;
      return JSON.parse(frame.toString());
    }
    expect(await request({ type: "session.list.request", limit: 2 })).toMatchObject({
      ok: true, sessions: [{ id: "chat-new" }, { id: "chat-middle" }], nextCursor: useConfig ? null : "2",
    });
    expect(await request({ type: "session.snapshot.request", sessionId: "chat-old" })).toMatchObject(
      useConfig ? { ok: false, error: ownedError } : { ok: true, messages: [{ text: "Result for chat-old" }] },
    );
    expect(await request({ type: "session.snapshot.request", sessionId: "agent-new" })).toMatchObject({
      ok: false, error: ownedError, messages: [],
    });
    expect(await request({ type: "session.snapshot.request", sessionId: "chat-new" })).toMatchObject({
      ok: true, messages: [{ text: "Result for chat-new" }],
    });
  } finally {
    await stop?.();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.doUnmock(layout);
    vi.resetModules();
  }
});

test("a standalone custom store needs an explicit ownership binding to serve Agents", async () => {
  const { startAgentBridge } = await import("../../bridge/start-agent-bridge.js");
  const remote = vi.fn();
  expect(() => startAgentBridge({
    token: "test-token", agents: { remote }, sessionStore: {} as SessionStore,
  })).toThrow("agents_session_scope_required");
  expect(remote).not.toHaveBeenCalled();
});
