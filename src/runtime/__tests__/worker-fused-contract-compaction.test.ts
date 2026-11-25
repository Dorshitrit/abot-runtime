import { expect, test, vi } from "vitest";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../context/operation-supervision-evidence.js";
import { buildRequestToolResultsMessage } from "../context/request-tool-results.js";
import { projectRequestContext } from "../context/request-context.js";
import { scanCompactionSources } from "../context/model-step-compaction-projection.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createPolicyModelStepCompactionController } from "../context/super-compaction/routing.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/contracts.js";
import { createWorkerDecisionFormat } from "../steps/worker-decision/format.js";
import { createWorkerFusedDecisionFormat } from "../steps/worker-decision/fused-decision-format.js";
import { projectWorkerFusedOutputContract } from "../steps/worker-decision/fused-output-contract.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";

test("restored Worker evidence preserves the exact trailing output contract outside compaction sources", async () => {
  const f = await mixedWorkerFixture();
  const saved = captureRequestContextCompaction(f.store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(saved)));
  const invoke = vi.fn();
  const request = createCompactionRequest({
    requestId: f.head.state.requestId, prompt: "Inspect the target.", invoke, store: restored,
  });
  const evidenceRefs = f.checkpoint.sourceDigests.map(({ sourceRef }) => sourceRef);
  const selectionFormat = createWorkerDecisionFormat({
    capabilities: [{
      capabilityId: "files.read", summary: "Read target.", effect: "observation",
      controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }],
    maxBatchCapabilityExecutions: 94,
  });
  const contract = Object.freeze({
    role: "system" as const,
    content: projectWorkerFusedOutputContract(selectionFormat, evidenceRefs),
  });
  const assignment = JSON.stringify({
    kind: "runtime_worker_evidence_assignment_v1", objective: f.call.objective,
    requestId: request.requestId, callId: f.call.callId, sourceRevision: f.view.sourceRevision,
    evidenceRefs,
  });
  const context = projectRequestContext({
    instructions: "Assess the evidence and select the next Worker action.",
    historyMessages: [], prompt: assignment,
    referenceMessages: [
      buildRequestToolResultsMessage(f.view),
      buildImmediateOperationSupervisionEvidenceMessage(f.head, f.call)!,
    ],
    continuationMessages: [contract],
    format: createWorkerFusedDecisionFormat(selectionFormat, evidenceRefs),
    budget: { contextWindowTokens: 16_000, outputReserveTokens: 2_048,
      safetyReserveTokens: 512, attachmentReserveTokens: 0 },
  });
  const sources = scanCompactionSources(
    context.messages, f.checkpoint.scopeId, new Map(f.sources.map((source) => [source.sourceRef, source])),
  );
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.every(({ index }) => context.messages[index] !== contract)).toBe(true);
  expect(sources.every(({ source }) => !source.content.includes(contract.content))).toBe(true);

  const projected = createPolicyModelStepCompactionController(request, {
    call: f.call, scopeId: f.checkpoint.scopeId, sourceRevision: f.view.sourceRevision,
    allowedConsumers: f.checkpoint.allowedConsumers, consumer: "worker.decision",
    resultSourceOverrides: f.sources,
  }, SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT).project(context.messages);

  expect(projected.filter(({ content }) => content === contract.content)).toEqual([contract]);
  expect(projected.indexOf(contract)).toBeGreaterThan(projected.findIndex(({ content }) => content === assignment));
  expect(projected.some(({ content }) => content === assignment)).toBe(true);
  expect(projected.at(-1)).toBe(contract);
  expect(JSON.stringify(projected)).toContain("Preserved exact evidence.");
  expect(restored.get(f.checkpoint.scopeId)?.sourceDigests).toEqual(f.checkpoint.sourceDigests);
  expect(captureRequestContextCompaction(restored)).toEqual(saved);
  expect(invoke).not.toHaveBeenCalled();
});
