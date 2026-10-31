import { bindWorkerPayloadSteering } from "../request/worker-payload-steering.js";
import {
  BOUND_REQUEST_MODEL_INVOCATION,
  type BoundRequestModelInvocationContext,
} from "../request/contracts.js";
import { restoreBoundApprovalFreshness } from "../request/worker-approval-freshness.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import { describe, expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { projectWorkerAdapters } from "../adapters/registered-tool-worker-capabilities/execution.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import {
  createRoleCapabilityBinding,
  restoreCapabilityApprovalGroup,
  type PreparedApprovalGroup,
} from "../orchestration/worker-capabilities/index.js";
import { createWorkerExecutionFreshness } from "../request/capability-execution-freshness.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { createRequestApprovalGate } from "../request/approval-wait/approval-gate.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import type { ToolApprovalController, ToolApprovalDecision } from "../ports.js";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";

const requestId = "worker-steering-fence";
const stoppedCode = "steering_superseded_before_external_execution";

async function fixture(
  options: {
    legacy?: boolean;
    payload?: boolean;
    gate?: boolean;
    mutateBeforeDispatch?: (
      inbox: ReturnType<typeof createRequestSteeringInbox>,
    ) => void;
  } = {},
) {
  const inbox = createRequestSteeringInbox({ requestId });
  const execute = vi.fn(async () => ({
    tool: "observe",
    ok: true,
    output: "observed",
    producedNewInformation: true,
  }));
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  let lateDecision!: (decision: ToolApprovalDecision) => void;
  const controller: ToolApprovalController = {
    requestToolApproval: vi.fn(async (_request, { abortSignal }) => {
      received();
      return new Promise<ToolApprovalDecision>((resolve, reject) => {
        lateDecision = resolve;
        abortSignal.addEventListener(
          "abort",
          () => reject(abortSignal.reason),
          { once: true },
        );
        if (abortSignal.aborted) reject(abortSignal.reason);
      });
    }),
  };
  const registration: RegisteredToolNormalInvocation = {
    toolName: "observe",
    definition: {
      name: "observe",
      routingCapability: "semantic_lookup",
      executionEffect: "read_only",
      params: {
        query: "string",
        ...(options.payload ? { content: "string" } : {}),
      },
    },
    contract: {
      version: 1,
      operations: [
        {
          operationId: "observe",
          summary: "Observe one value.",
          effect: "read_only",
          approval: "request_policy",
          ...(options.payload
            ? {
                payload: {
                  kind: "raw_text" as const,
                  param: "content",
                  instructions: "Return the complete payload.",
                  maxBytes: 1024,
                },
              }
            : {}),
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 100 },
            },
            required: ["query"],
          },
        },
      ],
    },
  };
  const normal = createRegisteredToolNormalInvocationExecutor({
    registrations: [registration],
    toolRegistry: { execute },
    requestId,
    abortSignal: new AbortController().signal,
    toolPermissionMode: "ask",
    nextApprovalId: () => "approval-exact",
    toolApprovalController: controller,
    ...(options.mutateBeforeDispatch
      ? {
          effectPersistence: {
            beforeEffect: async () => {
              options.mutateBeforeDispatch!(inbox);
            },
            afterEffect: async () => {},
          },
        }
      : {}),
  });
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => {
    steer(inbox);
    throw new ModelStepSteeringSupersededError(0);
  });
  const descriptors = [
    {
      capabilityId: "observe",
      summary: "Observe one value.",
      effect: "observation" as const,
      controls: registration.contract.operations[0]!.input,
    },
  ];
  const adapters = projectWorkerAdapters({
    operationIds: ["observe"],
    descriptors,
    executor: normal,
    ...(options.payload ? { payloadAuthor: { author } } : {}),
    sharedState: {},
    diagnostic: { requestId, operationIds: ["observe"] },
  });
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  const opened = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe the value.",
      ...(options.legacy ? {} : { workerSteeringVersion: 0 }),
    },
  });
  if (!opened.ok) throw new Error("worker not opened");
  const call = ledger.current().state.calls[1]!;
  const freshness = createWorkerExecutionFreshness({
    requestSteering: inbox,
    call,
  });
  const resources = new RequestToolResources();
  let finishWork!: () => void;
  if (options.gate)
    resources.work.trackUntil(
      new Promise<void>((resolve) => {
        finishWork = resolve;
      }),
    );
  const gate = options.gate
    ? createRequestApprovalGate({
        resources,
        controller,
        signal: new AbortController().signal,
        onEvent: () => {},
      })
    : undefined;
  const binding = createRoleCapabilityBinding({
    requestId,
    context: {},
    ledger,
    call,
    adapters,
    executionFreshness: freshness,
    ...(gate ? { approvalGate: gate } : {}),
  });
  return {
    author,
    inbox,
    ledger,
    call,
    freshness,
    binding,
    requested,
    execute,
    controller,
    adapters,
    lateDecision: (decision: ToolApprovalDecision) => lateDecision(decision),
    finishWork: () => finishWork?.(),
    resources,
  };
}

function steer(inbox: ReturnType<typeof createRequestSteeringInbox>) {
  expect(
    inbox.append({
      steerId: "new-instruction",
      text: "Stop and return control.",
    }).ok,
  ).toBe(true);
}

function expectNoExternalEffect(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.ledger.current().state.capabilityExecutions[0]).toMatchObject({
    status: "settled",
    outcome: "failed",
    observedEffect: "none",
    outcomeFingerprint: null,
    exactResult: { code: stoppedCode },
  });
}

