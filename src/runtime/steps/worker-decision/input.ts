import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import type { RoleCallDependencyResult } from "../../orchestration/role-calls/index.js";
import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  WORKER_DECISION_MODEL_STEP,
  type WorkerDecision,
  type WorkerDecisionDiagnosticContext,
  type WorkerResultAuthorSource,
} from "./contracts.js";
import { traceWorkerDecisionInputProjection } from "./input/diagnostic-projection.js";
import type {
  PreparedWorkerDecisionAssembly,
  PreparedWorkerDecisionSession,
  WorkerDecisionInputOptions,
  WorkerDecisionInputRequest,
  WorkerPendingCapabilityBatchSelection,
  WorkerPendingCapabilitySelection,
} from "./input/types.js";
import {
  prepareWorkerDecisionAssembly,
  prepareWorkerDecisionSession,
} from "./input/session.js";

export type {
  WorkerDecisionCapabilityResumeSource,
  WorkerDecisionCapabilitySource,
  WorkerDecisionInputRequest,
  WorkerPendingCapabilityBatchSelection,
  WorkerPendingCapabilitySelection,
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
} from "./input/types.js";
export { projectWorkerPayloadDependencyInput } from "./payload-dependency-results.js";

export function buildWorkerDecisionInput(
  request: WorkerDecisionInputRequest,
  options: WorkerDecisionInputOptions,
): {
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep:
    | typeof WORKER_DECISION_MODEL_STEP
    | typeof CAPABILITY_CONTROLS_MODEL_STEP;
  diagnostic: WorkerDecisionDiagnosticContext;
  allowedActions: readonly WorkerDecision["action"][];
  availableCapabilities: readonly WorkerCapabilityDescriptor[];
  availableCapabilityIds: readonly string[];
  maxBatchCapabilityExecutions: number;
  pendingCapabilitySelection?: WorkerPendingCapabilitySelection;
  pendingCapabilityBatchSelection?: WorkerPendingCapabilityBatchSelection;
  dependencyResults: readonly RoleCallDependencyResult[];
  resultAuthorSource: WorkerResultAuthorSource;
} {
  const session = prepareWorkerDecisionSession(request, options);
  const assembly = prepareWorkerDecisionAssembly(session);
  traceWorkerDecisionInputProjection(session, assembly);
  return projectBuiltWorkerDecisionInput(session, assembly);
}

function projectBuiltWorkerDecisionInput(
  session: PreparedWorkerDecisionSession,
  assembly: PreparedWorkerDecisionAssembly,
): ReturnType<typeof buildWorkerDecisionInput> {
  const { diagnostic } = session;
  const { dependencyResults } = session.canonicalState;
  const {
    capabilities,
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
  } = session.capabilitySelection;
  const {
    format,
    allowedActions,
    availableCapabilityIds,
    maxBatchCapabilityExecutions,
  } = session.contract;
  return {
    context: assembly.projection.context,
    format,
    modelStep: diagnostic.modelStep,
    diagnostic,
    allowedActions,
    availableCapabilities: capabilities,
    availableCapabilityIds,
    maxBatchCapabilityExecutions,
    ...(pendingCapabilitySelection ? { pendingCapabilitySelection } : {}),
    ...(pendingCapabilityBatchSelection
      ? { pendingCapabilityBatchSelection }
      : {}),
    dependencyResults,
    resultAuthorSource: assembly.references.resultAuthorSource,
  };
}
