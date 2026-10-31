import { readCompactionEnvelope } from "./support/semantic-compaction-contract-fixture.js";
import {
  semanticCompactionReplacementSlots,
  withCheckpointTokenMeasurement,
} from "./support/semantic-compaction-replacement-fixture.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import {
  settleRootRecall,
  RECALL_FACT,
} from "./support/root-compaction-evidence.js";
import {
  activeEvidenceCall,
  controlsReply,
  createControlsEvidenceFixture,
  evidenceDescriptor,
  runtimeCapsule,
} from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
const fact =
  "Exact selected target /prior/selected.txt contains approved value 42.";
const body = `${"SELECTED_RAW_DETAIL ".repeat(900)}${fact}`;
const continuation = (refs: readonly string[]) => ({
  completed: ["Observed selected evidence."],
  currentState: fact,
  findings: [fact],
  evidenceRefs: refs,
  artifacts: ["/prior/selected.txt"],
  decisions: [],
  failedApproaches: [],
  openWork: ["Complete frozen operation."],
  blockers: [],
  nextStep: "Use the selected fact.",
});
async function refine(
  fixture: Fixture,
  ids: readonly string[],
  objective = "Use selected fact for exact.txt.",
) {
  const head = fixture.ledger.current();
  return refineExecutionCapabilityInvocations(fixture.request, {
    head,
    call: activeEvidenceCall(head),
    capabilities: [evidenceDescriptor],
    eligibleSessionArtifactPaths: [],
    steeringSnapshot: fixture.steering.snapshot(),
    invocations: [
      {
        capabilityId: evidenceDescriptor.capabilityId,
        operationObjective: objective,
        selectionControls: { path: "exact.txt" },
        controlsEvidenceExecutionIds: ids,
      },
    ],
  });
}
function compactFixture(fixture: Fixture, repair = false) {
  const compactInputs: Record<string, unknown>[] = [];
  const controlsInputs: (readonly ChatMessage[])[] = [];
  let shouldRepair = repair;
  fixture.countInputTokens.mockImplementation(async (input) => ({
    inputTokens:
      input.modelStep === "capability.controls" &&
      JSON.stringify(input.messages).includes("SELECTED_RAW_DETAIL")
        ? 24000
        : 1000,
    profileId: "test",
    provider: "openai",
    model: "test",
    contextWindowTokens: 32000,
    source: "provider_input_token_count",
  }));
  fixture.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    if (input.modelStep === "context.compact") {
      const payload = readCompactionEnvelope(messages);
      compactInputs.push(payload);
      const sources = (payload.newSources ?? [payload.sourceSlice]) as {
        sourceRef: string;
        content: string;
      }[];
      const digests = sources.map(({ content }) =>
        content.includes(RECALL_FACT) ? RECALL_FACT : fact,
      );
      return {
        text: JSON.stringify({
          continuation: {
            ...continuation(sources.map(({ sourceRef }) => sourceRef)),
            findings: digests,
          },
          sourceDigests: semanticCompactionReplacementSlots(
            payload,
            (sourceRef) => {
              const index = sources.findIndex(
                (source) => source.sourceRef === sourceRef,
              );
              if (index < 0)
                throw new Error("controls_compaction_fixture_source_missing");
              return digests[index]!;
            },
          ),
        }),
        meta: {},
      };
    }
    controlsInputs.push([...messages]);
    if (shouldRepair) {
      shouldRepair = false;
      return {
        text: JSON.stringify({ decision: { invocations: {} } }),
        meta: {},
      };
    }
    return controlsReply({ query: fact });
  });
  return { compactInputs, controlsInputs };
}

