import { projectWorkerDecisionCallIdentity } from "../contracts.js";
import { projectEligibleWorkerSessionArtifactPaths } from "../runtime-path-refinement.js";
import { prepareWorkerCapabilitySelection } from "./capability-selection.js";
import {
  prepareWorkerCanonicalState,
  projectCapabilities,
  validateCanonicalSources,
} from "./canonical-state.js";
import { prepareWorkerDecisionContract } from "./contract.js";
import { resolveWorkerDecisionDiagnostic } from "./diagnostic-projection.js";
import {
  prepareWorkerPromptContext,
  projectWorkerDecisionContext,
} from "./prompt-context.js";
import { prepareWorkerReferenceContext } from "./reference-context.js";
import type {
  PreparedWorkerDecisionAssembly,
  PreparedWorkerDecisionSession,
  WorkerDecisionInputOptions,
  WorkerDecisionInputRequest,
} from "./types.js";

export function prepareWorkerDecisionSession(
  request: WorkerDecisionInputRequest,
  options: WorkerDecisionInputOptions,
): PreparedWorkerDecisionSession {
  const callIdentity = projectWorkerDecisionCallIdentity(options.call);
  const diagnostic = resolveWorkerDecisionDiagnostic(
    request.requestId,
    options,
    callIdentity,
  );
  const objective = options.call.objective!;
  validateCanonicalSources({
    requestId: request.requestId,
    call: options.call,
    capabilitySource: options.capabilitySource,
    resumeSource: options.capabilityResume,
  });
  const eligibleSessionArtifactPaths =
    projectEligibleWorkerSessionArtifactPaths(
      request.sessionArtifactPaths,
      options.requestToolResults,
    );
  const sessionArtifactPathAvailableCount =
    request.sessionArtifactPaths?.length ?? 0;
  const projectedCapabilities = projectCapabilities({
    requestId: request.requestId,
    call: options.call,
    binding: options.capabilitySource?.binding,
    authorityLedger: options.capabilitySource?.ledger,
    deferRuntimePathControls: eligibleSessionArtifactPaths.length > 0,
  });
  const capabilitySelection = prepareWorkerCapabilitySelection(
    options,
    projectedCapabilities,
  );
  const canonicalState = prepareWorkerCanonicalState(
    request,
    options,
    callIdentity,
  );
  const contract = prepareWorkerDecisionContract({
    options,
    projectedCapabilities,
    eligibleSessionArtifactPaths,
    canonicalSource: canonicalState.canonicalSource,
    capabilitySelection,
  });

  return Object.freeze({
    request,
    options,
    callIdentity,
    diagnostic,
    objective,
    eligibleSessionArtifactPaths,
    sessionArtifactPathAvailableCount,
    capabilitySelection,
    canonicalState,
    contract,
  });
}

export function prepareWorkerDecisionAssembly(
  session: PreparedWorkerDecisionSession,
): PreparedWorkerDecisionAssembly {
  const references = prepareWorkerReferenceContext(session);
  const prompt = prepareWorkerPromptContext(session, references);
  const projection = projectWorkerDecisionContext(session, references, prompt);
  return Object.freeze({ references, prompt, projection });
}
