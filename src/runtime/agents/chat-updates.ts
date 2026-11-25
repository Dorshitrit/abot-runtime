import { boundAgentDelegation, hasActiveDelegatedOrigin } from "./delegated-work-origin.js";
import { createHash } from "node:crypto";
import { projectAgentDetail } from "./application-view.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import type { AgentState } from "./agent-records.js";
import type { AgentConversationMessage, AgentWorkAttempt } from "./workspace-records.js";
import type { SessionStore } from "../ports.js";
import { chatUpdate, projectAgentSessionProgress, type AgentChatUpdate, type AgentSessionProgress } from "./session-progress.js";

const FOLLOW_UP_MS = 5 * 60_000;
const MAX_COMPLETED_RECEIPTS = 128;
const MAX_RECENT_AGENT_SNAPSHOTS = 128;
type RecentScope = "history" | "pending";
type WorkPeriod = readonly [number, number | null];
export type AgentProgressUpdate = AgentChatUpdate & Readonly<{
  sourceAgentId?: string; sourceAgentName?: string; sourceMissionId?: string; exchangeId?: string;
}>;
type ActiveWork = { workId: string; workKind: "work_session" | "delegation"; workUsage: AgentSessionProgress["workUsage"] };
type CollectedProgress = { updates: AgentProgressUpdate[]; active: ActiveWork | null; parked: boolean; work: WorkPeriod[]; complete: boolean };

function recentReports(updates: readonly AgentProgressUpdate[]) {
  return [...new Map(updates.map(update => [update.id, update])).values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 10);
}

function publishedMissions(detail: AgentApplicationDetail, state: AgentState, onlyMission?: string) {
  return new Set(detail.messages.filter(message => hasPublishedWorkOrigin(message, detail.agent.id, state))
    .filter(message => !onlyMission || message.missionId === onlyMission).map(message => message.missionId));
}

function recentAttemptIncluded(attempt: AgentWorkAttempt, scope?: RecentScope) {
  if (!scope) return true;
  // A pre-admission failure can settle without a receipt. Refresh it separately
  // so missing request evidence cannot disable the cache for confirmed history.
  const hasHistoryReceipt = attempt.status === "settled" && Boolean(attempt.result?.receiptId);
  return hasHistoryReceipt === (scope === "history");
}

function activeMission(detail: AgentApplicationDetail) {
  if (detail.mission?.status !== "active" || detail.agent.status !== "active") return null;
  return detail.status === "working" || detail.status === "thinking" ? detail.mission.id : null;
}

function modelReports(detail: AgentApplicationDetail, state: AgentState, missions: ReadonlySet<string>) {
  const updates: AgentChatUpdate[] = [];
  const admitted = new Set<string>();
  for (const trace of detail.responsibility) {
    if (trace.agentId !== detail.agent.id || !missions.has(trace.missionId) || !trace.accepted || admitted.has(trace.missionId)) continue;
    if (!["start_session", "continue_session", "delegate_agent"].includes(trace.plan.action)) continue;
    admitted.add(trace.missionId);
    if (trace.plan.publicUpdate) updates.push(chatUpdate(trace.missionId, [trace.id, "admission"], trace.createdAt, trace.plan.publicUpdate));
  }
  for (const call of state.invocations) {
    if (call.agentId === detail.agent.id && missions.has(call.missionId) && call.stage === "progress_report" && call.status === "settled" && call.publicUpdate)
      updates.push(chatUpdate(call.missionId, [call.id, "progress_report"], call.updatedAt, call.publicUpdate));
  }
  return updates;
}

function hasPublishedWorkOrigin(message: AgentConversationMessage, agentId: string, state: AgentState): boolean {
  if (message.agentId !== agentId || message.purpose !== "request") return false;
  if (message.role === "user" && message.source === null) return true;
  if (message.role !== "abot" || !message.source) return false;
  const exchange = state.mailbox.find(entry => entry.id === message.source!.correlationId);
  if (!exchange) return false;
  const receipt = boundAgentDelegation(state, exchange)?.message;
  return receipt?.id === message.id && receipt.missionId === message.missionId && receipt.agentId === agentId;
}

