import type {
  RoleCallChildReturnCommit,
  RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import type { RequestObservation } from "./result.js";
import {
  traceSupervisorRootObservationHandoffBound,
  type SupervisorRootDiagnosticContext,
} from "./supervisor-root-execution-diagnostics.js";

export type RootObservationHandoff = Readonly<{
  callerCallId: string;
  childCallId: string;
  resultRef: string;
  finalObservation: RequestObservation;
}>;

type ObservationSource = Pick<
  RootObservationHandoff,
  "callerCallId" | "childCallId" | "resultRef"
>;

export function bindSupervisorObservationHandoff(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  returnCommit: RoleCallChildReturnCommit;
  resume: RoleChildReturnContext;
  finalObservation: RequestObservation;
  replaced: boolean;
}): RootObservationHandoff {
  const { callerCallId, childCallId, resultRef } = params.returnCommit.effect;
  const source = { callerCallId, childCallId, resultRef };
  if (!hasBoundObservationReturn(params.resume, source)) {
    throw new Error("supervisor_observation_handoff_source_invalid");
  }
  const handoff = Object.freeze({
    ...source,
    finalObservation: params.finalObservation,
  });
  traceSupervisorRootObservationHandoffBound({
    diagnostic: params.diagnostic,
    ...source,
    replaced: params.replaced,
    observationContentLength: params.finalObservation.observationContent.length,
  });
  return handoff;
}

export function projectSupervisorFinalObservation(
  handoff: RootObservationHandoff,
  resume: RoleChildReturnContext | undefined,
): RequestObservation {
  if (!hasObservationSource(resume, handoff)) {
    throw new Error("supervisor_observation_handoff_source_invalid");
  }
  return handoff.finalObservation;
}

function hasBoundObservationReturn(
  resume: RoleChildReturnContext,
  source: ObservationSource,
): boolean {
  if (resume.returnedChildCallId !== source.childCallId) return false;
  if (resume.returnedResultRef !== source.resultRef) return false;
  return hasObservationSource(resume, source);
}

function hasObservationSource(
  resume: RoleChildReturnContext | undefined,
  source: ObservationSource,
): boolean {
  if (resume?.callerCallId !== source.callerCallId) return false;
  return resume.completedChildren.some((child) =>
    hasObservationIdentity(child, source),
  );
}

function hasObservationIdentity(
  child: ObservationSource,
  source: ObservationSource,
): boolean {
  if (child.callerCallId !== source.callerCallId) return false;
  if (child.childCallId !== source.childCallId) return false;
  return child.resultRef === source.resultRef;
}
