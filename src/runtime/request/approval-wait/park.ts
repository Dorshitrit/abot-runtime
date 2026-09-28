import { randomUUID } from "node:crypto";
import type {
  SessionRequestLifecycleSnapshot,
  SessionRequestLifecycleStore,
} from "../../../sessions/request-lifecycle/contracts.js";
import { captureRequestContextCompaction } from "../../context/semantic-compaction/snapshot.js";
import { captureRequestSessionMemory } from "../../context/session-memory/snapshot.js";
import type { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import type { RequestLifecycle } from "../../orchestration/lifecycle/request-lifecycle.js";
import type { prepareRequestExecution } from "../prepared-execution.js";
import type { RequestApprovalContinuation } from "../approval-continuation.js";
import type { RequestSteeringInbox } from "../request-steering.js";
import {
  REQUEST_APPROVAL_SNAPSHOT,
  snapshotRequestSeed,
  type RequestApprovalSnapshot,
} from "./snapshot.js";
import { captureApprovalSnapshotData } from "./snapshot-data.js";

export async function parkRequestApproval(params: {
  prepared: Awaited<ReturnType<typeof prepareRequestExecution>>;
  continuation: RequestApprovalContinuation;
  store: SessionRequestLifecycleStore;
  resources: RequestToolResources;
  lifecycle: RequestLifecycle;
  steering: RequestSteeringInbox;
  originalPrompt: string;
}): Promise<SessionRequestLifecycleSnapshot> {
  const { prepared, continuation } = params;
  if (!prepared.durable)
    throw new Error("request_durable_approval_not_enabled");
  params.lifecycle.beginToolApprovalWait();
  await params.steering.close();
  await prepared.events.drain();
  params.lifecycle.signal.throwIfAborted();
  const compaction = prepared.seed.contextCompactionStore;
  if (!compaction) throw new Error("request_approval_compaction_missing");
  const snapshot: RequestApprovalSnapshot = captureApprovalSnapshotData({
    kind: REQUEST_APPROVAL_SNAPSHOT,
    originalPrompt: params.originalPrompt,
    seed: snapshotRequestSeed(prepared.seed),
    requestWorkingDirectory: prepared.requestWorkingDirectory,
    toolAttachments: prepared.toolAttachments,
    runner: continuation,
    resources: params.resources.snapshot(),
    compaction: captureRequestContextCompaction(compaction),
    ...(prepared.seed.sessionMemory
      ? {
          sessionMemory: captureRequestSessionMemory(
            prepared.seed.sessionMemory,
          ),
        }
      : {}),
    presentation: prepared.callbacks.snapshot(),
    steering: params.steering.snapshot(),
    budgets: params.lifecycle.snapshotBudgets(),
  });
  const stored = await params.store.writeContinuation(prepared.seed.sessionId, {
    schema: REQUEST_APPROVAL_SNAPSHOT,
    version: 1,
    value: snapshot,
  });
  params.lifecycle.signal.throwIfAborted();
  const waitId = randomUUID();
  const approvalCaller = continuation.ledger.state.calls.find(
    (call) => call.callId === continuation.preparedGroup.callId,
  );
  const approvals = continuation.preparedGroup.entries.flatMap((entry) => {
    if (!entry.approvalRequest) return [];
    return [
      {
        approvalId: entry.approvalRequest.approvalId,
        actionFingerprint: entry.actionFingerprint,
        presentation: captureApprovalSnapshotData({
          ...entry.approvalRequest,
          executionId: entry.executionId,
          roleCallId: continuation.preparedGroup.callId,
          executorRole: approvalCaller?.roleId,
          tool: entry.approvalRequest.call.tool,
        }),
      },
    ];
  });
  const initialDecisions = continuation.preparedGroup.initialDecisions?.map(
    (receipt) => ({
      approvalId: receipt.approvalId,
      approved: receipt.decision.approved,
      ...(receipt.decision.reason ? { reason: receipt.decision.reason } : {}),
      commandId: `initial:${waitId}:${receipt.approvalId}`,
    }),
  );
  const approvalIntents = continuation.preparedGroup.entries.flatMap(
    (entry) => {
      if (!entry.approvalRequest) return [];
      const intent = entry.intent.trim();
      return intent ? [intent] : [];
    },
  );
  const approvalPresentation =
    [...new Set(approvalIntents)].join("\n\n") || "Tool approval required.";
  const committed = await prepared.durable.commit((expected) =>
    params.store.commitWait(prepared.seed.sessionId, {
      expected,
      waitId,
      approvals,
      continuation: stored,
      presentationText: [
        prepared.callbacks.getAnswerText().trim(),
        approvalPresentation,
      ]
        .filter(Boolean)
        .join("\n\n"),
      ...(initialDecisions?.length ? { initialDecisions } : {}),
    }),
  );
  // If an explicit Stop won during the commit, failure reconciliation cancels the saved wait.
  params.lifecycle.signal.throwIfAborted();
  return committed.current;
}
