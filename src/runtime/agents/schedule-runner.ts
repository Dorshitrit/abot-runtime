import type { AgentApplicationDetail, AgentMessageInput } from "./application-contracts.js";
import { AGENT_SCHEDULE_MAX_LATENESS_MS, type AgentScheduleDependencies, type AgentScheduleRecord, type AgentScheduleState } from "./schedule-contracts.js";
import { AgentScheduleStore } from "./schedule-store.js";
import { acceptedScheduleMission, addScheduleOccurrence, replaceSchedule, scheduleBindingMatches, scheduleHasUnresolvedClaim } from "./schedule-lifecycle.js";


type Claim = { schedule: AgentScheduleRecord; messageId: string };
export function createAgentScheduleRunner(store: AgentScheduleStore, deps: AgentScheduleDependencies, stopped: () => boolean) {
  const now = deps.now ?? Date.now;
  function ownedSchedule(state: AgentScheduleState, { id, agentId }: AgentScheduleRecord) {
    return state.schedules.find(entry => entry.id === id && entry.agentId === agentId);
  }
  function settleState(state: AgentScheduleState, claim: Claim, status: "accepted" | "skipped" | "unknown", reason: string, missionId: string | null = null) {
    const current = ownedSchedule(state, claim.schedule);
    if (!current) return;
    const occurrence = current.occurrences.find((entry) => entry.messageId === claim.messageId);
    if (!occurrence || occurrence.status !== "claimed") return;
    const occurrences = current.occurrences.map((entry) => entry.messageId === claim.messageId ? { ...entry, status, reason, missionId } : entry);
    replaceSchedule(state, { ...current, occurrences, status: current.status === "cancelled" ? "cancelled" :
      status === "unknown" ? "awaiting_user_decision" : current.nextRunAt === null ? "completed" : "active" });
  }
  async function settle(claim: Claim, status: "accepted" | "skipped" | "unknown", reason: string, missionId: string | null = null) {
    await store.transaction((state) => settleState(state, claim, status, reason, missionId));
  }
  async function recoverClaims() {
    const schedules = await store.transaction((state) => state.schedules);
    for (const schedule of schedules) for (const occurrence of schedule.occurrences.filter((entry) => entry.status === "claimed")) {
      const claim = { schedule, messageId: occurrence.messageId };
      try {
        const missionId = acceptedScheduleMission(schedule, occurrence, await deps.application.detail(schedule.agentId));
        await settle(claim, missionId ? "accepted" : "unknown", missionId ? "Recovered the durable Agent message receipt." : "The dispatch outcome is unknown; cancel and explicitly create a replacement if needed.", missionId);
      } catch { await settle(claim, "unknown", "The dispatch receipt could not be verified; user decision is required."); }
    }
  }
  async function skipElapsed() {
    await store.transaction((state) => {
      for (let record of state.schedules) {
        while (record.status === "active" && !scheduleHasUnresolvedClaim(record) && record.nextRunAt && Date.parse(record.nextRunAt) <= now()) {
          record = replaceSchedule(state, addScheduleOccurrence(record, now(), "skipped", "Missed while the Agent scheduler was offline; not backfilled."));
        }
      }
    });
  }
  async function claimDue(schedule: AgentScheduleRecord): Promise<Claim | null> {
    return store.transaction(async (state) => {
      let current = ownedSchedule(state, schedule);
      if (!current) return null;
      if (stopped() || current.status !== "active" || scheduleHasUnresolvedClaim(current) || !current.nextRunAt || Date.parse(current.nextRunAt) > now()) return null;
      while (current.nextRunAt && now() - Date.parse(current.nextRunAt) > AGENT_SCHEDULE_MAX_LATENESS_MS) {
        current = replaceSchedule(state, addScheduleOccurrence(current, now(), "skipped", "Missed the 30-second online delivery window; not backfilled."));
      }
      if (!current.nextRunAt || current.status !== "active") return null;
      let detail: AgentApplicationDetail;
      try { detail = await deps.application.detail(current.agentId); }
      catch { replaceSchedule(state, { ...current, status: "awaiting_user_decision" }); return null; }
      if (detail.agent.status === "archived") { replaceSchedule(state, addScheduleOccurrence(current, now(), "skipped", "Agent is archived.")); return null; }
      if (!scheduleBindingMatches(current, detail)) { replaceSchedule(state, { ...current, status: "awaiting_user_decision" }); return null; }
      if (detail.mission && ["active", "awaiting_user_decision"].includes(detail.mission.status)) {
        replaceSchedule(state, addScheduleOccurrence(current, now(), "skipped", "Agent already has an unfinished task.")); return null;
      }
      const claimed = replaceSchedule(state, addScheduleOccurrence(current, now(), "claimed", "Dispatch intent saved before the Agent call."));
      return { schedule: claimed, messageId: claimed.occurrences.at(-1)!.messageId };
    });
  }
  async function dispatch(claim: Claim) {
    if (stopped()) { await settle(claim, "skipped", "Scheduler stopped before dispatch."); return; }
    const occurrence = claim.schedule.occurrences.at(-1)!;
    try {
      const current = await deps.application.detail(claim.schedule.agentId);
      if (!scheduleBindingMatches(claim.schedule, current) || current.agent.status !== "active") {
        await settle(claim, "unknown", "The Agent configuration changed after the claim; explicit user approval is required."); return;
      }
      if (stopped()) { await settle(claim, "skipped", "Scheduler stopped before dispatch."); return; }
      const message: AgentMessageInput & { expectedAgentRevision: number } = {
        messageId: claim.messageId, text: claim.schedule.text, intent: "task", limits: claim.schedule.limits,
        expectedAgentRevision: claim.schedule.binding.agentRevision,
      };
      // Cancellation/update and Agent admission share this fence. No call can start
      // after a successful cancellation receipt. Agent send returns after admission.
      await store.transaction(async (state) => {
        const latest = ownedSchedule(state, claim.schedule);
        if (!latest) return;
        if (latest.status === "cancelled" || stopped()) {
          settleState(state, claim, "skipped", "Schedule cancelled or stopped before Agent admission."); return;
        }
        if (latest.status !== "active" || !latest.occurrences.some((entry) => entry.messageId === claim.messageId && entry.status === "claimed")) return;
        const detail = await deps.application.send(claim.schedule.agentId, message);
        const missionId = acceptedScheduleMission(claim.schedule, occurrence, detail);
        settleState(state, claim, missionId ? "accepted" : "unknown", missionId ? "Agent accepted this bounded scheduled task." : "No matching durable message receipt was returned.", missionId);
      });
    } catch (error) {
      try {
        const missionId = acceptedScheduleMission(claim.schedule, occurrence, await deps.application.detail(claim.schedule.agentId));
        if (missionId) { await settle(claim, "accepted", "Recovered the accepted message after a delivery error.", missionId); return; }
      } catch { /* The unknown outcome stays owned by the user. */ }
      const code = error instanceof Error ? error.message : "unknown";
      if (["agents_agent_busy", "agents_agent_not_active"].includes(code)) await settle(claim, "skipped", code);
      else await settle(claim, "unknown", "Dispatch outcome could not be established; no automatic retry.");
    }
  }
  return { recoverClaims, skipElapsed, async tick() {
    const schedules = await store.transaction((state) => state.schedules);
    for (const schedule of schedules) { if (stopped()) return; const claim = await claimDue(schedule); if (claim) await dispatch(claim); }
  } };
}
