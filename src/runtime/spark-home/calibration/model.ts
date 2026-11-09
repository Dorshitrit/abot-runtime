import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient, RuntimeConfig } from "../../ports.js";
import { loadRequestRunnerConfig } from "../../config/runner/loader.js";
import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import { settingsFailure } from "../settings/contracts.js";
import type { SparkHomeCalibrationDraftInput, SparkHomeCalibrationOptions } from "./contracts.js";

export const SPARK_HOME_CALIBRATION_STEP = "spark_home.calibration" as const;
const FORMAT = Object.freeze({ type: "text", calibrationInstructions: "omit" });
const INSTRUCTIONS = `Draft concise personal instructions for the user's SPARK HOME screen. Return only the editable instructions, at most 4000 characters. Do not create HTML, invoke tools, claim observations, save settings or create a screen.
Derive personal preferences solely from the user's explicit selected widgets, topics and constraints. Do not invent interests, personal facts, accounts, tasks or available data. No memories or conversation history are supplied.
Treat selected outcomes as required priorities, not an exhaustive allowlist. An unselected option is neither a requested requirement nor an exclusion. Do not turn a request for focus or priority into a blanket restriction to only the listed components. Write an exclusivity restriction only when the user explicitly imposed it, and preserve explicit exclusions. Leave room for relevant native system components to complement the requested content without claiming the user requested those components.
The supplied capability reference describes the offered widget capabilities, not a complete tool catalog, tool results or further user intent. publicWebSearchAvailable reports topic discovery through public web search only; false does not establish that all web reading is unavailable. A date calendar is a local date grid, not a connected calendar; system status uses live native readings with explicit computer, WSL or container scope. Web access does not guarantee coverage or current results. Require actual evidence, sources and dates for fetched facts; omit unavailable optional data instead of inventing it. Respect normal tool permissions and approvals.
For selected options with a nativeWidgetId, request that exact native widget in the editable instructions. The host supplies its live values; do not request tool calls or embedded measurements for it.
Turn the selected outcomes into clear focused standing requirements. Preserve the user's priorities and language when expressed. Leave composition and layout flexible, use deliberate empty space, and do not pad the screen with generic greetings or invented content. Keep optional content conditional. Do not add private plugins, integrations, recurring jobs or hidden actions.`;

export function sparkHomeCalibrationMessages(input: SparkHomeCalibrationDraftInput, binding: SparkHomeCalibrationOptions): ChatMessage[] {
  const reference = { kind: "spark_home_calibration_capabilities_v1", authority: "runtime_capability_reference",
    purpose: "feasibility_only", addsUserIntent: false, grantsActionAuthority: false,
    applicability: "this_draft_only", truncated: false,
    capabilities: {
      publicWebSearchAvailable: binding.options.some(option => option.id === "web_topics" && option.available),
      runtimeSystemStatusAvailable: binding.options.some(option => option.id === "system_status" && option.available),
    },
    options: binding.options.filter(option => input.widgetIds.includes(option.id)) };
  return [
    { role: "system", content: `${INSTRUCTIONS}\n\n${JSON.stringify(reference)}` },
    { role: "user", content: JSON.stringify({ selectedWidgets: input.widgetIds, topics: input.topics, constraints: input.constraints }) },
  ];
}

export async function draftSparkHomeCalibration(options: {
  config: RuntimeConfig; models: ModelGatewayClient;
  input: SparkHomeCalibrationDraftInput; binding: SparkHomeCalibrationOptions;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const runnerConfig = loadRequestRunnerConfig(options.config.requestRunner);
  const modelPreference = { profileId: options.binding.effectiveModelProfileId, scope: "all" as const };
  const selection = resolveModelContextAdmission({ runnerConfig, agentMode: "reasoning", modelStep: SPARK_HOME_CALIBRATION_STEP,
    modelPreference, modelPolicy: options.config.models, requestFormat: FORMAT });
  if (selection.invocation.profile.id !== modelPreference.profileId) return settingsFailure("spark_home_model_unavailable");
  const invoker = new RequestModelStepInvoker({ requestId: `spark-home-calibration:${randomUUID()}`, runnerConfig,
    agentMode: "reasoning", modelPreference, modelPolicy: options.config.models!, modelGatewayClient: options.models,
    abortSignal: options.abortSignal ?? new AbortController().signal, onThinkingDelta: () => {}, onThinkingTrace: () => {} });
  return invoker.invoke({ modelStep: SPARK_HOME_CALIBRATION_STEP, format: FORMAT,
    contextRetention: "exact", configuredInstructionPolicy: "omit",
    messages: sparkHomeCalibrationMessages(options.input, options.binding), timeoutReason: "spark_home_calibration_timeout",
    accept(text, diagnostics) {
      const incomplete = resolveOutputIncompleteError(diagnostics, SPARK_HOME_CALIBRATION_STEP);
      if (incomplete) throw incomplete;
      if (!text.trim() || text.length > 4000) return settingsFailure("spark_home_calibration_output_invalid");
      return text.trim();
    },
  });
}
