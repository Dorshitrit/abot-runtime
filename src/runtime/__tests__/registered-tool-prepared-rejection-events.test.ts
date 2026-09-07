import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  RegisteredToolNormalInvocation,
  ToolCallAdapter,
  ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createRegisteredToolWorkerFailureOutcomeFingerprint } from "../adapters/registered-tool-worker-capabilities/failure-outcome-fingerprint.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const ROOT_CALL: RoleCallFrame = {
  callId: "call-1",
  parentCallId: null,
  roleId: "supervisor",
  depth: 0,
  objective: null,
  dependencyResultRefs: [],
  status: "active",
  childCallIds: [],
  activationCount: 1,
  resultRef: null,
};
const EXECUTION_ID = "capability-execution-1";
const REJECTION_CODE = "steering_superseded_before_external_execution";
const REJECTION_MESSAGE =
  "steering_superseded_before_external_execution: No external execution occurred because a newer active-request update superseded this capability invocation.";
const RESULT: ToolExecutionResult = {
  ok: true,
  tool: "prepared_writer",
  output: "Text written.",
  producedNewInformation: true,
  data: { mutationEvidence: true },
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("registered tool prepared rejection events", () => {
  test.each([true, false])(
    "settles rejected materialized calls with payload enabled=%s",
    async (withPayload) => {
      const validateCall = vi.fn(() => ({
        error: "Materialized call rejected.",
      }));
      const fixture = createFixture(true, {
        withPayload,
        adapter: { validateCall },
      });
      const prepared = await fixture.prepare();
      expect(fixture.onEvent).not.toHaveBeenCalled();

      const result = await prepared.execute(EXECUTION_ID);

      expectInvocationRejection(
        result,
        "normal_invocation_call_invalid",
        "Materialized call rejected.",
      );
      expect(fixture.author).toHaveBeenCalledTimes(withPayload ? 1 : 0);
      expect(validateCall).toHaveBeenCalledExactlyOnceWith({
        tool: "prepared_writer",
        params: withPayload ? { content: "Requested text." } : {},
      });
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
        ...(withPayload
          ? ["tool.payload.started", "tool.payload.completed"]
          : []),
        "tool.failed",
      ]);
      expect(fixture.onEvent).toHaveBeenLastCalledWith("tool.failed", {
        tool: "prepared_writer",
        executionId: EXECUTION_ID,
        roleCallId: ROOT_CALL.callId,
        executorRole: ROOT_CALL.roleId,
        stage: "before_external_execution",
        error: "normal_invocation_call_invalid",
        meta: { intent: "Write the requested text." },
      });
      expectCorrelatedEvents(fixture.onEvent.mock.calls);
      expect(JSON.stringify(fixture.onEvent.mock.calls)).not.toContain(
        "Requested text.",
      );
    },
  );

  test.each([
    {
      name: "throwing validator",
      adapter: {
        validateCall() {
          throw new Error("Private validator error.");
        },
      },
      code: "normal_invocation_call_validation_failed",
      message:
        "The registered source tool adapter could not validate the complete call.",
    },
    {
      name: "unavailable normalized target",
      adapter: {
        normalizeCall() {
          return { tool: "unavailable_writer", params: {} };
        },
      },
      code: "normal_invocation_target_unavailable",
      message:
        "The normalized tool is not enabled in the selected request profile.",
    },
  ])(
    "settles $name without changing the canonical rejection",
    async ({ adapter, code, message }) => {
      const fixture = createFixture(true, { adapter });
      const prepared = await fixture.prepare();
      expect(fixture.onEvent).not.toHaveBeenCalled();

      const result = await prepared.execute(EXECUTION_ID);

      expectInvocationRejection(result, code, message);
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.payload.started",
        "tool.payload.completed",
        "tool.failed",
      ]);
      expect(fixture.onEvent.mock.calls.at(-1)?.[1]).toMatchObject({
        tool: "prepared_writer",
        error: code,
        stage: "before_external_execution",
      });
      expectCorrelatedEvents(fixture.onEvent.mock.calls);
    },
  );

  test.each([true, false])(
    "discarded invocation rejection stays silent with payload enabled=%s",
    async (withPayload) => {
      const fixture = createFixture(true, {
        withPayload,
        adapter: {
          validateCall: () => ({ error: "Materialized call rejected." }),
        },
      });
      await fixture.prepare();

      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.onEvent).not.toHaveBeenCalled();
    },
  );

  test.each([true, false])(
    "only a registered handle can prepare deferred control metadata: registered=%s",
    (registered) => {
      const validateCall = vi.fn(() => null);
      const normalizeCall = vi.fn((call) => call);
      const fixture = createFixture(true, {
        adapter: { validateCall, normalizeCall },
      });
      const onEvent = vi.fn();
      const executor = createRegisteredToolNormalInvocationExecutor({
        registrations: [fixture.registration],
        toolRegistry: { execute: vi.fn() },
        requestId: "request-unknown-handle",
        abortSignal: new AbortController().signal,
        toolPermissionMode: "full_access",
        nextApprovalId: () => "approval-unused",
        onEvent,
      });
      const emitter = executor.prepareRejectionEvent({
        handle: registered
          ? executor.operations[0]!.handle
          : { kind: "registered_tool_normal_invocation_handle" },
        controls: { topic: "Selected topic." },
        intent: "Describe the selected topic.",
      });

      expect(onEvent).not.toHaveBeenCalled();
      expect(validateCall).not.toHaveBeenCalled();
      expect(normalizeCall).not.toHaveBeenCalled();
      if (!registered) {
        expect(emitter).toBeUndefined();
        return;
      }
      emitter!({
        executionId: EXECUTION_ID,
        executorIdentity: ROOT_CALL,
        errorCode: "normal_invocation_call_invalid",
      });
      expect(onEvent).toHaveBeenCalledExactlyOnceWith("tool.failed", {
        tool: "prepared_writer",
        executionId: EXECUTION_ID,
        roleCallId: ROOT_CALL.callId,
        executorRole: ROOT_CALL.roleId,
        stage: "before_external_execution",
        error: "normal_invocation_call_invalid",
        meta: {
          intent: "Describe the selected topic.",
          params: { topic: "string(len=15)" },
        },
      });
    },
  );

  test.each(["stale", "throws"] as const)(
    "settles admitted payload activity when freshness becomes %s after preparation",
    async (freshness) => {
      const fixture = createFixture();
      const prepared = await fixture.prepare();
      expect(fixture.onEvent).not.toHaveBeenCalled();

      fixture.setFreshness(freshness);
      const result = await prepared.execute(EXECUTION_ID);

      expectCanonicalRejection(result);
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.payload.started",
        "tool.payload.completed",
        "tool.failed",
      ]);
      expect(fixture.onEvent).toHaveBeenLastCalledWith("tool.failed", {
        tool: "prepared_writer",
        executionId: EXECUTION_ID,
        roleCallId: ROOT_CALL.callId,
        executorRole: ROOT_CALL.roleId,
        stage: "before_external_execution",
        error: REJECTION_CODE,
        meta: {
          intent: "Write the requested text.",
          params: { content: "string(len=15)" },
        },
      });
      expectCorrelatedEvents(fixture.onEvent.mock.calls);
    },
  );

  test("discarded stale preparation publishes no lifecycle or rejection", async () => {
    const fixture = createFixture();
    await fixture.prepare();
    fixture.setFreshness("stale");

    expect(fixture.onEvent).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    "preserves normal execution and result with freshness enabled=%s",
    async (withFreshness) => {
      const fixture = createFixture(withFreshness);
      const prepared = await fixture.prepare();
      const result = await prepared.execute(EXECUTION_ID);

      expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.payload.started",
        "tool.payload.completed",
        "tool.started",
        "tool.completed",
      ]);
      expect(fixture.execute).toHaveBeenCalledExactlyOnceWith(
        { tool: "prepared_writer", params: { content: "Requested text." } },
        expect.any(Object),
      );
      expect(result).toMatchObject({
        outcome: "succeeded",
        observedEffect: "mutation",
      });
      expect(result.exactResult).toEqual({
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: RESULT,
      });
      expect(result).not.toHaveProperty("stage");
      expect(result).not.toHaveProperty("executionId");
      expectCorrelatedEvents(fixture.onEvent.mock.calls);
    },
  );

  test("stale payload preparation retains its single existing failure event", async () => {
    const fixture = createFixture();
    fixture.setFreshness("stale");
    const prepared = await fixture.prepare();
    expect(fixture.onEvent).not.toHaveBeenCalled();

    const result = await prepared.execute(EXECUTION_ID);

    expectCanonicalRejection(result);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.payload.started",
      "tool.payload.failed",
    ]);
    expectCorrelatedEvents(fixture.onEvent.mock.calls);
  });
});

