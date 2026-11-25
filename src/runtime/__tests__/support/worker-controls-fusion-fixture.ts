import { vi } from "vitest";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import type { ModelGatewayClient } from "../../ports.js";
import {
  createWorkerCapabilityBinding,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../../request/execution-scope.js";
import { runWorkerDecision } from "../../steps/worker-decision/run.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { createWorkerDecisionModelPolicy } from "./worker-decision-model-fixture.js";
import { applySteeringFixtureCommand, createSuperWorkerSteeringFixture } from "./super-worker-steering-fixture.js";

export const FUSION_GUIDANCE = "Use the assigned query and requested item count. If the source is unavailable, report that blocker without executing.";
export const FUSION_CAPABILITY = Object.freeze<WorkerCapabilityDescriptor>({
  capabilityId: "fixture.observe",
  summary: "Observe matching items.",
  effect: "observation",
  catalogGroups: ["read"],
  controlsRefinement: "fused_with_selection",
  controls: {
    type: "object", additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 120 },
      maxItems: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: [],
  },
});

export function fusedControlsReply(selection: Readonly<{ action: string; [key: string]: unknown }>) {
  return { text: JSON.stringify({ decision: {
    assessment: {
      requiresExecution: true, established: "", remaining: "The requested observation is still needed.",
      evidenceRefs: [],
    },
    selection,
  } }), meta: {} };
}

export async function createWorkerControlsFusionFixture(
  capabilities: readonly WorkerCapabilityDescriptor[] = [FUSION_CAPABILITY],
  countInputTokens?: ModelGatewayClient["countInputTokens"],
  contextWindowTokens = 8_000,
) {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const base = await createSuperWorkerSteeringFixture("supervisor", invoke);
  const execute = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async () => ({
    outcome: "succeeded", observedEffect: "observation", summary: "Observed the requested items.",
  }));
  const adapters = capabilities.map((descriptor) => ({ descriptor, execute }));
  const guidance = vi.fn(async (capabilityId: string) => capabilityId === FUSION_CAPABILITY.capabilityId
    ? FUSION_GUIDANCE : `Separate guidance for ${capabilityId}.`);
  const request = createTestRequestExecutionScope({
    ...base.request,
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), ...(countInputTokens ? { countInputTokens } : {}) },
    modelPolicy: createWorkerDecisionModelPolicy(contextWindowTokens, true),
    workerCapabilityProvider: {
      getDescriptors: () => capabilities,
      getAdapters: () => adapters,
      getExecutionGuidance: guidance,
    },
  });

  async function openWorker() {
    await applySteeringFixtureCommand(base.ledger, {
      authority: "active_role", type: "open_child", callerCallId: base.callerCall.callId,
      roleId: "worker", objective: "Observe five items matching the assigned query.",
    });
    const head = base.ledger.current();
    const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId)!;
    const binding = createWorkerCapabilityBinding({
      requestId: request.requestId, context: request.workerCapabilities.executionContext,
      call, ledger: base.ledger, adapters,
    });
    const options = {
      call,
      requestToolResults: projectRequestToolResults({
        ledger: base.ledger, head, callId: call.callId, modelStep: MODEL_STEPS.WORKER_DECISION,
      }),
      capabilitySource: { ledger: base.ledger, head, binding },
    };
    return { binding, decide: () => runWorkerDecision(request, options) };
  }

  function invokeWorker() {
    return request.executionPolicy.roleExecutors.invokeChild({
      requestId: request.requestId, context: request, callerCall: base.callerCall,
      ledger: base.ledger, expectedHead: base.ledger.current(), roleId: "worker",
      ...base.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
  }

  return { request, invoke, execute, guidance, ledger: base.ledger, steering: base.steering, openWorker, invokeWorker };
}
