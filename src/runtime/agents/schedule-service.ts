import { isDeepStrictEqual } from "node:util";
import type { AgentScheduleDependencies, AgentScheduleService } from "./schedule-contracts.js";
import { AgentScheduleStore } from "./schedule-store.js";
import { readAgentScheduleInput, requireAgentSchedule } from "./schedule-validation.js";
import { replaceSchedule, scheduleBinding, scheduleHasUnresolvedClaim } from "./schedule-lifecycle.js";
import { createAgentScheduleRunner } from "./schedule-runner.js";
import { AgentStateError } from "./state-error.js";
export type { AgentScheduleInput, AgentScheduleUpdate, AgentScheduleRecord, AgentScheduleService } from "./schedule-contracts.js";

/** Agent-owned wakeups are ordinary bounded messages; they never invoke a model or a looper. */
export function createAgentScheduleService(deps: AgentScheduleDependencies): AgentScheduleService {
  const store = new AgentScheduleStore(deps.filename); const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false, starting: Promise<void> | undefined, ticking: Promise<void> | undefined;
  const runner = createAgentScheduleRunner(store, deps, () => stopping);
  async function tick() {
    if (stopping) return;
    if (ticking) return ticking;
    const task = deps.runTick ? deps.runTick(runner.tick) : runner.tick(); ticking = task;
    try { await task; } finally { if (ticking === task) ticking = undefined; }
  }
  return {
    list: (agentId) => store.transaction((state) => state.schedules.filter((entry) => !agentId || entry.agentId === agentId)),
    async create(value) {
      const input = readAgentScheduleInput(value);
      return store.transaction(async (state) => {
        const existing = state.schedules.find((entry) => entry.id === input.id);
        if (existing) {
          if (!isDeepStrictEqual(readAgentScheduleInput(existing), input)) throw new AgentStateError("agents_schedule_identity_conflict");
          return existing;
        }
        if (Date.parse(input.startAt) <= now()) throw new AgentStateError("agents_schedule_start_must_be_future");
        const detail = await deps.application.detail(input.agentId);
        if (detail.agent.status !== "active") throw new AgentStateError("agents_agent_not_active");
        const record = { ...input, revision: 1, binding: scheduleBinding(detail.agent), status: "active" as const, nextRunAt: input.startAt, occurrences: [] };
        state.schedules.push(record); return record;
      });
    },
    update(id, expectedRevision, value, ownerId) {
      return store.transaction(async (state) => {
        const latest = requireAgentSchedule(state, id, expectedRevision, ownerId);
        const input = readAgentScheduleInput({ ...value, id, agentId: latest.agentId });
        if (Date.parse(input.startAt) <= now()) throw new AgentStateError("agents_schedule_start_must_be_future");
        const detail = await deps.application.detail(latest.agentId);
        if (detail.agent.status !== "active") throw new AgentStateError("agents_agent_not_active");
        if (latest.status === "cancelled" || scheduleHasUnresolvedClaim(latest)) throw new AgentStateError("agents_schedule_requires_cancel_and_replace");
        if (input.maxOccurrences <= latest.occurrences.length) throw new AgentStateError("agents_schedule_allowance_exhausted");
        return replaceSchedule(state, { ...latest, ...input, binding: scheduleBinding(detail.agent), status: "active", nextRunAt: input.startAt });
      });
    },
    cancel(id, expectedRevision, ownerId) {
      return store.transaction((state) => {
        const current = requireAgentSchedule(state, id, expectedRevision, ownerId);
        if (current.status === "cancelled") return current;
        return replaceSchedule(state, { ...current, status: "cancelled", nextRunAt: null });
      });
    },
    removeForAgent(agentId) {
      return store.transaction((state) => { state.schedules = state.schedules.filter(schedule => schedule.agentId !== agentId); });
    },
    async start() {
      if (starting) return starting;
      if (timer) return;
      stopping = false;
      starting = (async () => {
        await runner.recoverClaims(); await runner.skipElapsed();
        if (stopping) return;
        timer = setInterval(() => { void tick().catch((error) => deps.onError?.(error)); }, 1000); timer.unref?.();
        await tick();
      })();
      try { await starting; } finally { starting = undefined; }
    },
    async stop() { stopping = true; if (timer) clearInterval(timer); timer = undefined; await starting; await ticking; },
    tick,
  };
}
