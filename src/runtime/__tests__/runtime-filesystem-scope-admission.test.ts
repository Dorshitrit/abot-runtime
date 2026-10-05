import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { projectRequestContext } from "../context/request-context.js";
import { estimateMessagesTokens } from "../context/token-estimator.js";
import {
  buildRuntimeFilesystemScopeMessage,
  captureRuntimeFilesystemScope,
  type RuntimeFilesystemScope,
} from "../context/runtime-filesystem-scope.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";

describe("filesystem scope binding and admission", () => {
  test("retains one exact scope and current request while reducing history and counting scope tokens", () => {
    const scope = captureRuntimeFilesystemScope(resolve("frozen-work"))!;
    const capsule = buildRuntimeFilesystemScopeMessage({
      scope,
      workingDirectory: "project",
      capabilities: [{ runtimePathControlIds: ["path"] }],
    })!;
    const historyMessages = Object.freeze(
      Array.from({ length: 20 }, (_, index) =>
        Object.freeze({
          id: String(index),
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: "Earlier content ".repeat(40),
          createdAt: "2026-10-03T00:00:00.000Z",
        }),
      ),
    );
    const originalHistory = JSON.stringify(historyMessages);
    const originalScope = JSON.stringify(scope);
    const common = {
      instructions: "Use the current bounded assignment.",
      historyMessages,
      prompt: "Write the current requested target.",
      budget: {
        contextWindowTokens: 1500,
        outputReserveTokens: 150,
        safetyReserveTokens: 150,
        attachmentReserveTokens: 0,
      },
    };
    const withoutScope = projectRequestContext(common);
    const projected = projectRequestContext({
      ...common,
      referenceMessages: [capsule],
    });

    expect(projected.omittedHistoryMessageIds.length).toBeGreaterThan(0);
    expect(projected.selectedHistoryMessageIds.length).toBeGreaterThan(0);
    expect(
      projected.messages.filter(
        (message) => message.content === capsule.content,
      ),
    ).toEqual([capsule]);
    expect(
      projected.messages.filter((message) => message.content === common.prompt),
    ).toEqual([{ role: "user", content: common.prompt }]);
    expect(projected.budget.parts.referenceInputTokens).toBe(
      estimateMessagesTokens([capsule]),
    );
    expect(projected.budget.parts.pinnedInputTokens).toBeGreaterThan(
      withoutScope.budget.parts.pinnedInputTokens,
    );
    expect(JSON.stringify(historyMessages)).toBe(originalHistory);
    expect(JSON.stringify(scope)).toBe(originalScope);
  });

  test("shares one frozen scope with provider composition without leaking it into execution or model views", () => {
    const seed: RequestExecutionSeed = Object.freeze({
      requestId: "filesystem-binding",
      sessionId: "filesystem-session",
      prompt: "Current request",
      historyMessages: Object.freeze([]),
      shouldGenerateSessionTitle: false,
      runnerConfig: Object.freeze({}) as RequestExecutionSeed["runnerConfig"],
      agentMode: "reasoning",
      modelGatewayClient: Object.freeze(
        {},
      ) as RequestExecutionSeed["modelGatewayClient"],
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    });
    const originalSeed = JSON.stringify(seed);
    const requestWorkingDirectory = resolve("bound-root");
    let passedScope: RuntimeFilesystemScope | undefined;
    const request = createRequestExecutionScope({
      seed,
      requestWorkingDirectory,
      executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
      createWorkerCapabilities(view, filesystemScope) {
        passedScope = filesystemScope;
        expect(view).not.toHaveProperty("filesystemScope");
        expect(view).not.toHaveProperty("requestWorkingDirectory");
        return Object.freeze({
          getDescriptors: () => Object.freeze([]),
          getAdapters: () => Object.freeze([]),
        });
      },
    });

    expect(passedScope).toBe(request.workerCapabilities.filesystemScope);
    expect(passedScope?.agentWorkRoot).toBe(requestWorkingDirectory);
    expect(Object.isFrozen(passedScope)).toBe(true);
    expect(request.capabilities).toBe(request.workerCapabilities);
    expect(request.workerCapabilities.executionContext).not.toHaveProperty(
      "filesystemScope",
    );
    expect(request.modelInvocation).not.toHaveProperty("filesystemScope");
    expect(request).not.toHaveProperty("requestWorkingDirectory");
    expect(JSON.stringify(seed)).toBe(originalSeed);
  });
});
