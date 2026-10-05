import { traceDebug } from "../observability/debug-logger.js";
import type { SessionTerminalMessage } from "../../sessions/request-lifecycle/contracts.js";
import { ROLE_CALL_RESPONSE_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { projectOutputLimitCause } from "../steps/degraded-finalization/output-limit-cause.js";
import {
  boundedSuperFailureCode,
  createSuperFailureFallback,
} from "../steps/degraded-finalization/super.js";
import type { SuperFailureFinalization } from "./super-failure-explanation.js";
import type { RequestSteeringInbox } from "./request-steering.js";

/** Presentation uses trusted request services only, never a failed role ledger. */
export async function composeSuperFailureMessage(params: {
  requestId: string;
  error: unknown;
  finalization?: SuperFailureFinalization | undefined;
  steering: RequestSteeringInbox;
}): Promise<SessionTerminalMessage> {
  const input = {
    problem: {
      stage: "request_failure",
      code: boundedSuperFailureCode(params.error),
      ...projectOutputLimitCause(params.error),
    },
    progress: null,
  };
  const version = params.steering.snapshot().version;
  const explanation = params.finalization
    ? await params.finalization.explain({
        error: params.error,
        input,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        steeringVersion: version,
      })
    : createSuperFailureFallback(input, version);
  const currentVersion = params.steering.snapshot().version;
  const output =
    currentVersion === explanation.steeringVersion
      ? explanation.output
      : createSuperFailureFallback(input, currentVersion).output;
  await params.steering.close();
  traceDebug("runtime.request", "super.failure_message_prepared", {
    requestId: params.requestId,
    primaryCode: input.problem.code,
    secondaryCode: explanation.secondaryCode,
    source:
      currentVersion === explanation.steeringVersion
        ? explanation.source
        : "runtime_fallback",
    route: "request_failure",
    steeringVersion: currentVersion,
  });
  return { content: output, grounding: "conversation" };
}
