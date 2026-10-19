import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createSupervisorArtifactPathsReadmissionController } from "../steps/supervisor-decision/artifact-paths.js";
import {
  createArtifactReadmissionFixture,
  isArtifactMessage,
} from "./support/supervisor-artifact-readmission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createControllerFixture(targets?: readonly string[]) {
  const fixture = createArtifactReadmissionFixture({ targets });
  const receipt = {
    messages: [{ role: "system" as const, content: "committed checkpoint" }],
    scopeId: "active-scope",
    sourceRevision: 1,
    coveredSourceCount: 2,
    commit: vi.fn(),
  };
  const prepare = vi.fn(async () => ({
    kind: "prepared" as const,
    preparation: receipt,
  }));
  let stages = [
    {
      compactionScope: "active_request" as const,
      scopeId: receipt.scopeId,
      prepare,
    },
  ];
  const project = vi.fn((messages: readonly ChatMessage[]) => [...messages]);
  const proof = vi.fn(() => true);
  const controller: ModelStepContextCompactionController = {
    project,
    getStages: () => stages,
    hasExhaustedVerifiedCompactionSources: proof,
  };
  const wrapped = createSupervisorArtifactPathsReadmissionController(
    fixture.request,
    {
      controller,
      projection: fixture.input.artifactPathsProjection,
      format: fixture.input.format,
      includeInstructions: true,
    },
  );
  return {
    ...fixture,
    controller,
    wrapped,
    project,
    proof,
    prepare,
    receipt,
    clearStages: () => {
      stages = [];
    },
  };
}

test("absent artifact projection returns the exact existing controller", () => {
  const fixture = createControllerFixture([]);
  expect(fixture.wrapped).toBe(fixture.controller);
  expect(fixture.input.artifactPathsProjection).toBeUndefined();
});

test("preserves stage receipts, live stage changes and exhaustion proof ownership", async () => {
  const fixture = createControllerFixture();
  const messages = fixture.input.context.messages;
  expect(fixture.wrapped.getStages()).toBe(fixture.controller.getStages());
  const outcome = await fixture.wrapped.getStages()[0]!.prepare(messages);
  expect(outcome).toEqual({ kind: "prepared", preparation: fixture.receipt });
  if (outcome.kind !== "prepared") throw new Error("fixture stage missing");
  expect(outcome.preparation).toBe(fixture.receipt);
  expect(fixture.prepare).toHaveBeenCalledExactlyOnceWith(messages);
  expect(fixture.project).not.toHaveBeenCalled();
  await outcome.preparation.commit();
  expect(fixture.receipt.commit).toHaveBeenCalledOnce();
  expect(
    fixture.wrapped.hasExhaustedVerifiedCompactionSources?.(messages),
  ).toBe(true);
  expect(fixture.proof).toHaveBeenCalledExactlyOnceWith(messages);
  fixture.clearStages();
  expect(fixture.wrapped.getStages()).toEqual([]);
});

test("restores only the owned artifact additions after delegating the current projection", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const original = structuredClone(fixture.input.context.messages);
  const projected = fixture.wrapped.project(fixture.input.context.messages);
  expect(fixture.project).toHaveBeenCalledExactlyOnceWith(
    baseline.input.context.messages,
  );
  expect(projected).toEqual(original);
  expect(fixture.input.context.messages).toEqual(original);
  expect(projected.filter(isArtifactMessage)).toHaveLength(1);
  expect(fixture.gateway.invoke).not.toHaveBeenCalled();
});

test("latest projected growth yields both owned additions without changing unrelated passive messages", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const independentReference: ChatMessage = {
    role: "system",
    content: JSON.stringify({
      kind: "independent_reference",
      target: ".separate/record.txt",
    }),
  };
  const mandatory = [
    ...baseline.input.context.messages,
    independentReference,
    { role: "system" as const, content: "r".repeat(100_000) },
  ];
  fixture.project.mockReturnValue(mandatory);
  const projected = fixture.wrapped.project(fixture.input.context.messages);
  expect(projected).toBe(mandatory);
  expect(projected).toContain(independentReference);
  expect(projected.filter(isArtifactMessage)).toEqual([]);
  expect(fixture.prepare).not.toHaveBeenCalled();
});

