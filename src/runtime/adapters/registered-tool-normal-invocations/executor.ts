import {
  deriveRegisteredToolPayloadContextPlan,
  deriveRegisteredToolStagedPayloadPlan,
} from "../registered-tool-payload-plan.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutor,
  RegisteredToolNormalInvocationExecutorParams,
} from "./shared/contracts.js";
import { captureNormalInvocationRegistrations } from "./catalog/registrations.js";
import { projectRuntimePathBindings } from "./catalog/runtime-path-bindings.js";
import {
  executeNormalInvocation,
  prepareNormalInvocation,
} from "./execution/run.js";
import { emitNormalInvocationPayloadLifecycle } from "./payload/lifecycle.js";
import { prepareNormalInvocationPayloadLifecycle } from "./payload/lifecycle.js";

/**
 * Captures one selected ToolRegistry snapshot and executes its ordinary
 * invocation contracts. Normalization may only resolve another operation from
 * this exact snapshot; global registry fallbacks can never grant availability.
 */
export function createRegisteredToolNormalInvocationExecutor(
  params: RegisteredToolNormalInvocationExecutorParams,
): RegisteredToolNormalInvocationExecutor {
  const registrations = captureNormalInvocationRegistrations(
    params.registrations,
  );
  const operationByHandle = new WeakMap<object, BoundOperation>();
  const operations = Object.freeze(
    registrations.flatMap((registration) =>
      registration.contract.operations.map((operation) => {
        const runtimePathBindings = projectRuntimePathBindings(
          registration.definition,
          operation,
        );
        const payloadContextPlan = deriveRegisteredToolPayloadContextPlan(
          registration.definition,
          operation,
        );
        const stagedPayloadPlan = deriveRegisteredToolStagedPayloadPlan(
          registration.definition,
          operation,
        );
        const handle = Object.freeze({
          kind: "registered_tool_normal_invocation_handle" as const,
        });
        operationByHandle.set(
          handle,
          Object.freeze({
            registration,
            operation,
            ...(runtimePathBindings.length > 0 ? { runtimePathBindings } : {}),
            ...(payloadContextPlan ? { payloadContextPlan } : {}),
            ...(stagedPayloadPlan ? { stagedPayloadPlan } : {}),
          }),
        );
        return Object.freeze({
          handle,
          operation,
          ...(runtimePathBindings.length > 0 ? { runtimePathBindings } : {}),
          ...(payloadContextPlan ? { payloadContextPlan } : {}),
          ...(stagedPayloadPlan ? { stagedPayloadPlan } : {}),
        });
      }),
    ),
  );

  return Object.freeze({
    operations,
    emitPayloadLifecycle(input) {
      return emitNormalInvocationPayloadLifecycle({
        operationByHandle,
        input,
        ...(params.onEvent ? { onEvent: params.onEvent } : {}),
      });
    },
    preparePayloadLifecycle(input) {
      return prepareNormalInvocationPayloadLifecycle({
        operationByHandle,
        input,
        ...(params.onEvent ? { onEvent: params.onEvent } : {}),
      });
    },
    prepare(input) {
      return prepareNormalInvocation({
        executor: params,
        registrations,
        operationByHandle,
        input,
      });
    },
    execute(input) {
      return executeNormalInvocation({
        executor: params,
        registrations,
        operationByHandle,
        input,
      });
    },
  });
}
