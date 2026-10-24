import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { projectRequestContext } from "../../context/request-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";

/** Preparation sees the current request, not routing state or prior tool/document bodies. */
export function buildSupervisorPreparationInput(request: RequestExecutionScope, options: {
  instructions: string;
  format: ModelGatewayJsonSchemaFormat;
  diagnostic: SupervisorDecisionDiagnosticContext;
  referenceMessages?: readonly ChatMessage[];
}) {
  const admissionOptions = {
    runnerConfig: request.runnerConfig, agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...(request.modelPreference ? { modelPreference: request.modelPreference } : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  };
  const budget = resolveModelContextBudget(admissionOptions);
  const base = {
    instructions: options.instructions, format: options.format,
    prompt: request.prompt, historyMessages: [], budget,
    referenceMessages: options.referenceMessages,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    diagnostic: options.diagnostic, onEvent: request.onEvent, deferCompactionFailure: true,
  };
  // The exact model-step admission measures the complete envelope, including late
  // calibration and steering. Keep metadata whole even when this estimate exceeds it.
  return { format: options.format, context: projectRequestContext(base) };
}