test("C6/C11/C12: only selected evidence compacts at 70 percent and structured repair reuses its checkpoint", async () => {
  const fixture = await createControlsEvidenceFixture();
  const id = await fixture.addResult(body, { target: "/prior/selected.txt" });
  await fixture.addResult("UNSELECTED_MUST_NOT_COMPACT");
  const observed = compactFixture(fixture, true);
  await expect(refine(fixture, [id])).resolves.toMatchObject({
    invocations: [{ controls: { path: "exact.txt", query: fact } }],
  });
  expect(observed.compactInputs).toHaveLength(1);
  expect(JSON.stringify(observed.compactInputs)).not.toContain(
    "UNSELECTED_MUST_NOT_COMPACT",
  );
  expect(observed.compactInputs[0]).toMatchObject({
    newSources: [{ sourceRef: id }],
  });
  expect(JSON.stringify(observed.compactInputs[0])).toContain(
    "Use selected fact for exact.txt.",
  );
  expect(observed.controlsInputs).toHaveLength(2);
  for (const messages of observed.controlsInputs) {
    const capsule = runtimeCapsule(
      messages,
      "runtime_request_tool_results_v1",
    )!;
    expect(capsule.results).toEqual([]);
    expect(capsule.semanticCheckpoint).toMatchObject({
      coveredSources: [{ sourceRef: id }],
      continuation: { artifacts: ["/prior/selected.txt"] },
    });
    expect(JSON.stringify(messages)).not.toContain("SELECTED_RAW_DETAIL");
  }
  const snapshot = captureRequestContextCompaction(
    fixture.request.contextCompactionStore!,
  );
  expect(snapshot.checkpoints).toHaveLength(1);
  expect(snapshot.sources).toHaveLength(1);
  expect(snapshot.checkpoints[0]!.allowedConsumers).toEqual([
    "capability.controls",
  ]);
  expect(fixture.request.onEvent).toHaveBeenCalledWith(
    "context.compaction.started",
    expect.objectContaining({ triggerInputTokens: 22400 }),
  );
  await fixture.addResult("NEW_HEAD_WITHOUT_SELECTED_DELTA");
  await refine(fixture, [id]);
  expect(observed.compactInputs).toHaveLength(2);
  expect(
    captureRequestContextCompaction(fixture.request.contextCompactionStore!)
      .checkpoints,
  ).toHaveLength(2);
});

test("C10/C17: root and legacy Controls checkpoints stay isolated from the new frozen assignment", async () => {
  const fixture = await createControlsEvidenceFixture({
    longTermMemory: {
      enabled: true,
      retrieve: vi.fn(),
      processCandidates: vi.fn(),
      scheduleCandidates: vi.fn(),
      status: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    },
  });
  const id = await fixture.addResult(body);
  const memoryRecallMessage = await settleRootRecall(fixture.ledger);
  const observed = compactFixture(fixture);
  await refine(fixture, [id]);
  const store = fixture.request.contextCompactionStore!;
  const own = captureRequestContextCompaction(store).checkpoints[0]!;
  const call = activeEvidenceCall(fixture.ledger.current());
  store.commit({
    ...own,
    scopeId: `role:${call.roleId}:${call.callId}:controls-refinement`,
    objectiveFingerprint: hash(fixture.request.prompt),
    continuation: {
      ...own.continuation,
      findings: ["OLD_CONTROLS_UNSELECTED"],
    },
  });
  const head = fixture.ledger.current();
  const input = buildExecutionAgentInput(fixture.request, {
    head,
    call,
    steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: true,
    allowAuditor: true,
    memoryRecallMessage,
  });
  const root = createExecutionAgentCompactionController(fixture.request, {
    call,
    consumer: input.modelStep,
    steeringSnapshot: fixture.steering.snapshot(),
    head,
    allowedConsumers: ["execution.decision", "execution.response"],
  });
  const rootCandidate = await root.getStages()[0]!.prepare(input.messages);
  if (rootCandidate.kind !== "prepared")
    throw new Error("fixture_root_compaction_missing");
  await rootCandidate.preparation.commit();
  expect(JSON.stringify(root.project(input.messages))).toContain(RECALL_FACT);
  expect(input.contract.eligibleControlsEvidenceExecutionIds).toEqual([id]);
  await refine(fixture, []);
  const emptyInput = observed.controlsInputs.at(-1)!;
  expect(
    runtimeCapsule(emptyInput, "runtime_request_tool_results_v1"),
  ).toBeUndefined();
  expect(JSON.stringify(emptyInput)).not.toContain(RECALL_FACT);
  expect(JSON.stringify(emptyInput)).not.toContain("OLD_CONTROLS_UNSELECTED");
});

test("C9/C18: a future matching checkpoint revision fails before count or model dispatch", async () => {
  const fixture = await createControlsEvidenceFixture();
  const id = await fixture.addResult(body);
  compactFixture(fixture);
  await refine(fixture, [id]);
  const store = fixture.request.contextCompactionStore!;
  const checkpoint = captureRequestContextCompaction(store).checkpoints[0]!;
  store.commit({
    ...checkpoint,
    sourceRevision: fixture.ledger.current().revision + 1,
  });
  fixture.invoke.mockClear();
  fixture.countInputTokens.mockClear();
  await expect(refine(fixture, [id])).rejects.toThrow(
    "context_compaction_checkpoint_revision_invalid",
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.countInputTokens).not.toHaveBeenCalled();
});

