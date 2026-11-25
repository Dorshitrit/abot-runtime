import type { SessionRecord, SessionRequestRecord } from "../../sessions/types.js";
import { ordinarySessionUsageLowerBound } from "./ordinary-session-usage.js";
import type { AgentWorkResult } from "./application-contracts.js";
import type { AgentWorkAttempt } from "./workspace-records.js";
import { SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH } from "../steps/supervisor-decision/contracts.js";
import { hasUserInteractionBinding, isUserInteractionMessageText } from "../user-interactions/snapshot.js";

export type AgentChatUpdate = Readonly<{ id: string; missionId: string; createdAt: string; text: string }>;
export type AgentSessionProgress = Readonly<{
  updates: readonly AgentChatUpdate[];
  status: SessionRequestRecord["status"];
  workUsage: AgentWorkResult["usage"];
  periods: readonly (readonly [number, number | null])[];
}>;

export function chatUpdate(missionId: string, identity: readonly string[], createdAt: string, text: string): AgentChatUpdate {
  return { id: JSON.stringify(["agent-update", missionId, ...identity]), missionId, createdAt, text };
}

function publicInteraction(value: unknown, requestId: string) {
  if (!value || typeof value !== "object") return;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1 || receipt.kind !== "message" || receipt.requestId !== requestId ||
    typeof receipt.interactionId !== "string" || !receipt.interactionId.trim() ||
    !Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) < 1 ||
    !hasUserInteractionBinding(receipt.origin) || typeof receipt.createdAt !== "string") return;
  const at = Date.parse(receipt.createdAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== receipt.createdAt) return;
  const payload = receipt.payload;
  if (!payload || typeof payload !== "object" || !("text" in payload) || !isUserInteractionMessageText(payload.text)) return;
  return { interactionId: receipt.interactionId, createdAt: receipt.createdAt, text: payload.text };
}

function ownedRequest(session: SessionRecord | null, attempt: AgentWorkAttempt): SessionRequestRecord | undefined {
  const { sessionId, requestId } = attempt.request;
  if (session?.id !== sessionId) return;
  const request = session.requests?.find((entry) => entry.requestId === requestId && entry.sessionId === sessionId);
  if (!request?.generation || !Number.isFinite(Date.parse(request.createdAt))) return;
  // A retained Agent receipt binds the request generation. A fresh claim establishes
  // no receipt until the ordinary owner acknowledges this exact session and request.
  if (attempt.result?.receiptId && !attempt.result.receiptId.startsWith(`${requestId}:${request.generation}:`)) return;
  if (Date.parse(request.createdAt) < Date.parse(attempt.createdAt)) return;
  return request;
}

export function projectAgentSessionProgress(session: SessionRecord | null, attempt: AgentWorkAttempt): AgentSessionProgress | null {
  const request = ownedRequest(session, attempt);
  if (!request) return null;
  const { missionId } = attempt;
  const key = [attempt.id, request.generation!];
  const updates = new Map<string, AgentChatUpdate>();
  for (const event of request.events) {
    if (event.type !== "event" || event.requestId !== request.requestId) continue;
    const data = event.payload;
    if ((data.requestId !== undefined && data.requestId !== request.requestId) ||
        (data.sessionId !== undefined && data.sessionId !== request.sessionId) ||
        (data.generation !== undefined && data.generation !== request.generation)) continue;
    if (data.name === "thinking.delta" && (!data.eventName || data.eventName === data.name) && data.presentationKind === "acknowledgement") {
      // SUPER emits one complete public acknowledgement per generation. Other thinking is private.
      if (data.requestId !== request.requestId || data.sessionId !== request.sessionId || data.generation !== request.generation) continue;
      const text = typeof data.text === "string" ? data.text.trim() : typeof data.delta === "string" ? data.delta.trim() : "";
      if (text.length < 2 || text.length > SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH || !Number.isSafeInteger(event.seqNo) || event.seqNo <= 0 || !Number.isFinite(Date.parse(event.timestamp))) continue;
      const update = chatUpdate(missionId, [...key, "acknowledgement"], event.timestamp, text);
      if (!updates.has(update.id)) updates.set(update.id, update);
      continue;
    }
    if (data.name !== "user.interaction") continue;
    const published = publicInteraction(data.interaction, event.requestId);
    if (!published) continue;
    const update = chatUpdate(missionId, [...key, "interaction", published.interactionId], published.createdAt, published.text);
    if (!updates.has(update.id)) updates.set(update.id, update);
  }
  return { updates: [...updates.values()], status: request.status, workUsage: confirmedWorkUsage(request), periods: workPeriods(request) };
}

/** Live lower bound for optional presentation spending; never a mission accounting receipt. */
function confirmedWorkUsage(request: SessionRequestRecord): AgentWorkResult["usage"] {
  const receipts: Record<string, unknown>[] = [];
  for (const event of request.events) {
    if (event.requestId !== request.requestId || event.type !== "event") continue;
    const data = event.payload;
    if (data.name !== "context.window.snapshot" && data.name !== "context.window.provider_usage") continue;
    if (data.requestId !== request.requestId || data.sessionId !== request.sessionId || data.generation !== request.generation) return null;
    receipts.push(data);
  }
  return ordinarySessionUsageLowerBound(request.requestId, receipts);
}

/** Rebuild confirmed streaming intervals from the owner's durable approval boundaries. */
function workPeriods(request: SessionRequestRecord): (readonly [number, number | null])[] {
  const boundaries: { at: number; active: boolean }[] = [];
  const waits = new Set<string>();
  for (const event of request.events) {
    const data = event.payload;
    if (event.requestId !== request.requestId || data.name !== "request.lifecycle.changed" || data.generation !== request.generation) continue;
    const phase = data.lifecycle as { generation?: string; requestId?: string; sessionId?: string; status?: string; wait?: { waitId?: string; createdAt?: string } } | undefined;
    if (phase?.requestId !== request.requestId || phase.sessionId !== request.sessionId || phase.generation !== request.generation || phase.status !== "awaiting_approval") continue;
    if (phase.wait?.waitId && phase.wait.createdAt) {
      waits.add(phase.wait.waitId);
      boundaries.push({ at: Date.parse(phase.wait.createdAt), active: false });
    }
  }
  let start = Date.parse(request.createdAt);
  for (const decision of request.lifecycle?.decisionReceipts ?? []) {
    if (!decision.activation || decision.requestId !== request.requestId || decision.generation !== request.generation) continue;
    const at = Date.parse(decision.committedAt);
    if (!waits.has(decision.waitId)) start = Math.max(start, at); // Legacy receipt without its pause boundary.
    boundaries.push({ at, active: true });
  }
  if (request.status === "awaiting_approval" && request.lifecycle?.wait)
    boundaries.push({ at: Date.parse(request.lifecycle.wait.createdAt), active: false });
  const periods: [number, number | null][] = [];
  let opened: number | null = start;
  for (const boundary of boundaries.sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(boundary.at) || boundary.at < start) continue;
    if (boundary.active) { opened ??= boundary.at; continue; }
    if (opened !== null) periods.push([opened, boundary.at]);
    opened = null;
  }
  if (opened !== null && Number.isFinite(opened)) {
    if (request.status === "streaming") periods.push([opened, null]);
    else if (["completed", "failed"].includes(request.status)) periods.push([opened, Date.parse(request.updatedAt)]);
  }
  return periods;
}
