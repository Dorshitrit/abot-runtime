import { describe, expect, test, vi } from "vitest";

import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  buildCompactedRequestToolResultsMessage,
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import { isRequestToolResultsMessageBoundToView } from "../context/request-tool-results-message-binding.js";
import {
  createSemanticCompactionSha256Fingerprint,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  workerCapabilityContextCompactionScopeId,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityPayloadSourceProvenance,
} from "../orchestration/worker-capabilities/index.js";

describe("Planner-owned Worker tool-result scope", () => {
  test("projects only the bound Worker's executions before model context", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate two bounded items.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Establish the first item.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Establish the first item, then mutate the second item.",
          items: [
            {
              title: "Establish first item",
              objective: "Establish the first item.",
            },
            {
              title: "Mutate second item",
              objective: "Mutate only the second item.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    await settleCapability(ledger, {
      callId: "call-3",
      capabilityId: "example.sibling",
      effect: "observation",
      summary: "Sibling evidence must flow only through dependencies.",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "The first item is established.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Mutate only the second item.",
      dependencyResultRefs: ["result-1"],
      plannerPlan: { mode: "select", itemIds: ["plan-call-2-item-2"] },
    });
    const call = ledger
      .current()
      .state.calls.find(({ callId }) => callId === "call-4");
    if (!call) throw new Error("Current Worker call missing");
    let provenance: WorkerCapabilityPayloadSourceProvenance | undefined;
    const adapter: WorkerCapabilityAdapter<Readonly<{ marker: string }>> = {
      descriptor: {
        capabilityId: "example.current",
        summary: "Perform the current bounded mutation.",
        effect: "mutation",
        requiresPayloadAuthoringObjective: true,
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      },
      prepare: async (input) => {
        provenance = input.assignmentProvenance;
        return Object.freeze({
          actionFingerprint: `sha256:${"a".repeat(64)}`,
          acceptedControls: Object.freeze({}),
          execute: vi.fn(async () => ({
            outcome: "succeeded" as const,
            observedEffect: "mutation" as const,
            summary: "The current Worker mutation succeeded.",
          })),
        });
      },
      execute: async () => {
        throw new Error("Prepared execution was bypassed");
      },
    };
    const binding = createWorkerCapabilityBinding({
      requestId: "planner-worker-scope",
      context: Object.freeze({ marker: "current-item" }),
      call,
      ledger,
      adapters: [adapter],
    });
    await binding.execute({
      capabilityId: "example.current",
      intent: "Perform the current bounded mutation.",
      authoringObjective: "Author only the current item payload.",
      controls: Object.freeze({}),
    });
    expect(provenance).toMatchObject({
      kind: "planner_plan_item_v1",
      requestId: "planner-worker-scope",
      workerCallId: "call-4",
      invocationAttempt: 1,
    });

    const view = projectRequestToolResults({
      ledger,
      head: ledger.current(),
      modelStep: MODEL_STEPS.WORKER_DECISION,
      callId: "call-4",
    });

    expect(view.scope).toEqual({ kind: "call", callId: "call-4" });
    expect(view.results.map(({ executionId }) => executionId)).toEqual([
      "capability-execution-2",
    ]);
    expect(
      ledger.current().state.calls.find(({ callId }) => callId === "call-4")
        ?.dependencyResultRefs,
    ).toEqual(["result-1"]);
    const message = JSON.parse(buildRequestToolResultsMessage(view).content);
    expect(message.coverage).toEqual({ kind: "call", callId: "call-4" });
    expect(JSON.stringify(message)).not.toContain("capability-execution-1");

    const compacted = buildCompactedRequestToolResultsMessage(
      view,
      compactionCheckpoint(message.results[0], view.sourceRevision),
    );
    const compactedBody = JSON.parse(compacted.content);
    expect(compactedBody.coverage).toEqual({ kind: "call", callId: "call-4" });
    expect(JSON.stringify(compactedBody)).not.toContain(
      "capability-execution-1",
    );
    expect(isRequestToolResultsMessageBoundToView(compacted, view)).toBe(true);
    expect(
      isRequestToolResultsMessageBoundToView(
        compacted,
        Object.freeze({ ...view }),
      ),
    ).toBe(false);
  });
});

function compactionCheckpoint(
  visibleResult: Readonly<Record<string, unknown>>,
  sourceRevision: number,
): SemanticCompactionCheckpoint {
  return Object.freeze({
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: workerCapabilityContextCompactionScopeId("call-4"),
    requestId: "planner-worker-scope",
    currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
      "planner worker scope request",
    ),
    roleId: "worker",
    callId: "call-4",
    objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
      "Mutate only the second item.",
    ),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceRevision,
    sourceDigests: Object.freeze([
      Object.freeze({
        sourceRef: "capability-execution-2",
        sourceFingerprint: createSemanticCompactionSha256Fingerprint(
          JSON.stringify(visibleResult),
        ),
        digest: "The current Worker mutation succeeded.",
      }),
    ]),
    continuation: Object.freeze({
      completed: Object.freeze(["Applied the current item mutation."]),
      currentState: "The current item mutation is complete.",
      findings: Object.freeze([]),
      evidenceRefs: Object.freeze(["capability-execution-2"]),
      artifacts: Object.freeze([]),
      decisions: Object.freeze([]),
      failedApproaches: Object.freeze([]),
      openWork: Object.freeze([]),
      blockers: Object.freeze([]),
      nextStep: "Return the bound item result.",
    }),
  });
}

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "planner-worker-scope",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function settleCapability(
  ledger: RoleCallLedger,
  input: Readonly<{
    callId: string;
    capabilityId: string;
    effect: "observation" | "mutation";
    summary: string;
  }>,
): Promise<void> {
  const runningHead = await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: input.callId,
    invocationAttempt: 1,
    capabilityId: input.capabilityId,
    declaredEffect: input.effect,
    intent: input.summary,
    controlsJson: "{}",
  });
  const execution = runningHead.state.capabilityExecutions.find(
    ({ callId, status }) => callId === input.callId && status === "running",
  );
  if (!execution) throw new Error("Running capability execution missing");
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: input.callId,
    executionId: execution.executionId,
    outcome: "succeeded",
    observedEffect: input.effect,
    summary: input.summary,
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { summary: input.summary },
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}
