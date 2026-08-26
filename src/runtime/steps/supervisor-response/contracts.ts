import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type {
  SupervisorDecisionCallIdentity,
  SupervisorResumeContext,
} from "../supervisor-decision/index.js";

export const SUPERVISOR_RESPONSE_MODEL_STEP = MODEL_STEPS.SUPERVISOR_RESPONSE;

export type SupervisorResponseCallIdentity = SupervisorDecisionCallIdentity;
export type SupervisorResponseResumeContext = SupervisorResumeContext;

export type SupervisorResponseDiagnosticContext = Readonly<{
  requestId: string;
  modelStep: typeof SUPERVISOR_RESPONSE_MODEL_STEP;
  rootCallId: string;
  callId: string;
  parentCallId: string | null;
  depth: number;
  invocationAttempt: number;
}>;
