import { expect, test, vi } from "vitest";
import type { RequestExecutionSeed } from "../request/contracts.js";
import {
  createRequestExecutionScope,
  type RequestCapabilityCompositionView,
  type RequestExecutionScope,
} from "../request/execution-scope.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createSupervisorSkillSelectionWindows } from "../request/supervisor-skill-selection-window.js";

const initialEntry = Object.freeze({ rootCallId: "root-call" });

test("all bindings to one entry observe the same completed selection window", () => {
  const windows = createSupervisorSkillSelectionWindows();
  const first = windows.bind(initialEntry);
  const repeated = windows.bind(initialEntry);
  expect(first.isOpen()).toBe(true);
  expect(repeated.isOpen()).toBe(true);

  first.complete();
  expect(first.isOpen()).toBe(false);
  expect(repeated.isOpen()).toBe(false);
  expect(windows.bind(initialEntry).isOpen()).toBe(false);
  repeated.complete();
  expect(windows.bind(initialEntry).isOpen()).toBe(false);
});

test("each new direct-child return has one window without reopening previous entries", () => {
  const windows = createSupervisorSkillSelectionWindows();
  windows.bind(initialEntry).complete();
  const firstReturn = { ...initialEntry, returnedResultRef: "child-result-1" };
  const first = windows.bind(firstReturn);
  expect(first.isOpen()).toBe(true);
  first.complete();
  expect(windows.bind(firstReturn).isOpen()).toBe(false);

  const secondReturn = { ...initialEntry, returnedResultRef: "child-result-2" };
  expect(windows.bind(secondReturn).isOpen()).toBe(true);
  windows.bind(secondReturn).complete();
  expect(windows.bind(initialEntry).isOpen()).toBe(false);
  expect(windows.bind(firstReturn).isOpen()).toBe(false);
  expect(windows.bind(secondReturn).isOpen()).toBe(false);
});

test("identical child result references on different root calls do not share a window", () => {
  const windows = createSupervisorSkillSelectionWindows();
  const first = windows.bind({ rootCallId: "root-a", returnedResultRef: "child-result" });
  const second = windows.bind({ rootCallId: "root-b", returnedResultRef: "child-result" });
  first.complete();
  expect(first.isOpen()).toBe(false);
  expect(second.isOpen()).toBe(true);
  expect(windows.bind({ rootCallId: "root-b" }).isOpen()).toBe(true);
});

test("fresh request scopes cannot inherit completed windows from an earlier scope", () => {
  const first = createScope().scope;
  first.supervisorSkillSelectionWindows.bind(initialEntry).complete();
  const fresh = createScope(first).scope;

  expect(fresh.supervisorSkillSelectionWindows).not.toBe(first.supervisorSkillSelectionWindows);
  expect(first.supervisorSkillSelectionWindows.bind(initialEntry).isOpen()).toBe(false);
  expect(fresh.supervisorSkillSelectionWindows.bind(initialEntry).isOpen()).toBe(true);
});

test("selection progress stays internal to the request scope and out of capability and model views", () => {
  const { scope, compositionView } = createScope();
  const key = "supervisorSkillSelectionWindows";
  scope.supervisorSkillSelectionWindows.bind(initialEntry).complete();

  expect(Object.keys(scope)).not.toContain(key);
  expect({ ...scope }).not.toHaveProperty(key);
  expect(compositionView).not.toHaveProperty(key);
  expect(scope.workerCapabilities.executionContext).not.toHaveProperty(key);
  expect(scope.modelInvocation).not.toHaveProperty(key);
  expect(Object.isFrozen(scope)).toBe(true);
});

function createScope(seed: RequestExecutionSeed = createSeed()): {
  scope: RequestExecutionScope;
  compositionView: RequestCapabilityCompositionView;
} {
  let compositionView: RequestCapabilityCompositionView | undefined;
  const scope = createRequestExecutionScope({
    seed,
    executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
    createWorkerCapabilities(view) {
      compositionView = view;
      return { getDescriptors: () => [], getAdapters: () => [] };
    },
  });
  return { scope, compositionView: compositionView! };
}

function createSeed(): RequestExecutionSeed {
  return {
    requestId: "selection-window-request",
    sessionId: "selection-window-session",
    prompt: "Answer the current request.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {} as RequestExecutionSeed["runnerConfig"],
    agentMode: "reasoning",
    modelGatewayClient: {} as RequestExecutionSeed["modelGatewayClient"],
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  };
}
