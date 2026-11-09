import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient, RuntimeConfig } from "../../ports.js";
import { loadRequestRunnerConfig } from "../../config/runner/loader.js";
import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { resolveModelSelection } from "../../model/model-selection.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import type { SparkHomeRequestSettings } from "../settings/contracts.js";
import { isSparkHomeHtml } from "../contracts.js";
import { homeGenerationFailure, type SparkHomeGenerationModel } from "./contracts.js";
import { homePlanFormat, parseHomePlan } from "./model-contracts.js";
import { HOME_PLAN_INSTRUCTIONS, HOME_FOLLOWUP_INSTRUCTIONS, HOME_HTML_INSTRUCTIONS } from "./prompts.js";
import { SPARK_HOME_WIDGET_CATALOG } from "../widgets/catalog.js";

export function resolveHomeGenerationSelection(config: RuntimeConfig, settings: SparkHomeRequestSettings) {
  if (!settings.modelProfileId || !config.models?.profiles?.[settings.modelProfileId]) return homeGenerationFailure("spark_home_model_unavailable");
  const selected = resolveModelSelection({ agentMode: "reasoning", modelPreference: { profileId: settings.modelProfileId, scope: "all" },
    modelPolicy: config.models, modelExecutionPolicies: config.modelExecutionPolicies });
  if (selected.execution.primaryProfileId !== settings.modelProfileId) return homeGenerationFailure("spark_home_model_unavailable");
  if (selected.execution.policy !== "execution-agent-v1") return homeGenerationFailure("spark_home_execution_agent_required");
  return selected;
}

function homeModelMessages(instructions: string, input: { instructions: string; instruction?: string }, reference: unknown): ChatMessage[] {
  return [
    { role: "system", content: instructions },
    { role: "user", content: JSON.stringify({ kind: "spark_home_user_requirements_v1", authority: "saved_user_preferences_and_explicit_current_request",
      personalInstructions: input.instructions, ...(input.instruction ? { currentInstruction: input.instruction } : {}) }) },
    { role: "user", content: JSON.stringify({ kind: "spark_home_phase_reference_v1", authority: "passive_reference",
      addsUserIntent: false, grantsActionAuthority: false, applicability: "this_home_phase_only", reference }) },
  ];
}

/** No request kernel, role context, Skills, conversation compactor or payload author is called. */
export function createSparkHomeGenerationModel(input: {
  config: RuntimeConfig; models: ModelGatewayClient; settings: SparkHomeRequestSettings; runId: string; abortSignal: AbortSignal;
}): SparkHomeGenerationModel {
  resolveHomeGenerationSelection(input.config, input.settings);
  const runnerConfig = loadRequestRunnerConfig(input.config.requestRunner);
  const modelPreference = { profileId: input.settings.modelProfileId, scope: "all" as const };
  const invoker = new RequestModelStepInvoker({ requestId: input.runId, runnerConfig, agentMode: "reasoning",
    modelPreference, modelPolicy: input.config.models!, modelGatewayClient: input.models, abortSignal: input.abortSignal,
    onThinkingDelta: () => {}, onThinkingTrace: () => {} });
  const call = async <T>(step: "spark_home.plan" | "spark_home.followup" | "spark_home.html", messages: ChatMessage[],
    format: Record<string, unknown>, accept: (text: string) => T): Promise<T> => {
    input.abortSignal.throwIfAborted();
    const binding = resolveModelContextAdmission({ runnerConfig, agentMode: "reasoning", modelStep: step,
      modelPreference, modelPolicy: input.config.models, requestFormat: format });
    if (binding.invocation.profile.id !== input.settings.modelProfileId) return homeGenerationFailure("spark_home_model_overridden");
    return invoker.invoke({ modelStep: step, messages, format, contextRetention: "exact", configuredInstructionPolicy: "omit",
      timeoutReason: "spark_home_model_timeout", accept(text, diagnostics) {
        const incomplete = resolveOutputIncompleteError(diagnostics, step);
        if (incomplete) throw incomplete;
        return accept(text);
      } });
  };
  return {
    plan(value) {
      return call("spark_home.plan", homeModelMessages(HOME_PLAN_INSTRUCTIONS, value,
        { sourceContext: value.reference, operations: value.operations, resourceReadBudget: value.resourceReadBudget,
          systemWidgets: SPARK_HOME_WIDGET_CATALOG }),
      homePlanFormat(value.operations), text => parseHomePlan(text, value.operations));
    },
    followup(value) {
      return call("spark_home.followup", homeModelMessages(HOME_FOLLOWUP_INSTRUCTIONS, value,
        { sourceContext: value.reference, direction: value.direction, evidence: value.evidence,
          operations: value.operations, resourceReadBudget: value.resourceReadBudget, systemWidgets: SPARK_HOME_WIDGET_CATALOG }),
      homePlanFormat(value.operations), text => parseHomePlan(text, value.operations));
    },
    html(value) {
      return call("spark_home.html", homeModelMessages(HOME_HTML_INSTRUCTIONS, value,
        { sourceContext: value.reference, direction: value.direction, evidence: value.evidence,
          systemWidgets: SPARK_HOME_WIDGET_CATALOG }), { type: "text" }, text => {
          if (!isSparkHomeHtml(text)) return homeGenerationFailure("spark_home_html_invalid");
          return text;
        });
    },
  };
}
