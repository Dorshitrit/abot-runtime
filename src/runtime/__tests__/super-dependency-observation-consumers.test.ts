import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import * as observationProjection from "../context/super-dependency-observations.js";
import { createDependencyObservationConsumer, CONSUMER_TARGET } from "./support/dependency-observation-consumer.js";
import { dependencyObservationFixture, SELECTED_SOURCE, NESTED_SOURCE, UNSELECTED_SOURCE } from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";
import { fullTargetContextFixture } from "./support/full-target-context-fixture.js";

type Input = Parameters<ModelGatewayClient["invoke"]>[0];
let root: string;
beforeEach(async () => {
  configureDebugLogger({ enabled: false });
  root = await mkdtemp(join(tmpdir(), "dependency-consumers-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
  await rm(root, { recursive: true, force: true });
});

test("selected canonical observations reach Worker evidence, decision, controls and RAW, but not the target-only selector", async () => {
  const state = await dependencyObservationFixture();
  const consumer = await createDependencyObservationConsumer(root, state);
  expect(await consumer.run()).toMatchObject({ kind: "continue" });
  expect(consumer.execute).toHaveBeenCalledTimes(1);
  const inputs = consumer.invoke.mock.calls.map(([input]) => input);
  expect(inputs.map(input => input.modelStep)).toEqual([
    "worker.evidence", "worker.decision", "capability.controls", "tool_payload.raw", "tool_payload.raw",
  ]);
  for (const index of [0, 1, 2, 4]) {
    const input = inputs[index]!;
    const observations = observationValues(input);
    expect(observations.map(result => result.executionId)).toEqual([state.firstExecutionId, state.nestedExecutionId]);
    expect(observations.map(result => result.callId)).toEqual([state.firstProducer.callId, state.nestedProducer.callId]);
    expect(JSON.stringify(observations)).toContain(JSON.stringify(SELECTED_SOURCE).slice(1, -1));
    expect(JSON.stringify(observations)).toContain(JSON.stringify(NESTED_SOURCE).slice(1, -1));
    for (const marker of ["SELECTED_TRANSITIVE_TOOL_ONLY", "NESTED_SELECTED_TOOL_ONLY"])
      expect(messageText(input).split(marker)).toHaveLength(2);
  }
  const selector = inputs[3]!;
  expect(selector.format).toBeDefined();
  expect(observationValues(selector)).toEqual([]);
  expect(messageText(selector)).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
  expect(messageText(selector)).not.toContain("NESTED_SELECTED_TOOL_ONLY");
  expect(messageText(selector)).toContain("selected current target");
  for (const input of inputs) expect(messageText(input)).not.toContain(UNSELECTED_SOURCE);
  const raw = inputs[4]!;
  expect(raw.format).toBeUndefined();
  const target = (raw.messages as ChatMessage[]).filter(message =>
    message.content.startsWith('{"kind":"runtime_payload_target_content_v1"'));
  expect(target).toHaveLength(1);
  expect(target[0]!.content.slice(target[0]!.content.indexOf("\n") + 1)).toBe(CONSUMER_TARGET);
  expect(state.ledger.current().state.capabilityExecutions.at(-1)).toMatchObject({
    callId: state.call.callId, status: "settled", outcome: "succeeded",
  });
});

test("valid producer checkpoints replace selected raw observations in every consuming phase", async () => {
  const bypass = vi.spyOn(observationProjection, "projectSuperDependencyObservations")
    .mockImplementation((_head, _call, dependencies) => dependencies);
  const baselineState = await dependencyObservationFixture({ selectFirstDirectly: true });
  const baseline = await createDependencyObservationConsumer(root, baselineState,
    createDependencyCheckpoints(baselineState).store);
  await baseline.run();
  bypass.mockRestore();
  const state = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store, checkpoints } = createDependencyCheckpoints(state);
  const consumer = await createDependencyObservationConsumer(root, state, store);
  expect(await consumer.run()).toMatchObject({ kind: "continue" });
  const inputs = consumer.invoke.mock.calls.map(([input]) => input);
  expect(inputs).toHaveLength(5);
  for (const input of inputs) {
    expect(observationValues(input)).toEqual([]);
    expect(messageText(input)).not.toContain("SELECTED_TRANSITIVE_TOOL_ONLY");
    expect(messageText(input)).not.toContain("NESTED_SELECTED_TOOL_ONLY");
    expect(messageText(input)).not.toContain(UNSELECTED_SOURCE);
  }
  for (const index of [0, 1, 2, 4]) for (const checkpoint of checkpoints) {
    for (const digest of checkpoint.sourceDigests) {
      expect(messageText(inputs[index]!).split(digest.digest)).toHaveLength(2);
    }
  }
  expect(JSON.stringify(inputs)).toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
  expect(consumer.execute).toHaveBeenCalledTimes(1);
});

test("summary-only dependency consumers remain independent of observation enrichment", async () => {
  const options = { first: { observedEffect: "none" as const }, nested: { observedEffect: "none" as const } };
  const bypass = vi.spyOn(observationProjection, "projectSuperDependencyObservations")
    .mockImplementation((_head, _call, dependencies) => dependencies);
  const baseline = await createDependencyObservationConsumer(root, await dependencyObservationFixture(options));
  await baseline.run();
  bypass.mockRestore();
  const actual = await createDependencyObservationConsumer(root, await dependencyObservationFixture(options));
  await actual.run();
  expect(actual.invoke).toHaveBeenCalledTimes(5);
  expect(JSON.stringify(actual.invoke.mock.calls.map(([input]) => input)))
    .toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
});

test.each(["execution-agent-v1", undefined] as const)("%s keeps the full composed selector and RAW provider requests byte-identical", async policy => {
  const bypass = vi.spyOn(observationProjection, "projectPayloadDependencyObservationScope")
    .mockImplementation(context => context);
  const baseline = await fullTargetContextFixture(root, policy);
  await baseline.run();
  expect(bypass).toHaveBeenCalledTimes(2);
  bypass.mockRestore();
  const projection = vi.spyOn(observationProjection, "projectPayloadDependencyObservationScope");
  const actual = await fullTargetContextFixture(root, policy);
  await actual.run();
  expect(projection).toHaveBeenCalledTimes(2);
  expect(actual.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(actual.invoke.mock.calls.map(([input]) => input)))
    .toBe(JSON.stringify(baseline.invoke.mock.calls.map(([input]) => input)));
});

function messageText(input: Input): string {
  return (input.messages as ChatMessage[]).map(message => message.content).join("\n");
}

function observationValues(input: Input): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === "observations" && Array.isArray(child)) result.push(...child);
      else visit(child);
    }
  }
  for (const message of input.messages as ChatMessage[]) {
    const jsonStart = message.content.indexOf("{");
    if (jsonStart < 0) continue;
    try { visit(JSON.parse(message.content.slice(jsonStart))); } catch { /* Text and verbatim target capsules are not JSON records. */ }
  }
  return result;
}
