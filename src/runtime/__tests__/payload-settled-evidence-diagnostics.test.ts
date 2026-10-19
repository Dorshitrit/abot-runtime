import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

vi.mock("../observability/log-rotation.js", () => ({
  appendTraceLineWithRotation: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.stubEnv("LLM_RUNTIME_TRACE", "1");
  configureDebugLogger({ enabled: true });
});
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function settledResult(
  index: number,
  referenceData: string,
  adapterBody: string,
  target: string,
): WorkerSettledCapabilityResult {
  return Object.freeze({
    executionId: `capability-execution-${index}`,
    callId: "call-1",
    invocationAttempt: index,
    capabilityId: "example.observe",
    declaredEffect: "observation",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: `Observation ${index} completed.`,
    referenceData,
    references: [{ kind: "tool_target" as const, target }],
    adapterResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { nested: { body: adapterBody } },
    } as const,
  });
}

const adapterBody = "ADAPTER_BODY";
const targetBody = "TARGET_BODY";
const artifactBody = "ARTIFACT_BODY";
const independentBody = "UNREPRESENTED_BODY";
const targetPath = "sandbox/current.txt";
const artifactPath = "sandbox/related.txt";
const source = Object.freeze([
  settledResult(1, adapterBody, adapterBody, "sandbox/observed.txt"),
  settledResult(2, targetBody, "TARGET_RECEIPT", targetPath),
  settledResult(3, artifactBody, "ARTIFACT_RECEIPT", artifactPath),
  settledResult(4, independentBody, "INDEPENDENT_RECEIPT", "sandbox/independent.txt"),
]);

const scenarios = [
  { contextScope: "standard", retainedReferences: [targetBody, artifactBody, independentBody],
    deduplicatedCount: 1, deduplicatedChars: adapterBody.length },
  { contextScope: "target_only", retainedReferences: [],
    deduplicatedCount: 0, deduplicatedChars: 0 },
  { contextScope: "target_with_artifacts", retainedReferences: [independentBody],
    deduplicatedCount: 3,
    deduplicatedChars: adapterBody.length + targetBody.length + artifactBody.length },
] as const;

test.each(scenarios)("reports the final request payload representation for $contextScope", async (scenario) => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const fixture = await createControlsEvidenceFixture();
  const request = deriveTestRequestExecutionScope(fixture.request, {
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "tool_payload.raw": { timeoutMs: 20_000 } },
    },
    modelPolicy: {
      ...fixture.request.modelPolicy!,
      defaults: { profileId: "test", steps: { "tool_payload.raw": "toolPayload.raw" } },
    },
  });
  const sourceBytes = JSON.stringify(source);
  let observed: readonly WorkerSettledCapabilityResult[] | undefined;
  fixture.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("tool_payload.raw");
    const prefix = "Canonical runtime context:\n";
    const message = (input.messages as readonly ChatMessage[])
      .find(({ content }) => content.startsWith(prefix));
    expect(message).toBeDefined();
    const canonical = JSON.parse(message!.content.slice(prefix.length));
    expect(canonical.contextScope).toBe(scenario.contextScope);
    observed = canonical.settledCapabilityResults;
    expect(observed!.flatMap(({ referenceData }) => referenceData ? [referenceData] : []))
      .toEqual(scenario.retainedReferences);
    if (scenario.contextScope === "target_only") {
      expect(observed).toEqual([]);
    } else {
      expect(observed!.map(({ adapterResult }) => adapterResult))
        .toEqual(source.map(({ adapterResult }) => adapterResult));
      expect(observed![0]).not.toHaveProperty("referenceData");
    }
    if (scenario.contextScope === "target_with_artifacts") {
      expect(observed![1]).toHaveProperty("referenceDataRef", "runtime_payload_target_content_v1");
      expect(observed![2]).toHaveProperty("referenceDataRef", "runtime_payload_related_artifact_content_v1:1");
    }
    return { text: "complete payload", meta: {} };
  });
  const author = createRequestWorkerCapabilityPayloadAuthor(request, ["root"]);
  await expect(author.author({
    call: {
      callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0,
      objective: null, dependencyResultRefs: [], status: "active",
      childCallIds: [], activationCount: 5, resultRef: null,
    },
    executionId: "capability-execution-5",
    descriptor: {
      capabilityId: "example.write", summary: "Write the accepted output.", effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
    authoringObjective: "Author the accepted output using the observed facts.",
    controls: {},
    requestSteering: { kind: "request_steering_v1", version: 0, updates: [] },
    settledCapabilityResults: source,
    contextScope: scenario.contextScope,
    stage: { index: 1, count: 1, outputParam: "body" },
    targetContext: { targetParam: "path", targetPath, presentation: "full", content: targetBody },
    ...(scenario.contextScope === "target_with_artifacts" ? {
      relatedArtifactContexts: [{ sourceExecutionId: source[2]!.executionId,
        targetPath: artifactPath, presentation: "full", content: artifactBody }],
    } : {}),
    contract: { instructions: "Return the accepted output body.", minBytes: 1, maxBytes: 128 },
  })).resolves.toEqual({ status: "authored", body: "complete payload" });
  expect(fixture.invoke).toHaveBeenCalledOnce();
  expect(JSON.stringify(source)).toBe(sourceBytes);
  expect(observed).toBeDefined();

  const included = observed!;
  const sourceChars = source.reduce((sum, result) => sum + result.referenceData!.length, 0);
  const includedChars = included.reduce((sum, result) => sum + (result.referenceData?.length ?? 0), 0);
  const sourceSummaryChars = source.reduce((sum, result) => sum + result.summary.length, 0);
  const includedSummaryChars = included.reduce((sum, result) => sum + result.summary.length, 0);
  const projectionLogs = consoleLog.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter(({ scope, event, requestId }) => scope === "runtime.worker_capability_payload_context"
      && event === "projected" && requestId === request.requestId);
  expect(projectionLogs).toEqual([expect.objectContaining({
    contextScope: scenario.contextScope,
    sourceResultCount: source.length,
    includedResultCount: included.length,
    omittedResultCount: source.length - included.length,
    sourceSummaryCount: source.length,
    includedSummaryCount: included.length,
    omittedSummaryCount: source.length - included.length,
    sourceSummaryChars,
    includedSummaryChars,
    omittedSummaryChars: sourceSummaryChars - includedSummaryChars,
    sourceReferenceDataCount: source.length,
    includedReferenceDataCount: scenario.retainedReferences.length,
    omittedReferenceDataCount: source.length - scenario.retainedReferences.length,
    sourceReferenceDataChars: sourceChars,
    includedReferenceDataChars: includedChars,
    omittedReferenceDataChars: sourceChars - includedChars,
    deduplicatedReferenceDataCount: scenario.deduplicatedCount,
    deduplicatedReferenceDataChars: scenario.deduplicatedChars,
  })]);
});
