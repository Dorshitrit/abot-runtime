import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import * as mainCompaction from "../context/model-step-compaction-projection.js";
import * as superCompaction from "../context/super-dependency-observation-compaction.js";
import { projectPayloadDependencyObservationScope } from "../context/super-dependency-observations.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import type { SuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

const consumers = ["execution.decision", "execution.response"] as const;
type Consumer = typeof consumers[number];
const kinds = ["runtime_worker_assignment", "runtime_worker_capability_execution_assignment", "runtime_worker_result_assignment"] as const;
const shapedText = (kind: string, observations: unknown = []) =>
  JSON.stringify({ kind, dependencyResults: [{ observations, summary: "Literal user example; retain every byte." }] }, null, 2);
const history = (content: string) => [
  { id: "prior-user", requestId: "prior-request", role: "user" as const, content, createdAt: "2026-10-27T00:00:00Z" },
  { id: "prior-answer", requestId: "prior-request", role: "assistant" as const, content: "Prior plain answer.", createdAt: "2026-10-27T00:00:01Z" },
];

function executionContext(request: RequestExecutionScope, head: RoleCallLedgerHead, consumer: Consumer) {
  const call = activeEvidenceCall(head);
  const options = { head, call, steeringSnapshot: { version: 0, updates: [] },
    includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true };
  const input = consumer === "execution.decision"
    ? buildExecutionAgentInput(request, options)
    : buildExecutionAgentResponseInput(request, options);
  const controller = createExecutionAgentCompactionController(request, {
    ...options, consumer, allowedConsumers: consumers,
  });
  return { input, controller };
}

function watchSuperCompaction() {
  const resolver = vi.spyOn(superCompaction, "resolveSuperDependencyObservationCompaction");
  const scanner = vi.spyOn(superCompaction, "scanDependencyObservationSources");
  const projector = vi.spyOn(superCompaction, "projectDependencyObservationCheckpointMessage");
  const carrier = vi.spyOn(superCompaction, "hasDependencyObservationCarrier");
  return () => {
    expect(resolver).toHaveBeenCalled();
    for (const result of resolver.mock.results) {
      if (result.type !== "return") throw new Error("fixture_compaction_resolver_failed");
      expect(result.value.scanCompactionSources).toBe(mainCompaction.scanCompactionSources);
      expect(result.value.projectCheckpointMessages).toBe(mainCompaction.projectCheckpointMessages);
    }
    expect(scanner).not.toHaveBeenCalled();
    expect(projector).not.toHaveBeenCalled();
    expect(carrier).not.toHaveBeenCalled();
  };
}

function expectExactUserText(messages: readonly ChatMessage[], text: string) {
  expect(messages.filter(message => message.role === "user" && message.content === text)).toHaveLength(1);
}

test("absent and EA sidecars select the exact MAIN scanner and checkpoint projector", async () => {
  const fixture = await createControlsEvidenceFixture();
  const head = fixture.ledger.current();
  const call = activeEvidenceCall(head);
  const eaSidecar: SuperWorkerCompactionSidecar = {
    head, parentCallId: call.parentCallId, invocationAttempt: call.activationCount,
    requestId: head.state.requestId, callId: call.callId, sourceRevision: head.revision,
    sources: [], eligibleExecutionIds: [],
  };
  for (const sidecar of [undefined, eaSidecar]) {
    const projection = superCompaction.resolveSuperDependencyObservationCompaction(sidecar);
    expect(projection.scanCompactionSources).toBe(mainCompaction.scanCompactionSources);
    expect(projection.projectCheckpointMessages).toBe(mainCompaction.projectCheckpointMessages);
  }
});

test.each([
  ["undefined", undefined],
  ["EA", resolveRequestExecutionPolicy("execution-agent-v1").authority],
  ["altered SUPER", { ...resolveRequestExecutionPolicy("supervisor-worker-v1").authority, definitionHash: "different" }],
] as const)("%s RAW scope retains arbitrary observation data without interpreting or stripping it", (_name, authority) => {
  const dependency = Object.freeze({ resultRef: "literal-reference", observations: "not an observation array" });
  const context = Object.freeze({ contextScope: "target_only", dependencyResults: Object.freeze([dependency]) });
  const before = JSON.stringify(context);
  const projected = projectPayloadDependencyObservationScope(context, authority);
  expect(projected).toBe(context);
  expect(projected.dependencyResults).toBe(context.dependencyResults);
  expect(projected.dependencyResults[0]).toBe(dependency);
  expect(JSON.stringify(projected)).toBe(before);
});

