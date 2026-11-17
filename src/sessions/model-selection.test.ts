import { describe, expect, test } from "vitest";
import { projectSessionModelSelection } from "./model-selection.js";
import { projectSessionSnapshot } from "./snapshot.js";
import { compactRequestEvents } from "./record/projection.js";
import type { SessionRecord, SessionRequestRecord } from "./types.js";

const iso = (time: number) => new Date(time).toISOString();
function request(id: string, time: number, status: SessionRequestRecord["status"] = "completed"): SessionRequestRecord {
  return { requestId: id, sessionId: "session", generation: `generation-${id}`, status,
    createdAt: iso(time), updatedAt: iso(time), lastSeqNo: 0, events: [] };
}
function append(target: SessionRequestRecord, payload: Record<string, unknown>) {
  const seqNo = ++target.lastSeqNo;
  target.events.push({ type: "event", requestId: target.requestId, seqNo, timestamp: iso(100 + seqNo),
    payload: { type: "event", requestId: target.requestId, generation: target.generation, ...payload } });
}
function select(target: SessionRequestRecord, profileId = "local") {
  append(target, { name: "request.model.selected", selectedAt: 100,
    primaryProfileId: profileId, agentMode: "deep", rootModelSteps: ["execution.decision", "execution.response"],
    primaryModel: { label: "Local model", provider: "llamacpp", model: "model.gguf", apiKey: "must-not-project" },
    reasoningPreference: { profileId, mode: "budget", budgetTokens: 64 } });
}
function snapshot(target: SessionRequestRecord, fields: Record<string, unknown> = {}) {
  append(target, { name: "context.window.snapshot", admissionOutcome: "accepted", profileId: "local",
    modelStep: "execution.decision", reasoningEffort: "medium", reasoningBudget: { mode: "tokens", tokens: 64 },
    reasoningControlSource: "request", ...fields });
}
function session(requests: SessionRequestRecord[]): SessionRecord {
  return { id: "session", title: "Conversation", createdAt: iso(1), updatedAt: iso(10), lastAgentMode: "reasoning",
    messageCount: requests.length, requests,
    messages: requests.map((item, index) => ({ id: `msg-${index + 1}`, role: "assistant", content: "answer",
      requestId: item.requestId, createdAt: item.createdAt })) };
}

