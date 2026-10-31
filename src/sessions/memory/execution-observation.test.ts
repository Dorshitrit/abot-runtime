import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../types.js";
import { snapshotSessionMemorySource } from "./source.js";
import {
  EXECUTION_TOOL_OBSERVATION_KIND,
  projectExecutionHistoryContent,
  readExecutionToolObservation,
} from "./execution-observation.js";

function assistant(result = "A collected fact"): SessionMessage {
  return {
    id: "assistant-1", role: "assistant", content: "Short answer", requestId: "request-1",
    createdAt: "2026-10-27T00:00:00.000Z",
    observationContent: JSON.stringify({
      kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "request-1",
      results: [{ executionId: "execution-1", outcome: "completed", content: result }],
    }),
  };
}

function messages(response = assistant()): SessionMessage[] {
  return [{ id: "user-1", role: "user", content: "Collect information", requestId: "request-1",
    createdAt: "2026-10-27T00:00:00.000Z" }, response];
}

describe("EA historical observation source", () => {
  it("preserves the response and exact result as passive historical content", () => {
    const message = assistant();
    const original = structuredClone(message);
    const projected = JSON.parse(projectExecutionHistoryContent(message));
    expect(projected).toMatchObject({
      authority: "prior_conversation", requestId: message.requestId,
      assistantResponse: message.content, toolObservation: JSON.parse(message.observationContent!),
    });
    expect(projected).not.toHaveProperty("currentRequest");
    expect(projected).not.toHaveProperty("assignment");
    expect(message).toEqual(original);
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ kind: "different", requestId: "request-1", results: ["fact"] }),
    JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "another", results: ["fact"] }),
    JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "request-1", results: [] }),
    JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "request-1", results: "fact" }),
  ])("ignores an unrecognized or unbound observation (%s)", (observationContent) => {
    const message = { ...assistant(), observationContent };
    expect(readExecutionToolObservation(message)).toBeUndefined();
    expect(projectExecutionHistoryContent(message)).toBe(message.content);
  });

  it("does not project tool metadata on user messages or absent request bindings", () => {
    const user = { ...assistant(), role: "user" as const };
    expect(projectExecutionHistoryContent(user)).toBe(user.content);
    expect(readExecutionToolObservation({ ...assistant(), requestId: undefined })).toBeUndefined();
  });

  it("binds EA hashes to recognized evidence while preserving ordinary hashes", () => {
    const first = { messages: messages() };
    const changed = { messages: messages(assistant("A changed collected fact")) };
    const plain = { messages: messages({ ...assistant(), observationContent: undefined }) };
    const ordinary = snapshotSessionMemorySource(first);
    expect(ordinary.messageReferences).toEqual(snapshotSessionMemorySource(changed).messageReferences);
    expect(ordinary.sourceRevision).toBe(snapshotSessionMemorySource(plain).sourceRevision);
    expect(ordinary).not.toHaveProperty("scope");
    const execution = snapshotSessionMemorySource(first, "execution_agent");
    expect(execution.sourceRevision).not.toBe(snapshotSessionMemorySource(changed, "execution_agent").sourceRevision);
    expect(execution.historyMessages).toEqual(first.messages);
    expect(execution.turns[0]?.assistant.content).toBe("Short answer");
  });

  it("ignores unbound observation bytes even for EA source fingerprints", () => {
    const base = assistant();
    const first = snapshotSessionMemorySource({ messages: messages({ ...base, observationContent: "invalid" }) }, "execution_agent");
    const second = snapshotSessionMemorySource({ messages: messages({ ...base, observationContent: undefined }) }, "execution_agent");
    expect(first.messageReferences).toEqual(second.messageReferences);
  });
});
