import { restorePreparationRejection } from "./preparation-rejection.js";
import { isDeepStrictEqual } from "node:util";
import type { RoleCallLedger, RoleCallFrame } from "../../role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityExecutionFreshness,
} from "../contracts.js";
import type {
  BoundApprovalDecision,
  CapabilityApprovalGate,
  PreparedApprovalGroup,
  WorkerCapabilityApprovalWait,
} from "../approval-contracts.js";
import type { PreparedBoundInvocation } from "./invocation-preparation.js";
import type { WorkerCapabilityDiagnosticContext } from "../diagnostics.js";
import { settleAdmittedPreparedGroup } from "./settle-prepared.js";

export async function resolvePreparedGroupApproval<TContext>(params: {
  gate?: CapabilityApprovalGate;
  requestId: string;
  call: RoleCallFrame;
  invocations: readonly PreparedBoundInvocation<TContext>[];
  executionIds: readonly string[];
  batch: boolean;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}): Promise<WorkerCapabilityApprovalWait | undefined> {
  if (
    !params.gate ||
    !params.invocations.some((entry) => entry.prepared.approvalRequest)
  )
    return undefined;
  params.invocations.forEach((entry, index) =>
    entry.prepared.onAdmitted?.(params.executionIds[index]!),
  );
  const entries = params.invocations.map(
    ({ adapter, prepared, intent, authoringObjective }, index) => {
      if (
        (!adapter.restore && !restorePreparationRejection(prepared.snapshot)) ||
        prepared.snapshot === undefined ||
        !prepared.actionFingerprint
      )
        throw new Error("prepared_approval_snapshot_unavailable");
      return {
        executionId: params.executionIds[index]!,
        capabilityId: adapter.descriptor.capabilityId,
        declaredEffect: adapter.descriptor.effect,
        intent,
        ...(authoringObjective ? { authoringObjective } : {}),
        controls: prepared.acceptedControls,
        actionFingerprint: prepared.actionFingerprint,
        snapshot: prepared.snapshot,
        ...(prepared.approvalRequest
          ? { approvalRequest: prepared.approvalRequest }
          : {}),
      };
    },
  );
  const group: PreparedApprovalGroup = Object.freeze(
    structuredClone({
      kind: "prepared_approval_group_v1" as const,
      requestId: params.requestId,
      callId: params.call.callId,
      invocationAttempt: params.call.activationCount,
      batch: params.batch,
      entries,
      ...(params.executionFreshness
        ? { executionFreshnessToken: params.executionFreshness.token }
        : {}),
    }),
  );
  if (!isDeepStrictEqual(group, JSON.parse(JSON.stringify(group))))
    throw new Error("prepared_approval_snapshot_not_serializable");
  const resolution = await params.gate.resolve(group);
  if (resolution.kind === "awaiting_approval") {
    validateDecisions(group, resolution.decisions ?? [], false);
    return Object.freeze({
      kind: "awaiting_approval",
      group: Object.freeze({
        ...group,
        ...(resolution.decisions?.length
          ? { initialDecisions: resolution.decisions }
          : {}),
      }),
    });
  }
  applyDecisions(group, params.invocations, resolution.decisions);
  return undefined;
}

