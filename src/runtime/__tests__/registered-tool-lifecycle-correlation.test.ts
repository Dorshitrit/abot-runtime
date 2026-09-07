import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import type { ToolApprovalController, ToolRegistry } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const CALL: RoleCallFrame = {
  callId: "call-2",
  parentCallId: "call-1",
  roleId: "worker",
  depth: 1,
  objective: "Write the requested text.",
  dependencyResultRefs: [],
  status: "active",
  childCallIds: [],
  activationCount: 1,
  resultRef: null,
};

const INVOCATION = {
  context: {},
  call: CALL,
  controls: {},
  intent: "Write the text.",
  authoringObjective: "Write the requested text.",
  settledCapabilityResults: [],
};

const LIFECYCLE = [
  "tool.payload.started",
  "tool.payload.completed",
  "tool.started",
  "tool.completed",
];

const RESULT: ToolExecutionResult = {
  ok: true,
  tool: "correlation_writer",
  output: "Text written.",
  producedNewInformation: true,
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("registered tool lifecycle execution correlation", () => {
  test("binds payload and execution events to one id without changing tool input", async () => {
    const fixture = createFixture();
    await fixture.adapter.execute({
      ...INVOCATION,
      executionId: "capability-execution-7",
    });

    expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual(LIFECYCLE);
    expectExecutorIdentity(fixture.onEvent.mock.calls, CALL);
    expect(
      fixture.onEvent.mock.calls.every(
        ([, payload]) => payload.executionId === "capability-execution-7",
      ),
    ).toBe(true);
    expect(fixture.execute).toHaveBeenCalledExactlyOnceWith(
      { tool: "correlation_writer", params: { content: "Requested text." } },
      expect.any(Object),
    );
  });

  test("keeps payload lifecycle unpublished until admitted execution releases it", async () => {
    const fixture = createFixture();
    const prepared = await fixture.adapter.prepare!({
      ...INVOCATION,
      preparationId: "capability-preparation:call-2:1:1",
    });

    expect(fixture.onEvent).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    await prepared.execute("capability-execution-8");

    expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual(LIFECYCLE);
    expectExecutorIdentity(fixture.onEvent.mock.calls, CALL);
    expect(
      fixture.onEvent.mock.calls.every(
        ([, payload]) => payload.executionId === "capability-execution-8",
      ),
    ).toBe(true);
    expect(JSON.stringify(fixture.onEvent.mock.calls)).not.toContain(
      "capability-preparation",
    );
  });

  test("separates concurrent identical tools when they finish out of order", async () => {
    const pending = [createPendingToolResult(), createPendingToolResult()];
    let invocationIndex = 0;
    const execute = vi.fn<ToolRegistry["execute"]>(
      () => pending[invocationIndex++]!.promise,
    );
    const fixture = createFixture({ execute });
    const first = fixture.adapter.execute({
      ...INVOCATION,
      executionId: "capability-execution-1",
    });
    const second = fixture.adapter.execute({
      ...INVOCATION,
      call: { ...CALL, callId: "call-3" },
      executionId: "capability-execution-2",
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    pending[1]!.resolve(RESULT);
    await second;
    pending[0]!.resolve(RESULT);
    await first;

    for (const [executionId, callId] of [
      ["capability-execution-1", "call-2"],
      ["capability-execution-2", "call-3"],
    ]) {
      expectExecutorIdentity(
        fixture.onEvent.mock.calls.filter(
          ([, payload]) => payload.executionId === executionId,
        ),
        { callId: callId!, roleId: "worker" },
      );
      expect(
        fixture.onEvent.mock.calls
          .filter(([, payload]) => payload.executionId === executionId)
          .map(([name]) => name),
      ).toEqual(LIFECYCLE);
    }
    expect(
      fixture.onEvent.mock.calls
        .filter(([name]) => name === "tool.completed")
        .map(([, payload]) => payload.executionId),
    ).toEqual(["capability-execution-2", "capability-execution-1"]);
  });

  test("correlates failed payload preparation without emitting tool execution", async () => {
    const fixture = createFixture({
      author: async () => ({
        status: "failed",
        code: "payload_context_budget_exceeded",
      }),
    });
    const prepared = await fixture.adapter.prepare!({
      ...INVOCATION,
      preparationId: "capability-preparation:call-2:1:1",
    });
    expect(fixture.onEvent).not.toHaveBeenCalled();

    await expect(
      prepared.execute("capability-execution-9"),
    ).resolves.toMatchObject({
      outcome: "failed",
      observedEffect: "none",
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.payload.started",
      "tool.payload.failed",
    ]);
    expectExecutorIdentity(fixture.onEvent.mock.calls, CALL);
    expect(
      fixture.onEvent.mock.calls.every(
        ([, payload]) => payload.executionId === "capability-execution-9",
      ),
    ).toBe(true);
  });

  test.each([true, false])(
    "preserves approval identity when approved=%s",
    async (approved) => {
      const requestToolApproval = vi.fn<
        ToolApprovalController["requestToolApproval"]
      >(async () => ({ approved }));
      const fixture = createFixture({
        permissionMode: "ask",
        toolApprovalController: { requestToolApproval },
      });
      await fixture.adapter.execute({
        ...INVOCATION,
        executionId: "capability-execution-10",
      });

      const approvals = fixture.onEvent.mock.calls.filter(([name]) =>
        name.startsWith("tool.approval."),
      );
      expect(approvals.map(([name]) => name)).toEqual([
        "tool.approval.required",
        approved ? "tool.approval.granted" : "tool.approval.rejected",
      ]);
      expect(
        approvals.every(
          ([, payload]) =>
            payload.executionId === "capability-execution-10" &&
            payload.approvalId === "approval-1",
        ),
      ).toBe(true);
      expect(
        fixture.onEvent.mock.calls.every(
          ([, payload]) => payload.executionId === "capability-execution-10",
        ),
      ).toBe(true);
      expectExecutorIdentity(fixture.onEvent.mock.calls, CALL);
      expect(fixture.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(requestToolApproval.mock.calls[0]?.[0]).not.toHaveProperty(
        "executionId",
      );
      expect(requestToolApproval.mock.calls[0]?.[0]).not.toHaveProperty(
        "executorIdentity",
      );
    },
  );

  test("correlates approval rejection when a controller is unavailable", async () => {
    const fixture = createFixture({ permissionMode: "ask" });
    await fixture.adapter.execute({
      ...INVOCATION,
      executionId: "capability-execution-11",
    });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(
      fixture.onEvent.mock.calls.slice(-2).map(([name, payload]) => ({
        name,
        executionId: payload.executionId,
        approvalId: payload.approvalId,
      })),
    ).toEqual([
      {
        name: "tool.approval.required",
        executionId: "capability-execution-11",
        approvalId: "approval-1",
      },
      {
        name: "tool.approval.rejected",
        executionId: "capability-execution-11",
        approvalId: "approval-1",
      },
    ]);
  });

  test("keeps canonical root identity without guessing the model-facing contract", async () => {
    const fixture = createFixture();
    const rootCall: RoleCallFrame = {
      ...CALL,
      callId: "call-1",
      parentCallId: null,
      roleId: "supervisor",
      depth: 0,
      objective: null,
    };
    await fixture.adapter.execute({
      ...INVOCATION,
      call: rootCall,
      executionId: "root-execution",
    });
    expectExecutorIdentity(fixture.onEvent.mock.calls, rootCall);
  });

  test("keeps execution-id-only callers compatible without fabricating an executor", async () => {
    const onEvent = vi.fn();
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: [createRegistration()],
      toolRegistry: { execute: vi.fn(async () => RESULT) },
      requestId: "request-id-only",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
      onEvent,
    });
    const handle = executor.operations[0]!.handle;
    const payload = executor.preparePayloadLifecycle({
      handle,
      controls: {},
      phase: "started",
    });
    const invocation = executor.prepare({
      handle,
      controls: {},
      payload: "Requested text.",
    });
    if (payload.status !== "prepared" || invocation.status !== "prepared")
      throw new Error("expected prepared invocation");
    payload.emit("id-only");
    await invocation.execute("id-only");
    expect(onEvent.mock.calls).toHaveLength(3);
    for (const [, event] of onEvent.mock.calls) {
      expect(event.executionId).toBe("id-only");
      expect(event).not.toHaveProperty("roleCallId");
      expect(event).not.toHaveProperty("executorRole");
    }
  });

  test("preserves uncorrelated direct callers that omit the optional id", async () => {
    const onEvent = vi.fn();
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: [createRegistration()],
      toolRegistry: { execute: vi.fn(async () => RESULT) },
      requestId: "request-legacy",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
      onEvent,
    });
    const handle = executor.operations[0]!.handle;
    executor.emitPayloadLifecycle({ handle, controls: {}, phase: "started" });
    await executor.execute({
      handle,
      controls: {},
      payload: "Requested text.",
    });

    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.payload.started",
      "tool.started",
      "tool.completed",
    ]);
    for (const [, payload] of onEvent.mock.calls) {
      expect(payload).not.toHaveProperty("executionId");
      expect(payload).not.toHaveProperty("roleCallId");
      expect(payload).not.toHaveProperty("executorRole");
    }
  });
});