function expectInvocationRejection(
  result: unknown,
  code: string,
  message: string,
) {
  const exactResult = {
    kind: "runtime_capability_rejection_v1" as const,
    authority: "runtime" as const,
    status: "rejected" as const,
    stage: "before_external_execution" as const,
    code,
    message,
  };
  expect(result).toEqual({
    outcome: "failed",
    observedEffect: "none",
    summary: message,
    failureOutcomeFingerprint:
      createRegisteredToolWorkerFailureOutcomeFingerprint(exactResult),
    exactResult,
  });
}

function expectCanonicalRejection(result: unknown) {
  expect(result).toEqual({
    outcome: "failed",
    observedEffect: "none",
    summary: REJECTION_MESSAGE,
    failureOutcomeFingerprint: null,
    exactResult: {
      kind: "runtime_capability_rejection_v1",
      authority: "runtime",
      status: "rejected",
      stage: "before_external_execution",
      code: REJECTION_CODE,
      message: REJECTION_MESSAGE,
    },
  });
}

function expectCorrelatedEvents(
  events: readonly [string, Record<string, unknown>][],
) {
  for (const [, payload] of events) {
    expect(payload).toMatchObject({
      executionId: EXECUTION_ID,
      roleCallId: ROOT_CALL.callId,
      executorRole: ROOT_CALL.roleId,
    });
  }
  expect(JSON.stringify(events)).not.toContain("capability-preparation");
}

