import { describe, expect, test, vi } from "vitest";

import type { RequestExecutionSeed } from "../request/contracts.js";
import {
  createRequestExecutionScope,
  isRequestExecutionScope,
  type RequestCapabilityCompositionView,
  type RequestCapabilityExecutionView,
} from "../request/execution-scope.js";
import type { WorkerCapabilityAdapterProvider } from "../orchestration/worker-capabilities/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { resolveRequestModelStepInvoker } from "../model/invoke-step.js";

describe("request execution scope", () => {
  test("projects exact capability composition and execution views", () => {
    const seed = createSeed();
    const provider = emptyProvider<RequestCapabilityExecutionView>();
    let compositionView: RequestCapabilityCompositionView | undefined;

    const scope = createRequestExecutionScope({
      seed,
      executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
      createWorkerCapabilities(view) {
        compositionView = view;
        return provider;
      },
    });

    expect(compositionView).toBeDefined();
    expect(Object.keys(compositionView!)).toEqual([
      "requestId",
      "runnerConfig",
      "agentMode",
      "modelPreference",
      "modelPolicy",
      "modelGatewayClient",
      "requestSteering",
      "abortSignal",
      "onThinkingDelta",
      "onThinkingTrace",
      "modelSteps",
      "sessionId",
      "prompt",
      "historyMessages",
      "toolPermissionMode",
      "toolApprovalController",
      "onEvent",
      "contextCompactionStore",
    ]);
    expect(compositionView).not.toHaveProperty("sessionArtifactPaths");
    expect(compositionView).not.toHaveProperty("sessionMemory");
    expect(compositionView).not.toHaveProperty("attachments");
    expect(compositionView).not.toHaveProperty("temporalContext");
    expect(compositionView).not.toHaveProperty("shouldGenerateSessionTitle");
    expect(compositionView).not.toHaveProperty("onAcknowledgement");
    expect(compositionView).not.toHaveProperty("onSessionTitle");
    expect(compositionView).not.toHaveProperty("onAnswerToken");
    expect(compositionView).not.toHaveProperty("workerCapabilityProvider");
    expect(compositionView).not.toHaveProperty("workerCapabilities");

    expect(scope.workerCapabilities.provider).toBe(provider);
    expect(scope.capabilities).toBe(scope.workerCapabilities);
    expect(scope.executionPolicy).toBe(EXECUTION_AGENT_V1_EXECUTION_POLICY);
    expect(scope.policy.executionPolicy).toBe(scope.executionPolicy);
    expect(scope.policy.selection).toBe(scope.executionPolicySelection);
    expect(compositionView?.modelSteps).toBe(scope.modelSteps);
    expect(resolveRequestModelStepInvoker(scope)).toBe(scope.modelSteps);
    const unboundLookalike = Object.freeze({
      ...scope.modelInvocation,
      modelSteps: scope.modelSteps,
    });
    expect(isRequestExecutionScope(unboundLookalike)).toBe(false);
    expect(scope.workerCapabilities.executionContext.modelSteps).toBe(
      scope.modelSteps,
    );
    expect(Object.keys(scope.workerCapabilities.executionContext)).toEqual([
      "requestId",
      "sessionId",
      "prompt",
      "temporalContext",
      "historyMessages",
      "shouldGenerateSessionTitle",
      "runnerConfig",
      "executionPolicySelection",
      "attachments",
      "agentMode",
      "modelPreference",
      "modelPolicy",
      "modelGatewayClient",
      "contextCompactionStore",
      "requestSteering",
      "toolPermissionMode",
      "toolApprovalController",
      "abortSignal",
      "onAcknowledgement",
      "onSessionTitle",
      "onThinkingDelta",
      "onThinkingTrace",
      "onAnswerToken",
      "onEvent",
      "modelSteps",
    ]);
    expect(scope.workerCapabilities.executionContext.historyMessages).toBe(
      scope.session.historyMessages,
    );
    expect(scope.workerCapabilities.executionContext.modelGatewayClient).toBe(
      scope.model.modelGatewayClient,
    );
    expect(scope.workerCapabilities.executionContext.abortSignal).toBe(
      scope.lifecycle.abortSignal,
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "sessionArtifactPaths",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "sessionMemory",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "workerCapabilityProvider",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "workerCapabilities",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "capabilities",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "identity",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "presentation",
    );
    expect(scope.workerCapabilities.executionContext).not.toHaveProperty(
      "modelInvocation",
    );
    expect(compositionView).not.toHaveProperty("identity");
    expect(compositionView).not.toHaveProperty("presentation");
    expect(compositionView).not.toHaveProperty("modelInvocation");
    expect(Object.keys(scope)).toEqual([
      "requestId",
      "sessionId",
      "prompt",
      "temporalContext",
      "historyMessages",
      "sessionArtifactPaths",
      "shouldGenerateSessionTitle",
      "runnerConfig",
      "executionPolicySelection",
      "attachments",
      "agentMode",
      "modelPreference",
      "modelPolicy",
      "modelGatewayClient",
      "contextCompactionStore",
      "requestSteering",
      "toolPermissionMode",
      "toolApprovalController",
      "abortSignal",
      "onAcknowledgement",
      "onSessionTitle",
      "onThinkingDelta",
      "onThinkingTrace",
      "onAnswerToken",
      "onEvent",
      "sessionMemory",
      "executionPolicy",
      "modelSteps",
      "workerCapabilities",
    ]);
    expect(scope.requestId).toBe(scope.identity.requestId);
    expect(scope.sessionId).toBe(scope.identity.sessionId);
    expect(scope.prompt).toBe(scope.input.prompt);
    expect(scope.historyMessages).toBe(scope.session.historyMessages);
    expect(scope.sessionMemory).toBe(seed.sessionMemory);
    expect(scope.session.sessionMemory).toBe(seed.sessionMemory);
    expect(scope.runnerConfig).toBe(scope.model.runnerConfig);
    expect(scope.requestSteering).toBe(scope.lifecycle.requestSteering);
    expect(scope.onAnswerToken).toBe(scope.presentation.onAnswerToken);
    expect(scope.modelInvocation.requestId).toBe(scope.identity.requestId);
    expect(scope.modelInvocation.runnerConfig).toBe(scope.model.runnerConfig);
    expect(scope.modelInvocation.abortSignal).toBe(scope.lifecycle.abortSignal);
    expect(scope.modelInvocation.onThinkingTrace).toBe(
      scope.presentation.onThinkingTrace,
    );
    expect(Object.isFrozen(compositionView)).toBe(true);
    expect(Object.isFrozen(scope.workerCapabilities.executionContext)).toBe(
      true,
    );
    expect(Object.isFrozen(scope.workerCapabilities)).toBe(true);
    expect(Object.isFrozen(scope.modelSteps)).toBe(true);
    expect(Object.isFrozen(scope.identity)).toBe(true);
    expect(Object.isFrozen(scope.input)).toBe(true);
    expect(Object.isFrozen(scope.session)).toBe(true);
    expect(Object.isFrozen(scope.model)).toBe(true);
    expect(Object.isFrozen(scope.lifecycle)).toBe(true);
    expect(Object.isFrozen(scope.presentation)).toBe(true);
    expect(Object.isFrozen(scope.policy)).toBe(true);
    expect(Object.isFrozen(scope.modelInvocation)).toBe(true);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  test("keeps request-owned facets, invokers, and providers isolated", () => {
    const firstProvider = emptyProvider<RequestCapabilityExecutionView>();
    const secondProvider = emptyProvider<RequestCapabilityExecutionView>();
    let firstComposition: RequestCapabilityCompositionView | undefined;
    let secondComposition: RequestCapabilityCompositionView | undefined;
    const first = createRequestExecutionScope({
      seed: createSeed("first"),
      executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
      createWorkerCapabilities(view) {
        firstComposition = view;
        return firstProvider;
      },
    });
    const second = createRequestExecutionScope({
      seed: createSeed("second"),
      executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
      createWorkerCapabilities(view) {
        secondComposition = view;
        return secondProvider;
      },
    });

    expect(first.identity).not.toBe(second.identity);
    expect(first.input).not.toBe(second.input);
    expect(first.session).not.toBe(second.session);
    expect(first.model).not.toBe(second.model);
    expect(first.lifecycle).not.toBe(second.lifecycle);
    expect(first.presentation).not.toBe(second.presentation);
    expect(first.policy).not.toBe(second.policy);
    expect(first.modelInvocation).not.toBe(second.modelInvocation);
    expect(first.modelSteps).not.toBe(second.modelSteps);
    expect(first.capabilities).not.toBe(second.capabilities);
    expect(first.capabilities.provider).toBe(firstProvider);
    expect(second.capabilities.provider).toBe(secondProvider);
    expect(firstComposition?.modelSteps).toBe(first.modelSteps);
    expect(secondComposition?.modelSteps).toBe(second.modelSteps);
    expect(first.capabilities.executionContext.modelSteps).toBe(
      first.modelSteps,
    );
    expect(second.capabilities.executionContext.modelSteps).toBe(
      second.modelSteps,
    );
    expect(first.capabilities.executionContext.historyMessages).toBe(
      first.session.historyMessages,
    );
    expect(second.capabilities.executionContext.historyMessages).toBe(
      second.session.historyMessages,
    );
    expect(first.capabilities.executionContext.historyMessages).not.toBe(
      second.capabilities.executionContext.historyMessages,
    );
    expect(resolveRequestModelStepInvoker(first)).toBe(first.modelSteps);
    expect(resolveRequestModelStepInvoker(second)).toBe(second.modelSteps);
  });

  test("does not treat an unbound structural lookalike as a request scope", () => {
    expect(isRequestExecutionScope(createSeed())).toBe(false);
  });

  test("keeps scheduled provenance on the root scope and outside capability or invocation views", () => {
    const scheduledExecution = Object.freeze({
      jobId: "scheduled-job",
      runId: "scheduled-run",
      title: "Scheduled task",
      scheduledAt: "2026-09-06T13:00:00.000Z",
      triggerType: "schedule" as const,
    });
    let composition: RequestCapabilityCompositionView | undefined;
    const scope = createRequestExecutionScope({
      seed: { ...createSeed(), scheduledExecution },
      executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
      createWorkerCapabilities(view) {
        composition = view;
        return emptyProvider<RequestCapabilityExecutionView>();
      },
    });
    expect(scope.scheduledExecution).toEqual(scheduledExecution);
    expect(scope.input.scheduledExecution).toBe(scope.scheduledExecution);
    expect(Object.isFrozen(scope.input.scheduledExecution)).toBe(true);
    for (const view of [
      composition,
      scope.capabilities.executionContext,
      scope.modelInvocation,
    ]) {
      expect(view).not.toHaveProperty("scheduledExecution");
      expect(JSON.stringify(view)).not.toContain(scheduledExecution.jobId);
    }
  });
});

function createSeed(suffix = "scope"): RequestExecutionSeed {
  return Object.freeze({
    requestId: `request-${suffix}`,
    sessionId: `session-${suffix}`,
    prompt: "Keep the exact request contract.",
    temporalContext: Object.freeze({
      currentDateTime: "2026-08-18 12:00:00 GMT−04:00",
      timeZone: "America/New_York",
    }),
    historyMessages: Object.freeze([]),
    sessionArtifactPaths: Object.freeze(["artifact.txt"]),
    shouldGenerateSessionTitle: true,
    runnerConfig: Object.freeze({}) as RequestExecutionSeed["runnerConfig"],
    executionPolicySelection: Object.freeze({
      policy: "execution-agent-v1" as const,
      source: "model_profile" as const,
      primaryProfileId: "direct-profile",
    }),
    attachments: [],
    agentMode: "reasoning",
    modelPreference: Object.freeze({
      profileId: "direct-profile",
      scope: "all" as const,
    }),
    modelPolicy: Object.freeze({}) as RequestExecutionSeed["modelPolicy"],
    modelGatewayClient: Object.freeze(
      {},
    ) as RequestExecutionSeed["modelGatewayClient"],
    contextCompactionStore: Object.freeze(
      {},
    ) as RequestExecutionSeed["contextCompactionStore"],
    sessionMemory: Object.freeze({
      project() {
        return Object.freeze({
          priorConversationMessages: Object.freeze([]),
          historyMessages: Object.freeze([]),
          compactableTurnCount: 0,
          checkpointRevision: 0,
          sourceRevision: "sha256:test",
        });
      },
      async prepare() {
        throw new Error("session_memory_compaction_not_available");
      },
    }),
    requestSteering: Object.freeze(
      {},
    ) as RequestExecutionSeed["requestSteering"],
    toolPermissionMode: "full_access",
    toolApprovalController: Object.freeze(
      {},
    ) as RequestExecutionSeed["toolApprovalController"],
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}

function emptyProvider<TContext>(): WorkerCapabilityAdapterProvider<TContext> {
  return Object.freeze({
    getDescriptors: () => Object.freeze([]),
    getAdapters: () => Object.freeze([]),
  });
}
