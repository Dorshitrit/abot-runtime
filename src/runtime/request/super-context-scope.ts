import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import { withSuperCompactionFailure } from "../context/super-compaction-failure-owner.js";
import { createOwnedSuperContextFailure } from "../context/super-context-failure.js";
import {
  InvalidatedCompactionScopeError,
  freezeCompactionInvalidation,
} from "../context/semantic-compaction/scope-quarantine.js";
import {
  assertSuperCompactionCheckpointBinding,
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import type { RequestExecutionScope } from "./execution-scope.js";

/** Repeated parent-driven invocation cannot revive a quarantined owned scope. */
export function requireLiveSuperContextScope(params: {
  request: RequestExecutionScope;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  contractId: string;
}): void {
  const store = params.request.contextCompactionStore;
  // Payload failures settle through the existing capability path. Re-check the
  // canonical inventory at the fresh activation before any further inference.
  if (store?.snapshot) {
    const integrity = {
      requestId: params.request.requestId,
      prompt: params.request.prompt,
      head: params.head,
      store,
    };
    assertSuperCompactionSourceIntegrity(integrity);
    for (const checkpoint of store.snapshot().checkpoints) {
      const owner =
        checkpoint.callId === params.call.callId
          ? {
              head: params.head,
              binding: {
                requestId: params.request.requestId,
                callId: params.call.callId,
                parentCallId: params.call.parentCallId,
                contractId: params.contractId,
                invocationAttempt: params.call.activationCount,
                sourceRevision: params.head.revision,
                modelStep: "context.compact" as const,
                phase: "scope_preflight",
                scopeId: checkpoint.scopeId,
              },
            }
          : undefined;
      withSuperCompactionFailure(owner, () =>
        assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint }),
      );
    }
  }
  const records = store?.snapshot?.().invalidatedScopes ?? [];
  const record = records.find(
    (candidate) => candidate.binding.callId === params.call.callId,
  );
  if (!record) return;
  const validated = freezeCompactionInvalidation(record);
  assertSuperCompactionCheckpointBinding({
    requestId: params.request.requestId,
    prompt: params.request.prompt,
    head: params.head,
    checkpoint: { ...validated.binding, scopeId: validated.scopeId },
  });
  throw createOwnedSuperContextFailure({
    code: "context_compaction_scope_invalidated",
    head: params.head,
    binding: {
      requestId: params.request.requestId,
      callId: params.call.callId,
      parentCallId: params.call.parentCallId,
      contractId: params.contractId,
      invocationAttempt: params.call.activationCount,
      sourceRevision: params.head.revision,
      modelStep: "context.compact",
      phase: "scope_reuse",
      scopeId: validated.scopeId,
    },
    cause: new InvalidatedCompactionScopeError(validated),
  });
}
