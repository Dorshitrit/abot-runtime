import { expect, test } from "vitest";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  createCapabilityResultCompactionSource,
  projectCanonicalCapabilityResultCompactionSources,
} from "../context/capability-result-compaction-source.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
  type RequestToolResult,
} from "../context/request-tool-results.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
} from "../context/semantic-compaction/contracts.js";

test.each([undefined, "", "different reference", "the output"])(
  "A4 canonical content preserves optional reference semantics: %s",
  (referenceData) => {
    const result: RequestToolResult = {
      executionId: "execution",
      callId: "worker",
      invocationAttempt: 1,
      capabilityId: "tool",
      declaredEffect: "observation",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed",
      ...(referenceData === undefined ? {} : { referenceData }),
      references: [],
      adapterResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: { referenceData: "the output", ordered: { z: 1, a: 2 } },
      },
      summaryProjection: "superseded_target_evidence",
      supersededByExecutionIds: ["later"],
    };
    const source = createCapabilityResultCompactionSource(result);
    const content = JSON.parse(source.content);
    expect(content.referenceData).toBe(
      referenceData === "different reference" ? referenceData : undefined,
    );
    expect(content.references).toEqual([]);
    expect(content).not.toHaveProperty("summaryProjection");
    expect(content).not.toHaveProperty("supersededByExecutionIds");
    expect(source.content).toContain('"ordered":{"z":1,"a":2}');
    expect(
      createCapabilityResultCompactionSource(JSON.parse(source.content)),
    ).toEqual(source);
  },
);

test("A4 registered adapter dedup retains a single exact output and freezes source bytes", () => {
  const adapter = {
    kind: "registered_tool_execution_result_v1" as const,
    authority: "registered_plugin" as const,
    status: "executed" as const,
    result: {
      ok: true,
      tool: "read",
      producedNewInformation: true,
      output: "Original body",
    },
  };
  const result: RequestToolResult = {
    executionId: "e",
    callId: "c",
    invocationAttempt: 1,
    capabilityId: "read",
    declaredEffect: "observation",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read",
    referenceData: "Original body",
    adapterResult: adapter,
  };
  const source = createCapabilityResultCompactionSource(result);
  adapter.result.output = "Mutated later";
  expect(source.content).not.toContain("Mutated later");
  expect(JSON.parse(source.content)).not.toHaveProperty("referenceData");
  expect(Object.isFrozen(source)).toBe(true);
});

test("A3 corrupted canonical accepted controls reject rather than author new evidence", async () => {
  const { head, call } = await createSuperCompactionSourceFixture();
  const corrupted = {
    ...head,
    state: {
      ...head.state,
      capabilityExecutions: head.state.capabilityExecutions.map(
        (execution) => ({ ...execution, controlsJson: "[]" }),
      ),
    },
  };
  expect(() =>
    projectCanonicalCapabilityResultCompactionSources({
      head: corrupted,
      callId: call.callId,
    }),
  ).toThrow("accepted_capability_action_controls_invalid");
});

test("B4 copied messages and missing/stale SUPER sidecars reject before compactor invocation", async () => {
  const { request, call, head, view, invoke } =
    await createSuperCompactionSourceFixture();
  const bound = buildRequestToolResultsMessage(view);
  const sidecar = readSuperWorkerCompactionSidecar(view)!;
  const options = {
    call,
    sourceRevision: head.revision,
    scopeId: `worker:${call.callId}:request-tool-results`,
    allowedConsumers: [MODEL_STEPS.WORKER_DECISION],
    requireSuperWorkerSources: true,
  };
  await expect(
    createModelStepCompactionController(request, options)
      .getStages()[0]!
      .prepare([{ ...bound }]),
  ).rejects.toThrow("context_compaction_source_binding_required");
  await expect(
    createModelStepCompactionController(request, {
      ...options,
      superWorkerCompaction: sidecar,
    })
      .getStages()[0]!
      .prepare([{ ...bound }]),
  ).rejects.toThrow("context_compaction_source_message_binding_invalid");
  await expect(
    createModelStepCompactionController(request, {
      ...options,
      sourceRevision: head.revision + 1,
    })
      .getStages()[0]!
      .prepare([bound]),
  ).rejects.toThrow("context_compaction_source_revision_invalid");
  expect(invoke).not.toHaveBeenCalled();
});

