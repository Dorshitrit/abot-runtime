import {
  validateToolNormalInvocationInput,
  validateToolNormalInvocationPayload,
} from "../../../../capabilities/normal-invocation/index.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutionInput,
  RegisteredToolNormalInvocationRejection,
} from "../shared/contracts.js";
import { rejectNormalInvocation } from "../shared/rejection.js";
import { isPlainRecord } from "../shared/values.js";

export function validatePublicInput(
  source: BoundOperation,
  controls: Readonly<Record<string, unknown>>,
) {
  if (!source.stagedPayloadPlan) {
    return validateToolNormalInvocationInput(source.operation, controls);
  }
  return validateToolNormalInvocationInput(
    Object.freeze({
      ...source.operation,
      input: source.stagedPayloadPlan.publicInput,
    }),
    controls,
  );
}

export function prepareCompleteInvocationInput(
  source: BoundOperation,
  input: Pick<
    RegisteredToolNormalInvocationExecutionInput,
    "controls" | "payload" | "materializedParams"
  >,
):
  | Readonly<{
      ok: true;
      controls: Readonly<Record<string, unknown>>;
      payload?: string;
    }>
  | Readonly<{
      ok: false;
      rejection: RegisteredToolNormalInvocationRejection;
    }> {
  const plan = source.stagedPayloadPlan;
  if (!plan) {
    if (input.materializedParams !== undefined) {
      return {
        ok: false,
        rejection: rejectNormalInvocation(
          "normal_invocation_materialized_params_unexpected",
          "The selected ordinary capability does not accept staged payload values.",
        ),
      };
    }
    const sourceInput = validateToolNormalInvocationInput(
      source.operation,
      input.controls,
    );
    if (!sourceInput.ok) {
      return {
        ok: false,
        rejection: rejectNormalInvocation(
          "normal_invocation_input_invalid",
          sourceInput.issue,
        ),
      };
    }
    const payloadIssue = validateToolNormalInvocationPayload(
      source.operation,
      input.payload,
    );
    if (payloadIssue) {
      return {
        ok: false,
        rejection: rejectNormalInvocation(
          "normal_invocation_payload_invalid",
          payloadIssue,
        ),
      };
    }
    return {
      ok: true,
      controls: sourceInput.value,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    };
  }

  if (input.payload !== undefined) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_payload_conflict",
        "The selected ordinary capability payload was supplied through conflicting channels.",
      ),
    };
  }
  const publicInput = validatePublicInput(source, input.controls);
  if (!publicInput.ok) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_input_invalid",
        publicInput.issue,
      ),
    };
  }
  const materialized = input.materializedParams;
  const expectedNames = new Set(plan.payloadParams);
  if (
    !isPlainRecord(materialized) ||
    Object.keys(materialized).length !== expectedNames.size ||
    Object.entries(materialized).some(
      ([name, value]) =>
        !expectedNames.has(name) ||
        typeof value !== "string" ||
        Object.hasOwn(publicInput.value, name),
    )
  ) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_materialized_params_invalid",
        "The selected ordinary capability staged payload values are invalid.",
      ),
    };
  }

  const fullControls = Object.freeze({
    ...publicInput.value,
    ...Object.fromEntries(
      Object.entries(materialized).filter(([name]) =>
        Object.hasOwn(source.operation.input.properties, name),
      ),
    ),
  });
  const sourceInput = validateToolNormalInvocationInput(
    source.operation,
    fullControls,
  );
  if (!sourceInput.ok) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_input_invalid",
        sourceInput.issue,
      ),
    };
  }
  const payload = materialized[plan.outputParam];
  const payloadIssue = validateToolNormalInvocationPayload(
    source.operation,
    payload,
  );
  if (payloadIssue) {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_payload_invalid",
        payloadIssue,
      ),
    };
  }
  return Object.freeze({
    ok: true as const,
    controls: sourceInput.value,
    ...(payload === undefined ? {} : { payload }),
  });
}
