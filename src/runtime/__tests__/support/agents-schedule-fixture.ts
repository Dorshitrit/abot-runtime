import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { AgentApplicationDetail, AgentApplicationService } from "../../agents/application-contracts.js";
import { createAgentScheduleService } from "../../agents/schedule-service.js";
import type { AgentScheduleInput } from "../../agents/schedule-contracts.js";
import { AgentScheduleStore } from "../../agents/schedule-store.js";
import { addScheduleOccurrence, replaceSchedule } from "../../agents/schedule-lifecycle.js";
import { agentDefinition, agentMissionLimits } from "./agents-foundation-fixture.js";

export async function agentsScheduleFixture(intervalMs: number | null = null, maxOccurrences = 1) {
  const root = await mkdtemp(join(tmpdir(), "agents-schedule-"));
  const filename = join(root, "agents", "schedules.json");
  let clock = Date.parse("2026-11-17T10:00:00.000Z");
  let detail: AgentApplicationDetail = { peerClarification: null, agent: { id: "agent-a", revision: 1, status: "active", definition: agentDefinition(), createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() },
    status: "idle", mission: null, sessions: [], attempts: [], decisions: [], responsibility: [], mailbox: [], activity: null, messages: [], recovery: { requiresNewBudget: false } };
  const get = vi.fn(async () => structuredClone(detail));
  const send = vi.fn<AgentApplicationService["send"]>(async (agentId, input) => {
    detail = { ...detail, messages: [...detail.messages, { id: input.messageId, agentId, missionId: `mission-${send.mock.calls.length}`,
      role: "user", source: null, text: input.text, createdAt: new Date(clock).toISOString() }] };
    return structuredClone(detail);
  });
  const deps = { filename, application: { detail: get, send }, now: () => clock };
  const service = createAgentScheduleService(deps);
  const services = [service];
  const input: AgentScheduleInput = { id: "schedule-a", agentId: "agent-a", title: "Fixture check", text: "Inspect the fictional task.",
    startAt: new Date(clock + 1000).toISOString(), intervalMs, maxOccurrences, limits: agentMissionLimits() };
  return { root, filename, service, input, get, send, now: () => clock, advance(ms: number) { clock += ms; },
    detail: () => detail, setDetail(value: AgentApplicationDetail) { detail = value; },
    another() { const next = createAgentScheduleService(deps); services.push(next); return next; },
    async claim() { await new AgentScheduleStore(filename).transaction((state) => { replaceSchedule(state, addScheduleOccurrence(state.schedules[0]!, clock, "claimed", "Simulated durable claim before crash.")); }); },
    async dispose() { for (const service of services) await service.stop(); await rm(root, { recursive: true, force: true }); } };
}