/** Pure hydration. Call the returned execute only after durable decision-to-running commit. */
export async function restoreCapabilityApprovalGroup<TContext>(params: {
  context: TContext;
  ledger: RoleCallLedger;
  adapters: readonly WorkerCapabilityAdapter<TContext>[];
  group: PreparedApprovalGroup;
  executionFreshness?: WorkerCapabilityExecutionFreshness;
}) {
  const head = params.ledger.current();
  const group = params.group;
  const call = head.state.calls.find((entry) => entry.callId === group.callId);
  if (
    group.kind !== "prepared_approval_group_v1" ||
    group.requestId !== head.state.requestId ||
    !call ||
    call.status !== "waiting_for_capability" ||
    call.activationCount !== group.invocationAttempt ||
    group.entries.length === 0 ||
    (!group.batch && group.entries.length !== 1) ||
    new Set(group.entries.map((entry) => entry.executionId)).size !==
      group.entries.length
  )
    throw new Error("prepared_approval_group_mismatch");
  if (
    group.executionFreshnessToken !== undefined &&
    !isDeepStrictEqual(
      group.executionFreshnessToken,
      params.executionFreshness?.token,
    )
  )
    throw new Error("prepared_approval_freshness_mismatch");
  const running = head.state.capabilityExecutions.filter(
    (entry) => entry.status === "running",
  );
  if (running.length !== group.entries.length)
    throw new Error("prepared_approval_group_mismatch");
  const invocations = await Promise.all(
    group.entries.map(async (entry) => {
      const admitted = running.find(
        (value) => value.executionId === entry.executionId,
      );
      const adapter = params.adapters.find(
        (value) => value.descriptor.capabilityId === entry.capabilityId,
      );
      if (
        !admitted ||
        admitted.callId !== group.callId ||
        admitted.invocationAttempt !== group.invocationAttempt ||
        admitted.capabilityId !== entry.capabilityId ||
        admitted.declaredEffect !== entry.declaredEffect ||
        admitted.actionFingerprint !== entry.actionFingerprint ||
        admitted.intent !== entry.intent ||
        !isDeepStrictEqual(JSON.parse(admitted.controlsJson), entry.controls) ||
        !adapter ||
        adapter.descriptor.effect !== entry.declaredEffect
      )
        throw new Error("prepared_approval_execution_mismatch");
      const prepared =
        restorePreparationRejection(entry.snapshot) ??
        (await adapter.restore?.(
          {
            context: params.context,
            call,
            intent: entry.intent,
            controls: entry.controls,
            ...(entry.authoringObjective
              ? { authoringObjective: entry.authoringObjective }
              : {}),
            ...(params.executionFreshness
              ? { executionFreshness: params.executionFreshness }
              : {}),
          },
          entry.snapshot,
        ));
      if (!prepared) throw new Error("prepared_approval_restore_unavailable");
      if (
        prepared.actionFingerprint !== entry.actionFingerprint ||
        !isDeepStrictEqual(prepared.acceptedControls, entry.controls) ||
        !isDeepStrictEqual(prepared.approvalRequest, entry.approvalRequest)
      )
        throw new Error("prepared_approval_restore_mismatch");
      return {
        adapter,
        prepared,
        intent: entry.intent,
        controls: entry.controls,
      };
    }),
  );
  const diagnostic: WorkerCapabilityDiagnosticContext = {
    requestId: group.requestId,
    call,
    capabilityIds: group.entries.map((entry) => entry.capabilityId),
    scopeMode: call.workerCapabilityScope ? "catalog_groups" : "full",
    scopeCatalogGroupIds: call.workerCapabilityScope?.catalogGroupIds ?? [],
    knownCatalogGroupCount: 0,
    fullCapabilityCount: params.adapters.length,
    filteredCapabilityCount: params.adapters.length,
  };
  return Object.freeze({
    async execute(decisions: readonly BoundApprovalDecision[]) {
      applyDecisions(group, invocations, decisions);
      return settleAdmittedPreparedGroup({
        ledger: params.ledger,
        expectedHead: head,
        call,
        invocations,
        executionIds: group.entries.map((entry) => entry.executionId),
        batch: group.batch,
        diagnostic,
      });
    },
  });
}

function validateDecisions(
  group: PreparedApprovalGroup,
  decisions: readonly BoundApprovalDecision[],
  complete: boolean,
) {
  const required = group.entries.filter((entry) => entry.approvalRequest);
  if (
    (complete && decisions.length !== required.length) ||
    new Set(decisions.map((entry) => entry.approvalId)).size !==
      decisions.length
  )
    throw new Error("prepared_approval_decisions_incomplete");
  for (const decision of decisions) {
    const entry = required.find(
      (entry) => entry.approvalRequest!.approvalId === decision.approvalId,
    );
    if (
      !entry ||
      entry.actionFingerprint !== decision.actionFingerprint ||
      typeof decision.decision?.approved !== "boolean"
    )
      throw new Error("prepared_approval_decision_mismatch");
  }
}
function applyDecisions<TContext>(
  group: PreparedApprovalGroup,
  invocations: readonly PreparedBoundInvocation<TContext>[],
  decisions: readonly BoundApprovalDecision[],
) {
  validateDecisions(group, decisions, true);
  invocations.forEach((invocation, index) => {
    const approval = group.entries[index]!.approvalRequest;
    if (!approval) return;
    if (!invocation.prepared.applyApprovalDecision)
      throw new Error("prepared_approval_decision_unavailable");
    invocation.prepared.applyApprovalDecision(
      decisions.find(
        (decision) => decision.approvalId === approval.approvalId,
      )!,
    );
  });
}

export async function resumeCapabilityApprovalGroup<TContext>(
  params: Parameters<typeof restoreCapabilityApprovalGroup<TContext>>[0] & {
    decisions: readonly BoundApprovalDecision[];
  },
) {
  const prepared = await restoreCapabilityApprovalGroup(params);
  return prepared.execute(params.decisions);
}
