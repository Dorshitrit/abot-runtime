import { hasExecutionHistoryAuthority } from "../context/execution-history-policy.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import { SESSION_MEMORY_PROTECTED_TURN_COUNT } from "../context/session-memory/contracts.js";
import { projectSessionMemoryMessages } from "../context/session-memory/projection.js";
import { createSessionHistoryCompactionStage } from "../context/session-memory/stage.js";
import { resolvePolicySessionMemoryCompactor } from "../context/super-compaction/history-routing.js";
import { admitCompactedContext } from "../model/context-compaction-admission.js";
import { createModelContextAssessment } from "../model/model-context-assessment.js";
import { resolveModelContextAdmission } from "../model/model-context-budget.js";
import type { ModelStepCompactionStage } from "../model/context-compaction-contracts.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { RuntimeCommandResult } from "./contracts.js";
import type { CommandModelContext } from "./model-context.js";

export async function compactSessionCommand(
  binding: CommandModelContext,
  session: SessionRecord,
  claimFinalization?: () => void,
): Promise<RuntimeCommandResult> {
  const { context, policy, dependencies } = binding;
  const executionHistory = hasExecutionHistoryAuthority(policy.authority);
  const memory = createRequestSessionMemory({
    sessionId: session.id,
    session,
    ...(executionHistory ? { scope: "execution_agent" as const } : {}),
    repository: dependencies.sessionStore,
    compactor: resolvePolicySessionMemoryCompactor(
      dependencies.sessionMemoryCompactor,
      dependencies.superSessionMemoryCompactor,
      policy.authority,
    ),
  });
  const before = memory.project();
  if (before.compactableTurnCount === 0) {
    const onlyProtectedHistoryRemains = !executionHistory && before.historyMessages.length > 0;
    return {
      eventName: "context.compaction.completed",
      outcome: "no_change",
      details: {
        reason: "no_eligible_sources",
        ...(onlyProtectedHistoryRemains ? { protectedTurnLimit: SESSION_MEMORY_PROTECTED_TURN_COUNT } : {}),
        compactionScope: "session_history",
        checkpointRevision: before.checkpointRevision,
      },
    };
  }
  const modelStep = executionHistory
    ? "execution.decision"
    : "supervisor.decision";
  // This is a history projection measurement, not a decision-generation call.
  // Match existing checkpoint measurement's text format at the provider boundary.
  const format = { type: "text" } as const;
  const admission = resolveModelContextAdmission({
    runnerConfig: context.runnerConfig,
    agentMode: context.agentMode,
    modelStep,
    modelPreference: context.modelPreference,
    modelPolicy: context.modelPolicy,
    reasoningPreference: context.reasoningPreference,
    requestFormat: format,
  });
  const assertCurrent = () => context.abortSignal.throwIfAborted();
  const { assess } = createModelContextAssessment({
    request: context,
    params: { modelStep, format },
    admission,
    assertCurrent,
  });
  const messages = projectSessionMemoryMessages(before);
  const assessment = await assess(messages);
  const historyStage = createSessionHistoryCompactionStage(
    context,
    session.id,
    memory,
    before,
  );
  const stage: ModelStepCompactionStage = {
    ...historyStage,
    async prepare(input, preparationContext) {
      const prepared = await historyStage.prepare(input, preparationContext);
      if (prepared.kind !== "prepared") return prepared;
      return {
        ...prepared,
        preparation: {
          ...prepared.preparation,
          async commit() {
            assertCurrent();
            claimFinalization?.();
            await prepared.preparation.commit();
          },
        },
      };
    },
  };
  let completion: Record<string, unknown> | undefined;
  // Enter the existing admission/verification/commit path directly. Only its automatic trigger is skipped.
  await admitCompactedContext({
    messages,
    assessment,
    assess,
    assertCurrent,
    assertNotAborted: assertCurrent,
    abortSignal: context.abortSignal,
    triggerReason: "user_command",
    controller: { project: (input) => [...input], getStages: () => [stage] },
    identity: {
      requestId: context.requestId,
      invocationId: `${context.requestId}:compact`,
      modelStep,
      profileId: admission.invocation.profile.id,
      provider: admission.invocation.profile.provider,
      model: admission.invocation.model,
    },
    onEvent(name, details) {
      if (name === "context.compaction.completed") completion = details;
    },
  });
  return {
    eventName: "context.compaction.completed",
    outcome: "compacted",
    details: {
      ...completion,
      checkpointRevision: memory.project().checkpointRevision,
    },
  };
}
