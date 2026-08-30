import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createRoleCallLedger,
  composeRoleCallPlanChildObjective,
  projectRoleCallDependencyResults,
  projectRoleChildReturnContext,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerCommand,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
  type RoleExecutorInput,
} from "../orchestration/role-executors/index.js";

type TestContext = Readonly<{ marker: string }>;
type TestValue = Readonly<{ artifactRef: string }>;

const WORKER_OBJECTIVE = "Create the requested artifact.";

function testExactCapabilityResult(
  input: Readonly<{
    outcome: "succeeded" | "failed";
    observedEffect: "none" | "observation" | "mutation" | "indeterminate";
    summary: string;
  }>,
) {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: input.outcome === "succeeded",
    payload: Object.freeze({ ...input }),
  });
}

async function openWorkerLedger(
  requestId = "request-1",
  objective = WORKER_OBJECTIVE,
): Promise<Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  const opened = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective,
  });
  const call = opened.state.calls.find(
    (candidate) => candidate.callId === opened.state.activeCallId,
  );
  if (!call) throw new Error("Worker call was not created");
  return Object.freeze({ ledger, call });
}

async function openPlannerLedger(
  requestId = "planner-request",
  objective = "Coordinate the requested artifact.",
  limits: Readonly<{
    maxDepth?: number;
    maxCalls?: number;
    maxCapabilityExecutions?: number;
    workingDirectory?: string;
  }> = {},
): Promise<Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: limits.maxDepth ?? 4,
        maxCalls: limits.maxCalls ?? 8,
        maxCapabilityExecutions: limits.maxCapabilityExecutions ?? 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  const opened = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective,
    ...(limits.workingDirectory !== undefined
      ? { workingDirectory: limits.workingDirectory }
      : {}),
  });
  const call = opened.state.calls.find(
    (candidate) => candidate.callId === opened.state.activeCallId,
  );
  if (!call) throw new Error("Planner call was not created");
  return Object.freeze({ ledger, call });
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) {
    throw new Error(`role call commit rejected: ${result.code}`);
  }
  return result.head;
}

async function settleObservationCapability(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
): Promise<string> {
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "Observe one bounded value.",
      controlsJson: "{}",
    },
  });
  if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
    throw new Error("capability begin failed");
  }
  const executionId = begun.effect.executionId;
  const settled = await ledger.apply({
    expectedHead: begun.head,
    command: {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
      exactResult: testExactCapabilityResult({
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observed.",
      }),
    },
  });
  if (!settled.ok || settled.effect.type !== "capability_execution_settled") {
    throw new Error("capability settle failed");
  }
  return executionId;
}

