import { expect, vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityPreparedExecution,
} from "../../orchestration/worker-capabilities/index.js";
import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import { createRequestRoleCallPolicy } from "../../request/role-call-policy.js";
import { runRequestRunner } from "../../request/runner.js";
import { restoreApprovalCompaction } from "../../request/approval-wait/super-compaction-restore.js";
import type { RequestContextCompactionSnapshot } from "../../context/semantic-compaction/snapshot.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
  type SemanticCompactionCheckpoint,
} from "../../context/semantic-compaction/contracts.js";
import { buildExecutionCapabilityResultMessage } from "../../steps/execution-agent/capability-result-context.js";
import { createControlsEvidenceFixture } from "./execution-controls-evidence-fixture.js";
import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";
import { deriveTestRequestExecutionScope } from "./request-execution-scope.js";
import {
  readCompactionEnvelope,
  compactContinuation,
} from "./semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./semantic-compaction-replacement-fixture.js";

export const APPROVAL_SOURCE_MARKER = "ORIGINAL_READ_RECEIPT_EXACT";
const controls = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const;
const actionFingerprint = hash("approved exact mutation");

export function nativeCompactionSource(
  message: ChatMessage,
): SemanticCompactionSource {
  if (message.role !== "tool") throw new Error("test_native_result_required");
  const content = JSON.stringify(message);
  return {
    sourceRef: `tool-result:${message.toolCallId}`,
    sourceFingerprint: hash(content),
    content,
  };
}

export function legacyExecutionMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "tool") throw new Error("test_native_result_required");
  const envelope = JSON.parse(message.content);
  envelope.authority = "capability_adapter_result";
  delete envelope.result.outcome;
  delete envelope.result.observedEffect;
  delete envelope.result.summary;
  return { ...message, content: JSON.stringify(envelope) };
}