test("A6 supersession retains original identity but only eligible evidence is newly folded", async () => {
  const { request, ledger, call, head, view, commit } =
    await createSuperCompactionSourceFixture();
  const original = readSuperWorkerCompactionSidecar(view)!.sources[0]!;
  const first = head.state.capabilityExecutions[0]!;
  await commit({
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: 2,
    capabilityId: first.capabilityId,
    declaredEffect: "mutation",
    intent: "Update catalog",
    controlsJson: "{}",
  });
  await commit({
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: "capability-execution-2",
    outcome: "succeeded",
    observedEffect: "mutation",
    summary: "Catalog updated",
    references: first.references,
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { changed: true },
    },
  });
  const current = ledger.current();
  const next = projectRequestToolResults({
    ledger,
    head: current,
    callId: call.callId,
    modelStep: MODEL_STEPS.WORKER_DECISION,
  });
  const sidecar = readSuperWorkerCompactionSidecar(next)!;
  expect(sidecar.sources[0]).toEqual(original);
  expect(sidecar.eligibleExecutionIds).toEqual(["capability-execution-2"]);
  const controller = createModelStepCompactionController(request, {
    call,
    sourceRevision: current.revision,
    allowedConsumers: [MODEL_STEPS.WORKER_DECISION],
    scopeId: `worker:${call.callId}:request-tool-results`,
    superWorkerCompaction: sidecar,
    requireSuperWorkerSources: true,
  });
  await expect(
    controller.getStages()[0]!.prepare([buildRequestToolResultsMessage(next)]),
  ).rejects.toThrow("fixture_compactor_failure");
  expect(
    request.contextCompactionStore!.snapshot!().sources.map(
      (source) => source.sourceRef,
    ),
  ).toEqual(["capability-execution-2"]);
  expect(buildRequestToolResultsMessage(next).content).not.toContain(
    "Complete catalog evidence.",
  );
});

test("F1 canonical registration conflicts carry exact invocation provenance while provider errors stay unchanged", async () => {
  const { request, view, worker, head, call, invoke } =
    await createSuperCompactionSourceFixture();
  const sidecar = readSuperWorkerCompactionSidecar(view)!;
  const source = sidecar.sources[0]!;
  const content = JSON.stringify({
    ...JSON.parse(source.content),
    summary: "Different immutable source.",
  });
  request.contextCompactionStore!.registerSources([
    { ...source, content, sourceFingerprint: hash(content) },
  ]);
  const error = await worker().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(SuperContextFailure);
  expect(error).toMatchObject({
    code: "context_compaction_source_identity_conflict",
    binding: {
      requestId: request.requestId,
      callId: call.callId,
      parentCallId: call.parentCallId,
      contractId: "delegated.worker",
      invocationAttempt: call.activationCount,
      sourceRevision: head.revision,
      modelStep: MODEL_STEPS.WORKER_DECISION,
      sourceRef: source.sourceRef,
    },
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(sidecar)).not.toContain("capabilityExecutions");
  const other = await createSuperCompactionSourceFixture("another-request");
  const providerError = await other
    .worker()
    .catch((failure: unknown) => failure);
  expect(providerError).not.toBeInstanceOf(SuperContextFailure);
  expect(providerError).toMatchObject({ message: "fixture_compactor_failure" });
  expect(other.request.contextCompactionStore!.snapshot!().sources[0]).toEqual(
    source,
  );
});

test.each([true, false])(
  "F1 payload projection retains the rejected source only for SUPER opt-in: %s",
  async (superOwned) => {
    const { request, view, call, invoke } =
      await createSuperCompactionSourceFixture();
    const sidecar = readSuperWorkerCompactionSidecar(view)!;
    const source = sidecar.sources[0]!;
    const scopeId = `worker:${call.callId}:request-tool-results`;
    const allowedConsumers = [MODEL_STEPS.TOOL_PAYLOAD_RAW];
    request.contextCompactionStore!.commit({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId,
      requestId: request.requestId,
      roleId: "worker",
      callId: call.callId,
      currentRequestFingerprint: hash(request.prompt),
      objectiveFingerprint: hash(call.objective!),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      sourceRevision: view.sourceRevision,
      allowedConsumers,
      sourceDigests: [
        {
          sourceRef: source.sourceRef,
          sourceFingerprint: hash("different bytes"),
          digest: "Earlier evidence.",
        },
      ],
      continuation: {
        completed: [],
        currentState: "Earlier evidence.",
        findings: [],
        evidenceRefs: [source.sourceRef],
        artifacts: [],
        decisions: [],
        failedApproaches: [],
        openWork: ["Write report."],
        blockers: [],
        nextStep: "Write report.",
      },
    });
    const controller = createModelStepCompactionController(request, {
      call,
      sourceRevision: view.sourceRevision,
      scopeId,
      allowedConsumers,
      consumer: MODEL_STEPS.TOOL_PAYLOAD_RAW,
      ...(superOwned
        ? { superWorkerCompaction: sidecar }
        : { resultSourceOverrides: sidecar.sources }),
    });
    let error: unknown;
    try {
      controller.project!([
        {
          role: "user",
          content: `Canonical runtime context:\n${JSON.stringify({ settledCapabilityResults: [JSON.parse(source.content)] })}`,
        },
      ]);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "context_compaction_source_identity_conflict",
    );
    if (superOwned) {
      expect(error).toBeInstanceOf(SuperContextFailure);
      expect((error as SuperContextFailure).binding.sourceRef).toBe(
        source.sourceRef,
      );
    } else {
      expect((error as Error).constructor).toBe(Error);
    }
    expect(invoke).not.toHaveBeenCalled();
  },
);
