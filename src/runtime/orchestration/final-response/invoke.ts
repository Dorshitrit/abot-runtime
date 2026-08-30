import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import type { RootAuthoredResponse } from "../../long-term-memory/contracts.js";
import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import {
  parseRootAuthoredResponse,
  type RootFinalResponseValidator,
} from "./authoring-contract.js";
import { createRootAuthoredResponseFormat } from "./format.js";

export function invokeRootAuthoredResponse(params: {
  request: BoundRequestModelInvocationContext;
  modelStep: ModelStep;
  messages: ChatMessage[];
  timeoutReason: string;
  invalidOutputReason: string;
  contextCompaction?: ModelStepContextCompactionController;
  maxResponseChars?: number;
  validateFinalResponse?: RootFinalResponseValidator;
}): Promise<RootAuthoredResponse> {
  return invokeStructuredModelStep({
    request: params.request,
    modelStep: params.modelStep,
    format: createRootAuthoredResponseFormat(params.maxResponseChars),
    messages: params.messages,
    timeoutReason: params.timeoutReason,
    invalidOutputReason: params.invalidOutputReason,
    ...(params.contextCompaction
      ? { contextCompaction: params.contextCompaction }
      : {}),
    parse: (text) =>
      parseRootAuthoredResponse(text, {
        ...(params.maxResponseChars !== undefined
          ? { maxResponseChars: params.maxResponseChars }
          : {}),
        ...(params.validateFinalResponse
          ? { validateFinalResponse: params.validateFinalResponse }
          : {}),
      }),
  });
}