export async function createExecutionApprovalCompactionFixture() {
  let pressure = false;
  const compacted: (readonly ChatMessage[])[] = [];
  const model = createExecApprovalScript(
    "execution-agent-v1",
    [
      { capabilityId: "evidence.read", controls: {} },
      { capabilityId: "evidence.change", controls: {} },
    ],
    "evidence",
  );
  const scripted = model.invoke.getMockImplementation()!;
  model.invoke.mockImplementation(async (input) => {
    if (input.modelStep !== "context.compact") return scripted(input);
    const messages = input.messages as readonly ChatMessage[];
    compacted.push(messages);
    const envelope = readCompactionEnvelope(messages);
    const refs = envelope.newSources!.map(({ sourceRef }) => sourceRef);
    return {
      text: JSON.stringify({
        continuation: compactContinuation({
          evidenceRefs: refs,
          currentState: "The exact operations settled.",
        }),
        sourceDigests: semanticCompactionReplacementSlots(
          envelope,
          () => "Canonical operation evidence.",
        ),
      }),
      meta: {},
    };
  });
  const performed = vi.fn();
  const observed = vi.fn(async () => ({
    outcome: "succeeded" as const,
    observedEffect: "observation" as const,
    summary: "Observed original source.",
    exactResult: {
      kind: "registered_tool_execution_result_v1" as const,
      authority: "registered_plugin" as const,
      status: "executed" as const,
      result: {
        ok: true,
        tool: "evidence.read",
        output: APPROVAL_SOURCE_MARKER,
        producedNewInformation: true,
      },
    },
  }));
  function prepared(): WorkerCapabilityPreparedExecution {
    let approved = false;
    return {
      actionFingerprint,
      acceptedControls: {},
      snapshot: { target: "exact" },
      approvalRequest: {
        requestId: "controls-evidence-test",
        approvalId: "approve-exact-mutation",
        call: { tool: "evidence.change", params: {} },
      },
      applyApprovalDecision: (receipt) => {
        approved = receipt.decision.approved;
      },
      execute: async (executionId) => {
        if (!approved) throw new Error("test_effect_without_approval");
        performed(executionId);
        return {
          outcome: "succeeded",
          observedEffect: "mutation",
          summary: "Changed exact target.",
          exactResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: true,
            payload: { target: "exact" },
          },
        };
      },
    };
  }
  const adapters: WorkerCapabilityAdapter<unknown>[] = [
    {
      descriptor: {
        capabilityId: "evidence.read",
        summary: "Read source.",
        effect: "observation",
        controls,
        catalogGroups: ["evidence"],
      },
      execute: observed,
    },
    {
      descriptor: {
        capabilityId: "evidence.change",
        summary: "Change exact target.",
        effect: "mutation",
        controls,
        catalogGroups: ["evidence"],
      },
      prepare: async () => prepared(),
      restore: async (_input, snapshot) => {
        expect(snapshot).toEqual({ target: "exact" });
        return prepared();
      },
      execute: async () => {
        throw new Error("test_unprepared_dispatch");
      },
    },
  ];
  const countInputTokens: NonNullable<
    ModelGatewayClient["countInputTokens"]
  > = async (input) => ({
    inputTokens:
      pressure &&
      input.modelStep === "execution.decision" &&
      JSON.stringify(input.messages).includes(APPROVAL_SOURCE_MARKER)
        ? 30000
        : 1000,
    profileId: "test",
    provider: "openai",
    model: "test",
    contextWindowTokens: 32000,
    source: "provider_input_token_count",
  });
  const { request } = await createControlsEvidenceFixture({
    modelGatewayClient: { ...model, countInputTokens },
    workerCapabilityProvider: {
      getDescriptors: () => adapters.map(({ descriptor }) => descriptor),
      getAdapters: () => adapters,
    },
    approvalGate: { resolve: async () => ({ kind: "awaiting_approval" }) },
  });
  const waiting = await runRequestRunner(request, { durableApproval: true });
  if (waiting.kind !== "awaiting_approval")
    throw new Error("test_approval_wait_missing");
  const continuation = JSON.parse(
    JSON.stringify(waiting.continuation),
  ) as typeof waiting.continuation;
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: createRequestRoleCallPolicy(request.executionPolicy),
    checkpoint: continuation.ledger,
  });
  const head = ledger.current();
  const prior = head.state.capabilityExecutions.find(
    ({ status }) => status === "settled",
  )!;
  const currentMessage = buildExecutionCapabilityResultMessage(head, prior);
  const call = head.state.calls[0]!;
  function checkpoint(
    sources: readonly SemanticCompactionSource[],
    scopeSuffix = "continuation",
  ): SemanticCompactionCheckpoint {
    return {
      kind: "runtime_semantic_compaction_checkpoint_v2",
      requestId: request.requestId,
      currentRequestFingerprint: hash(request.prompt),
      roleId: call.roleId,
      callId: call.callId,
      objectiveFingerprint: hash(request.prompt),
      contextLane: "role_continuation",
      scopeId: `role:${call.roleId}:${call.callId}:${scopeSuffix}`,
      sourceRevision: head.revision,
      allowedConsumers: ["execution.decision", "execution.response"],
      sourceDigests: sources.map(({ sourceRef, sourceFingerprint }) => ({
        sourceRef,
        sourceFingerprint,
        digest: "Original operation evidence.",
      })),
      continuation: compactContinuation({
        evidenceRefs: sources.map(({ sourceRef }) => sourceRef),
      }),
    };
  }
  function snapshot(legacy = true): RequestContextCompactionSnapshot {
    const source = nativeCompactionSource(
      legacy ? legacyExecutionMessage(currentMessage) : currentMessage,
    );
    return {
      kind: "request_context_compaction_v1",
      sources: [source],
      checkpoints: [checkpoint([source])],
    };
  }
  function restore(snapshot: RequestContextCompactionSnapshot) {
    return restoreApprovalCompaction({
      snapshot,
      ledgerCheckpoint: continuation.ledger,
      requestId: request.requestId,
      prompt: request.prompt,
      executionPolicy: request.executionPolicy,
    });
  }
  async function resume(snapshot: RequestContextCompactionSnapshot) {
    const store = restore(snapshot);
    pressure = true;
    const resumed = await runRequestRunner(
      deriveTestRequestExecutionScope(request, {
        contextCompactionStore: store,
      }),
      {
        durableApproval: true,
        continuation,
        decisions: [
          {
            approvalId: "approve-exact-mutation",
            actionFingerprint,
            decision: { approved: true },
          },
        ],
      },
    );
    return { resumed, store };
  }
  return {
    request,
    continuation,
    head,
    currentMessage,
    observed,
    performed,
    compacted,
    checkpoint,
    snapshot,
    restore,
    resume,
  };
}
