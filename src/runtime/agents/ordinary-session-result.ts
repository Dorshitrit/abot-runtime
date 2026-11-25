import type { SessionRequestReplay } from "../../sessions/types.js";
import type { AgentWorkRequest, AgentWorkResult } from "./application-contracts.js";
import { ordinarySessionUsage } from "./ordinary-session-usage.js";

export function unknownOrdinarySessionResult(error = "The existing session has no verifiable result yet."): AgentWorkResult {
  return { status: "unknown", output: null, error, usage: null, receiptId: null };
}
function matchesRequestedSession(request: AgentWorkRequest, replay: SessionRequestReplay): boolean {
  if (replay.requestId !== request.requestId) return false;
  if (replay.sessionId !== request.sessionId) return false;
  return true;
}
function hasConflictingTerminalIdentity(request: AgentWorkRequest, replay: SessionRequestReplay): boolean {
  const terminal = replay.events.filter((event) => event.type === "completed" || event.type === "failed").at(-1);
  if (!terminal) return replay.finalState !== null;
  if (terminal.requestId !== request.requestId) return true;
  if (terminal.sessionId !== undefined && terminal.sessionId !== request.sessionId) return true;
  if (terminal.generation !== undefined && terminal.generation !== replay.generation) return true;
  if (replay.finalState && terminal.type !== replay.finalState.status) return true;
  return false;
}
function ordinaryReceiptId(replay: SessionRequestReplay): string | null {
  if (!replay.generation) return null;
  const last = replay.finalState ? replay.events.filter((event) => event.type === "completed" || event.type === "failed").at(-1) : replay.events.at(-1);
  const sequence = typeof last?.seqNo === "number" ? last.seqNo : replay.lifecycle?.revision;
  return `${replay.requestId}:${replay.generation}:${sequence ?? "snapshot"}`;
}

/** A finished request is evidence to evaluate, not an Agent mission completion. */
export function projectOrdinarySessionResult(request: AgentWorkRequest, replay: SessionRequestReplay | null): AgentWorkResult {
  if (!replay) return unknownOrdinarySessionResult();
  if (!matchesRequestedSession(request, replay)) return unknownOrdinarySessionResult("The request receipt belongs to a different session.");
  if (hasConflictingTerminalIdentity(request, replay)) return unknownOrdinarySessionResult("The request terminal identity could not be verified.");
  const base = { output: null, error: null, usage: ordinarySessionUsage(request.requestId, replay.events), receiptId: ordinaryReceiptId(replay) };
  if (replay.lifecycle?.status === "awaiting_approval") return { ...base, status: "awaiting_approval" };
  const final = replay.finalState;
  if (!final) return { ...base, status: "running" };
  if (replay.lifecycle && replay.lifecycle.status !== final.status)
    return unknownOrdinarySessionResult("The session and terminal receipt disagree.");
  if (final.status === "completed") {
    const output = typeof final.output === "string" ? final.output : null;
    if (final.disposition === "blocked") return { ...base, status: "failed", output, error: "request_blocked" };
    return { ...base, status: "completed", output };
  }
  const error = typeof final.error === "string" ? final.error : "request_failed";
  const cancelled = replay.lifecycle?.terminalCause === "request_cancelled" || error === "request_cancelled";
  return { ...base, status: cancelled ? "cancelled" : "failed", error, output: final.details?.stoppedResponse ?? null };
}
