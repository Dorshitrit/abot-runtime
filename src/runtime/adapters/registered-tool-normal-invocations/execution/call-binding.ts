import {
  validateToolNormalInvocationInput,
  validateToolNormalInvocationPayload,
} from "../../../../capabilities/normal-invocation/index.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
  ToolCallAdapter,
  ToolNormalInvocationOperation,
} from "../../../../capabilities/tool-types.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationRejection,
} from "../shared/contracts.js";
import { rejectNormalInvocation } from "../shared/rejection.js";
import { isPlainRecord } from "../shared/values.js";

export function materializeCall(
  binding: BoundOperation,
  controls: Readonly<Record<string, unknown>>,
  payload: string | undefined,
): ToolCall {
  return Object.freeze({
    tool: binding.registration.toolName,
    params: Object.freeze({
      ...controls,
      ...(binding.operation.fixedParams ?? {}),
      ...(binding.operation.payload && payload !== undefined
        ? { [binding.operation.payload.param]: payload }
        : {}),
    }),
  });
}

export function resolveExactTargetOperation(
  registrations: readonly RegisteredToolNormalInvocation[],
  call: ToolCall,
):
  | Readonly<{ ok: true; binding: BoundOperation }>
  | Readonly<{
      ok: false;
      rejection: RegisteredToolNormalInvocationRejection;
    }> {
  const registration = registrations.find(
    (entry) => entry.toolName === call.tool,
  );
  if (!registration) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_target_unavailable",
        "The normalized tool is not enabled in the selected request profile.",
      ),
    };
  }
  const matches = registration.contract.operations.filter((operation) =>
    matchesMaterializedCall(operation, call.params),
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_target_ambiguous",
        matches.length === 0
          ? "The normalized call does not match a registered ordinary operation."
          : "The normalized call matches more than one registered ordinary operation.",
      ),
    };
  }
  return {
    ok: true,
    binding: Object.freeze({ registration, operation: matches[0]! }),
  };
}

export function captureToolCall(value: unknown): ToolCall | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const tool = value.tool;
  const rawParams = value.params;
  if (
    typeof tool !== "string" ||
    tool.trim().length === 0 ||
    !isPlainRecord(rawParams)
  ) {
    return undefined;
  }
  const capturedParams = Object.fromEntries(
    Object.entries(rawParams).map(([name, item]) => [
      name,
      Array.isArray(item) ? Object.freeze([...item]) : item,
    ]),
  );
  return Object.freeze({
    tool,
    params: Object.freeze(capturedParams),
  });
}

export function validateCompleteCall(params: {
  adapter: ToolCallAdapter | undefined;
  call: ToolCall;
  rejectedCode: string;
  failedCode: string;
  failedMessage: string;
}):
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      rejection: RegisteredToolNormalInvocationRejection;
    }> {
  if (!params.adapter?.validateCall) {
    return Object.freeze({ ok: true as const });
  }
  try {
    const validation: unknown = params.adapter.validateCall(params.call);
    if (validation === null || validation === undefined) {
      return Object.freeze({ ok: true as const });
    }
    if (
      !isPlainRecord(validation) ||
      typeof validation.error !== "string" ||
      validation.error.trim().length === 0 ||
      (validation.repairHint !== undefined &&
        typeof validation.repairHint !== "string")
    ) {
      return Object.freeze({
        ok: false as const,
        rejection: rejectNormalInvocation(
          params.failedCode,
          params.failedMessage,
        ),
      });
    }
    return Object.freeze({
      ok: false as const,
      rejection: rejectNormalInvocation(
        params.rejectedCode,
        [
          validation.error,
          ...(validation.repairHint?.trim()
            ? [`Repair: ${validation.repairHint.trim()}`]
            : []),
        ].join("\n"),
      ),
    });
  } catch {
    return Object.freeze({
      ok: false as const,
      rejection: rejectNormalInvocation(
        params.failedCode,
        params.failedMessage,
      ),
    });
  }
}

function matchesMaterializedCall(
  operation: ToolNormalInvocationOperation,
  params: Record<string, unknown>,
): boolean {
  const publicNames = Object.keys(operation.input.properties);
  const fixedNames = Object.keys(operation.fixedParams ?? {});
  const payloadName = operation.payload?.param;
  const allowed = new Set([
    ...publicNames,
    ...fixedNames,
    ...(payloadName ? [payloadName] : []),
  ]);
  if (Object.keys(params).some((name) => !allowed.has(name))) return false;
  for (const [name, value] of Object.entries(operation.fixedParams ?? {})) {
    if (params[name] !== value) return false;
  }
  const publicInput = Object.fromEntries(
    publicNames
      .filter((name) => Object.hasOwn(params, name))
      .map((name) => [name, params[name]]),
  );
  if (!validateToolNormalInvocationInput(operation, publicInput).ok) {
    return false;
  }
  const payload = payloadName ? params[payloadName] : undefined;
  return validateToolNormalInvocationPayload(operation, payload) === undefined;
}