export function hasOutstandingDelegation(state: AgentState, agentId: string, missionId: string): boolean {
  return state.mailbox.some(exchange => exchange.agentId === agentId && exchange.missionId === missionId && exchange.status !== "answered");
}

/** Only public reports cross an exact delegation binding; private peer dialogue stays private. */
export function createAgentChatUpdates(sessions: Pick<SessionStore, "getSessionById">) {
  const completed = new Map<string, AgentSessionProgress>();
  const recentHistory = new Map<string, { signature: string; updates: AgentProgressUpdate[] }>();
  const reads = new Map<string, ReturnType<SessionStore["getSessionById"]>>();
  function retainRecentHistory(agentId: string, history: { signature: string; updates: AgentProgressUpdate[] }, complete: boolean) {
    recentHistory.delete(agentId);
    if (!complete) return;
    if (recentHistory.size >= MAX_RECENT_AGENT_SNAPSHOTS) recentHistory.delete(recentHistory.keys().next().value!);
    recentHistory.set(agentId, history);
  }
  function readSession(id: string) {
    const inFlight = reads.get(id);
    if (inFlight) return inFlight;
    const pending = sessions.getSessionById(id).finally(() => reads.delete(id));
    reads.set(id, pending);
    return pending;
  }
  async function collect(detail: AgentApplicationDetail, state: AgentState, onlyMission?: string, visited = new Set<string>(), recentScope?: RecentScope): Promise<CollectedProgress> {
    const agentId = detail.agent.id;
    const published = publishedMissions(detail, state, onlyMission);
    const owned = new Set(detail.sessions.filter((binding) => binding.agentId === agentId).map((binding) => binding.sessionId));
    const updates: AgentProgressUpdate[] = recentScope === "pending" ? [] : modelReports(detail, state, published);
    const bySession = new Map<string, AgentWorkAttempt[]>();
    const work: WorkPeriod[] = [];
    let active: ActiveWork | null = null;
    let parked = false;
    let complete = true;
    for (const attempt of detail.attempts) {
      if (!recentAttemptIncluded(attempt, recentScope)) continue;
      if (attempt.agentId !== agentId || !published.has(attempt.missionId) || !owned.has(attempt.request.sessionId) || !attempt.claimId) continue;
      if (attempt.status === "unknown" || attempt.status === "awaiting_approval") parked = true;
      const group = bySession.get(attempt.request.sessionId) ?? [];
      group.push(attempt); bySession.set(attempt.request.sessionId, group);
    }
    for (const [sessionId, attempts] of bySession) {
      // Missing optional presentation evidence must never prevent an Agent chat from opening.
      let read: Promise<Awaited<ReturnType<typeof readSession>> | null> | undefined;
      for (const attempt of attempts) {
        const key = JSON.stringify([agentId, attempt.id, sessionId, attempt.request.requestId, attempt.result?.receiptId]);
        let progress = recentScope ? undefined : completed.get(key);
        if (!progress) {
          read ??= readSession(sessionId).catch(() => null);
          progress = projectAgentSessionProgress(await read, attempt) ?? undefined;
          if (!progress) { complete = false; continue; }
          if (!recentScope && attempt.status === "settled" && attempt.result?.receiptId && ["completed", "failed"].includes(progress.status)) {
            if (completed.size >= MAX_COMPLETED_RECEIPTS) completed.delete(completed.keys().next().value!);
            completed.set(key, progress);
          }
        }
        if (recentScope === "history" && (!attempt.result?.receiptId || !["completed", "failed"].includes(progress.status))) complete = false;
        updates.push(...progress.updates);
        if (onlyMission) {
          work.push(...progress.periods);
          if (attempt.status !== "claimed" && attempt.status !== "running") continue;
          if (progress.status === "awaiting_approval") parked = true;
          if (progress.status === "streaming") active = { workId: attempt.id, workKind: "work_session", workUsage: progress.workUsage };
        }
      }
    }
    for (const missionId of recentScope ? [] : published) {
      const identity = JSON.stringify([agentId, missionId]);
      if (visited.has(identity)) continue;
      visited.add(identity);
      for (const exchange of state.mailbox) {
        if (exchange.agentId !== agentId || exchange.missionId !== missionId) continue;
        const binding = boundAgentDelegation(state, exchange);
        if (!binding || visited.has(JSON.stringify([binding.agent.id, binding.mission.id]))) continue;
        const child = projectAgentDetail(state, binding.agent.id, false);
        const forwarded = await collect(child, state, binding.mission.id, visited);
        for (const update of forwarded.updates) updates.push({
          ...chatUpdate(missionId, [exchange.id, "delegated", update.id], update.createdAt, update.text),
          sourceAgentId: update.sourceAgentId ?? binding.agent.id,
          sourceAgentName: update.sourceAgentName ?? binding.agent.definition.name,
          sourceMissionId: update.sourceMissionId ?? binding.mission.id,
          exchangeId: exchange.id,
        });
      }
    }
    updates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return { updates, active, parked, work, complete };
  }
  async function project(detail: AgentApplicationDetail, state: AgentState) {
    return (await collect(detail, state)).updates;
  }
  /** Local catalogue keeps originals only; pending session events are independent of Agent revisions. */
  async function recent(detail: AgentApplicationDetail, state: AgentState) {
    const published = publishedMissions(detail, state);
    const owned = new Set(detail.sessions.filter(binding => binding.agentId === detail.agent.id).map(binding => binding.sessionId));
    const retained = detail.attempts.filter(attempt => recentAttemptIncluded(attempt, "history") && attempt.agentId === detail.agent.id &&
      published.has(attempt.missionId) && owned.has(attempt.request.sessionId) && attempt.claimId);
    const signature = createHash("sha256").update(JSON.stringify([
      [...published], [...owned], modelReports(detail, state, published),
      retained.map(attempt => [attempt.id, attempt.missionId, attempt.claimId, attempt.request.sessionId,
        attempt.request.requestId, attempt.createdAt, attempt.result?.receiptId]),
    ])).digest("hex");
    let history = recentHistory.get(detail.agent.id);
    if (history?.signature !== signature) {
      const collected = await collect(detail, state, undefined, new Set(), "history");
      history = { signature, updates: recentReports(collected.updates) };
      retainRecentHistory(detail.agent.id, history, collected.complete);
    }
    const pending = await collect(detail, state, undefined, new Set(), "pending");
    return recentReports([...history.updates, ...pending.updates]);
  }
  async function latest(detail: AgentApplicationDetail, state: AgentState) {
    const missionId = activeMission(detail);
    if (!missionId) return null;
    const { updates, parked } = await collect(detail, state, missionId);
    return parked ? null : updates.at(-1) ?? null;
  }
  async function checkpoint(detail: AgentApplicationDetail, state: AgentState, now = Date.now()) {
    const missionId = activeMission(detail);
    if (!missionId || hasOutstandingDelegation(state, detail.agent.id, missionId)) return null;
    const assignment = detail.messages.find(message => message.missionId === missionId && message.role === "abot" && message.purpose === "request");
    if (assignment && !hasActiveDelegatedOrigin(state, assignment)) return null;
    const { updates, work, active, parked } = await collect(detail, state, missionId);
    if (parked || !active) return null;
    if (active.workKind === "work_session" && !active.workUsage) return null;
    const last = updates.at(-1);
    const due = fiveMinuteCheckpoint(work, now, last ? Date.parse(last.createdAt) : -Infinity);
    if (due === null) return null;
    return { agentId: detail.agent.id, missionId, ...active, dueAt: new Date(due).toISOString(),
      ...(last ? { lastUpdateId: last.id, lastUpdateText: last.text } : {}) };
  }
  return Object.assign(project, { latest, checkpoint, recent });
}

/** Count the union of confirmed work intervals after the most recent published report. */
function fiveMinuteCheckpoint(periods: WorkPeriod[], now: number, after: number): number | null {
  let elapsed = 0, priorEnd = after;
  for (const [from, until] of periods.sort(([a], [b]) => a - b)) {
    const start = Math.max(from, priorEnd), end = Math.min(until ?? now, now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (elapsed + end - start >= FOLLOW_UP_MS) return start + FOLLOW_UP_MS - elapsed;
    elapsed += end - start;
    priorEnd = end;
  }
  return null;
}
