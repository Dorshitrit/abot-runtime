import { expect, test, vi } from "vitest";
import type { SessionRequestLifecycleSnapshot } from "../../sessions/request-lifecycle/contracts.js";
import { createEmptyAgentState, type AgentState } from "../agents/agent-records.js";
import { reduceAgentCommand } from "../agents/state-reducer.js";
import type { AgentStateCommand } from "../agents/state-commands.js";
import { emptyAgentNotificationCursor, projectAgentNotifications } from "../agents/notification-attention.js";
import { readAgentNotificationApprovals } from "../agents/notification-approvals.js";
import { agentDefinition, agentMissionLimits } from "./support/agents-foundation-fixture.js";
import type { SessionStore } from "../ports.js";

const started = Date.parse("2026-11-18T10:00:00Z");
function fixture() {
  let state = createEmptyAgentState(), time = started;
  const commit = (command: AgentStateCommand) => {
    state = reduceAgentCommand(state, command, new Date(++time).toISOString());
    return state;
  };
  commit({ kind: "register_agent", agentId: "a", definition: agentDefinition() });
  commit({ kind: "open_agent_turn", agentId: "a", missionId: "mission", messageId: "user", text: "Compare the supplied results", intent: "task", limits: agentMissionLimits(), source: null });
  return { commit, read: () => state };
}

test("public committed replies project independently of Web and private delegated dialogue stays private", () => {
  const f = fixture();
  const state = f.commit({ kind: "finish_agent_turn", agentId: "a", missionId: "mission", status: "exhausted", reason: "Allowance reached", messageId: "answer", text: "Saved partial findings" });
  const page = projectAgentNotifications(state, emptyAgentNotificationCursor(), started);
  expect(page.entries).toEqual([expect.objectContaining({ targetAgentId: "a", missionId: "mission", messageId: "answer", reason: "exhausted", output: "Saved partial findings" })]);
  expect(projectAgentNotifications(state, page.cursor, started).entries).toEqual([]);
  const delegated: AgentState = { ...state, messages: state.messages.map(message => message.id === "user"
    ? { ...message, role: "abot", source: { agentId: "abot", missionId: "parent", correlationId: "exchange" } } : message) };
  expect(projectAgentNotifications(delegated, emptyAgentNotificationCursor(), started).entries).toEqual([]);
});

test("canonical unknown outcome sends empty attention once per wait and resumes permit a distinct wait", () => {
  const f = fixture();
  const waiting = f.commit({ kind: "mark_agent_waiting", agentId: "a", missionId: "mission", reason: "Unknown external outcome" });
  const first = projectAgentNotifications(waiting, emptyAgentNotificationCursor(), started);
  expect(first.entries).toHaveLength(1);
  expect(first.entries[0]).toMatchObject({ reason: "attention", output: "", targetAgentId: "a" });
  expect(first.entries[0]).not.toHaveProperty("messageId");
  const accounting = { ...waiting, revision: waiting.revision + 9, missions: waiting.missions.map(mission => ({ ...mission, updatedAt: new Date(started + 100).toISOString(), usage: { ...mission.usage, totalTokens: 100 } })) };
  expect(projectAgentNotifications(accounting, first.cursor, started).entries).toEqual([]);
  expect(projectAgentNotifications(accounting, emptyAgentNotificationCursor(), started).entries[0]?.eventId).toBe(first.entries[0]?.eventId);
  f.commit({ kind: "resume_agent_turn", agentId: "a", missionId: "mission", text: "Continue" });
  const second = f.commit({ kind: "mark_agent_waiting", agentId: "a", missionId: "mission", reason: "Unknown external outcome" });
  const next = projectAgentNotifications(second, first.cursor, started);
  expect(next.entries).toHaveLength(1);
  expect(next.entries[0]?.eventId).not.toBe(first.entries[0]?.eventId);
});

test("deliberate pause, historical wait, deleted agent and internal session completion do not notify", () => {
  const f = fixture();
  const paused = f.commit({ kind: "mark_agent_waiting", agentId: "a", missionId: "mission", reason: "Paused by the user." });
  expect(projectAgentNotifications(paused, emptyAgentNotificationCursor(), started).entries).toEqual([]);
  const waiting = f.commit({ kind: "mark_agent_waiting", agentId: "a", missionId: "mission", reason: "Needs user decision" });
  const historical = projectAgentNotifications(waiting, emptyAgentNotificationCursor(), started + 100);
  expect(historical.entries).toEqual([]);
  expect(projectAgentNotifications(waiting, historical.cursor, started).entries).toEqual([]);
  expect(projectAgentNotifications({ ...waiting, deletingAgentIds: ["a"] }, emptyAgentNotificationCursor(), started).entries).toEqual([]);
  expect(projectAgentNotifications({ ...waiting, missions: waiting.missions.map(mission => ({ ...mission, status: "active", waitingReason: null })) }, emptyAgentNotificationCursor(), started).entries).toEqual([]);
});