function createFixture(
  options: {
    author?: WorkerCapabilityPayloadAuthor["author"];
    execute?: ToolRegistry["execute"];
    permissionMode?: "full_access" | "ask";
    toolApprovalController?: ToolApprovalController;
  } = {},
) {
  const registration = createRegistration();
  const execute = vi.fn(options.execute ?? (async () => RESULT));
  const onEvent =
    vi.fn<(name: string, payload: Record<string, unknown>) => void>();
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) =>
      name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const provider = createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry,
    requestId: "request-correlation",
    sessionId: "session-correlation",
    abortSignal: new AbortController().signal,
    toolPermissionMode: options.permissionMode ?? "full_access",
    ...(options.toolApprovalController
      ? { toolApprovalController: options.toolApprovalController }
      : {}),
    payloadAuthor: {
      author:
        options.author ??
        (async () => ({
          status: "authored",
          body: "Requested text.",
        })),
    },
    nextApprovalId: () => "approval-1",
    onEvent,
  });
  return { adapter: provider.getAdapters()[0]!, execute, onEvent };
}

function createRegistration(): RegisteredToolNormalInvocation {
  return {
    toolName: "correlation_writer",
    definition: {
      name: "correlation_writer",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { content: "string" },
    },
    contract: {
      version: 1,
      operations: [
        {
          operationId: "write_correlation_text",
          summary: "Write the supplied text.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
          effect: "mutating",
          approval: "request_policy",
          payload: {
            kind: "raw_text",
            param: "content",
            instructions: "Write the complete requested text.",
            maxBytes: 1024,
          },
        },
      ],
    },
  };
}

function createPendingToolResult() {
  let resolve!: (result: ToolExecutionResult) => void;
  const promise = new Promise<ToolExecutionResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function expectExecutorIdentity(
  events: readonly [string, Record<string, unknown>][],
  call: Pick<RoleCallFrame, "callId" | "roleId">,
) {
  for (const [, payload] of events) {
    expect(payload).toMatchObject({
      roleCallId: call.callId,
      executorRole: call.roleId,
    });
  }
}
