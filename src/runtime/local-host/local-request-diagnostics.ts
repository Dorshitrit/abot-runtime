import type { RequestSteeringAppendResult } from "../request/request-steering.js";
import {
  diagnosticErrorType,
  traceRequestControl,
  type RequestControlDiagnosticFields,
} from "../observability/request-control-diagnostics.js";

export type LocalRequestDiagnosticFields = RequestControlDiagnosticFields;

export type LocalRequestFinishSource =
  | "unspecified"
  | "initial_steering_rejected"
  | "ordinary_handler_finally"
  | "resumed_handler_finally"
  | "scheduled_completed"
  | "scheduled_failed";

/** Unknown transport values are observed without invoking user-supplied getters. */
export function steeringInputDiagnosticFields(
  requestId: unknown,
  input: unknown,
): LocalRequestDiagnosticFields {
  const fields: LocalRequestDiagnosticFields = {
    requestId: typeof requestId === "string" ? requestId : undefined,
    requestIdType: typeof requestId,
  };
  try {
    if (!input || typeof input !== "object") return fields;
    const steerId = Object.getOwnPropertyDescriptor(input, "steerId")?.value;
    const text = Object.getOwnPropertyDescriptor(input, "text")?.value;
    return {
      ...fields,
      steerId: typeof steerId === "string" ? steerId : undefined,
      textLength: typeof text === "string" ? text.length : undefined,
    };
  } catch {
    // An uninspectable diagnostic value must not change transport validation.
  }
  return fields;
}

export function steeringResultDiagnosticFields(
  result: RequestSteeringAppendResult,
): LocalRequestDiagnosticFields {
  try {
    if (result.ok) {
      return {
        accepted: true,
        duplicate: result.duplicate,
        acceptedSequence: result.update.sequence,
      };
    }
    return { accepted: false, reason: result.reason };
  } catch {
    return { resultInspectable: false };
  }
}

export function traceLocalRequest(
  event: string,
  fields: LocalRequestDiagnosticFields,
): void {
  traceRequestControl("runtime.local_request_control", event, fields);
}

export function traceLocalRequestFailure(
  event: string,
  fields: LocalRequestDiagnosticFields,
  error: unknown,
): void {
  traceLocalRequest(event, {
    ...fields,
    errorType: diagnosticErrorType(error),
  });
}