test("does not synthesize a capsule or change instructions when the bound source is absent", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const messages = baseline.input.context.messages;
  const projected = fixture.wrapped.project(messages);
  expect(fixture.project).toHaveBeenCalledExactlyOnceWith(messages);
  expect(projected).toEqual(messages);
  expect(projected.filter(isArtifactMessage)).toEqual([]);
});

test("pre-compaction removes only the last admitted owned capsule and its instructions", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const projected = fixture.wrapped.project(fixture.input.context.messages);
  const owned = projected.find(isArtifactMessage)!;
  const unrelatedClone: ChatMessage = { ...owned };
  const steering: ChatMessage = {
    role: "user",
    content: "Keep the requested outcome.",
  };
  const messages = [...projected, unrelatedClone, steering];
  const result = fixture.wrapped.projectForCompaction!(messages);
  expect(result).toEqual([
    ...baseline.input.context.messages,
    unrelatedClone,
    steering,
  ]);
  expect(result).toContain(unrelatedClone);
  expect(result).not.toContain(owned);
  expect(messages).toContain(owned);
  expect(fixture.project).toHaveBeenCalledOnce();
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.wrapped.projectForCompaction!(result)).toBe(result);
});

test("pre-compaction removes the smaller capsule admitted after mandatory context grows", () => {
  const targets = Array.from(
    { length: 8 },
    (_, index) => `.exact-${index}/${"p".repeat(600)}.txt`,
  );
  const fixture = createControllerFixture(targets);
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const budget = fixture.assess(fixture.input.context.messages);
  const growth: ChatMessage = {
    role: "system",
    content: "r".repeat(
      budget.compactionTriggerInputTokens - budget.estimatedInputTokens + 500,
    ),
  };
  fixture.project.mockImplementation((messages) => [...messages, growth]);
  const projected = fixture.wrapped.project(fixture.input.context.messages);
  const capsule = projected.find(isArtifactMessage)!;
  expect(capsule).toBeDefined();
  expect(capsule.content).not.toBe(
    fixture.input.artifactPathsProjection!.message.content,
  );
  const projectedTargets = JSON.parse(capsule.content).targets as string[];
  expect(projectedTargets.length).toBeGreaterThan(0);
  expect(projectedTargets.length).toBeLessThan(targets.length);
  expect(projectedTargets).toEqual(targets.slice(0, projectedTargets.length));
  const result = fixture.wrapped.projectForCompaction!(projected);
  expect(result).toEqual([...baseline.input.context.messages, growth]);
  expect(result.filter(isArtifactMessage)).toEqual([]);
});

test("pre-compaction preserves no-owned-message identity and resets its bound projection", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  expect(
    fixture.wrapped.projectForCompaction!(baseline.input.context.messages),
  ).toBe(baseline.input.context.messages);
  const oldProjection = fixture.wrapped.project(fixture.input.context.messages);
  const plainProjection = fixture.wrapped.project(
    baseline.input.context.messages,
  );
  expect(fixture.wrapped.projectForCompaction!(plainProjection)).toBe(
    plainProjection,
  );
  expect(fixture.wrapped.projectForCompaction!(oldProjection)).toBe(
    oldProjection,
  );
});

test("pre-compaction delegates the stripped context exactly once to an existing optional hook", () => {
  const fixture = createControllerFixture();
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const projectForCompaction = vi.fn(
    (messages: readonly ChatMessage[]) => messages,
  );
  const wrapped = createSupervisorArtifactPathsReadmissionController(
    fixture.request,
    {
      controller: { ...fixture.controller, projectForCompaction },
      projection: fixture.input.artifactPathsProjection,
      format: fixture.input.format,
      includeInstructions: true,
    },
  );
  const projected = wrapped.project(fixture.input.context.messages);
  const result = wrapped.projectForCompaction!(projected);
  expect(projectForCompaction).toHaveBeenCalledExactlyOnceWith(
    baseline.input.context.messages,
  );
  expect(result).toEqual(baseline.input.context.messages);
  expect(fixture.prepare).not.toHaveBeenCalled();
  projectForCompaction.mockClear();
  expect(wrapped.projectForCompaction!(result)).toBe(result);
  expect(projectForCompaction).toHaveBeenCalledExactlyOnceWith(result);
});
