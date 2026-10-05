import {
  createRoleCallLedger,
  type RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import { buildExecutionContinuationMessages } from "../../steps/execution-agent/state-context.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../context/operation-supervision-evidence.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../../context/semantic-compaction/index.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./semantic-compaction-contract-fixture.js";
import type { ChatMessage } from "../../../model-gateway/types.js";

export async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}
export async function supervisionClosureFixture(
  options: {
    batch?: boolean;
    repeatBoth?: boolean;
    duplicateReference?: boolean;
  } = {},
) {
  const f = semanticContractFixture({ policy: "execution-agent-v1" });
  const request = f.params.request;
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: hash("policy"),
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  for (let round = 0; round < 2; round++) {
    const call = ledger.current().state.calls[0]!;
    const entries = Array.from(
      { length: options.batch ? 2 : 1 },
      (_, index) => ({
        capabilityId: "files.read",
        declaredEffect: "observation",
        intent: "Read exact target.",
        controlsJson: JSON.stringify({ path: `target-${index}.txt` }),
        actionFingerprint: hash(
          index === 0 || options.repeatBoth
            ? `action-${index}`
            : `action-${round}-${index}`,
        ),
      }),
    );
    const beforeCount = ledger.current().state.capabilityExecutions.length;
    await commit(ledger, {
      authority: "active_role",
      type: options.batch
        ? "begin_capability_batch"
        : "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      ...(options.batch ? { entries } : entries[0]),
    });
    const settlements = ledger
      .current()
      .state.capabilityExecutions.slice(beforeCount)
      .map((execution) => ({
        executionId: execution.executionId,
        outcome: "succeeded",
        observedEffect: "observation",
        outcomeFingerprint: "succeeded",
        summary: "Read target.",
        ...(options.duplicateReference
          ? { referenceData: "EXACT_REFERENCE_ONCE" }
          : {}),
        exactResult: {
          kind: "generic_capability_result_v1",
          authority: "capability_adapter",
          status: "executed",
          ok: true,
          payload: options.duplicateReference
            ? { referenceData: "EXACT_REFERENCE_ONCE" }
            : { marker: `EXACT_${execution.executionId}` },
        },
      }));
    await commit(ledger, {
      authority: "runtime",
      type: options.batch
        ? "settle_capability_batch"
        : "settle_capability_execution",
      callId: call.callId,
      ...(options.batch ? { settlements } : settlements[0]),
    });
  }
  const head = ledger.current();
  const call = head.state.calls[0]!;
  const native = buildExecutionContinuationMessages(head, call);
  const capsule = buildImmediateOperationSupervisionEvidenceMessage(
    head,
    call,
  )!;
  const messages = [capsule, ...native];
  const optionsForController = {
    call: { ...call, objective: request.prompt },
    sourceRevision: head.revision,
    allowedConsumers: ["execution.decision", "execution.response"] as const,
    consumer: "execution.decision" as const,
  };
  const controller = () =>
    createModelStepCompactionController(request, optionsForController);
  const installCheckpoint = () => {
    const sources = native.map((message) => ({
      sourceRef:
        message.role === "tool"
          ? `tool-result:${message.toolCallId}`
          : `tool-action:${hash(message.role === "assistant" ? message.toolCalls!.map(({ callId }) => callId).join("\n") : "").slice(7)}`,
      content: JSON.stringify(message),
      sourceFingerprint: hash(JSON.stringify(message)),
    }));
    f.store.registerSources(sources);
    const checkpoint = {
      kind: "runtime_semantic_compaction_checkpoint_v2" as const,
      requestId: request.requestId,
      currentRequestFingerprint: hash(request.prompt),
      roleId: call.roleId,
      callId: call.callId,
      objectiveFingerprint: hash(request.prompt),
      contextLane: "role_continuation" as const,
      scopeId: `role:${call.roleId}:${call.callId}:continuation`,
      sourceRevision: head.revision,
      allowedConsumers: optionsForController.allowedConsumers,
      sourceDigests: sources.map(({ sourceRef, sourceFingerprint }) => ({
        sourceRef,
        sourceFingerprint,
        digest: "Read target.",
      })),
      continuation: compactContinuation(),
    };
    f.store.commit(checkpoint);
    return checkpoint;
  };
  return {
    ...f,
    request,
    ledger,
    head,
    call,
    native,
    capsule,
    messages,
    optionsForController,
    controller,
    installCheckpoint,
  };
}
export function readEvidence(messages: readonly ChatMessage[]) {
  return messages.flatMap(({ content }) => {
    try {
      const value = JSON.parse(content);
      return value.kind === "runtime_operation_supervision_evidence_v1"
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
}
