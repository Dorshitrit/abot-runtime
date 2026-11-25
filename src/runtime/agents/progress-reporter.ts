import type { AgentApplicationDependencies, AgentApplicationDetail } from "./application-contracts.js";
import { createAgentManagementModel } from "./management-model.js";
import { projectAgentDetail } from "./application-view.js";
import { hasOutstandingDelegation, type createAgentChatUpdates } from "./chat-updates.js";

const QUIET_INTERVAL = 5 * 60_000;
const PROBE_INTERVAL = 10_000;

/** The environment observer owns progress generation even when no browser is connected. */
export function createAgentProgressReporter(deps: AgentApplicationDependencies, projection: Pick<ReturnType<typeof createAgentChatUpdates>, "checkpoint">) {
  const invoke = createAgentManagementModel(deps);
  const jobs = new Map<string, Promise<void>>();
  const probes = new Map<string, number>();
  const controller = new AbortController();

  async function inspect(agentId: string, missionId: string) {
    const state = await deps.store.read();
    const detail = projectAgentDetail(state, agentId, false);
    if (detail.mission?.id !== missionId) return null;
    return projection.checkpoint(detail, state);
  }

  async function report(agentId: string, missionId: string) {
    const state = await deps.store.read();
    if (state.invocations.some(call => call.id === `progress:${missionId}`)) return;
    // The executing child owns the report and its charge; the parent projects that public text.
    if (hasOutstandingDelegation(state, agentId, missionId)) return;
    const detail = projectAgentDetail(state, agentId, false);
    if (detail.mission?.id !== missionId) return;
    const checkpoint = await projection.checkpoint(detail, state);
    if (!checkpoint || controller.signal.aborted) return;
    await invoke({ agentId, missionId, stage: "progress_report", instructions: "", signal: controller.signal,
      progress: { source: checkpoint, current: () => inspect(agentId, missionId) } });
  }

  function observe(details: readonly AgentApplicationDetail[], now = Date.now()) {
    const active = new Set<string>();
    for (const detail of details) {
      const mission = detail.mission;
      if (mission?.status !== "active" || detail.agent.status !== "active" || controller.signal.aborted) continue;
      if (detail.status !== "working" && detail.status !== "thinking") continue;
      if (detail.agent.definition.onboarding?.updates === "needed") continue;
      active.add(mission.id);
      if (now - Date.parse(mission.createdAt) < QUIET_INTERVAL || jobs.has(mission.id)) continue;
      if ((probes.get(mission.id) ?? 0) > now) continue;
      probes.set(mission.id, now + PROBE_INTERVAL);
      const job = report(detail.agent.id, mission.id)
        .catch(() => { /* Optional presentation must not interrupt task execution. Charged failures stay in the ledger. */ })
        .finally(() => jobs.delete(mission.id));
      jobs.set(mission.id, job);
    }
    for (const id of probes.keys()) if (!active.has(id)) probes.delete(id);
  }
  async function whenIdle() { await Promise.all(jobs.values()); }
  return { observe, whenIdle, isBusy: () => jobs.size > 0, async stop() { controller.abort(); await whenIdle(); } };
}