function createFixture(
  withFreshness = true,
  options: {
    withPayload?: boolean;
    adapter?: ToolCallAdapter;
  } = {},
) {
  const withPayload = options.withPayload ?? true;
  const registration: RegisteredToolNormalInvocation = {
    toolName: "prepared_writer",
    ...(options.adapter ? { adapter: options.adapter } : {}),
    definition: {
      name: "prepared_writer",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: withPayload ? { content: "string" } : {},
    },
    contract: {
      version: 1,
      operations: [
        {
          operationId: "write_prepared_text",
          summary: "Write the supplied text.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
          effect: "mutating",
          approval: "request_policy",
          ...(withPayload
            ? {
                payload: {
                  kind: "raw_text",
                  param: "content",
                  instructions: "Write the complete requested text.",
                  maxBytes: 1024,
                },
              }
            : {}),
        },
      ],
    },
  };
  const execute = vi.fn<ToolRegistry["execute"]>(async () => RESULT);
  const onEvent =
    vi.fn<(name: string, payload: Record<string, unknown>) => void>();
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
    status: "authored",
    body: "Requested text.",
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const provider = createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry,
    requestId: "request-prepared-rejection",
    sessionId: "session-prepared-rejection",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    payloadAuthor: { author },
    nextApprovalId: () => "approval-unused",
    onEvent,
  });
  let freshness: "current" | "stale" | "throws" = "current";
  const executionFreshness = {
    token: { kind: "request_steering_v1" as const, version: 0, updates: [] },
    isCurrent() {
      if (freshness === "throws") throw new Error("Freshness check failed.");
      return freshness === "current";
    },
  };
  return {
    registration,
    execute,
    author,
    onEvent,
    setFreshness(value: typeof freshness) {
      freshness = value;
    },
    prepare: () =>
      provider.getAdapters()[0]!.prepare!({
        context: {},
        call: ROOT_CALL,
        preparationId: "capability-preparation:call-1:1:1",
        controls: {},
        intent: "Write the requested text.",
        authoringObjective: "Write the requested text.",
        settledCapabilityResults: [],
        ...(withFreshness ? { executionFreshness } : {}),
      }),
  };
}
