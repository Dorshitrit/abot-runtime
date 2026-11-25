import type { AgentApplicationDependencies, AgentApplicationDetail } from "./application-contracts.js";
import type { AgentWorkAttempt } from "./workspace-records.js";
import { UNKNOWN_AGENT_WORK } from "./application-dispatch.js";
import { agentBudgetStopReason } from "./live-budget-monitor.js";

/** A cancelled mission may still own a request whose final receipt arrives later. */
export function hasAgentWorkToReconcile(detail: AgentApplicationDetail): boolean {
  if (detail.mission?.status === "awaiting_user_decision" && agentBudgetStopReason(detail.mission)) return true;
  if (detail.attempts?.some(needsReceiptReconciliation)) return true;
  if (detail.mailbox?.some(exchange => exchange.status !== "answered")) return true;
  return detail.mission?.status === "active" && ["working", "awaiting_approval"].includes(detail.status);
}

function needsReceiptReconciliation(attempt: AgentWorkAttempt): boolean {
  if (!attempt.claimId || attempt.userResolved) return false;
  return attempt.status === "settled" ? attempt.result?.usage === null && !!attempt.result.receiptId : attempt.status !== "prepared";
}

/** Observe only existing exact requests, including historical cancelled/paused work. Never redispatch. */
export async function reconcileAgentWork(deps: AgentApplicationDependencies, agentId: string, liveMissionId?: string): Promise<ReadonlySet<string>> {
  const state = await deps.store.read();
  const settled = new Set<string>();
  for (const attempt of state.attempts) {
    if (attempt.agentId !== agentId || !needsReceiptReconciliation(attempt)) continue;
    const result = await deps.work.inspect(attempt.request).catch(() => UNKNOWN_AGENT_WORK);
    // The live dispatch can be between durable claim and request admission. A missing replay
    // there is not proof of an uncertain execution or permission to park the mission.
    if (result.status === "unknown" && attempt.missionId === liveMissionId) continue;
    await deps.store.commitApplication({ kind: "observe_agent_work", agentId, attemptId: attempt.id, result });
    if (attempt.status !== "settled" && ["completed", "failed", "cancelled"].includes(result.status)) settled.add(attempt.missionId);
  }
  const latest = await deps.store.read();
  for (const exchange of latest.mailbox) {
    if (exchange.agentId !== agentId && exchange.recipientAgentId !== agentId) continue;
    if (exchange.status === "answered") continue;
    await deps.store.commitApplication({kind:"reconcile_cancelled_exchange",agentId:exchange.agentId,exchangeId:exchange.id});
  }
  return settled;
}
