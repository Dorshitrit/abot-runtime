import { dirname, resolve } from "node:path";
import type WebSocket from "ws";
import { readAgentAssociations } from "../runtime/agents/session-association.js";
import type { SessionStore } from "../runtime/ports.js";
import * as defaultSessions from "../sessions/index.js";
import { normalizeCursor, normalizeLimit, toSessionListItem } from "../sessions/record/projection.js";
import { approvalResponseIdentity } from "./request-approval-protocol.js";
import { handleRuntimeReplayBridgeMessage } from "./runtime-replay.js";
import type { AgentBridgeOptions } from "./start-agent-bridge.js";

class BridgeAgentSessionAccessError extends Error {}

export function isAgentSessionAccessError(error: unknown): error is Error {
  return error instanceof BridgeAgentSessionAccessError;
}

type Associations = Awaited<ReturnType<typeof readAgentAssociations>>;
function assertOrdinary(index: Associations, sessionId: unknown, requestId: unknown) {
  const owned = (set: ReadonlySet<string>, id: unknown) => typeof id === "string" && (set.has(id) || set.has(id.trim()));
  if (owned(index.sessionIds, sessionId) || owned(index.requestIds, requestId)) {
    throw new BridgeAgentSessionAccessError("agent_session_requires_agents_workspace");
  }
}

const replayMutations = new Set(["session.snapshot.request", "session.delete.request",
  "session.messages.clear.request", "session.message.delete.request"]);
const controls = new Set(["request.approvals.request", "request.approval.decide.request",
  "steer_request", "tool_approval_response", "run_request", "attachment.upload.request", "attachment.fetch.request"]);

export function bindBridgeAgentSessionAccess(options: Pick<AgentBridgeOptions, "runtimeConfig" | "sessionStore" | "agents">) {
  if (!options.runtimeConfig && options.sessionStore) {
    if (options.agents) throw new Error("agents_session_scope_required");
    return undefined;
  }
  return createBridgeAgentSessionAccess(options.runtimeConfig?.paths.runtimeDir, options.sessionStore);
}

export function createBridgeAgentSessionAccess(runtimeDir = dirname(defaultSessions.defaultSessionsDir), sessions: Pick<SessionStore,
  "getAllSessions" | "getRequestReplayById" | "listOrdinary"> = defaultSessions) {
  // Standalone replay uses the global session store even if a separate runtime config was supplied.
  const replayRuntimeDir = sessions === defaultSessions ? dirname(defaultSessions.defaultSessionsDir) : runtimeDir;
  const distinctReplayRoot = resolve(replayRuntimeDir) !== resolve(runtimeDir);
  async function associations(): Promise<Associations> {
    try {
      if (!distinctReplayRoot) return await readAgentAssociations(runtimeDir);
      const [runtime, replay] = await Promise.all([readAgentAssociations(runtimeDir), readAgentAssociations(replayRuntimeDir)]);
      return {
        sessionIds: new Set([...runtime.sessionIds, ...replay.sessionIds]),
        requestIds: new Set([...runtime.requestIds, ...replay.requestIds]),
      };
    } catch { throw new BridgeAgentSessionAccessError("agent_session_index_unavailable"); }
  }
  const scopedReplay = {
    ...defaultSessions,
    async listSessions(params?: {limit?:number; cursor?:string|null}) {
      if (sessions.listOrdinary) return sessions.listOrdinary(params);
      const records = await sessions.getAllSessions();
      // Read the ownership index after enumeration. The Agent durably binds a session before creating it.
      const index = await associations();
      const visible = records.filter(record => !index.sessionIds.has(record.id));
      const offset = normalizeCursor(params?.cursor);
      const page = visible.slice(offset, offset + normalizeLimit(params?.limit));
      const next = offset + page.length;
      return {sessions:page.map(toSessionListItem), nextCursor:next < visible.length ? String(next) : null};
    },
    async getRequestReplayById(requestId: string, afterSeq?: number, sessionHint?: string) {
      assertOrdinary(await associations(), sessionHint, requestId);
      const result = await sessions.getRequestReplayById(requestId, afterSeq);
      if (result) assertOrdinary(await associations(), result.sessionId, result.requestId);
      return result;
    },
  };

  return {
    async handle(socket: WebSocket, message: Record<string, unknown>): Promise<boolean> {
      const type = message.type;
      if (type === "session.list.request") {
        return handleRuntimeReplayBridgeMessage(socket, message, {sessionStore:scopedReplay});
      }
      if (type === "request.events.request") {
        const hint = typeof message.sessionId === "string" ? message.sessionId : undefined;
        return handleRuntimeReplayBridgeMessage(socket, message, {sessionStore:{...scopedReplay,
          getRequestReplayById:(id, after) => scopedReplay.getRequestReplayById(id, after, hint)}});
      }
      if (typeof type !== "string" || !replayMutations.has(type) && !controls.has(type)) return false;
      // Legacy tool approval IDs refer only to prompts opened by this bridge connection.
      if (type === "tool_approval_response" && !message.requestId && !message.sessionId) return false;
      try {
        const index = await associations();
        assertOrdinary(index, message.sessionId, message.requestId);
        // Legacy sessions may have requests predating the Agent attempt index.
        if (index.sessionIds.size && typeof message.requestId === "string" && message.requestId.trim() &&
            (type === "request.approvals.request" || type === "request.approval.decide.request" || type === "steer_request") &&
            !(typeof message.sessionId === "string" && message.sessionId.trim())) {
          const replay = await sessions.getRequestReplayById(message.requestId, Number.MAX_SAFE_INTEGER)
            .catch(() => { throw new BridgeAgentSessionAccessError("agent_session_index_unavailable"); });
          if (replay) assertOrdinary(await associations(), replay.sessionId, replay.requestId);
        }
      }
      catch (error) {
        if (!isAgentSessionAccessError(error)) throw error;
        if (replayMutations.has(type)) {
          // Reuse the ordinary protocol's validation and correlation/error shapes, with no store access.
          const deny = async (): Promise<never> => { throw error; };
          return handleRuntimeReplayBridgeMessage(socket, message, {sessionStore:{
            listSessions:deny, getRequestReplayById:deny, getSessionSnapshot:deny, deleteSessionWithStats:deny,
            clearSessionMessages:deny, deleteMessageWithStats:deny,
          }});
        }
        // The bridge's admission failure publisher formats both ordinary and command failures.
        if (type === "run_request") throw error;
        if (type === "steer_request") {
          socket.send(JSON.stringify({type:"steer_ack",requestId:message.requestId,steerId:message.steerId,accepted:false,reason:error.message}));
        } else if (type === "attachment.upload.request" || type === "attachment.fetch.request") {
          const {correlationId, sessionId} = approvalResponseIdentity(message);
          socket.send(JSON.stringify({type:type.replace(/\.request$/u,".response"),correlationId,sessionId,ok:false,attachment:null,error:error.message}));
        } else if (type !== "tool_approval_response") {
          socket.send(JSON.stringify({type:type.replace(/\.request$/u,".response"),...approvalResponseIdentity(message),ok:false,error:error.message}));
        }
        return true;
      }
      return false;
    },
  };
}
