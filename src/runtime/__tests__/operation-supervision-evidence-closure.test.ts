import { expectCompactedSupervisionReference } from "./support/compacted-supervision-assertions.js";
import { bindRequestToolResultsMessage } from "../context/request-tool-results-message-binding.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { readOperationSupervisionEvidenceBinding } from "../context/operation-supervision-evidence-binding.js";
import { projectOperationSupervisionEvidenceClosure } from "../context/operation-supervision-evidence-projection.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  supervisionClosureFixture,
  readEvidence,
  commit,
} from "./support/supervision-closure-fixture.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../context/operation-supervision-evidence.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { buildRequestToolResultsMessage } from "../context/request-tool-results.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

test("S02/S11: a covered same-call origin retains its accepted operation and links to its exact digest", async () => {
  const { head, call, view, store, checkpoint } = await mixedWorkerFixture();
  const { request } = await createSuperCompactionSourceFixture();
  const controller = createModelStepCompactionController(
    {
      ...request,
      requestId: head.state.requestId,
      prompt: "Inspect the target.",
      contextCompactionStore: store,
    },
    {
      call,
      sourceRevision: head.revision,
      consumer: "worker.decision",
      allowedConsumers: checkpoint.allowedConsumers,
      scopeId: checkpoint.scopeId,
    },
  );
  const projected = controller.project([
    buildRequestToolResultsMessage(view),
    buildImmediateOperationSupervisionEvidenceMessage(head, call)!,
  ]);
  const capsule = projected
    .map(({ content }) => JSON.parse(content))
    .find(({ kind }) => kind === "runtime_operation_supervision_evidence_v1");
  expect(capsule?.entries[0].evidence).toMatchObject({
    kind: "compacted_capability_result_reference",
    acceptedAction: {
      executionId: "capability-execution-2",
      controls: { path: "target.txt" },
    },
  });
  expectCompactedSupervisionReference(
    projected,
    capsule.entries[0].evidence,
    "capability-execution-2",
  );
});

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("S03/S06: exact surviving native action/result keeps one reference and repeated projection is identical", async () => {
  const f = await supervisionClosureFixture();
  const projected = f.controller().project(f.messages);
  expect(projected).toEqual(f.messages);
  expect(readEvidence(projected)[0].entries[0].evidence).toEqual({
    kind: "existing_exact_capability_result_lane",
    executionId: "capability-execution-2",
  });
  f.installCheckpoint();
  const compacted = f.controller().project(f.messages);
  expect(f.controller().project(compacted)).toEqual(compacted);
  expect(JSON.stringify(compacted)).not.toContain(
    "EXACT_capability-execution-2",
  );
  expectCompactedSupervisionReference(
    compacted,
    readEvidence(compacted)[0].entries[0].evidence,
    "tool-result:capability-execution-2",
  );
});

test("compacted supervision removes a full result carried in summary while retaining its source and outcome", async () => {
  const summary = "FULL_RESULT_SUMMARY:" + "source detail ".repeat(500).trim();
  const f = await supervisionClosureFixture({
    summary,
    registeredOutput: summary,
  });
  expect(JSON.stringify(f.controller().project(f.messages))).toContain(summary);
  const original = JSON.stringify(f.head.state);
  const checkpoint = f.installCheckpoint();
  const projected = f.controller().project(f.messages);
  const evidence = readEvidence(projected)[0].entries[0].evidence;
  expect(evidence.receipt).toMatchObject({
    executionId: "capability-execution-2",
    outcome: "succeeded",
    observedEffect: "observation",
  });
  expect(evidence.receipt.summary).not.toBe(summary);
  expect(JSON.stringify(projected)).not.toContain(summary);
  expectCompactedSupervisionReference(
    projected,
    evidence,
    "tool-result:capability-execution-2",
  );
  expect(f.controller().project(projected)).toEqual(projected);
  expect(f.store.get(checkpoint.scopeId)).toEqual(checkpoint);
  expect(JSON.stringify(f.head.state)).toBe(original);
  expect(f.head.state.capabilityExecutions[1]!.summary).toBe(summary);
});

test.each([false, true])(
  "S05: native batch stays closed and covered notice origins link to their own digest (both=%s)",
  async (repeatBoth) => {
    const f = await supervisionClosureFixture({ batch: true, repeatBoth });
    expect(f.native.filter(({ role }) => role === "assistant")).toHaveLength(2);
    expect(f.native.filter(({ role }) => role === "tool")).toHaveLength(4);
    const unchanged = f.controller().project(f.messages);
    expect(unchanged).toEqual(f.messages);
    f.installCheckpoint();
    const projected = f.controller().project(f.messages);
    expect(
      projected.filter(({ role }) => role === "tool" || role === "assistant"),
    ).toHaveLength(0);
    expect(readEvidence(projected)[0].entries).toHaveLength(repeatBoth ? 2 : 1);
    expect(JSON.stringify(projected)).not.toContain(
      "EXACT_capability-execution-3",
    );
    for (const entry of readEvidence(projected)[0].entries)
      expectCompactedSupervisionReference(
        projected,
        entry.evidence,
        `tool-result:${entry.originExecutionId}`,
      );
    expect(JSON.stringify(projected)).not.toContain(
      "EXACT_capability-execution-1",
    );
  },
);

