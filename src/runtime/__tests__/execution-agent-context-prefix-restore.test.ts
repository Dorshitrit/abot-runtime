import { projectPromptCacheBoundary } from "../model/prompt-cache-boundary.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { projectCheckpointMessages, scanCompactionSources } from "../context/model-step-compaction-projection.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { executionCompactionScopeId } from "../context/execution-compaction-objective.js";
import { resolveExecutionEvidenceCheckpoint } from "../context/execution-compaction-checkpoint-selection.js";
import { compactedSourceFixture, settledSource } from "./support/compacted-execution-source-fixture.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { executionCompactionSteeringFixture, STEERED_FACT } from "./support/execution-compaction-steering-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function kindIndex(messages: readonly ChatMessage[], kind: string): number {
  return messages.findIndex(({ content }) => {
    try { return JSON.parse(content).kind === kind; } catch { return false; }
  });
}

test("old-order checkpoint snapshots retain source identity after regeneration and a new result", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  await f.addResult("ORIGINAL_SOURCE_BYTES");
  const head = f.ledger.current();
  const call = activeEvidenceCall(head);
  const options = { head, call, steeringSnapshot: f.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true };
  // The unchanged provider path supplies the pre-change ordering of the same bytes.
  const legacy = buildExecutionAgentInput({ ...f.request, modelPolicy: {
    ...f.request.modelPolicy, providers: { openai: { type: "ollama" } },
  } }, options);
  const binding = { requestId: f.request.requestId, callId: call.callId,
    prompt: f.request.prompt, objective: f.request.prompt };
  const scopeId = executionCompactionScopeId(binding);
  const oldSources = scanCompactionSources(legacy.messages, scopeId, new Map()).map(({ source }) => source);
  expect(oldSources).toHaveLength(2);
  const saved = compactedSourceFixture(oldSources.map((_, index) => settledSource(String(index))), {
    requestId: binding.requestId, callId: binding.callId,
    scopeId, currentRequestFingerprint: hash(binding.prompt),
    objectiveFingerprint: hash(binding.objective), sourceRevision: head.revision,
  }, oldSources);
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(saved.store)));
  const restored = restoreRequestContextCompaction(snapshot);
  const checkpoint = resolveExecutionEvidenceCheckpoint({ ...binding, store: restored, sourceRevision: head.revision });
  expect(checkpoint).toEqual(saved.checkpoint);

  const regenerated = buildExecutionAgentInput(f.request, options);
  expect(scanCompactionSources(regenerated.messages, scopeId, new Map()).map(({ source }) => source)).toEqual(oldSources);
  await f.addResult("NEW_SOURCE_BYTES");
  const advanced = f.ledger.current();
  const next = buildExecutionAgentInput(f.request, { ...options, head: advanced, call: activeEvidenceCall(advanced) });
  const projected = projectCheckpointMessages(next.messages, scopeId, checkpoint!, new Map());
  expect(JSON.stringify(projected)).not.toContain("ORIGINAL_SOURCE_BYTES");
  expect(JSON.stringify(projected)).toContain("NEW_SOURCE_BYTES");
  const checkpointIndex = kindIndex(projected, "runtime_semantic_compaction_checkpoint_v2");
  expect(checkpointIndex).toBeGreaterThan(projected.findIndex(({ content }) => content === binding.prompt));
  expect(checkpointIndex).toBeLessThan(projected.findIndex(({ role }) => role === "tool"));
  expect(kindIndex(projected, "runtime_execution_state_v1")).toBeGreaterThan(
    projected.map(({ role }) => role).lastIndexOf("tool"),
  );
  validateModelGatewayMessages(projected);
  expect(projectPromptCacheBoundary({ messages: projected, beforeMessage: next.promptCacheBoundaryBeforeMessage }))
    .toEqual({ promptCacheBoundaryBeforeMessageIndex: projected.indexOf(next.promptCacheBoundaryBeforeMessage!) });
  expect(projected.indexOf(next.promptCacheBoundaryBeforeMessage!)).toBeGreaterThan(checkpointIndex);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  for (const source of oldSources) {
    expect(restored.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
  }
});

test("the real admission/compaction path keeps activation state after compacted evidence and steering last", async () => {
  const f = await executionCompactionSteeringFixture({ modelPolicy: executionPrefixCachePolicy });
  f.steering.append({ steerId: "current-steering", text: "Report the observed value only." });
  await f.run();
  const consumer = f.invoke.mock.calls.find(([input]) => input.modelStep === "execution.decision")![0];
  const messages = consumer.messages as ChatMessage[];
  expect(consumer.promptCacheBoundaryBeforeMessageIndex).toBeGreaterThan(0);
  expect(consumer.promptCacheBoundaryBeforeMessageIndex).toBeLessThan(messages.length - 1);
  validateModelGatewayMessages(messages);
  expect(JSON.stringify(messages)).toContain(STEERED_FACT);
  const checkpointIndex = kindIndex(messages, "runtime_semantic_compaction_checkpoint_v2");
  expect(checkpointIndex).toBeGreaterThan(messages.findIndex(({ content }) => content === f.request.prompt));
  expect(kindIndex(messages, "runtime_execution_state_v1")).toBeGreaterThan(checkpointIndex);
  expect(messages.at(-1)?.content).toContain("Report the observed value only.");
  expect(messages.filter(({ content }) => content === f.request.prompt)).toHaveLength(1);
  const countedInputs = f.countInputTokens.mock.calls
    .filter(([input]) => input.modelStep === "execution.decision")
    .map(([input]) => ({ input, messages: input.messages as ChatMessage[] }))
    // Admission also counts isolated source slices; inspect complete request inputs.
    .filter(({ messages: counted }) => counted.some(({ content }) => content === f.request.prompt));
  expect(countedInputs.length).toBeGreaterThan(0);
  const finalCount = countedInputs.at(-1)!;
  expect(finalCount.messages).toEqual(messages);
  expect(finalCount.input.promptCacheBoundaryBeforeMessageIndex).toBe(consumer.promptCacheBoundaryBeforeMessageIndex);
  expect(f.invoke.mock.calls.filter(([input]) => input.modelStep !== "execution.decision")
    .every(([input]) => input.promptCacheBoundaryBeforeMessageIndex === undefined)).toBe(true);
  for (const { input, messages: counted } of countedInputs) {
    expect(input.promptCacheBoundaryBeforeMessageIndex).toBeGreaterThan(
      Math.max(counted.map(({ role }) => role).lastIndexOf("tool"),
        kindIndex(counted, "runtime_semantic_compaction_checkpoint_v2")),
    );
    expect(kindIndex(counted, "runtime_execution_state_v1")).toBeGreaterThan(
      Math.max(counted.map(({ role }) => role).lastIndexOf("tool"),
        kindIndex(counted, "runtime_semantic_compaction_checkpoint_v2")),
    );
  }
});
