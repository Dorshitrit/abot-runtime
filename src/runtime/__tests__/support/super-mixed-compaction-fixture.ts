import {
  createRoleCallLedger,
  composeRoleCallPlanChildObjective,
  type RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../context/operation-supervision-evidence.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
} from "../../context/semantic-compaction/index.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
export async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

export async function mixedWorkerFixture(
  throughPlanner = false,
  referenceData?: string,
) {
  const ledger = createRoleCallLedger({
    requestId: "mixed-handoff",
    policy: {
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  if (throughPlanner)
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Inspect the target.",
      workingDirectory: ".",
    });
  const planItems = [
    { title: "Read", objective: "Read the established target." },
  ];
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: throughPlanner ? "call-2" : "call-1",
    roleId: "worker",
    objective: throughPlanner
      ? composeRoleCallPlanChildObjective(planItems, 8192)
      : "Read the established target.",
    ...(throughPlanner
      ? {
          plannerPlan: {
            mode: "declare",
            plan: { summary: "Inspect target.", items: planItems },
            selectedItemIndexes: [0],
          },
        }
      : {}),
  });
  for (let index = 0; index < 2; index++) {
    const call = ledger.current().state.calls.at(-1)!;
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read target.",
      controlsJson: '{"path":"target.txt"}',
      actionFingerprint: hash("same accepted action"),
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: ledger.current().state.capabilityExecutions.at(-1)!
        .executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Read target.",
      outcomeFingerprint: "succeeded",
      ...(referenceData ? { referenceData } : {}),
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: { content: "Target evidence." },
      },
    });
  }
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const view = projectRequestToolResults({
    ledger,
    head,
    callId: call.callId,
    modelStep: "worker.decision",
  });
  const notice = buildImmediateOperationSupervisionEvidenceMessage(head, call)!;
  const sources = [
    {
      sourceRef: `operation-supervision-evidence:${hash(notice.content).slice(7)}`,
      content: JSON.stringify(notice),
    },
    ...view.results.map((result) => ({
      sourceRef: result.executionId,
      content: JSON.stringify(result),
    })),
  ].map((source) => ({ ...source, sourceFingerprint: hash(source.content) }));
  const store = createRequestContextCompactionStore();
  store.registerSources(sources);
  const checkpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    requestId: head.state.requestId,
    currentRequestFingerprint: hash("Inspect the target."),
    roleId: "worker",
    callId: call.callId,
    objectiveFingerprint: hash(call.objective!),
    contextLane: "role_continuation" as const,
    scopeId: `worker:${call.callId}:request-tool-results`,
    sourceRevision: head.revision,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceDigests: sources.map((source) => ({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: "Preserved exact evidence.",
    })),
    continuation: {
      completed: ["Read target."],
      currentState: "Read finished.",
      findings: ["Target evidence."],
      evidenceRefs: sources.map((source) => source.sourceRef),
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: [],
      blockers: [],
      nextStep: "Return the result.",
    },
  };
  store.commit(checkpoint);
  return { ledger, head, call, view, store, checkpoint, sources };
}
