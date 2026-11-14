import { bindModelInvocation } from "../model/bound-invocation.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { captureRequestReasoningPreference } from "../request/reasoning-preference.js";
import { parseRequestInput } from "../request/input.js";
import { resolveRequestDependencies } from "../request/dependencies.js";
import type {
  BoundRequestModelInvocationContext,
  RequestHandlerOptions,
  RunRequestMessage,
} from "../request/contracts.js";

export type CommandModelContext = Readonly<{
  dependencies: ReturnType<typeof resolveRequestDependencies>;
  context: BoundRequestModelInvocationContext;
  policy: ReturnType<typeof resolveRequestExecutionPolicy>;
}>;

/** Configuration/binding only: commands do not manufacture conversation or role calls. */
export function createCommandModelContext(
  message: RunRequestMessage,
  options: RequestHandlerOptions,
  signal: AbortSignal,
  dependencies: ReturnType<
    typeof resolveRequestDependencies
  > = resolveRequestDependencies(options),
): CommandModelContext {
  const input = parseRequestInput(message);
  const loaded = dependencies.loadDecisionEnvironment();
  const selection = resolveModelSelection({
    agentMode: input.rawAgentMode,
    modelPreference: input.rawModelPreference,
    modelPolicy: loaded.modelPolicy,
    modelExecutionPolicies: loaded.modelExecutionPolicies,
  });
  const policy = resolveRequestExecutionPolicy(selection.execution.policy);
  const context = bindModelInvocation({
    requestId: message.requestId,
    runnerConfig: loaded.runnerConfig,
    agentMode: selection.agentMode,
    modelPreference: selection.modelPreference,
    modelPolicy: loaded.modelPolicy,
    reasoningPreference: captureRequestReasoningPreference(
      input.rawReasoningPreference,
      selection,
    ),
    modelGatewayClient: dependencies.modelGatewayClient,
    abortSignal: signal,
    onThinkingDelta: () => {},
    onThinkingTrace: () => {},
  });
  return { dependencies, context, policy };
}