test("S03/S09: covered duplicate referenceData stays in the source store without raw re-embedding", async () => {
  const f = await supervisionClosureFixture({ duplicateReference: true });
  f.installCheckpoint();
  const projected = f.controller().project(f.messages);
  expect(JSON.stringify(projected)).not.toContain("EXACT_REFERENCE_ONCE");
  expectCompactedSupervisionReference(
    projected,
    readEvidence(projected)[0].entries[0].evidence,
    "tool-result:capability-execution-2",
  );
  expect(
    f.store.snapshot!().sources.some(({ content }) =>
      content.includes("EXACT_REFERENCE_ONCE"),
    ),
  ).toBe(true);
  expect(
    readEvidence(projected)[0].entries[0].evidence.receipt,
  ).not.toHaveProperty("referenceData");
});

test.each([
  "request",
  "call",
  "activation",
  "role",
  "revision",
  "future",
  "controls",
  "payload",
  "consumer_missing",
] as const)(
  "S07/S15: rejects %s identity before generation",
  async (boundary) => {
    const f = await supervisionClosureFixture();
    const context = {
      requestId: f.request.requestId,
      call: f.call,
      sourceRevision: f.head.revision,
      consumer: "execution.decision" as string | undefined,
    };
    if (boundary === "request") context.requestId = "foreign-request";
    if (boundary === "call")
      context.call = { ...f.call, callId: "foreign-call" };
    if (boundary === "activation")
      context.call = { ...f.call, activationCount: f.call.activationCount + 1 };
    if (boundary === "role") context.call = { ...f.call, roleId: "worker" };
    if (boundary === "revision") context.sourceRevision += 1;
    if (boundary === "future") context.sourceRevision -= 1;
    if (boundary === "controls") context.consumer = "capability.controls";
    if (boundary === "payload") context.consumer = "tool_payload.raw";
    if (boundary === "consumer_missing") context.consumer = undefined;
    expect(() =>
      projectOperationSupervisionEvidenceClosure(
        f.messages,
        context as Parameters<
          typeof projectOperationSupervisionEvidenceClosure
        >[1],
      ),
    ).toThrow("operation_supervision_evidence_context_binding_invalid");
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

test("S07: copied descriptors reject; serialized or fake-symbol capsules gain no protection", async () => {
  const f = await supervisionClosureFixture();
  const copied = Object.create(
    Object.getPrototypeOf(f.capsule),
    Object.getOwnPropertyDescriptors(f.capsule),
  ) as ChatMessage;
  expect(() => f.controller().project([copied, ...f.native])).toThrow(
    "operation_supervision_evidence_message_binding_invalid",
  );
  const serialized = JSON.parse(JSON.stringify(f.capsule)) as ChatMessage;
  expect(readOperationSupervisionEvidenceBinding(serialized)).toBeUndefined();
  Object.defineProperty(
    serialized,
    Symbol("currentOperationSupervisionAuthority"),
    { value: { message: serialized } },
  );
  expect(readOperationSupervisionEvidenceBinding(serialized)).toBeUndefined();
});

test.each([
  "action",
  "result",
  "missing_action",
  "missing_result",
  "duplicate_capsule",
] as const)(
  "S08: %s cannot falsely satisfy exact closure",
  async (mutation) => {
    const f = await supervisionClosureFixture();
    let messages = [...f.messages];
    const lastAction = messages
      .map(({ role }) => role)
      .lastIndexOf("assistant");
    const lastResult = messages.map(({ role }) => role).lastIndexOf("tool");
    if (mutation === "action") {
      const action = messages[lastAction]!;
      if (action.role !== "assistant" || !action.toolCalls)
        throw new Error("expected_action");
      messages[lastAction] = {
        role: "assistant",
        content: "",
        toolCalls: action.toolCalls!.map((call) => ({
          ...call,
          arguments: call.arguments.replace("target-0.txt", "foreign.txt"),
        })),
      };
    }
    if (mutation === "result") {
      const result = messages[lastResult]!;
      if (result.role !== "tool") throw new Error("expected_result");
      messages[lastResult] = {
        ...result,
        content: result.content.replace(
          "EXACT_capability",
          "TAMPERED_capability",
        ),
      };
    }
    if (mutation === "missing_action") messages.splice(lastAction, 1);
    if (mutation === "missing_result") messages.splice(lastResult, 1);
    if (mutation === "duplicate_capsule") messages.push(f.capsule);
    expect(() => f.controller().project(messages)).toThrow(
      "operation_supervision_evidence_exact_lane_invalid",
    );
  },
);

test("S07: an otherwise matching future checkpoint is rejected with current protected evidence", async () => {
  const f = await supervisionClosureFixture();
  const checkpoint = f.installCheckpoint();
  f.store.commit({
    ...checkpoint,
    sourceRevision: checkpoint.sourceRevision + 1,
  });
  expect(() => f.controller().project(f.messages)).toThrow(
    "context_compaction_checkpoint_revision_invalid",
  );
});

test("S14: serialized canonical state and checkpoint reconstruct private evidence instead of serialized authority", async () => {
  const summary =
    "RESTORED_FULL_SUMMARY:" + "source detail ".repeat(500).trim();
  const f = await supervisionClosureFixture({
    summary,
    registeredOutput: summary,
  });
  const checkpoint = f.installCheckpoint();
  await commit(f.ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: f.call.callId,
    invocationAttempt: f.call.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read separate target.",
    controlsJson: '{"path":"other.txt"}',
  });
  const state = JSON.parse(
    JSON.stringify(captureRoleCallLedgerCheckpoint(f.ledger)),
  );
  const restored = restoreRoleCallLedgerCheckpoint(state, {
    requestId: f.request.requestId,
    policy: f.head.policy,
  });
  const snapshot = JSON.parse(
    JSON.stringify(captureRequestContextCompaction(f.store)),
  );
  const store = restoreRequestContextCompaction(snapshot);
  await commit(restored, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: f.call.callId,
    executionId: "capability-execution-3",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read other target.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { other: true },
    },
  });
  const active = restored.current().state.calls[0]!;
  await commit(restored, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: active.callId,
    invocationAttempt: active.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read target.",
    controlsJson: '{"path":"target-0.txt"}',
    actionFingerprint: f.head.state.capabilityExecutions[0]!.actionFingerprint,
  });
  expect(store.get(checkpoint.scopeId)).toEqual(checkpoint);
  const head = restored.current();
  const call = head.state.calls[0]!;
  const capsule = buildImmediateOperationSupervisionEvidenceMessage(
    head,
    call,
  )!;
  expect(head.state.capabilityExecutions[1]!.summary).toBe(summary);
  expect(capsule).not.toBe(f.capsule);
  expect(readOperationSupervisionEvidenceBinding(capsule)).toBeDefined();
  const projected = createModelStepCompactionController(
    { ...f.request, contextCompactionStore: store },
    {
      ...f.optionsForController,
      call: { ...call, objective: f.request.prompt },
      sourceRevision: head.revision,
    },
  ).project([capsule, ...buildExecutionContinuationMessages(head, call)]);
  expect(JSON.stringify(projected)).not.toContain(summary);
  expectCompactedSupervisionReference(
    projected,
    readEvidence(projected)[0].entries[0].evidence,
    "tool-result:capability-execution-2",
  );
});