async function settleObservationCapabilityBatch(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
): Promise<readonly string[]> {
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "begin_capability_batch",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      entries: [
        {
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Observe the first bounded value.",
          controlsJson: "{}",
        },
        {
          capabilityId: "example.observe",
          declaredEffect: "observation",
          intent: "Observe the second bounded value.",
          controlsJson: "{}",
        },
      ],
    },
  });
  if (!begun.ok || begun.effect.type !== "capability_batch_begun") {
    throw new Error("capability batch begin failed");
  }
  const executionIds = begun.effect.executionIds;
  const settled = await ledger.apply({
    expectedHead: begun.head,
    command: {
      authority: "runtime",
      type: "settle_capability_batch",
      callId: call.callId,
      settlements: executionIds.map((executionId, index) => {
        const summary = `Observed source ${index + 1}.`;
        return {
          executionId,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary,
          exactResult: testExactCapabilityResult({
            outcome: "succeeded",
            observedEffect: "observation",
            summary,
          }),
        };
      }),
    },
  });
  if (!settled.ok || settled.effect.type !== "capability_batch_settled") {
    throw new Error("capability batch settle failed");
  }
  return executionIds;
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("mechanical role executor registry", () => {
  test("executes the exact registered role and returns its bounded result", async () => {
    const { ledger, call } = await openWorkerLedger();
    const executeWorker = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "completed" as const,
      summary: "  Artifact created.  ",
      value: { artifactRef: "artifact-1" },
    }));
    const executeResearcher = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "completed" as const,
      summary: "Research complete.",
      value: { artifactRef: "research-1" },
    }));
    const registry = createRoleExecutorRegistry<TestContext, TestValue>([
      { roleId: "worker", execute: executeWorker },
      { roleId: "researcher", execute: executeResearcher },
    ]);

    await expect(
      registry.execute({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Artifact created.",
      value: { artifactRef: "artifact-1" },
    });

    expect(registry.roleIds).toEqual(["worker", "researcher"]);
    expect(executeWorker).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "context-1" },
      call,
      ledger,
      availableChildRoleIds: ["researcher"],
    });
    expect(executeResearcher).not.toHaveBeenCalled();
  });

  test("executes one exact registered child for an active Supervisor caller", async () => {
    const requestId = "request-root-child";
    const ledger = createRoleCallLedger({
      requestId,
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const expectedHead = ledger.current();
    const callerCall = expectedHead.state.calls.find(
      (candidate) => candidate.callId === expectedHead.state.rootCallId,
    );
    if (!callerCall) throw new Error("Supervisor root was not created");
    const executeWorker = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "completed" as const,
      summary: "Exact child result.",
      value: { artifactRef: "artifact-root-child" },
    }));
    const registry = createRoleExecutorRegistry<TestContext, TestValue>([
      { roleId: "worker", execute: executeWorker },
    ]);

    const child = await registry.invokeChild({
      requestId,
      context: { marker: "root-context" },
      callerCall,
      ledger,
      expectedHead,
      roleId: "worker",
      objective: WORKER_OBJECTIVE,
      turnCount: 1,
    });

    expect(Object.keys(child).sort()).toEqual(["execution", "returnCommit"]);
    expect(Object.isFrozen(child)).toBe(true);
    expect(child.execution).toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Exact child result.",
      value: { artifactRef: "artifact-root-child" },
    });
    expect(child.returnCommit.effect).toEqual({
      type: "child_returned",
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-1",
    });
    expect(child.returnCommit.head).toBe(ledger.current());
    expect(ledger.current().state.activeCallId).toBe("call-1");
    expect(
      ledger
        .current()
        .state.calls.find((candidate) => candidate.callId === "call-1"),
    ).toMatchObject({
      roleId: "supervisor",
      status: "active",
      activationCount: 2,
      childCallIds: ["call-2"],
    });
    expect(
      ledger
        .current()
        .state.calls.find((candidate) => candidate.callId === "call-2"),
    ).toMatchObject({
      parentCallId: "call-1",
      roleId: "worker",
      status: "completed",
      resultRef: "result-1",
    });
    expect(
      projectRoleChildReturnContext(ledger, child.returnCommit),
    ).toMatchObject({
      callerCallId: "call-1",
      invocationAttempt: 2,
      returnedChildCallId: "call-2",
      returnedResultRef: "result-1",
      completedChildren: [
        {
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-1",
          roleId: "worker",
          objective: WORKER_OBJECTIVE,
          outcome: "completed",
          summary: "Exact child result.",
        },
      ],
    });
    expect(executeWorker).toHaveBeenCalledExactlyOnceWith({
      context: { marker: "root-context" },
      call: expect.objectContaining({
        callId: "call-2",
        parentCallId: "call-1",
        roleId: "worker",
        depth: 1,
        activationCount: 1,
      }),
      ledger,
      availableChildRoleIds: [],
    });
  });

  test("automatically supplies every prior direct-sibling result in caller order", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const requestId = "request-automatic-sibling-results";
    const ledger = createRoleCallLedger({
      requestId,
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    await commit(ledger, { authority: "runtime", type: "create_root" });

    const executeWorker = vi.fn<RoleExecutor<TestContext>["execute"]>(
      async () => ({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "First sibling completed.",
      }),
    );
    const executeReviewer = vi.fn<RoleExecutor<TestContext>["execute"]>(
      async () => ({
        kind: "terminal" as const,
        outcome: "failed" as const,
        summary: "Second sibling reported a gap.",
      }),
    );
    const executePlanner = vi.fn<RoleExecutor<TestContext>["execute"]>(
      async () => ({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "Third sibling consumed prior results.",
      }),
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "worker", execute: executeWorker },
      { roleId: "reviewer", execute: executeReviewer },
      { roleId: "planner", execute: executePlanner },
    ]);

    async function invoke(
      roleId: "worker" | "reviewer" | "planner",
      objective: string,
    ): Promise<void> {
      const expectedHead = ledger.current();
      const callerCall = expectedHead.state.calls.find(
        (candidate) => candidate.callId === expectedHead.state.rootCallId,
      );
      if (!callerCall) throw new Error("Supervisor root was not created");
      await registry.invokeChild({
        requestId,
        context: { marker: "automatic-sibling-context" },
        callerCall,
        ledger,
        expectedHead,
        roleId,
        objective,
        turnCount: callerCall.activationCount,
      });
    }

    await invoke("worker", "Produce the first bounded result.");
    await invoke("reviewer", "Audit the first bounded result.");
    await invoke("planner", "Synthesize the bounded sibling results.");

    expect(executeWorker.mock.calls[0]![0].call.dependencyResultRefs).toEqual(
      [],
    );
    expect(executeReviewer.mock.calls[0]![0].call.dependencyResultRefs).toEqual(
      ["result-1"],
    );
    expect(executePlanner.mock.calls[0]![0].call.dependencyResultRefs).toEqual([
      "result-1",
      "result-2",
    ]);

    const requested = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.scope === "runtime.role_executors" &&
          entry.event === "child.requested",
      );
    expect(requested).toEqual([
      expect.objectContaining({
        childRoleId: "worker",
        dependencyResolution: "all_prior_direct_siblings_v1",
        inheritedSiblingResultCount: 0,
        inheritedSiblingResultRefs: [],
        dependencyResultCount: 0,
        dependencyResultRefs: [],
      }),
      expect.objectContaining({
        childRoleId: "reviewer",
        inheritedSiblingResultCount: 1,
        inheritedSiblingResultRefs: ["result-1"],
        dependencyResultCount: 1,
        dependencyResultRefs: ["result-1"],
      }),
      expect.objectContaining({
        childRoleId: "planner",
        inheritedSiblingResultCount: 2,
        inheritedSiblingResultRefs: ["result-1", "result-2"],
        dependencyResultCount: 2,
        dependencyResultRefs: ["result-1", "result-2"],
      }),
    ]);
  });

  test("does not leak cousin results or parent dependencies into descendants", async () => {
    const requestId = "request-sibling-scope-isolation";
    const ledger = createRoleCallLedger({
      requestId,
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate one nested bounded result.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Produce the nested bounded result.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Coordinate one nested bounded result.",
          items: [
            {
              title: "Produce nested result",
              objective: "Produce the nested bounded result.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: "Nested worker result.",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "Planner aggregate result.",
    });

    const executeReviewer = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.call.dependencyResultRefs).toEqual([]);
        expect(
          projectRoleCallDependencyResults(ledger.current(), input.call),
        ).toEqual([]);
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Descendant review completed.",
        };
      },
    );
    const executeWorker = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.call.dependencyResultRefs).toEqual(["result-2"]);
        expect(
          projectRoleCallDependencyResults(ledger.current(), input.call),
        ).toEqual([
          {
            resultRef: "result-2",
            producerCallId: "call-2",
            roleId: "planner",
            outcome: "completed",
            summary: "Planner aggregate result.",
          },
        ]);
        if (input.call.activationCount === 1) {
          return {
            kind: "invoke_role" as const,
            roleId: "reviewer" as const,
            objective: "Review only this Worker's bounded outcome.",
          };
        }
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Root Worker completed without context leakage.",
        };
      },
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "worker", execute: executeWorker },
      { roleId: "reviewer", execute: executeReviewer },
    ]);
    const expectedHead = ledger.current();
    const callerCall = expectedHead.state.calls.find(
      (candidate) => candidate.callId === expectedHead.state.rootCallId,
    );
    if (!callerCall) throw new Error("Supervisor root was not resumed");

    await expect(
      registry.invokeChild({
        requestId,
        context: { marker: "scope-isolation-context" },
        callerCall,
        ledger,
        expectedHead,
        roleId: "worker",
        objective: "Consume the Planner aggregate and complete bounded work.",
        turnCount: callerCall.activationCount,
      }),
    ).resolves.toMatchObject({
      execution: {
        outcome: "completed",
        summary: "Root Worker completed without context leakage.",
      },
    });
    expect(executeWorker).toHaveBeenCalledTimes(2);
    expect(executeReviewer).toHaveBeenCalledOnce();
  });

  test("rejects a stale root child request before invoking its executor", async () => {
    const requestId = "request-stale-root-child";
    const ledger = createRoleCallLedger({
      requestId,
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const expectedHead = ledger.current();
    const callerCall = expectedHead.state.calls.find(
      (candidate) => candidate.callId === expectedHead.state.rootCallId,
    );
    if (!callerCall) throw new Error("Supervisor root was not created");
    await commit(ledger, {
      authority: "supervisor",
      type: "complete_root_response",
      callId: callerCall.callId,
      response: "Committed elsewhere.",
    });
    const currentHead = ledger.current();
    const executeWorker = vi.fn();
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: executeWorker,
      } as RoleExecutor<TestContext>,
    ]);

    await expect(
      registry.invokeChild({
        requestId,
        context: { marker: "root-context" },
        callerCall,
        ledger,
        expectedHead,
        roleId: "worker",
        objective: WORKER_OBJECTIVE,
        turnCount: 1,
      }),
    ).rejects.toThrow(
      "role_executor_child_invocation_invalid:supervisor:child_request_state_changed",
    );
    expect(executeWorker).not.toHaveBeenCalled();
    expect(ledger.current()).toBe(currentHead);
  });

  test("rejects an unregistered role without selecting another executor", async () => {
    const { ledger, call } = await openWorkerLedger();
    const execute = vi.fn();
    const registry = createRoleExecutorRegistry<TestContext, TestValue>([
      {
        roleId: "worker",
        execute,
      } as RoleExecutor<TestContext, TestValue>,
    ]);

    await expect(
      registry.execute({
        requestId: "request-1",
        context: { marker: "context-1" },
        call: { ...call, roleId: "reviewer" },
        ledger,
      }),
    ).rejects.toThrow("role_executor_not_registered");
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects untrusted dispatch identity without logging or returning it", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger();
    const secretRole = `role-${"SECRET".repeat(80)}`;
    const secretRequest = `request-${"SECRET".repeat(80)}`;
    const secretCall = `call-${"SECRET".repeat(80)}`;
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(),
      } as RoleExecutor<TestContext>,
    ]);

    await expect(
      registry.execute({
        requestId: secretRequest,
        context: { marker: "context-1" },
        call: {
          ...call,
          callId: secretCall,
          roleId: secretRole,
        } as unknown as RoleCallFrame,
        ledger,
      }),
    ).rejects.toThrow(/^role_executor_not_registered$/);

    const serializedLogs = JSON.stringify(
      consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      ),
    );
    expect(serializedLogs).not.toContain("SECRET");
    expect(serializedLogs).toContain('"roleIdRecognized":false');
    expect(serializedLogs).toContain('"requestIdLength":257');
    expect(serializedLogs).toContain('"callIdLength":257');
  });

  test("rejects duplicate registrations and malformed executor results", async () => {
    const executor: RoleExecutor<TestContext, TestValue> = {
      roleId: "worker",
      execute: vi.fn(async () => ({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "Done.",
      })),
    };
    expect(() => createRoleExecutorRegistry([executor, executor])).toThrow(
      "duplicate_role_executor",
    );

    const { ledger, call } = await openWorkerLedger();
    const invalid = createRoleExecutorRegistry<TestContext, TestValue>([
      {
        roleId: "worker",
        execute: vi.fn(async () => ({
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "   ",
        })),
      },
    ]);
    await expect(
      invalid.execute({
        requestId: "request-1",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow("role_executor_result_invalid:worker:summary_invalid");
  });

  test("rejects a Worker capability scope on a non-Worker child result", async () => {
    const requestId = "request-non-worker-capability-scope";
    const { ledger, call } = await openPlannerLedger(requestId);
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "planner",
        execute: vi.fn(async () => ({
          kind: "invoke_role" as const,
          roleId: "researcher" as const,
          objective: "Analyze the bounded context.",
          workerCapabilityScope: { catalogGroupIds: ["read"] },
        })),
      },
      {
        roleId: "researcher",
        execute: vi.fn(async () => ({
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Analyzed.",
        })),
      },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_result_invalid:planner:child_invocation_shape_invalid",
    );
    expect(ledger.current().state.calls).toHaveLength(2);
    expect(ledger.current().state.activeCallId).toBe("call-2");
  });

  test("rejects an invalid or unsupported-role working directory before opening a child", async () => {
    const invocations = [
      {
        kind: "invoke_role" as const,
        roleId: "researcher" as const,
        objective: "Analyze the bounded context.",
        workingDirectory: "project/site",
      },
      {
        kind: "invoke_role" as const,
        roleId: "reviewer" as const,
        objective: "Review the bounded context.",
        workingDirectory: "project/site",
      },
      {
        kind: "invoke_role" as const,
        roleId: "worker" as const,
        objective: "Produce the bounded artifact.",
        workingDirectory: "project/../other",
      },
    ];

    for (const invocation of invocations) {
      const requestId = `request-invalid-working-directory-${invocation.roleId}`;
      const { ledger, call } = await openPlannerLedger(requestId);
      const registry = createRoleExecutorRegistry<TestContext>([
        {
          roleId: "planner",
          execute: vi.fn(async () => invocation),
        },
        {
          roleId: invocation.roleId,
          execute: vi.fn(async () => ({
            kind: "terminal" as const,
            outcome: "completed" as const,
            summary: "Completed.",
          })),
        },
      ]);

      await expect(
        registry.execute({
          requestId,
          context: { marker: "context-1" },
          call,
          ledger,
        }),
      ).rejects.toThrow(
        "role_executor_result_invalid:planner:child_invocation_shape_invalid",
      );
      expect(ledger.current().state.calls).toHaveLength(2);
      expect(ledger.current().state.activeCallId).toBe("call-2");
    }
  });

  test("continues the exact same role after one canonical capability settlement", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger("request-continuation");
    const execute = vi.fn(async (input: RoleExecutorInput<TestContext>) => {
      if (input.call.activationCount === 1) {
        expect(input.continuation).toBeUndefined();
        const executionId = await settleObservationCapability(
          ledger,
          input.call,
        );
        return {
          kind: "continue" as const,
          continuation: {
            kind: "capability_execution" as const,
            executionId,
          },
        };
      }
      expect(input.continuation).toEqual({
        kind: "capability_execution",
        executionId: "capability-execution-1",
      });
      expect(Object.isFrozen(input.continuation)).toBe(true);
      return {
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "Observation consumed.",
      };
    });
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "worker", execute },
    ]);

    await expect(
      registry.execute({
        requestId: "request-continuation",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Observation consumed.",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.map(([input]) => ({
        callId: input.call.callId,
        activationCount: input.call.activationCount,
        continuation: input.continuation,
      })),
    ).toEqual([
      {
        callId: call.callId,
        activationCount: 1,
        continuation: undefined,
      },
      {
        callId: call.callId,
        activationCount: 2,
        continuation: {
          kind: "capability_execution",
          executionId: "capability-execution-1",
        },
      },
    ]);
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        callId: call.callId,
        invocationAttempt: 1,
        status: "settled",
      }),
    ]);

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.continued",
          requestId: "request-continuation",
          callId: call.callId,
          executionId: "capability-execution-1",
          fromActivation: 1,
          toActivation: 2,
          turnCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.completed",
          activationCount: 2,
          turnCount: 2,
        }),
      ]),
    );
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(
      "Produce the bounded artifact and report observable evidence.",
    );
    expect(serializedLogs).not.toContain(
      "Worker produced the artifact with evidence.",
    );
    expect(serializedLogs).not.toContain(
      "Planner coordinated the completed artifact.",
    );
  });

  test("continues the exact same role once after one canonical observation batch", async () => {
    const { ledger, call } = await openWorkerLedger(
      "request-batch-continuation",
    );
    const execute = vi.fn(async (input: RoleExecutorInput<TestContext>) => {
      if (input.call.activationCount === 1) {
        const executionIds = await settleObservationCapabilityBatch(
          ledger,
          input.call,
        );
        return {
          kind: "continue" as const,
          continuation: {
            kind: "capability_batch_execution" as const,
            executionIds,
          },
        };
      }
      expect(input.call.activationCount).toBe(2);
      expect(input.continuation).toEqual({
        kind: "capability_batch_execution",
        executionIds: ["capability-execution-1", "capability-execution-2"],
      });
      const continuation = input.continuation;
      if (continuation?.kind !== "capability_batch_execution") {
        throw new Error("Expected capability batch continuation");
      }
      expect(Object.isFrozen(continuation)).toBe(true);
      expect(Object.isFrozen(continuation.executionIds)).toBe(true);
      return {
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "Both observations consumed.",
      };
    });
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "worker", execute },
    ]);

    await expect(
      registry.execute({
        requestId: "request-batch-continuation",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Both observations consumed.",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        invocationAttempt: 1,
        status: "settled",
      }),
      expect.objectContaining({
        executionId: "capability-execution-2",
        invocationAttempt: 1,
        status: "settled",
      }),
    ]);
  });

  test("mechanically executes one exact child and resumes its exact caller", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const requestId = "request-role-child";
    const { ledger, call } = await openPlannerLedger(requestId);
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.availableChildRoleIds).toEqual(["worker"]);
        expect(Object.isFrozen(input.availableChildRoleIds)).toBe(true);
        if (input.call.activationCount === 1) {
          expect(input.continuation).toBeUndefined();
          return {
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective:
              "Produce the bounded artifact and report observable evidence.",
            workerCapabilityScope: {
              catalogGroupIds: ["write", "exec"],
            },
            workingDirectory: " ./project\\site//. ",
            plannerPlan: {
              mode: "declare" as const,
              plan: {
                summary: "Coordinate the completed artifact.",
                items: [
                  {
                    title: "Produce bounded artifact",
                    objective:
                      "Produce the bounded artifact and report observable evidence.",
                  },
                ],
              },
              selectedItemIndexes: [0],
            },
          };
        }
        expect(input.call.callId).toBe(call.callId);
        expect(input.call.activationCount).toBe(2);
        expect(input.continuation?.kind).toBe("role_child");
        if (input.continuation?.kind !== "role_child") {
          throw new Error("expected role_child continuation");
        }
        expect(Object.isFrozen(input.continuation)).toBe(true);
        expect(Object.isFrozen(input.continuation.commit)).toBe(true);
        expect(input.continuation.commit.effect).toEqual({
          type: "child_returned",
          callerCallId: "call-2",
          childCallId: "call-3",
          resultRef: "result-1",
          planItemIds: ["plan-call-2-item-1"],
        });
        expect(
          projectRoleChildReturnContext(ledger, input.continuation.commit)
            .completedChildren[0],
        ).toMatchObject({
          childCallId: "call-3",
          roleId: "worker",
          workingDirectory: "project/site",
        });
        expect(ledger.current()).toBe(input.continuation.commit.head);
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Planner coordinated the completed artifact.",
        };
      },
    );
    const executeWorker = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.availableChildRoleIds).toEqual(["planner"]);
        expect(Object.isFrozen(input.availableChildRoleIds)).toBe(true);
        expect(input.call).toMatchObject({
          callId: "call-3",
          parentCallId: "call-2",
          roleId: "worker",
          depth: 2,
          activationCount: 1,
          workerCapabilityScope: {
            catalogGroupIds: ["write", "exec"],
          },
          workingDirectory: "project/site",
        });
        expect(Object.isFrozen(input.call.workerCapabilityScope)).toBe(true);
        expect(
          Object.isFrozen(input.call.workerCapabilityScope?.catalogGroupIds),
        ).toBe(true);
        expect(input.continuation).toBeUndefined();
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Worker produced the artifact with evidence.",
        };
      },
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
      { roleId: "worker", execute: executeWorker },
    ]);

    const plannerResult = await registry.execute({
      requestId,
      context: { marker: "context-role-child" },
      call,
      ledger,
    });

    expect(plannerResult).toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Planner coordinated the completed artifact.",
    });
    expect(executePlanner).toHaveBeenCalledTimes(2);
    expect(executeWorker).toHaveBeenCalledOnce();
    expect(ledger.current().state.activeCallId).toBe("call-2");
    expect(
      ledger
        .current()
        .state.calls.find((candidate) => candidate.callId === "call-3"),
    ).toMatchObject({
      parentCallId: "call-2",
      status: "completed",
      resultRef: "result-1",
    });

    const returnedPlanner = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: plannerResult.outcome,
        summary: plannerResult.summary,
      },
    });
    expect(returnedPlanner).toMatchObject({
      ok: true,
      effect: {
        type: "child_returned",
        callerCallId: "call-1",
        childCallId: "call-2",
        resultRef: "result-2",
      },
    });
    expect(ledger.current().state.activeCallId).toBe("call-1");

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "child.requested",
          callId: "call-2",
          childRoleId: "worker",
          childObjectiveLength: 60,
          workerCapabilityCatalogGroupIds: ["write", "exec"],
          workerCapabilityCatalogGroupCount: 2,
          workingDirectoryIncluded: true,
          workingDirectoryLength: 12,
          fromActivation: 1,
          turnCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "child.started",
          callId: "call-2",
          childCallId: "call-3",
          childRoleId: "worker",
          childDepth: 2,
          workerCapabilityCatalogGroupIds: ["write", "exec"],
          workerCapabilityCatalogGroupCount: 2,
          workingDirectoryIncluded: true,
          workingDirectoryLength: 12,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "child.completed",
          callId: "call-2",
          childCallId: "call-3",
          outcome: "completed",
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.continued",
          continuationKind: "role_child",
          callId: "call-2",
          childCallId: "call-3",
          resultRef: "result-1",
          fromActivation: 1,
          toActivation: 2,
          turnCount: 1,
        }),
      ]),
    );
  });

  test("canonically opens and resumes one working-directory-scoped Planner child", async () => {
    const requestId = "request-working-directory-planner-child";
    const ledger = createRoleCallLedger({
      requestId,
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    const rooted = await commit(ledger, {
      authority: "runtime",
      type: "create_root",
    });
    const rootCall = rooted.state.calls[0]!;
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.call).toMatchObject({
          callId: "call-2",
          parentCallId: "call-1",
          roleId: "planner",
          workingDirectory: "project/site",
          activationCount: 1,
        });
        expect(Object.isFrozen(input.call)).toBe(true);
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Planner completed the bounded coordination.",
        };
      },
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
    ]);

    const result = await registry.invokeChild({
      requestId,
      context: { marker: "planner-working-directory" },
      callerCall: rootCall,
      ledger,
      expectedHead: rooted,
      roleId: "planner",
      objective: "Coordinate the bounded project outcome.",
      workingDirectory: " ./project\\site//. ",
      turnCount: 1,
    });

    expect(result.execution).toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Planner completed the bounded coordination.",
    });
    expect(executePlanner).toHaveBeenCalledOnce();
    expect(result.returnCommit.head.state.calls[1]).toMatchObject({
      roleId: "planner",
      workingDirectory: "project/site",
      status: "completed",
      resultRef: "result-1",
    });
    expect(result.returnCommit.head.state.calls[0]).toMatchObject({
      roleId: "supervisor",
      status: "active",
      activationCount: 2,
    });
  });

  test("continues sequential child calls independently of capability limits", async () => {
    const requestId = "request-sequential-children";
    const { ledger, call } = await openPlannerLedger(
      requestId,
      "Coordinate two independent bounded findings.",
      { maxCapabilityExecutions: 1 },
    );
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        if (input.call.activationCount === 1) {
          return {
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective: "Produce the first bounded finding.",
            plannerPlan: {
              mode: "declare" as const,
              plan: {
                summary: "Coordinate two independent bounded findings.",
                items: [
                  {
                    title: "Produce first finding",
                    objective: "Produce the first bounded finding.",
                  },
                  {
                    title: "Produce second finding",
                    objective:
                      "Produce the second independent bounded finding.",
                  },
                ],
              },
              selectedItemIndexes: [0],
            },
          };
        }
        if (input.continuation?.kind !== "role_child") {
          throw new Error("expected exact child return");
        }
        const resume = projectRoleChildReturnContext(
          ledger,
          input.continuation.commit,
        );
        if (input.call.activationCount === 2) {
          expect(resume.completedChildren).toHaveLength(1);
          expect(resume.completedChildren[0]).toMatchObject({
            childCallId: "call-3",
            roleId: "worker",
            outcome: "completed",
            summary: "First finding complete.",
          });
          return {
            kind: "invoke_role" as const,
            roleId: "reviewer" as const,
            objective: "Produce the second independent bounded finding.",
            plannerPlan: {
              mode: "select" as const,
              itemIds: ["plan-call-2-item-2"],
            },
          };
        }
        expect(input.call.activationCount).toBe(3);
        expect(resume.completedChildren).toEqual([
          expect.objectContaining({
            childCallId: "call-3",
            resultRef: "result-1",
            roleId: "worker",
          }),
          expect.objectContaining({
            childCallId: "call-4",
            resultRef: "result-2",
            roleId: "reviewer",
          }),
        ]);
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Both independent findings were coordinated.",
        };
      },
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
      {
        roleId: "worker",
        execute: vi.fn(async () => ({
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "First finding complete.",
        })),
      },
      {
        roleId: "reviewer",
        execute: vi.fn(async () => ({
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "Second finding complete.",
        })),
      },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-sequential" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Both independent findings were coordinated.",
    });
    expect(executePlanner).toHaveBeenCalledTimes(3);
    expect(ledger.current().state.calls).toHaveLength(4);
    expect(ledger.current().state.results).toHaveLength(2);
    expect(ledger.current().state.capabilityExecutions).toHaveLength(0);
  });

  test("binds several plan items before one child and settles them together", async () => {
    const requestId = "request-planner-multi-binding";
    const { ledger, call } = await openPlannerLedger(
      requestId,
      "Coordinate three requested outcomes.",
    );
    const firstItems = [
      {
        title: "Establish first outcome",
        objective: "Establish the first requested outcome.",
      },
      {
        title: "Establish second outcome",
        objective: "Establish the second requested outcome.",
      },
    ];
    const firstObjective = composeRoleCallPlanChildObjective(
      firstItems,
      ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    )!;
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        if (input.call.activationCount === 1) {
          return {
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective: firstObjective,
            plannerPlan: {
              mode: "declare" as const,
              plan: {
                summary: "Coordinate three requested outcomes.",
                items: [
                  ...firstItems,
                  {
                    title: "Establish third outcome",
                    objective: "Establish the third requested outcome.",
                  },
                ],
              },
              selectedItemIndexes: [0, 1],
            },
          };
        }
        if (input.call.activationCount === 2) {
          expect(input.continuation?.kind).toBe("role_child");
          if (input.continuation?.kind !== "role_child") {
            throw new Error("expected Planner child continuation");
          }
          expect(input.continuation.commit.effect).toEqual({
            type: "child_returned",
            callerCallId: "call-2",
            childCallId: "call-3",
            resultRef: "result-1",
            planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
          });
          expect(input.continuation.commit.head).toBe(input.ledger.current());
          expect(input.call).toMatchObject({
            callId: "call-2",
            roleId: "planner",
            status: "active",
            activationCount: 2,
          });
          expect(input.ledger.current().state.calls).toHaveLength(3);
          expect(input.ledger.current().state.results).toHaveLength(1);
          expect(
            input.ledger
              .current()
              .state.plans[0]?.itemStates.map((item) =>
                Object.freeze({ itemId: item.itemId, status: item.status }),
              ),
          ).toEqual([
            { itemId: "plan-call-2-item-1", status: "done" },
            { itemId: "plan-call-2-item-2", status: "done" },
            { itemId: "plan-call-2-item-3", status: "pending" },
          ]);
          return {
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective: "Establish the third requested outcome.",
            plannerPlan: {
              mode: "select" as const,
              itemIds: ["plan-call-2-item-3"],
            },
          };
        }
        return {
          kind: "terminal" as const,
          outcome: "completed" as const,
          summary: "All three requested outcomes were coordinated.",
        };
      },
    );
    const executeWorker = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => ({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary:
          input.call.callId === "call-3"
            ? "The first worker established both bound outcomes."
            : "The second worker established the third outcome.",
      }),
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
      { roleId: "worker", execute: executeWorker },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-planner-completion-subset" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "All three requested outcomes were coordinated.",
    });
    expect(executePlanner).toHaveBeenCalledTimes(3);
    expect(executeWorker).toHaveBeenCalledTimes(2);
    expect(ledger.current().state.plans[0]?.itemStates).toEqual([
      {
        itemId: "plan-call-2-item-1",
        status: "done",
        childCallId: "call-3",
      },
      {
        itemId: "plan-call-2-item-2",
        status: "done",
        childCallId: "call-3",
      },
      {
        itemId: "plan-call-2-item-3",
        status: "done",
        childCallId: "call-4",
      },
    ]);
  });

  test("returns a failed child only to its caller without fallback or retry", async () => {
    const requestId = "request-failed-child";
    const { ledger, call } = await openPlannerLedger(requestId);
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        if (input.call.activationCount === 1) {
          return {
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective: "Attempt the bounded unavailable observation.",
            plannerPlan: {
              mode: "declare" as const,
              plan: {
                summary: "Attempt the bounded unavailable observation.",
                items: [
                  {
                    title: "Attempt bounded observation",
                    objective: "Attempt the bounded unavailable observation.",
                  },
                ],
              },
              selectedItemIndexes: [0],
            },
          };
        }
        if (input.continuation?.kind !== "role_child") {
          throw new Error("expected failed role child");
        }
        const resume = projectRoleChildReturnContext(
          ledger,
          input.continuation.commit,
        );
        expect(resume.completedChildren).toEqual([
          expect.objectContaining({
            roleId: "worker",
            outcome: "failed",
            summary: "Required observation is unavailable.",
          }),
        ]);
        return {
          kind: "terminal" as const,
          outcome: "failed" as const,
          summary: "Planner could not establish the requested result.",
        };
      },
    );
    const executeWorker = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "failed" as const,
      summary: "Required observation is unavailable.",
    }));
    const executeReviewer = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "completed" as const,
      summary: "Automatic fallback must not run.",
    }));
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
      { roleId: "worker", execute: executeWorker },
      { roleId: "reviewer", execute: executeReviewer },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-failed-child" },
        call,
        ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      summary: "Planner could not establish the requested result.",
    });
    expect(executePlanner).toHaveBeenCalledTimes(2);
    expect(executeWorker).toHaveBeenCalledOnce();
    expect(executeReviewer).not.toHaveBeenCalled();
  });

  test("rejects a same-role child before opening another call frame", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const requestId = "request-repeated-planner";
    const { ledger, call } = await openPlannerLedger(requestId);
    const executePlanner = vi.fn(
      async (input: RoleExecutorInput<TestContext>) => {
        expect(input.availableChildRoleIds).toEqual([]);
        expect(Object.isFrozen(input.availableChildRoleIds)).toBe(true);
        return {
          kind: "invoke_role" as const,
          roleId: "planner" as const,
          objective: "Coordinate one independently bounded sub-outcome.",
        };
      },
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "planner", execute: executePlanner },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-repeated-planner" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_child_invocation_invalid:planner:child_role_matches_caller",
    );
    expect(executePlanner).toHaveBeenCalledOnce();
    expect(
      ledger.current().state.calls.map(({ roleId, depth }) => ({
        roleId,
        depth,
      })),
    ).toEqual([
      { roleId: "supervisor", depth: 0 },
      { roleId: "planner", depth: 1 },
    ]);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.started",
          roleId: "planner",
          registeredRoleIds: ["planner"],
          availableChildRoleIds: [],
          turnCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "child.rejected",
          roleId: "planner",
          childRoleId: "planner",
          issueCode: "child_role_matches_caller",
        }),
      ]),
    );
  });

  test.each([
    {
      requestId: "request-depth-limit",
      limits: { maxDepth: 1 },
      issueCode: "depth_limit_exceeded",
    },
    {
      requestId: "request-call-limit",
      limits: { maxCalls: 2 },
      issueCode: "call_limit_exceeded",
    },
  ] as const)(
    "preserves the caller when a child is rejected by $issueCode",
    async ({ requestId, limits, issueCode }) => {
      const { ledger, call } = await openPlannerLedger(
        requestId,
        "Coordinate one bounded child.",
        limits,
      );
      const before = ledger.current();
      const executeWorker = vi.fn();
      const registry = createRoleExecutorRegistry<TestContext>([
        {
          roleId: "planner",
          execute: vi.fn(async () => ({
            kind: "invoke_role" as const,
            roleId: "worker" as const,
            objective: "Produce one bounded child result.",
          })),
        },
        {
          roleId: "worker",
          execute: executeWorker,
        } as RoleExecutor<TestContext>,
      ]);

      await expect(
        registry.execute({
          requestId,
          context: { marker: "context-limit" },
          call,
          ledger,
        }),
      ).rejects.toThrow(
        `role_executor_child_invocation_invalid:planner:${issueCode}`,
      );
      expect(ledger.current()).toBe(before);
      expect(ledger.current().state.activeCallId).toBe(call.callId);
      expect(executeWorker).not.toHaveBeenCalled();
    },
  );

  test("rejects an unavailable selected child without opening another role", async () => {
    const requestId = "request-unavailable-child";
    const { ledger, call } = await openPlannerLedger(requestId);
    const before = ledger.current();
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "planner",
        execute: vi.fn(async () => ({
          kind: "invoke_role" as const,
          roleId: "researcher" as const,
          objective: "Research the bounded question.",
        })),
      },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-unavailable-child" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_child_invocation_invalid:planner:child_executor_not_registered",
    );
    expect(ledger.current()).toBe(before);
    expect(ledger.current().state.calls).toHaveLength(2);
  });

  test("rejects a continuation without canonical ledger progress", async () => {
    const { ledger, call } = await openWorkerLedger("request-no-progress");
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async () => ({
          kind: "continue" as const,
          continuation: {
            kind: "capability_execution" as const,
            executionId: "capability-execution-1",
          },
        })),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-no-progress",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_continuation_invalid:worker:ledger_not_advanced",
    );
  });

  test("rejects a continuation that names a different execution", async () => {
    const { ledger, call } = await openWorkerLedger("request-wrong-execution");
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async ({ call: activeCall }) => {
          await settleObservationCapability(ledger, activeCall);
          return {
            kind: "continue" as const,
            continuation: {
              kind: "capability_execution" as const,
              executionId: "capability-execution-2",
            },
          };
        }),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-wrong-execution",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_continuation_invalid:worker:execution_unavailable",
    );
  });

  test.each([
    {
      name: "reorders the settled batch",
      executionIds: ["capability-execution-2", "capability-execution-1"],
    },
    {
      name: "replaces one settled batch execution",
      executionIds: ["capability-execution-1", "capability-execution-3"],
    },
  ])("rejects a continuation that $name", async ({ executionIds }) => {
    const requestId = `request-invalid-batch-${executionIds.join("-")}`;
    const { ledger, call } = await openWorkerLedger(requestId);
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async ({ call: activeCall }) => {
          await settleObservationCapabilityBatch(ledger, activeCall);
          return {
            kind: "continue" as const,
            continuation: {
              kind: "capability_batch_execution" as const,
              executionIds,
            },
          };
        }),
      },
    ]);

    await expect(
      registry.execute({
        requestId,
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_continuation_invalid:worker:execution_unavailable",
    );
  });

  test("rejects more than one activation advance in a single executor turn", async () => {
    const { ledger, call } = await openWorkerLedger("request-stale-activation");
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async ({ call: activeCall }) => {
          await settleObservationCapability(ledger, activeCall);
          const advancedCall = ledger
            .current()
            .state.calls.find(
              (candidate) => candidate.callId === activeCall.callId,
            )!;
          const executionId = await settleObservationCapability(
            ledger,
            advancedCall,
          );
          return {
            kind: "continue" as const,
            continuation: {
              kind: "capability_execution" as const,
              executionId,
            },
          };
        }),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-stale-activation",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_continuation_invalid:worker:revision_advance_invalid",
    );
  });

  test("rejects a continuation whose settled execution belongs to another call", async () => {
    const authority = await openWorkerLedger("request-wrong-call");
    const before = authority.ledger.current();
    const nextCall = Object.freeze({
      ...authority.call,
      activationCount: authority.call.activationCount + 1,
    });
    const after = Object.freeze({
      ...before,
      revision: before.revision + 2,
      state: Object.freeze({
        ...before.state,
        capabilityExecutionSequence:
          before.state.capabilityExecutionSequence + 1,
        calls: Object.freeze(
          before.state.calls.map((candidate) =>
            candidate.callId === authority.call.callId ? nextCall : candidate,
          ),
        ),
        capabilityExecutions: Object.freeze([
          ...before.state.capabilityExecutions,
          Object.freeze({
            executionId: "capability-execution-1",
            callId: "call-other",
            invocationAttempt: authority.call.activationCount,
            capabilityId: "example.observe",
            declaredEffect: "observation" as const,
            status: "settled" as const,
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: "Observed.",
          }),
        ]),
      }),
    }) as unknown as RoleCallLedgerHead;
    let currentReadCount = 0;
    const ledger = Object.freeze({
      current() {
        currentReadCount += 1;
        return currentReadCount <= 2 ? before : after;
      },
      apply: vi.fn(),
    }) as unknown as RoleCallLedger;
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async () => ({
          kind: "continue" as const,
          continuation: {
            kind: "capability_execution" as const,
            executionId: "capability-execution-1",
          },
        })),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-wrong-call",
        context: { marker: "context-1" },
        call: authority.call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_continuation_invalid:worker:execution_call_mismatch",
    );
  });

  test("rejects a terminal result if the executor changed canonical state", async () => {
    const { ledger, call } = await openWorkerLedger(
      "request-terminal-state-change",
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async ({ call: activeCall }) => {
          await settleObservationCapability(ledger, activeCall);
          return {
            kind: "terminal" as const,
            outcome: "completed" as const,
            summary: "State changed without a continuation.",
          };
        }),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-terminal-state-change",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow(
      "role_executor_result_invalid:worker:terminal_state_changed",
    );
  });

  test("logs dispatch boundaries without objective or result content", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const objective = "OBJECTIVE_SECRET_SHOULD_NOT_BE_LOGGED";
    const summary = "SUMMARY_SECRET_SHOULD_NOT_BE_LOGGED";
    const { ledger, call } = await openWorkerLedger(
      "request-logging",
      objective,
    );
    const registry = createRoleExecutorRegistry<TestContext>([
      {
        roleId: "worker",
        execute: vi.fn(async () => ({
          kind: "terminal" as const,
          outcome: "failed" as const,
          summary,
        })),
      },
    ]);
    await registry.execute({
      requestId: "request-logging",
      context: { marker: "context-1" },
      call,
      ledger,
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.resolved",
          requestId: "request-logging",
          callId: "call-2",
          parentCallId: "call-1",
          roleId: "worker",
          objectiveLength: objective.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.started",
          callId: "call-2",
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.completed",
          callId: "call-2",
          outcome: "failed",
          summaryLength: summary.length,
          hasValue: false,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(objective);
    expect(JSON.stringify(logs)).not.toContain(summary);
  });

  test("logs an executor failure and never falls back to another role", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger("request-failure");
    const executeWorker = vi.fn(async () => {
      throw new TypeError("EXECUTOR_SECRET_SHOULD_NOT_BE_LOGGED");
    });
    const executeReviewer = vi.fn(async () => ({
      kind: "terminal" as const,
      outcome: "completed" as const,
      summary: "Fallback must not run.",
    }));
    const registry = createRoleExecutorRegistry<TestContext>([
      { roleId: "worker", execute: executeWorker },
      { roleId: "reviewer", execute: executeReviewer },
    ]);
    await expect(
      registry.execute({
        requestId: "request-failure",
        context: { marker: "context-1" },
        call,
        ledger,
      }),
    ).rejects.toThrow("EXECUTOR_SECRET_SHOULD_NOT_BE_LOGGED");
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(executeWorker).toHaveBeenCalledOnce();
    expect(executeReviewer).not.toHaveBeenCalled();
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.failed",
          requestId: "request-failure",
          callId: "call-2",
          roleId: "worker",
          errorType: "TypeError",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(
      "EXECUTOR_SECRET_SHOULD_NOT_BE_LOGGED",
    );
  });
});
