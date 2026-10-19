import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { permitsModelContentTrace } from "../../model-gateway/observability/content-trace-policy.js";
import type { ModelStep } from "../../shared/model-steps.js";

/** A transport/provider failure bound to the model step that actually invoked it. */
export class ModelProviderFailure extends Error {
  readonly code = "model_provider_failure";
  readonly stage: string;

  constructor(
    readonly modelStep: ModelStep,
    cause: ModelGatewayInvocationError,
  ) {
    super(cause.message, { cause });
    this.name = "ModelProviderFailure";
    this.stage = `model_provider_${cause.kind}`;
  }
}

/** Unrecognized local faults retain their identity and existing failure path. */
export async function invokeModelProvider<T>(
  modelStep: ModelStep,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (error: unknown) {
    if (!(error instanceof ModelGatewayInvocationError)) throw error;
    throw new ModelProviderFailure(modelStep, error);
  }
}

/** Retains bounded diagnostics when the failed child no longer escapes the request. */
export function projectModelProviderFailureDiagnostics(
  error: unknown,
  messages: unknown,
): Record<string, unknown> {
  if (!(error instanceof ModelProviderFailure)) return {};
  return {
    providerFailureCode: error.code,
    providerFailureStage: error.stage,
    ...(permitsModelContentTrace(error.modelStep, messages)
      ? { providerErrorPreview: error.message.slice(0, 400) }
      : { contentOmitted: true }),
  };
}