test("S11: a SUPER exact lane contradiction is owned by the Worker boundary", async () => {
  const f = await mixedWorkerFixture();
  const { request } = await createSuperCompactionSourceFixture();
  const message = buildRequestToolResultsMessage(f.view);
  const malformed = bindRequestToolResultsMessage(
    f.view,
    message.content.replaceAll("Target evidence.", "Contradictory evidence."),
  );
  const controller = createModelStepCompactionController(
    {
      ...request,
      requestId: f.head.state.requestId,
      prompt: "Inspect the target.",
      contextCompactionStore: f.store,
    },
    {
      call: f.call,
      sourceRevision: f.head.revision,
      consumer: "worker.decision",
      allowedConsumers: f.checkpoint.allowedConsumers,
      scopeId: f.checkpoint.scopeId,
      superWorkerCompaction: undefined,
    },
  );
  // Supply the original canonical view as sidecar through its other bound message.
  let error: unknown;
  try {
    controller.project([
      malformed,
      buildImmediateOperationSupervisionEvidenceMessage(f.head, f.call)!,
    ]);
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(SuperContextFailure);
  expect(error).toMatchObject({
    code: "context_compaction_source_identity_conflict",
    binding: { callId: f.call.callId, modelStep: "worker.decision" },
  });
});

test("S12/S15: unrelated inputs keep their exact message objects and no binding", async () => {
  const f = await supervisionClosureFixture();
  const ordinary: ChatMessage[] = [
    { role: "system", content: "Instructions." },
    { role: "user", content: "What is 2+2?" },
  ];
  const projected = f.controller().project(ordinary);
  expect(projected).toEqual(ordinary);
  expect(projected[1]).toBe(ordinary[1]);
});
