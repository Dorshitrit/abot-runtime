import type { ChatMessage } from "../../model-gateway/types.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { projectToolMediaMessages } from "../context/tool-media-projection.js";
import type { RequestModelInvocationView } from "../request/contracts.js";
import { countModelInputTokens } from "./input-token-count.js";
import type { ResolvedModelContextAdmission } from "./model-context-budget.js";
import type { ModelStepInvocationInput } from "./model-step-port.js";

/** Measures every candidate through the same media, provider-count and estimate path. */
export function createModelContextAssessment(input: {
  request: RequestModelInvocationView;
  params: Pick<ModelStepInvocationInput<unknown>, "modelStep" | "format" | "promptCacheBoundaryBeforeMessage">;
  admission: ResolvedModelContextAdmission;
  assertCurrent(): void;
  abortSignal?: AbortSignal;
}) {
  const { request, params, admission, assertCurrent } = input;
  const calibrationInstructions = (admission.invocation.instructions ?? [])
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
  const effectiveFormat = admission.effectiveFormat;
  const projectMedia = (candidate: readonly ChatMessage[]) =>
    projectToolMediaMessages({
      messages: candidate,
      store: request.toolResources?.media,
      modelStep: params.modelStep,
      supportsImages:
        admission.invocation.profile.capabilities.inputModalities.includes(
          "image",
        ),
    });
  const assess = async (candidateMessages: readonly ChatMessage[]) => {
    assertCurrent();
    const projected = projectMedia(candidateMessages);
    const measuredInputTokens = await countModelInputTokens({
      request,
      invocation: admission.invocation,
      modelStep: params.modelStep,
      messages: projected,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(params.promptCacheBoundaryBeforeMessage
        ? { promptCacheBoundaryBeforeMessage: params.promptCacheBoundaryBeforeMessage } : {}),
      ...(params.format !== undefined ? { format: params.format } : {}),
    });
    assertCurrent();
    return assessRequestMessagesBudget({
      messages:
        calibrationInstructions.length > 0
          ? [
              {
                role: "system" as const,
                content: calibrationInstructions.join("\n"),
              },
              ...projected,
            ]
          : projected,
      ...(isSchemaFormat(effectiveFormat)
        ? { format: { schema: effectiveFormat.schema } }
        : {}),
      budget: admission.budget,
      ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
    });
  };
  return { assess, projectMedia };
}

function isSchemaFormat(
  format: "json" | Record<string, unknown> | undefined,
): format is Record<string, unknown> & { schema: unknown } {
  return (
    typeof format === "object" &&
    format !== null &&
    Object.prototype.hasOwnProperty.call(format, "schema")
  );
}