describe("canonical session model presentation", () => {
  test("projects the latest request independently of a targeted historical page without changing history", () => {
    const older = request("older", 1); select(older, "old");
    const latest = request("latest", 2); select(latest); snapshot(latest);
    const source = session([older, latest]);
    const before = structuredClone(source);
    const page = projectSessionSnapshot(source, { page: { limit: 1, targetMessageId: "1" } });
    expect(page.requests.map((item) => item.requestId)).toEqual(["older"]);
    expect(page.modelSelection).toMatchObject({ requestId: "latest", generation: "generation-latest", status: "completed",
      primaryProfileId: "local", agentMode: "deep", selectedAt: 100,
      effectiveReasoning: { profileId: "local", modelStep: "execution.decision", reasoningEffort: "medium", reasoningBudget: { mode: "tokens", tokens: 64 } } });
    expect(page.modelSelection?.primaryModel).toEqual({ label: "Local model", provider: "llamacpp", model: "model.gguf" });
    expect(projectSessionSnapshot(source, { identitiesOnly: true })).not.toHaveProperty("modelSelection");
    expect(source).toEqual(before);
  });

  test("prioritizes an active chat and excludes newer command requests", () => {
    const active = request("active", 1, "awaiting_approval"); select(active);
    const newer = request("newer", 2); select(newer, "cloud");
    const command = request("command", 3, "streaming");
    append(command, { name: "command.started", requestKind: "command" }); select(command, "command-profile");
    expect(projectSessionModelSelection(session([active, newer, command]))?.requestId).toBe("active");
    expect(projectSessionModelSelection(session([command]))).toBeUndefined();
  });

  test("an unknown latest request cannot inherit a previous model or stale generation", () => {
    const previous = request("previous", 1); select(previous);
    const latest = request("latest", 2); select(latest, "stale");
    latest.events[0]!.payload.generation = "old-generation";
    expect(projectSessionModelSelection(session([previous, latest]))).toEqual({
      requestId: "latest", generation: "generation-latest", status: "completed", selectedAt: 2,
    });
  });

  test("utility, child and rejected attempts cannot replace root reasoning", () => {
    const target = request("latest", 1); select(target); snapshot(target);
    snapshot(target, { modelStep: "context.compact", reasoningEffort: "none" });
    snapshot(target, { modelStep: "worker.decision", reasoningEffort: "high" });
    snapshot(target, { admissionOutcome: "rejected", reasoningEffort: "xhigh" });
    expect(projectSessionModelSelection(session([target]))?.effectiveReasoning?.reasoningEffort).toBe("medium");
    snapshot(target, { profileId: "replacement", reasoningEffort: "high" });
    expect(projectSessionModelSelection(session([target]))).not.toHaveProperty("effectiveReasoning");
  });

  test("undefined reasoning remains unknown while explicit none remains disabled", () => {
    const target = request("latest", 1); select(target);
    snapshot(target, { reasoningEffort: undefined, reasoningBudget: undefined, reasoningControlSource: undefined });
    expect(projectSessionModelSelection(session([target]))?.effectiveReasoning).toEqual({ profileId: "local", modelStep: "execution.decision" });
    snapshot(target, { reasoningEffort: "none", reasoningBudget: undefined });
    expect(projectSessionModelSelection(session([target]))?.effectiveReasoning?.reasoningEffort).toBe("none");
  });

  test("preserves the original reasoning sequence across replay and calibrated replacement without mixing cursor domains", () => {
    const target = request("latest", 1); select(target);
    snapshot(target, { eventSequence: 70, seqNo: 900 });
    snapshot(target, { eventSequence: 90, modelStep: "context.compact" });
    const page = projectSessionSnapshot(session([target]));
    expect(page.modelSelection?.reasoningEventSequence).toBe(70);
    expect(page.requests[0]?.events[1]).toMatchObject({ eventSequence: 70, seqNo: 2 });
    snapshot(target, { profileId: "replacement", eventSequence: 100 });
    expect(projectSessionModelSelection(session([target]))).toMatchObject({ reasoningEventSequence: 100 });
    expect(projectSessionModelSelection(session([target]))).not.toHaveProperty("effectiveReasoning");
    snapshot(target, { eventSequence: undefined, seqNo: 2000 });
    expect(projectSessionModelSelection(session([target]))).not.toHaveProperty("reasoningEventSequence");
  });

  test("long-run event compaction preserves selection and effective reasoning", () => {
    const target = request("latest", 1); select(target); snapshot(target);
    for (let index = 0; index < 1000; index += 1) append(target, { name: "thinking.delta", text: "x".repeat(index) });
    target.events = compactRequestEvents(target.events);
    expect(target.events).toHaveLength(3);
    expect(projectSessionModelSelection(session([target]))).toMatchObject({ primaryProfileId: "local", effectiveReasoning: { reasoningEffort: "medium" } });
  });

  test("latest-page selection reads request headers but no historical event bodies", () => {
    let historicalBodyReads = 0;
    const history = Array.from({ length: 100 }, (_, requestIndex) => {
      const target = request(`history-${requestIndex}`, requestIndex + 1);
      select(target, "old-model");
      for (let eventIndex = 1; eventIndex < 1000; eventIndex += 1) {
        append(target, { name: "tool.completed", output: "historical result" });
        const event = target.events.at(-1)!;
        const payload = event.payload;
        Object.defineProperty(event, "payload", { get() { historicalBodyReads += 1; return payload; } });
      }
      return target;
    });
    const latest = request("latest", 101); select(latest); snapshot(latest);
    const page = projectSessionSnapshot(session([...history, latest]), { page: { limit: 1 } });
    expect(page.modelSelection?.requestId).toBe("latest");
    expect(page.requests.map((item) => item.requestId)).toEqual(["latest"]);
    expect(historicalBodyReads).toBe(0);
  });

  test("terminal-only legacy commands are excluded by their first canonical marker", () => {
    const chat = request("chat", 1); select(chat);
    const command = request("legacy-command", 2);
    delete command.generation;
    append(command, { name: "command.failed", requestKind: "command", error: "request_interrupted" });
    expect(projectSessionModelSelection(session([chat, command]))?.requestId).toBe("chat");
    expect(projectSessionSnapshot(session([chat, command]), { page: { limit: 1 } }).requests.map((item) => item.requestId)).toContain("legacy-command");
  });
});