describe("Worker steering execution fence", () => {
  test.each([false, true])(
    "wakes live pending approval without executing (gate=%s)",
    async (gate) => {
      const f = await fixture({ gate });
      const attempt = f.binding.execute({
        capabilityId: "observe",
        intent: "Observe.",
        controls: { query: "value" },
      });
      await f.requested;
      steer(f.inbox);
      await attempt;
      expectNoExternalEffect(f);
      f.lateDecision({ approved: true });
      await Promise.resolve();
      expect(f.execute).not.toHaveBeenCalled();
      f.finishWork();
      await f.resources.dispose();
    },
  );

  test("steering accepted while persisting admission prevents dispatch", async () => {
    const f = await fixture({ mutateBeforeDispatch: steer });
    const attempt = f.binding.execute({
      capabilityId: "observe",
      intent: "Observe.",
      controls: { query: "value" },
    });
    await f.requested;
    f.lateDecision({ approved: true });
    await attempt;
    expectNoExternalEffect(f);
  });

  test("steering during payload settles no effect and never injects the update into Worker author input", async () => {
    const f = await fixture({ payload: true });
    await f.binding.execute({
      capabilityId: "observe",
      intent: "Observe.",
      controls: { query: "value" },
    });
    expect(f.author).toHaveBeenCalledOnce();
    expect(f.author.mock.calls[0]![0]).not.toHaveProperty("requestSteering");
    expect(f.controller.requestToolApproval).not.toHaveBeenCalled();
    expectNoExternalEffect(f);

    let history = ["accepted evidence"];
    const request = Object.defineProperties(
      { modelSteps: { invoke: vi.fn() } },
      {
        [BOUND_REQUEST_MODEL_INVOCATION]: { value: true },
        historyMessages: { enumerable: true, get: () => history },
      },
    ) as unknown as BoundRequestModelInvocationContext & {
      readonly historyMessages: readonly string[];
    };
    const scoped = bindWorkerPayloadSteering(
      request,
      f.call,
      f.ledger.current().policy.authority,
    );
    history = ["new settled evidence"];
    expect(scoped[BOUND_REQUEST_MODEL_INVOCATION]).toBe(true);
    expect(scoped.historyMessages).toBe(history);
    expect(
      Object.getOwnPropertyDescriptor(scoped, BOUND_REQUEST_MODEL_INVOCATION)
        ?.enumerable,
    ).toBe(false);
  });

  test("Worker token contains no user text and matches its immutable assignment", async () => {
    const f = await fixture();
    expect(f.freshness.token).toEqual({
      kind: "worker_steering_v1",
      callId: f.call.callId,
      version: 0,
    });
    const wrong = {
      ...f.freshness,
      token: { ...f.freshness.token, callId: "call-999" },
    };
    expect(() =>
      createRoleCapabilityBinding({
        requestId,
        context: {},
        ledger: f.ledger,
        call: f.call,
        adapters: f.adapters,
        executionFreshness: wrong,
      }),
    ).toThrow("execution_freshness_invalid");
    const rewrittenCall = { ...f.call, workerSteeringVersion: 1 };
    expect(() =>
      createRoleCapabilityBinding({
        requestId,
        context: {},
        ledger: f.ledger,
        call: rewrittenCall,
        adapters: f.adapters,
        executionFreshness: createWorkerExecutionFreshness({
          requestSteering: f.inbox,
          call: rewrittenCall,
        }),
      }),
    ).toThrow("worker_steering_version_mismatch");
  });

  test.each([false, true])(
    "restored approved action is fenced after newer accepted steering (legacy=%s)",
    async (legacy) => {
      const f = await fixture({ legacy });
      const binding = createRoleCapabilityBinding({
        requestId,
        context: {},
        ledger: f.ledger,
        call: f.call,
        adapters: f.adapters,
        executionFreshness: f.freshness,
        approvalGate: { resolve: async () => ({ kind: "awaiting_approval" }) },
      });
      const waiting = await binding.execute({
        capabilityId: "observe",
        intent: "Observe.",
        controls: { query: "value" },
      });
      if (!("kind" in waiting) || waiting.kind !== "awaiting_approval")
        throw new Error("not waiting");
      const { executionFreshnessToken, ...withoutToken } = waiting.group;
      const group = JSON.parse(
        JSON.stringify(legacy ? withoutToken : waiting.group),
      ) as PreparedApprovalGroup;
      const checkpoint = JSON.parse(
        JSON.stringify(captureRoleCallLedgerCheckpoint(f.ledger)),
      );
      const restoredLedger = createRoleCallLedger({
        requestId,
        policy: checkpoint.policy,
        checkpoint,
      });
      steer(f.inbox);
      const freshness = restoreBoundApprovalFreshness(
        group,
        f.inbox,
        restoredLedger.current(),
      )!;
      const restored = await restoreCapabilityApprovalGroup({
        context: {},
        ledger: restoredLedger,
        adapters: f.adapters,
        group,
        executionFreshness: freshness,
      });
      await restored.execute(
        group.entries
          .filter((entry) => entry.approvalRequest)
          .map((entry) => ({
            approvalId: entry.approvalRequest!.approvalId,
            actionFingerprint: entry.actionFingerprint,
            decision: { approved: true },
          })),
      );
      expect(f.execute).not.toHaveBeenCalled();
      expect(
        restoredLedger.current().state.capabilityExecutions[0],
      ).toMatchObject({
        status: "settled",
        observedEffect: "none",
        exactResult: { code: stoppedCode },
      });
    },
  );
});
