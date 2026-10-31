import { afterEach, beforeEach, expect, test } from "vitest";
import { buildContextBuckets, buildContextWindow } from "../../sessions/context-window.js";
import { readExecutionToolObservation } from "../../sessions/memory/execution-observation.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectExecutionHistoryObservation } from "../steps/execution-agent/history-observation.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("EA capture preserves the exact legacy context buckets and conversation window", async () => {
  const f = await createControlsEvidenceFixture();
  await f.addResult("Only the EA history projection may see marker AMBER-731.");
  const head = f.ledger.current();
  const observation = projectExecutionHistoryObservation(f.request, head, activeEvidenceCall(head));
  expect(observation).toBeDefined();
  expect(observation).not.toHaveProperty("observationMeta");

  const store = createInMemorySessionStore();
  const sessionId = f.request.sessionId;
  await store.appendMessage(sessionId, "user", "Earlier question", { requestId: "earlier" });
  await store.appendMessage(sessionId, "assistant", "Earlier answer", {
    requestId: "earlier",
    observationMeta: { kind: "stable_fact", carryPolicy: "always" },
    observationContent: "Existing legacy observation remains available.",
  });
  await store.appendMessage(sessionId, "user", "Read the source", { requestId: f.request.requestId });
  const before = await store.appendMessage(sessionId, "assistant", "The source was read", {
    requestId: f.request.requestId,
  });
  const answer = before.messages.at(-1)!;
  const after = {
    ...before,
    messages: [...before.messages.slice(0, -1), { ...answer, ...observation }],
  };

  expect(readExecutionToolObservation(after.messages.at(-1)!)?.results).toHaveLength(1);
  expect(buildContextBuckets(after)).toEqual(buildContextBuckets(before));
  expect(buildContextBuckets(after, { includeRecentConversationAcrossTaskResults: true })).toEqual(
    buildContextBuckets(before, { includeRecentConversationAcrossTaskResults: true }),
  );
  expect(buildContextWindow(after)).toEqual(buildContextWindow(before));
  expect(JSON.stringify(buildContextBuckets(after))).not.toContain("AMBER-731");
});
