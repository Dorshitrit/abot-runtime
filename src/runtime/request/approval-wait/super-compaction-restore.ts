import { createRoleCallLedger } from "../../orchestration/role-calls/index.js";
import { hasSuperContextContract } from "../../context/super-context-policy.js";
import { createOwnedSuperContextFailure } from "../../context/super-context-failure.js";
import { restoreRequestContextCompaction } from "../../context/semantic-compaction/snapshot.js";
import {
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
  assertSuperCompactionCheckpointBinding,
} from "../../context/semantic-compaction/super-source-integrity.js";
import { createRequestRoleCallPolicy } from "../role-call-policy.js";
import type { CompiledRequestExecutionPolicy } from "../execution-scope.js";
import type { RequestContextCompactionSnapshot } from "../../context/semantic-compaction/snapshot.js";
import type { RoleCallLedgerCheckpoint } from "../../orchestration/role-calls/checkpoint.js";

/** Compatibility must finish before approved effects or any model continuation. */
export function restoreApprovalCompaction(params: {
  snapshot: RequestContextCompactionSnapshot;
  ledgerCheckpoint: RoleCallLedgerCheckpoint;
  requestId: string;
  prompt: string;
  executionPolicy: CompiledRequestExecutionPolicy;
}) {
  const { snapshot, executionPolicy } = params;
  if (!hasSuperContextContract(executionPolicy.authority, "supervisor"))
    return restoreRequestContextCompaction(snapshot);
  const ledger = createRoleCallLedger({
    requestId: params.requestId,
    policy: createRequestRoleCallPolicy(executionPolicy),
    checkpoint: params.ledgerCheckpoint,
  });
  const head = ledger.current();
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("context_compaction_snapshot_call_invalid");
  try {
    const store = restoreRequestContextCompaction(snapshot, {
      restoreSuperQuarantine: true,
    });
    const input = {
      requestId: params.requestId,
      prompt: params.prompt,
      head,
      store,
    };
    assertSuperCompactionSourceIntegrity(input);
    for (const record of snapshot.invalidatedScopes ?? [])
      assertSuperCompactionCheckpointBinding({
        ...input,
        checkpoint: { ...record.binding, scopeId: record.scopeId },
      });
    for (const checkpoint of snapshot.checkpoints)
      assertSuperCompactionCheckpointIntegrity({ ...input, checkpoint });
    return store;
  } catch (cause) {
    throw createOwnedSuperContextFailure({
      code: "context_compaction_snapshot_source_incompatible",
      head,
      cause,
      binding: {
        requestId: params.requestId,
        callId: call.callId,
        parentCallId: call.parentCallId,
        invocationAttempt: call.activationCount,
        sourceRevision: head.revision,
        contractId:
          call.roleId === "supervisor"
            ? "supervisor"
            : `delegated.${call.roleId}`,
        modelStep: "context.compact",
        phase: "approval_resume",
        scopeId: `approval:${call.callId}`,
      },
    });
  }
}
