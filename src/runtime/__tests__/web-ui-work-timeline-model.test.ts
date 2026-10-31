import { describe, expect, test } from "vitest";
import { buildConversationWorkTimeline } from "../../web-ui/app/lib/conversation-work-timeline-model.js";

type Event = Record<string, unknown>;
const requestId = "request-1";
function event(name: string, eventSequence?: number, fields: Event = {}): Event {
  return { type: "event", name, requestId, ...(eventSequence ? { eventSequence } : {}), ...fields };
}
function tool(name: string, sequence?: number, fields: Event = {}): Event {
  return event(name, sequence, { tool: "read_file", executionId: "execution-1", executorRole: "worker", roleCallId: "worker-1", ...fields });
}
function update(id: string, sequence?: number, fields: Event = {}): Event {
  return { id, kind: "user_interaction", role: "assistant", requestId, text: id,
    interactionSequence: 999, ...(sequence ? { eventSequence: sequence } : {}), ...fields };
}
const build = (events: Event[], updates: Event[] = [], streaming = true) =>
  buildConversationWorkTimeline({ requestId, events, updates, streaming });

describe("unified work timeline chronology", () => {
  test("interleaves updates, acknowledgement and one tool with preserved outcome evidence", () => {
    const source = { tool: "read_file", query: "report" };
    const events = [
      event("thinking.delta", 1, { presentationKind: "acknowledgement", text: "I will check." }),
      tool("tool.payload.started", 3, { intent: "Read the report", meta: { path: "report.md" } }),
      tool("tool.started", 4, { intent: "Read the report" }),
      tool("tool.completed", 6, { intent: "Read the report", ok: true, meta: { outputPreview: "Exact evidence", path: "report.md" }, webSources: source }),
      event("thinking.delta", 7, { text: "Private reasoning" }),
    ];
    const updates = [update("First update", 2), update("Second update", 5)];
    const before = structuredClone({ events, updates });
    const entries = build(events, updates);
    expect(entries.map((entry) => entry.kind === "message" ? entry.text : entry.kind))
      .toEqual(["I will check.", "First update", "Read the report", "tool", "Second update"]);
    expect(entries.find((entry) => entry.kind === "tool")).toMatchObject({
      role: "worker", callId: "worker-1", action: { status: "completed", preview: "Exact evidence", target: "report.md", intent: "Read the report", roleCallId: "worker-1" },
    });
    expect({ events, updates }).toEqual(before);
  });

  test("sorts late canonical events, deduplicates replay and retains independent executions", () => {
    const finished = tool("tool.completed", 5, { ok: true });
    const entries = build([finished, tool("tool.started", 2), finished,
      tool("tool.started", 4, { executionId: "execution-2", executorRole: "reviewer", roleCallId: "reviewer-1" })],
      [update("after", 3), update("before", 1), update("before", 1)]);
    expect(entries.map((entry) => entry.kind === "message" ? entry.text : entry.role)).toEqual(["before", "worker", "after", "reviewer"]);
    expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(2);
  });

  test("does not move a genuinely later intent before the tool's first recorded event", () => {
    const entries = build([tool("tool.started", 2), tool("tool.completed", 4, { ok: true, intent: "Recorded later" })], [update("between", 3)]);
    expect(entries.map((entry) => entry.kind === "message" ? entry.text : entry.kind)).toEqual(["tool", "between", "Recorded later"]);
  });

  test("does not compare runtime, replay, arrival timestamps or interaction-only counters", () => {
    const entries = build([
      event("worker.completed", 10, { stage: "worker", summary: "runtime ten" }),
      event("reviewer.completed", undefined, { seqNo: 2, stage: "reviewer", summary: "replay two" }),
      event("planner.completed", 3, { stage: "planner", summary: "runtime three" }),
      event("legacy.recorded", undefined, { updatedAt: 999999999, summary: "unsequenced" }),
    ], [update("runtime five", 5), update("unsequenced update", undefined, { interactionSequence: 1, createdAt: "1900-01-01" })]);
    expect(entries.map((entry) => entry.kind === "message" ? entry.text : entry.kind === "event" ? entry.event.summary : entry.kind))
      .toEqual(["runtime three", "replay two", "runtime five", "unsequenced", "runtime ten", "unsequenced update"]);
  });

  test("keeps unsequenced legacy tool evidence and foreign requests out of scope", () => {
    const entries = build([tool("tool.completed", undefined, { executionId: "", ok: true, meta: { path: "legacy.txt" } }),
      tool("tool.started", 1, { requestId: "another" })], [update("wrong", 2, { requestId: "another" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", action: { legacy: true, target: "legacy.txt", status: "completed" } });
  });

  test("keeps correlated approval and execution phases as one stable tool row", () => {
    const entries = build([
      tool("tool.approval.required", 1, { approvalId: "approval-1", intent: "Read approval report" }),
      event("tool.approval.granted", 2, { approvalId: "approval-1" }),
      tool("tool.started", 3), tool("tool.completed", 4, { ok: true }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "tool"]);
    expect(entries[1]).toMatchObject({ id: JSON.stringify([requestId, "execution-1"]), role: "worker", action: { status: "completed" } });
  });

  test("preserves memory, basket, skill, delegation, return and source event payloads", () => {
    const delegation = { callerRole: "supervisor", callerCallId: "root-1", childCallId: "planner-1", childRole: "planner", objective: "Exact delegated objective" };
    const source = event("web.source.recorded", 8, { webSources: { sources: [{ url: "https://example.test/source", title: "Exact source" }] }, summary: "Source evidence" });
    const entries = build([
      event("memory.retrieval.started", 1), event("memory.retrieval.completed", 2),
      event("runtime.stage", 3, { stage: "information_basket", phase: "discovery_found" }),
      event("runtime.stage", 4, { stage: "supervisor", phase: "skills", summary: "Read exact Skill" }),
      event("role.delegated", 5, delegation), event("role.delegated", 6, delegation),
      event("role.returned", 7, { ...delegation, outcome: "completed", summary: "Exact planner result" }), source,
    ], [], false);
    expect(entries.map((entry) => entry.kind)).toEqual(["memory", "basket", "skill", "delegation", "return", "event"]);
    expect(entries[0]).toMatchObject({ activities: [{ state: "done" }] });
    expect(entries[3]).toMatchObject({ role: "supervisor", delegation: { objective: "Exact delegated objective" } });
    expect(entries[4]).toMatchObject({ role: "planner", receipt: { summary: "Exact planner result" } });
    expect(entries[5]).toMatchObject({ event: source });
  });
  test("retains unpaired legacy lifecycle diagnostics without inventing completion", () => {
    const entries = build([event("runtime.stage", 1, { stage: "worker" }),
      tool("tool.payload.started", 2, { executionId: "", executorRole: "" }),
      tool("tool.started", 3, { executionId: "", executorRole: "" })]);
    expect(entries.map((entry) => entry.kind)).toEqual(["event", "event", "event"]);
    expect(entries.slice(1).map((entry) => entry.role)).toEqual(["worker", "worker"]);
    expect(entries[2]).toMatchObject({ event: { name: "tool.started" } });
  });

  test("uses recorded owners across phases, preserves legacy association and rejects unsupported ownership", () => {
    const entries = build([event("runtime.stage", 1, { stage: "planner" }),
      tool("tool.completed", 2, { executionId: "", executorRole: "", ok: true }),
      tool("tool.started", 3, { executionId: "modern-missing", executorRole: "", stage: "planner" }),
      tool("tool.started", 4, { executionId: "unsupported", executorRole: "made-up-role" }),
      tool("tool.started", 5, { executionId: "recorded-later", executorRole: "" }),
      tool("tool.completed", 6, { executionId: "recorded-later", executorRole: "reviewer", ok: true })]);
    expect(entries.filter((entry) => entry.kind === "tool").map((entry) => entry.role))
      .toEqual(["planner", "unknown", "unknown", "reviewer"]);
  });

  test.each(["stage", "delegation", "return"])("attributes canonical plan diagnostics using explicit Planner %s evidence", (source) => {
    const binding = { callerRole: "supervisor", callerCallId: "root-1", childRole: "planner", childCallId: "planner-1", objective: "Plan the work" };
    const evidence: Record<string, Event> = {
      stage: event("runtime.stage", 1, { stage: "planner" }),
      delegation: event("role.delegated", 1, binding),
      return: event("role.returned", 1, { ...binding, outcome: "completed", summary: "Plan ready" }),
    };
    const plans = [
      event("Plan 1/2", 2, { stage: "development_plan", payload: { plan: { summary: "Exact plan" } } }),
      event("planner.plan.item.started", 3, { item: { id: "item-1", title: "Do work", status: "in_progress" } }),
      event("Plan 1/2", 4, { stage: "development_plan", payload: { plan: { summary: "Exact plan" } } }),
    ];
    const entries = build([evidence[source]!, ...plans]);
    const diagnostics = entries.filter((entry) => entry.kind === "event").filter((entry) => plans.includes(entry.event));
    expect(diagnostics).toHaveLength(plans.length);
    expect(diagnostics.map((entry) => entry.role)).toEqual(["planner", "planner", "planner"]);
    expect(diagnostics.map((entry) => entry.event)).toEqual(plans);
  });

  test("keeps EA plan reports with the root and never infers actual tool ownership from plan display", () => {
    const entries = build([
      event("runtime.stage", 1, { requestId: "another", stage: "planner" }),
      event("Plan 1/1", 2, { stage: "development_plan" }),
      event("planner.plan.item.completed", 3),
      tool("tool.started", 4, { executionId: "modern-missing", executorRole: "", stage: "planner" }),
      tool("tool.completed", 5, { executionId: "", executorRole: "", ok: true }),
      event("custom.notice", 6, { summary: "Planner plan updated" }),
    ]);
    expect(entries.map((entry) => entry.role)).toEqual(["root", "root", "unknown", "unknown", "unknown"]);
    expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(2);
    expect(entries.at(-1)).toMatchObject({ kind: "event", event: { summary: "Planner plan updated" } });
  });

  test.each(["started", "completed", "failed"])("categorizes raw and projected context compaction %s without changing evidence", (phase) => {
    const name = "context.compaction." + phase;
    const raw = event(name, 1, { stage: "context_compaction", phase, message: "Exact context details", beforeInputTokens: 12000 });
    const projected = event("Display-only title", 2, { eventName: name, stage: "context_compaction", phase, summary: "Exact projected details", tone: phase === "failed" ? "failed" : "neutral" });
    const before = structuredClone([raw, projected]);
    const entries = build([projected, raw]);
    expect(entries.map((entry) => entry.role)).toEqual(["context", "context"]);
    expect(entries.filter((entry) => entry.kind === "event").map((entry) => entry.event)).toEqual(before);
    expect([raw, projected]).toEqual(before);
  });

  test("does not infer context management from display text, unrelated names, or tool stage", () => {
    const entries = build([
      event("custom.notice", 1, { summary: "Context Compaction Started" }),
      event("context.other.completed", 2, { stage: "context_compaction" }),
      tool("tool.started", 3, { executorRole: "", stage: "context_compaction" }),
      tool("tool.completed", 4, { executorRole: "", stage: "context_compaction", ok: true }),
    ]);
    expect(entries.map((entry) => entry.role)).toEqual(["unknown", "unknown", "unknown"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["event", "event", "tool"]);
    expect(entries[2]).toMatchObject({ action: { status: "completed", executorRole: "unknown" } });
  });

});