for (const kind of kinds) {
  test.each(["current", "history"] as const)(
    `EA ${kind} JSON in %s remains plain user data during initial compaction preparation`,
    async location => {
      const text = shapedText(kind);
      const prompt = location === "current" ? text : "Explain the previous JSON example.";
      const fixture = await createControlsEvidenceFixture({
        prompt, historyMessages: location === "history" ? history(text) : [],
      });
      const assertMainOnly = watchSuperCompaction();
      for (const consumer of consumers) {
        const { input, controller } = executionContext(fixture.request, fixture.ledger.current(), consumer);
        const original = JSON.stringify(input.messages);
        expectExactUserText(input.messages, text);
        expect(controller.project(input.messages)).toEqual(input.messages);
        await expect(controller.getStages()[0]!.prepare(input.messages)).resolves.toEqual({
          kind: "unavailable", reason: "no_eligible_sources",
        });
        expect(JSON.stringify(input.messages)).toBe(original);
      }
      expect(fixture.invoke).not.toHaveBeenCalled();
      expect(fixture.countInputTokens).not.toHaveBeenCalled();
      expect(captureRequestContextCompaction(fixture.request.contextCompactionStore!)).toMatchObject({
        checkpoints: [], sources: [],
      });
      assertMainOnly();
    },
  );
}

test.each(consumers)(
  "%s compacts only native EA evidence and restores identical messages without interpreting current or historical Worker JSON",
  async consumer => {
    const currentText = shapedText(kinds[0]);
    const priorText = shapedText(kinds[1], [{ executionId: "user-example-only", adapterResult: "not a canonical source" }]);
    const fixture = await createRootCompactionFixture("execution-agent-v1", { prompt: currentText });
    const request = deriveTestRequestExecutionScope(fixture.request, {
      sessionMemory: undefined, historyMessages: history(priorText),
    });
    const assertMainOnly = watchSuperCompaction();
    const { input, controller } = executionContext(request, fixture.head, consumer);
    const originalMessages = JSON.stringify(input.messages);
    expectExactUserText(input.messages, currentText);
    expectExactUserText(input.messages, priorText);
    expect(controller.project(input.messages)).toEqual(input.messages);

    const prepared = await controller.getStages()[0]!.prepare(input.messages);
    if (prepared.kind !== "prepared") throw new Error("fixture_native_compaction_missing");
    expect(prepared.preparation.coveredSourceCount).toBe(2);
    expect(prepared.preparation.hasExhaustedCompactionSources).toBe(true);
    await prepared.preparation.commit();
    const projected = controller.project(input.messages);
    expect(projected).toEqual(prepared.preparation.messages);
    for (const text of [currentText, priorText]) expectExactUserText(projected, text);
    expect(projected.some(message => message.role === "tool" ||
      (message.role === "assistant" && message.toolCalls))).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("source detail ");
    expect(JSON.stringify(input.messages)).toBe(originalMessages);

    const snapshot = captureRequestContextCompaction(request.contextCompactionStore!);
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(snapshot.sources).toHaveLength(2);
    expect(snapshot.checkpoints[0]!.allowedConsumers).toEqual(consumers);
    expect(snapshot.checkpoints[0]!.sourceDigests.map(source => source.sourceRef).sort())
      .toEqual(snapshot.sources.map(source => source.sourceRef).sort());
    expect(snapshot.sources.some(source => source.content.includes("source detail "))).toBe(true);
    for (const source of snapshot.sources)
      expect(source.sourceFingerprint).toBe(createSemanticCompactionSha256Fingerprint(source.content));
    expect(fixture.modelInputs.every(input => input.step === "context.compact")).toBe(true);
    const summaryInputs = JSON.stringify(fixture.modelInputs);
    expect(summaryInputs).not.toContain("user-example-only");

    const serialized = JSON.stringify(snapshot);
    const restored = restoreRequestContextCompaction(JSON.parse(serialized));
    expect(JSON.stringify(captureRequestContextCompaction(restored))).toBe(serialized);
    const restoredRequest = deriveTestRequestExecutionScope(request, { contextCompactionStore: restored });
    const restoredContext = executionContext(restoredRequest, fixture.head, consumer);
    expect(restoredContext.input.messages).toEqual(input.messages);
    expect(JSON.stringify(restoredContext.controller.project(restoredContext.input.messages)))
      .toBe(JSON.stringify(projected));
    await expect(restoredContext.controller.getStages()[0]!.prepare(restoredContext.input.messages))
      .resolves.toEqual({ kind: "unavailable", reason: "no_new_sources" });
    expect(JSON.stringify(captureRequestContextCompaction(restored))).toBe(serialized);
    assertMainOnly();
  },
);
