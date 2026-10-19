import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { projectRequestContext } from "../../context/request-context.js";
import { resolveModelContextAdmission, resolveModelContextBudget } from "../../model/model-context-budget.js";
import { estimateMessagesTokens } from "../../context/token-estimator.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { buildAvailableSkillsText, AVAILABLE_SKILLS_MAX_TOKENS } from "../../knowledge-skills/available-skills-projection.js";
import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";

/** Preparation sees the current request, not routing state or prior tool/document bodies. */
export function buildSupervisorPreparationInput(request: RequestExecutionScope, options: {
  instructions: string;
  format: ModelGatewayJsonSchemaFormat;
  diagnostic: SupervisorDecisionDiagnosticContext;
  availableSkills?: readonly KnowledgeSkillMetadata[];
  expandedCatalog?: boolean;
}) {
  const admissionOptions = {
    runnerConfig: request.runnerConfig, agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...(request.modelPreference ? { modelPreference: request.modelPreference } : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  };
  const budget = resolveModelContextBudget(admissionOptions);
  const calibration = resolveModelContextAdmission(admissionOptions).invocation.instructions ?? [];
  const additionalMessages = appendRequestSteeringContext(
    calibration.length ? [{ role: "system", content: calibration.join("\n") }] : [],
    resolveRequestSteeringInbox(request.requestSteering).snapshot(),
  );
  const additionalTokens = estimateMessagesTokens(additionalMessages, budget.tokenEstimation);
  const base = {
    instructions: options.instructions, format: options.format,
    prompt: request.prompt, historyMessages: [], budget,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    diagnostic: options.diagnostic, onEvent: request.onEvent, deferCompactionFailure: true,
  };
  const baseContext = projectRequestContext(base);
  const catalog = options.availableSkills === undefined ? undefined : buildAvailableSkillsText({
    skills: options.availableSkills,
    budgetTokens: options.expandedCatalog
      ? Math.max(0, baseContext.budget.availableInputTokens - baseContext.budget.estimatedInputTokens - additionalTokens)
      : AVAILABLE_SKILLS_MAX_TOKENS,
    tokenEstimation: budget.tokenEstimation,
    includeListHint: false,
  });
  const instructions = options.availableSkills === undefined ? options.instructions : [
    catalog ?? "Available Skills: no remaining candidate metadata is available.", options.instructions,
  ].join("\n");
  return { format: options.format, context: projectRequestContext({ ...base, instructions }) };
}
