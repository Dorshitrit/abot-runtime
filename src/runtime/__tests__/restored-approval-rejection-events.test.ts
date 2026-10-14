import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
} from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { projectWorkerAdapters } from "../adapters/registered-tool-worker-capabilities/execution.js";
import { buildExecutionCapabilityResultMessage } from "../steps/execution-agent/capability-result-context.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import {
  createRoleCapabilityBinding,
  restoreCapabilityApprovalGroup,
  type BoundApprovalDecision,
  type PreparedApprovalGroup,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityExecutionFreshness,
} from "../orchestration/worker-capabilities/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const REQUEST_ID = "restored-rejection";
const TARGET = "/workspace/original.txt";
const REFERENCES = [{ kind: "tool_target", target: TARGET }];
const SUPERSEDED_CODE = "steering_superseded_before_external_execution";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("restored registered approval rejection evidence", () => {
  test.each([
    [true, "before restore"],
    [false, "before restore"],
    [true, "during restore"],
    [false, "during restore"],
  ] as const)(
    "keeps lifecycle and target evidence when superseded (approved=%s, %s)",
    async (approved, timing) => {
      const f = fixture();
      const parked = await park(f);
      const originalRole = parked.ledger.current().state.calls[0]!.roleId;
      if (timing === "before restore") f.supersede();
      const restored = await restoreCapabilityApprovalGroup({
        context: {},
        ...parked,
        adapters: f.adapters(timing === "during restore"),
        executionFreshness: f.executionFreshness,
      });
      expect(f.onEvent).not.toHaveBeenCalled();
      const decisions = decisionsFor(parked.group, approved);
      const savedGroup = structuredClone(parked.group);
      const savedDecisions = structuredClone(decisions);
      const result = await restored.execute(decisions);
      const original = parked.group.entries[0]!;
      const settled = parked.ledger.current().state.capabilityExecutions[0]!;

      expect(f.execute).not.toHaveBeenCalled();
      expect(f.normalize).toHaveBeenCalledOnce();
      expect(f.nextApprovalId).toHaveBeenCalledOnce();
      expect(f.appliedDecision).toHaveBeenCalledExactlyOnceWith(decisions[0]);
      expect(result.executionIds).toEqual([original.executionId]);
      expect(parked.group).toEqual(savedGroup);
      expect(decisions).toEqual(savedDecisions);
      expect(settled).toMatchObject({
        executionId: original.executionId,
        actionFingerprint: original.actionFingerprint,
        callId: parked.group.callId,
        status: "settled",
        outcome: "failed",
        observedEffect: "none",
        outcomeFingerprint: null,
        exactResult: {
          kind: "runtime_capability_rejection_v1",
          authority: "runtime",
          status: "rejected",
          stage: "before_external_execution",
          code: SUPERSEDED_CODE,
        },
      });
      const message = buildExecutionCapabilityResultMessage(
        parked.ledger.current(),
        settled,
      );
      expect(message).toMatchObject({
        role: "tool",
        toolCallId: original.executionId,
      });
      expect.soft(JSON.parse(message.content)).toMatchObject({
        authority: "canonical_role_call_ledger",
        presenceEffect: "runtime_result_only_not_user_intent",
        invocationAttempt: parked.group.invocationAttempt,
        result: {
          executionId: original.executionId,
          capabilityId: original.capabilityId,
          outcome: "failed",
          observedEffect: "none",
          adapterResult: {
            authority: "runtime",
            status: "rejected",
            code: SUPERSEDED_CODE,
            references: REFERENCES,
          },
        },
      });
      expect.soft(settled.references).toEqual(REFERENCES);
      expect.soft(settled.exactResult?.references).toEqual(REFERENCES);
      expect.soft(f.onEvent).toHaveBeenCalledExactlyOnceWith(
        "tool.failed",
        expect.objectContaining({
          executionId: original.executionId,
          roleCallId: parked.group.callId,
          executorRole: originalRole,
          tool: "target_reader",
          stage: "before_external_execution",
          error: SUPERSEDED_CODE,
        }),
      );
    },
  );

  test.each([true, false])(
    "preserves fresh approval behavior (approved=%s)",
    async (approved) => {
      const f = fixture();
      const parked = await park(f);
      const restored = await restoreCapabilityApprovalGroup({
        context: {},
        ...parked,
        adapters: f.adapters(),
        executionFreshness: f.executionFreshness,
      });
      expect(f.onEvent).not.toHaveBeenCalled();
      const decisions = decisionsFor(parked.group, approved);
      await restored.execute(decisions);
      const settled = parked.ledger.current().state.capabilityExecutions[0]!;
      expect(f.normalize).toHaveBeenCalledOnce();
      expect(f.nextApprovalId).toHaveBeenCalledOnce();
      expect(f.appliedDecision).toHaveBeenCalledExactlyOnceWith(decisions[0]);
      expect(settled.executionId).toBe(parked.group.entries[0]!.executionId);
      expect(settled.actionFingerprint).toBe(
        parked.group.entries[0]!.actionFingerprint,
      );
      expect(settled.references).toEqual(REFERENCES);
      expect(settled.exactResult?.references).toEqual(REFERENCES);
      if (approved) {
        expect(f.execute).toHaveBeenCalledExactlyOnceWith(
          { tool: "target_reader", params: { target: TARGET } },
          expect.any(Object),
        );
        expect(settled.outcome).toBe("succeeded");
        expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual([
          "tool.approval.granted",
          "tool.started",
          "tool.completed",
        ]);
        return;
      }
      expect(f.execute).not.toHaveBeenCalled();
      expect(settled).toMatchObject({
        outcome: "failed",
        observedEffect: "none",
        exactResult: { code: "tool_approval_rejected" },
      });
      expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.approval.rejected",
      ]);
    },
  );
});