test("large retained conversations drain bounded pages without skipping messages or retaining previews in cursors", () => {
  const f = fixture();
  const base = f.read();
  const state: AgentState = { ...base, messages: [...base.messages, ...Array.from({ length: 123 }, (_, index) => ({
    id: `reply-${index}`, agentId: "a", missionId: "mission", role: "assistant" as const, purpose: "reply" as const,
    source: null, text: "🌙".repeat(800), createdAt: new Date(started + 10 + index).toISOString(),
  }))] };
  let cursor = emptyAgentNotificationCursor();
  const ids = new Set<string>();
  for (const expected of [50, 50, 23]) {
    const page = projectAgentNotifications(state, cursor, started);
    expect(page.entries).toHaveLength(expected);
    for (const entry of page.entries) {
      expect(ids.has(entry.eventId)).toBe(false);
      ids.add(entry.eventId);
      expect(entry.output.length).toBeLessThanOrEqual(600);
    }
    expect(JSON.stringify(page.cursor)).not.toContain("🌙");
    cursor = page.cursor;
  }
  expect(ids.size).toBe(123);
  expect(cursor.delivered).toBeUndefined();
  expect(projectAgentNotifications(state, cursor, started).entries).toEqual([]);
});

test("approval waits use exact existing wait identity and never publish tool details", async () => {
  const f = fixture(), base = f.read();
  const attempt = { id: "attempt", agentId: "a", missionId: "mission", status: "awaiting_approval", userResolved: false,
    request: { sessionId: "work", requestId: "request" } } as unknown as AgentState["attempts"][number];
  const state = { ...base, attempts: [attempt] };
  const wait = { schemaVersion: 1, sessionId: "work", requestId: "request", generation: "generation", status: "awaiting_approval", revision: 5,
    wait: { waitId: "approval-1", createdAt: new Date(started + 20).toISOString(), presentationMessageId: "private-presentation", approvals: [{ tool: "private tool details" }] }, decisionReceipts: [] } as unknown as SessionRequestLifecycleSnapshot;
  const get = vi.fn(async () => wait);
  const snapshots = await readAgentNotificationApprovals(state, { requestLifecycle: { get } } as unknown as Pick<SessionStore, "requestLifecycle">);
  expect(get).toHaveBeenCalledWith("work", "request");
  const page = projectAgentNotifications(state, emptyAgentNotificationCursor(), started, snapshots);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({ reason: "attention", output: "" });
  expect(JSON.stringify(page)).not.toContain("private");
  expect(projectAgentNotifications(state, page.cursor, started, [{ ...wait, revision: 6 }]).entries).toEqual([]);
  expect(projectAgentNotifications(state, page.cursor, started, [{ ...wait, wait: { ...wait.wait!, waitId: "approval-2" } }]).entries).toHaveLength(1);
  get.mockResolvedValue({ ...wait, requestId: "foreign" });
  expect(await readAgentNotificationApprovals(state, { requestLifecycle: { get } } as unknown as Pick<SessionStore, "requestLifecycle">)).toEqual([]);
});

test("hard budget completion without model text produces one exact terminal system event", () => {
  const f = fixture();
  const waiting = f.commit({ kind: "mark_agent_waiting", agentId: "a", missionId: "mission", reason: "agents_token_limit_reached" });
  const first = projectAgentNotifications(waiting, emptyAgentNotificationCursor(), started);
  const ended = f.commit({ kind: "finish_agent_turn", agentId: "a", missionId: "mission", status: "exhausted", reason: "agents_token_limit_reached" });
  expect(ended.messages.filter(message => message.role === "assistant")).toEqual([]);
  const terminal = projectAgentNotifications(ended, first.cursor, started);
  expect(terminal.entries).toHaveLength(1);
  expect(terminal.entries[0]).toMatchObject({ targetAgentId: "a", missionId: "mission", reason: "attention", attentionKind: "budget", output: "" });
  expect(terminal.entries[0]).not.toHaveProperty("messageId");
  expect(terminal.entries[0]!.eventId).not.toBe(first.entries[0]!.eventId);
  expect(projectAgentNotifications(ended, terminal.cursor, started).entries).toEqual([]);
  expect(projectAgentNotifications(ended, emptyAgentNotificationCursor(), started).entries[0]!.eventId).toBe(terminal.entries[0]!.eventId);
  expect(projectAgentNotifications({ ...ended, deletingAgentIds: ["a"] }, emptyAgentNotificationCursor(), started).entries).toEqual([]);
});
