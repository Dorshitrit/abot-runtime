import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../../orchestration/role-calls/contracts.js";
import { createModelStepCompactionController } from "../model-step-compaction.js";
import type { SemanticCompactionRequest } from "../semantic-compaction/generation-contracts.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import { projectSuperContinuation } from "./continuation-projection.js";
import { generateSuperCompactionCandidate } from "./run.js";

type CompactionOptions = Parameters<
  typeof createModelStepCompactionController
>[1];

/** Generation follows frozen request authority; canonical projection and commit remain shared. */
export function createPolicyModelStepCompactionController(
  request: SemanticCompactionRequest,
  options: CompactionOptions,
  authority?: ExecutionPolicyAuthoritySnapshot,
): ModelStepContextCompactionController {
  if (!authority) return createModelStepCompactionController(request, options);
  if (!hasSuperContextContract(authority, "supervisor"))
    return createModelStepCompactionController(request, options);
  return createModelStepCompactionController(
    request,
    { ...options, projectContinuation: projectSuperContinuation },
    generateSuperCompactionCandidate,
  );
}
