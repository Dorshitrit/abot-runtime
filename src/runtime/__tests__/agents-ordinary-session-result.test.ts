import { expect, test } from "vitest";
import type { SessionRequestReplay } from "../../sessions/types.js";
import type { AgentWorkRequest } from "../agents/application-contracts.js";
import { projectOrdinarySessionResult } from "../agents/ordinary-session-result.js";
import { ordinarySessionUsage } from "../agents/ordinary-session-usage.js";
const request: AgentWorkRequest = { agentId: "agent", missionId: "mission", attemptId: "attempt", requestId: "request",
  sessionId: "session", assignment: "Compare fictional notes.", modelProfileId: "model", toolPermissionMode: "ask" };
function receipt(): SessionRequestReplay { return { requestId: "request", sessionId: "session", generation: "generation",
  events: [{ type: "completed", requestId: "request", generation: "generation", seqNo: 2 }],
  finalState: { status: "completed", output: "Result.", completedAt: 1 } }; }
function snapshot(id: string): Record<string, unknown> { return { requestId: "request", name: "context.window.snapshot", invocationId: id, admissionOutcome: "accepted" }; }
function usage(id: string, totalTokens = 17): Record<string, unknown> { return { requestId: "request", name: "context.window.provider_usage", invocationId: id, totalTokens, measurement: "actual", source: "provider_reported" }; }

test("uses only complete, measured existing invocation receipts and deduplicates repeated events", () => {
  expect(ordinarySessionUsage("request", [snapshot("a"), usage("a"), usage("a"), snapshot("b"), usage("b", 5)]))
    .toEqual({ modelCalls: 2, totalTokens: 22 });
  expect(ordinarySessionUsage("request", [snapshot("a"), usage("a", 0)])).toEqual({ modelCalls: 1, totalTokens: 0 });
});
test.each([
  [], [snapshot("a")], [usage("a")], [snapshot("a"), usage("a"), snapshot("b")],
  [snapshot("a"), usage("a"), usage("a", 5)], [snapshot("a"), { ...usage("a"), totalTokens: -1 }],
  [snapshot("a"), { ...usage("a"), measurement: "estimated" }],
].map((events) => ({ events })))("missing or conflicting usage stays unknown (%j)", ({ events }) => {
  expect(ordinarySessionUsage("request", events)).toBeNull();
});
test("derives measured total only from two valid provider counts, ignoring unrelated requests", () => {
  const event = { ...usage("a"), totalTokens: undefined, inputTokens: 10, outputTokens: 2 };
  expect(ordinarySessionUsage("request", [snapshot("a"), event, { ...usage("x"), requestId: "another" }]))
    .toEqual({ modelCalls: 1, totalTokens: 12 });
});
test.each([
  { requestId: "foreign" }, { sessionId: "foreign" },
  { events: [{ type: "completed", requestId: "foreign", seqNo: 2 }] },
  { events: [{ type: "completed", requestId: "request", generation: "old", seqNo: 2 }] },
  { events: [] },
])("rejects unrelated or unverifiable terminal facts (%j)", (change) => {
  expect(projectOrdinarySessionResult(request, { ...receipt(), ...change }).status).toBe("unknown");
});
test("a blocked request stays failed evidence and a cancel stays cancelled", () => {
  const blocked = receipt(); blocked.finalState = { status: "completed", disposition: "blocked", output: "Need input.", completedAt: 1 };
  expect(projectOrdinarySessionResult(request, blocked)).toMatchObject({ status: "failed", error: "request_blocked", output: "Need input." });
  const cancelled = receipt(); cancelled.events[0].type = "failed";
  cancelled.finalState = { status: "failed", error: "request_cancelled", details: { stoppedResponse: "Stopped." }, completedAt: 1 };
  expect(projectOrdinarySessionResult(request, cancelled)).toMatchObject({ status: "cancelled", error: "request_cancelled", output: "Stopped." });
});
test("terminal receipt identity stays stable if a later presentation event arrives", () => {
  const replay = receipt(); const before = projectOrdinarySessionResult(request, replay);
  replay.events.push({ type: "event", name: "status", requestId: "request", seqNo: 3 });
  expect(projectOrdinarySessionResult(request, replay).receiptId).toBe(before.receiptId);
});