function fixture() {
  let current = true;
  const executionFreshness: WorkerCapabilityExecutionFreshness = {
    token: { kind: "request_steering_v1", version: 0, updates: [] },
    isCurrent: () => current,
  };
  const execute = vi.fn(async (call: ToolCall) => ({
    tool: call.tool,
    ok: true,
    output: "Original target observed.",
    producedNewInformation: true,
  }));
  const normalize = vi.fn((call: ToolCall) => call);
  const onEvent = vi.fn();
  const nextApprovalId = vi.fn(() => "original-approval");
  const appliedDecision = vi.fn();
  const controls: WorkerCapabilityDescriptor["controls"] = {
    type: "object",
    additionalProperties: false,
    properties: { target: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["target"],
  };
  const registration: RegisteredToolNormalInvocation = {
    toolName: "target_reader",
    definition: {
      name: "target_reader",
      routingCapability: "semantic_lookup",
      executionEffect: "read_only",
      params: { target: "string" },
    },
    contract: {
      version: 1,
      operations: [
        {
          operationId: "target_reader",
          summary: "Observe the selected target.",
          effect: "read_only",
          approval: "request_policy",
          input: controls,
        },
      ],
    },
    adapter: {
      normalizeCall: normalize,
      validateCall: () => null,
      executionBinding: () => ({ identity: "fixed-host" }),
    },
  };
  const descriptor: WorkerCapabilityDescriptor = {
    capabilityId: "target_reader",
    summary: "Observe the selected target.",
    effect: "observation",
    controls,
    selectionControlIds: ["target"],
  };
  const adapters = (supersedeDuringRestore = false) => {
    const executor = createRegisteredToolNormalInvocationExecutor({
      registrations: [registration],
      toolRegistry: { execute },
      requestId: REQUEST_ID,
      abortSignal: new AbortController().signal,
      toolPermissionMode: "ask",
      nextApprovalId,
      onEvent,
    });
    const [adapter] = projectWorkerAdapters<{}>({
      operationIds: [descriptor.capabilityId],
      descriptors: [descriptor],
      executor,
      sharedState: {},
      diagnostic: {
        requestId: REQUEST_ID,
        operationIds: [descriptor.capabilityId],
      },
    });
    const wrapped: WorkerCapabilityAdapter<{}> = {
      ...adapter!,
      async restore(input, snapshot) {
        const prepared = await adapter!.restore!(input, snapshot);
        if (supersedeDuringRestore) current = false;
        return {
          ...prepared,
          applyApprovalDecision(decision) {
            appliedDecision(decision);
            prepared.applyApprovalDecision!(decision);
          },
        };
      },
    };
    return [wrapped];
  };
  return {
    execute,
    normalize,
    onEvent,
    nextApprovalId,
    appliedDecision,
    executionFreshness,
    adapters,
    supersede() {
      current = false;
    },
  };
}

async function park(f: ReturnType<typeof fixture>) {
  const ledger = createRoleCallLedger({
    requestId: REQUEST_ID,
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"d".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: [],
        capabilityAuthorities: ["root"],
      },
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
  const opened = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  if (!opened.ok) throw new Error("root not opened");
  const binding = createRoleCapabilityBinding({
    requestId: REQUEST_ID,
    context: {},
    ledger,
    call: ledger.current().state.calls[0]!,
    adapters: f.adapters(),
    executionFreshness: f.executionFreshness,
    approvalGate: { resolve: async () => ({ kind: "awaiting_approval" }) },
  });
  const result = await binding.execute({
    capabilityId: "target_reader",
    intent: "Observe the original target.",
    controls: { target: TARGET },
  });
  if (!("kind" in result) || result.kind !== "awaiting_approval")
    throw new Error("expected approval wait");
  const checkpoint = JSON.parse(
    JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)),
  );
  return {
    ledger: createRoleCallLedger({
      requestId: REQUEST_ID,
      policy: checkpoint.policy,
      checkpoint,
    }),
    group: JSON.parse(JSON.stringify(result.group)) as PreparedApprovalGroup,
  };
}

function decisionsFor(
  group: PreparedApprovalGroup,
  approved: boolean,
): BoundApprovalDecision[] {
  return group.entries.map((entry) => ({
    approvalId: entry.approvalRequest!.approvalId,
    actionFingerprint: entry.actionFingerprint,
    decision: { approved },
  }));
}