test("C11: selected scope exhaustion fails admission without repeated compaction or provider dispatch", async () => {
  const fixture = await createControlsEvidenceFixture();
  const id = await fixture.addResult(body);
  const observed = compactFixture(fixture);
  fixture.countInputTokens.mockImplementation(
    withCheckpointTokenMeasurement(async (input) => ({
      inputTokens: input.modelStep === "capability.controls" ? 24000 : 1000,
      profileId: "test",
      provider: "openai",
      model: "test",
      contextWindowTokens: 32000,
      source: "provider_input_token_count",
    })),
  );
  await expect(refine(fixture, [id])).rejects.toThrow(
    "context_compaction_projection_not_reduced",
  );
  expect(observed.compactInputs).toHaveLength(1);
  expect(observed.controlsInputs).toHaveLength(0);
  expect(
    captureRequestContextCompaction(fixture.request.contextCompactionStore!)
      .checkpoints,
  ).toHaveLength(0);
});

test("C11: estimator-only admission compacts selected sources without claiming an actual count", async () => {
  const fixture = await createControlsEvidenceFixture();
  const ids = [];
  for (let index = 0; index < 3; index++)
    ids.push(
      await fixture.addResult(
        `${body}\n${"more selected details ".repeat(600)}`,
      ),
    );
  const observed = compactFixture(fixture);
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelGatewayClient: { invoke: fixture.invoke, invokeRaw: vi.fn() },
  });
  await refine({ ...fixture, request }, ids);
  expect(observed.compactInputs.length).toBeGreaterThan(0);
  expect(fixture.countInputTokens).not.toHaveBeenCalled();
  expect(observed.controlsInputs).toHaveLength(1);
  const checkpoint = captureRequestContextCompaction(
    request.contextCompactionStore!,
  ).checkpoints[0]!;
  expect(checkpoint.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual(
    ids,
  );
  expect(
    checkpoint.sourceDigests.every(({ digest }) => digest.includes(fact)),
  ).toBe(true);
  expect(JSON.stringify(observed.controlsInputs)).not.toContain(
    "SELECTED_RAW_DETAIL",
  );
  expect(request.onEvent).toHaveBeenCalledWith(
    "context.window.snapshot",
    expect.objectContaining({
      modelStep: "capability.controls",
      measurement: "estimated",
      compactionTriggerPercent: 70,
    }),
  );
});

test("C21: repeated assignments retain one exact source and one checkpoint per compacted binding", async () => {
  const fixture = await createControlsEvidenceFixture();
  const id = await fixture.addResult(body);
  const observed = compactFixture(fixture);
  const store = fixture.request.contextCompactionStore!;
  const bytes: number[] = [];
  for (let index = 0; index < 12; index++) {
    await refine(fixture, [id], `Bounded operation ${index} on exact.txt.`);
    const beforeRepair = captureRequestContextCompaction(store);
    await refine(fixture, [id], `Bounded operation ${index} on exact.txt.`);
    const snapshot = captureRequestContextCompaction(store);
    expect(snapshot).toEqual(beforeRepair);
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.checkpoints).toHaveLength(index + 1);
    bytes.push(JSON.stringify(snapshot).length);
    expect(
      captureRequestContextCompaction(
        restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot))),
      ),
    ).toEqual(snapshot);
  }
  expect(observed.compactInputs).toHaveLength(12);
  expect(bytes.at(-1)!).toBeGreaterThan(bytes[0]!);
  expect(bytes.at(-1)! - bytes[0]!).toBeLessThan(body.length * 2);
  console.info(
    "C21 snapshot retention",
    JSON.stringify({
      assignments: 12,
      checkpoints: 12,
      exactSources: 1,
      bytes,
      sourcesBytes: JSON.stringify(
        captureRequestContextCompaction(store).sources,
      ).length,
      checkpointsBytes: JSON.stringify(
        captureRequestContextCompaction(store).checkpoints,
      ).length,
    }),
  );
});

test("C18: restored source/hash conflict with the selected canonical ledger fails before provider dispatch", async () => {
  const fixture = await createControlsEvidenceFixture();
  const id = await fixture.addResult(body);
  compactFixture(fixture);
  await refine(fixture, [id]);
  const captured = captureRequestContextCompaction(
    fixture.request.contextCompactionStore!,
  );
  const changedContent = captured.sources[0]!.content.replace(
    "SELECTED_RAW_DETAIL",
    "CONFLICTING_SOURCE_BYTES",
  );
  const sourceFingerprint = hash(changedContent);
  const restored = restoreRequestContextCompaction({
    ...captured,
    sources: [
      { ...captured.sources[0]!, content: changedContent, sourceFingerprint },
    ],
    checkpoints: captured.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      sourceDigests: checkpoint.sourceDigests.map((digest) => ({
        ...digest,
        sourceFingerprint,
      })),
    })),
  });
  const request = deriveTestRequestExecutionScope(fixture.request, {
    contextCompactionStore: restored,
  });
  fixture.invoke.mockClear();
  fixture.countInputTokens.mockClear();
  await expect(refine({ ...fixture, request }, [id])).rejects.toThrow(
    "context_compaction_source_identity_conflict",
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.countInputTokens).not.toHaveBeenCalled();
});
