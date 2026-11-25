import { randomUUID } from "node:crypto";
import { AGENT_WRAP_UP_GUIDANCE } from "./work-guidance.js";
import { ordinarySessionUsageLowerBound } from "./ordinary-session-usage.js";
import type WebSocket from "ws";
import type { RuntimeRequestHandler } from "../composition.js";
import type { LocalPendingToolApproval, LocalToolApprovalDecisionInput, LocalToolApprovalDecisionResult } from "../local-host/request-approval-contracts.js";
import type { SessionStore, ToolApprovalController } from "../ports.js";
import type { AgentWorkPort, AgentWorkRequest, AgentWorkResult } from "./application-contracts.js";
import { projectOrdinarySessionResult, unknownOrdinarySessionResult } from "./ordinary-session-result.js";

type OrdinarySessions = Pick<SessionStore, "getOrCreateSession" | "getSessionById" | "getRequestReplayById">;
type OrdinaryApprovalDecision = Omit<LocalToolApprovalDecisionInput, "sessionId" | "requestId">;
export type OrdinaryAgentSessionPort = AgentWorkPort & Readonly<{
  listApprovals(request: AgentWorkRequest): Promise<readonly LocalPendingToolApproval[]>;
  decideApproval(request: AgentWorkRequest, decision: OrdinaryApprovalDecision): Promise<LocalToolApprovalDecisionResult>;
  subscribeEvents(listener: (event: Record<string, unknown>) => void): () => void;
}>;

/** Ordinary client view: approval authority and continuation stay with the existing owner. */
const waitingApprovalView: ToolApprovalController = {
  requestToolApproval(_request, options) {
    return new Promise((resolve) => {
      const retired = () => resolve({ approved: false, reason: "Agent approval view detached." });
      if (options?.abortSignal?.aborted) { retired(); return; }
      options?.abortSignal?.addEventListener("abort", retired, { once: true });
    });
  },
};

/** Agent module owns dispatch idempotency. This port calls the unchanged client exactly once. */
export function createOrdinaryAgentSessionPort(input: Readonly<{
  sessions: OrdinarySessions;
  requests: RuntimeRequestHandler;
  onEvent?: (request: AgentWorkRequest, event: Record<string, unknown>) => void;
}>): OrdinaryAgentSessionPort {
  async function inspect(request: AgentWorkRequest): Promise<AgentWorkResult> {
    try {
      const replay = await input.sessions.getRequestReplayById(request.requestId, 0, request.sessionId);
      return projectOrdinarySessionResult(request, replay);
    } catch { return unknownOrdinarySessionResult("The existing session could not be read."); }
  }
  function socket(request: AgentWorkRequest): WebSocket {
    return { send(raw: string) {
      if (!input.onEvent) return;
      try {
        const event: unknown = JSON.parse(raw);
        if (!event || typeof event !== "object" || Array.isArray(event)) return;
        const message = event as Record<string, unknown>;
        if (message.requestId !== request.requestId) return;
        input.onEvent(request, message);
      } catch { /* A client presentation failure cannot alter execution. */ }
    } } as WebSocket;
  }
  return Object.freeze({
    async createSession(request) {
      if (await input.sessions.getSessionById(request.sessionId)) throw new Error("agents_work_session_already_exists");
      await input.sessions.getOrCreateSession(request.sessionId);
    },
    async run(request, signal) {
      signal.throwIfAborted();
      const existing = await input.sessions.getSessionById(request.sessionId);
      if (!existing || existing.id !== request.sessionId) throw new Error("agents_work_session_missing");
      try {
        await input.requests.handle(socket(request), {
          type: "run_request", requestId: request.requestId, sessionId: request.sessionId,
          text: request.assignment, agentMode: "reasoning",
          modelPreference: { profileId: request.modelProfileId, scope: "all" },
          toolPermissionMode: request.toolPermissionMode,
        }, { abortSignal: signal, durableApprovals: true, toolApprovalController: waitingApprovalView });
      } catch {
        // A transport error may follow committed work. Never resend or infer failure.
      }
      return inspect(request);
    },
    inspect,
    async inspectUsage(request) {
      const replay = await input.sessions.getRequestReplayById(request.requestId, 0, request.sessionId);
      if (!replay || replay.requestId !== request.requestId || replay.sessionId !== request.sessionId || !replay.generation) return null;
      const events = replay.events.filter(event => event.name === "context.window.snapshot" || event.name === "context.window.provider_usage");
      if (events.some(event => event.requestId !== request.requestId || event.sessionId !== request.sessionId || event.generation !== replay.generation)) return null;
      return ordinarySessionUsageLowerBound(request.requestId, events);
    },
    async adviseWrapUp(request) {
      if (!input.requests.steer) return "unavailable";
      const replay = await input.sessions.getRequestReplayById(request.requestId, 0, request.sessionId);
      if (!replay || replay.requestId !== request.requestId || replay.sessionId !== request.sessionId || !replay.generation) return "unavailable";
      const lifecycle = replay.lifecycle;
      if (!lifecycle || lifecycle.requestId !== request.requestId || lifecycle.sessionId !== request.sessionId ||
        lifecycle.generation !== replay.generation || replay.finalState) return "unavailable";
      if (lifecycle.status === "awaiting_approval") return "deferred";
      if (lifecycle.status !== "streaming" || !lifecycle.activation) return "unavailable";
      if (replay.events.some(event => event.type === "completed" || event.type === "failed" ||
        (event.requestId !== undefined && event.requestId !== request.requestId) ||
        (event.sessionId !== undefined && event.sessionId !== request.sessionId) ||
        (event.generation !== undefined && event.generation !== replay.generation))) return "unavailable";
      const result = await input.requests.steer(request.requestId, {
        steerId: `agent-wrap-up:${request.attemptId}`, text: AGENT_WRAP_UP_GUIDANCE,
      });
      if (result.ok) return "accepted";
      return result.reason === "request_not_active" ? "deferred" : "unavailable";
    },
    async cancel(request) {
      if (!input.requests.cancel) return unknownOrdinarySessionResult("The existing runtime does not expose cancellation.");
      const replay = await input.sessions.getRequestReplayById(request.requestId, 0, request.sessionId);
      if (replay && (replay.sessionId !== request.sessionId || replay.requestId !== request.requestId))
        return unknownOrdinarySessionResult("The cancellation target could not be verified.");
      const current = replay?.lifecycle;
      const wait = current?.status === "awaiting_approval" && current.wait ? {
        generation: current.generation, waitId: current.wait.waitId, revision: current.revision, commandId: randomUUID(),
      } : undefined;
      await input.requests.cancel(request.requestId, request.sessionId, wait);
      return inspect(request);
    },
    async listApprovals(request) {
      const controls = input.requests.approvalControls;
      if (!controls) return [];
      return (await controls.list(request.sessionId)).filter((entry) => entry.sessionId === request.sessionId && entry.request.requestId === request.requestId);
    },
    async decideApproval(request, decision) {
      const controls = input.requests.approvalControls;
      if (!controls) return { accepted: false, reason: "approval_resume_unavailable" };
      return controls.decide({ ...decision, sessionId: request.sessionId, requestId: request.requestId });
    },
    subscribeEvents(listener) { return input.requests.approvalControls?.subscribeEvents(listener) ?? (() => {}); },
  } satisfies OrdinaryAgentSessionPort);
}
