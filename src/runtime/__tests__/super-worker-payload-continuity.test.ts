import { expect, test } from "vitest";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
} from "../context/semantic-compaction/contracts.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/payload-contracts.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";

type ModelGatewayInvokeParams = Parameters<ModelGatewayClient["invoke"]>[0];

test("A2/E6 reuses a canonical Worker checkpoint in payload authoring without copying internal sources", async () => {
  const { request, call, view, payload, invoke } =
    await createSuperCompactionSourceFixture();
  const sidecar = readSuperWorkerCompactionSidecar(view)!;
  const store = request.contextCompactionStore!;
  store.registerSourcesAtomically!(sidecar.sources);
  store.commit({
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: `worker:${call.callId}:request-tool-results`,
    requestId: request.requestId,
    currentRequestFingerprint: hash(request.prompt),
    roleId: "worker",
    callId: call.callId,
    objectiveFingerprint: hash(call.objective!),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceRevision: view.sourceRevision,
    sourceDigests: sidecar.sources.map((source) => ({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: "Catalog evidence preserved.",
    })),
    continuation: {
      completed: ["Catalog read"],
      currentState: "The catalog evidence is ready.",
      findings: ["Catalog evidence preserved."],
      evidenceRefs: sidecar.sources.map((source) => source.sourceRef),
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: ["Write a draft."],
      blockers: [],
      nextStep: "Author the draft.",
    },
  });
  invoke.mockImplementation(async (input: ModelGatewayInvokeParams) => {
    expect(input.modelStep).toBe(MODEL_STEPS.TOOL_PAYLOAD_RAW);
    const serialized = JSON.stringify(input.messages);
    expect(serialized).toContain("Catalog evidence preserved.");
    expect(serialized).not.toContain("Complete catalog evidence.");
    expect(serialized).not.toContain("superWorkerCompaction");
    expect(serialized).not.toContain("eligibleExecutionIds");
    expect(serialized).not.toContain("acceptedAction");
    return { text: "report body", meta: {} };
  });
  await expect(payload()).resolves.toEqual({
    status: "authored",
    body: "report body",
  });
  expect(invoke).toHaveBeenCalledOnce();
});

test("A6 target-only payload omissions are never revived by the internal source sidecar", async () => {
  const { request, call, view, payload, invoke } =
    await createSuperCompactionSourceFixture();
  let messages: readonly ChatMessage[] = [];
  invoke.mockImplementation(async (input: ModelGatewayInvokeParams) => {
    messages = input.messages as readonly ChatMessage[];
    expect(JSON.stringify(messages)).not.toContain(
      "Complete catalog evidence.",
    );
    expect(JSON.stringify(messages)).not.toContain("acceptedAction");
    return { text: "report body", meta: {} };
  });
  await expect(payload({ contextScope: "target_only" })).resolves.toEqual({
    status: "authored",
    body: "report body",
  });
  const controller = createModelStepCompactionController(request, {
    call,
    sourceRevision: view.sourceRevision,
    allowedConsumers: [MODEL_STEPS.TOOL_PAYLOAD_RAW],
    superWorkerCompaction: readSuperWorkerCompactionSidecar(view),
    requireSuperWorkerSources: true,
  });
  await expect(controller.getStages()[0]!.prepare(messages)).resolves.toEqual({
    kind: "unavailable",
    reason: "no_eligible_sources",
  });
  expect(request.contextCompactionStore!.snapshot!().sources).toEqual([]);
  expect(invoke).toHaveBeenCalledOnce();
});

test("E6 ordinary Worker and payload schemas remain unchanged while their canonical source contains the accepted action", async () => {
  const { payload, invoke, payloadInput, view } =
    await createSuperCompactionSourceFixture();
  const sidecar = readSuperWorkerCompactionSidecar(
    payloadInput.settledCapabilityResults,
  )!;
  expect(JSON.parse(sidecar.sources[0]!.content)).toHaveProperty(
    "acceptedAction",
  );
  expect(JSON.parse(sidecar.sources[0]!.content)).not.toHaveProperty(
    "referenceData",
  );
  expect(JSON.stringify(view)).not.toContain("sourceFingerprint");
  invoke.mockImplementation(async (input: ModelGatewayInvokeParams) => {
    const context = (input.messages as readonly { content: string }[]).find(
      (message) => message.content.startsWith("Canonical runtime context:\n"),
    )!;
    const decoded = JSON.parse(
      context.content.slice("Canonical runtime context:\n".length),
    );
    expect(decoded.settledCapabilityResults).toEqual(
      payloadInput.settledCapabilityResults,
    );
    expect(decoded.settledCapabilityResults[0]).not.toHaveProperty(
      "acceptedAction",
    );
    expect(decoded).not.toHaveProperty("superWorkerCompaction");
    return { text: "report body", meta: {} };
  });
  await expect(payload()).resolves.toEqual({
    status: "authored",
    body: "report body",
  });
});
