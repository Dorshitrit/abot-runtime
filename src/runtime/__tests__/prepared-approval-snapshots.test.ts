import { describe, expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { projectWorkerAdapters } from "../adapters/registered-tool-worker-capabilities/execution.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import {
  createRoleCapabilityBinding,
  restoreCapabilityApprovalGroup,
  resumeCapabilityApprovalGroup,
  type PreparedApprovalGroup,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
} from "../../capabilities/tool-types.js";

function fixture(rejectSecond = false) {
  const execute = vi.fn(async (call: ToolCall) => ({
    tool: call.tool,
    ok: true,
    output: "Exact output " + call.params.query,
    producedNewInformation: true,
  }));
  const normalize = vi.fn((call: ToolCall) => call);
  const onEvent = vi.fn();
  let sequence = 0;
  const registrations = ["first", "second", "third"].map(
    (name): RegisteredToolNormalInvocation => ({
      toolName: name,
      definition: {
        name,
        routingCapability: "semantic_lookup",
        executionEffect: "read_only",
        params: { query: "string" },
      },
      contract: {
        version: 1,
        operations: [
          {
            operationId: name,
            summary: "Read an exact query.",
            effect: "read_only",
            approval: "request_policy",
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
      adapter: {
        normalizeCall: normalize,
        validateCall: () =>
          rejectSecond && name === "second"
            ? { error: "fixture_rejection" }
            : null,
        executionBinding: () => ({ identity: "fixed-host" }),
      },
    }),
  );
  const createExecutor = () =>
    createRegisteredToolNormalInvocationExecutor({
      registrations,
      toolRegistry: { execute },
      requestId: "prepared-group",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "ask",
      nextApprovalId: () => "approval-" + ++sequence,
      onEvent,
    });
  const descriptors: WorkerCapabilityDescriptor[] = registrations.map(
    (registration) => ({
      capabilityId: registration.toolName,
      summary: "Read one exact query.",
      effect: "observation",
      controls: registration.contract.operations[0]!
        .input as WorkerCapabilityDescriptor["controls"],
    }),
  );
  const adapters = () =>
    projectWorkerAdapters({
      operationIds: descriptors.map((entry) => entry.capabilityId),
      descriptors,
      executor: createExecutor(),
      sharedState: {},
      diagnostic: {
        requestId: "prepared-group",
        operationIds: descriptors.map((entry) => entry.capabilityId),
      },
    });
  return { execute, normalize, onEvent, createExecutor, adapters };
}
async function openLedger() {
  const ledger = createRoleCallLedger({
    requestId: "prepared-group",
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
  const root = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  if (!root.ok) throw new Error("root");
  const opened = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Read three queries.",
    },
  });
  if (!opened.ok) throw new Error("child");
  return ledger;
}
async function parked(f: ReturnType<typeof fixture>, initialDecision = false) {
  const ledger = await openLedger();
  const binding = createRoleCapabilityBinding({
    requestId: "prepared-group",
    context: {},
    ledger,
    call: ledger.current().state.calls[1]!,
    adapters: f.adapters(),
    approvalGate: {
      resolve: async (group) => ({
        kind: "awaiting_approval" as const,
        ...(initialDecision
          ? {
              decisions: [
                {
                  approvalId: group.entries[0]!.approvalRequest!.approvalId,
                  actionFingerprint: group.entries[0]!.actionFingerprint,
                  decision: { approved: true },
                },
              ],
            }
          : {}),
      }),
    },
  });
  const result = await binding.executeBatch({
    invocations: ["first", "second", "third"].map((capabilityId) => ({
      capabilityId,
      intent: "Read exact input.",
      controls: { query: capabilityId + "-query" },
    })),
  });
  if (!("kind" in result) || result.kind !== "awaiting_approval")
    throw new Error("expected wait");
  const checkpoint = JSON.parse(
    JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)),
  );
  return {
    group: JSON.parse(JSON.stringify(result.group)) as PreparedApprovalGroup,
    ledger: createRoleCallLedger({
      requestId: "prepared-group",
      policy: checkpoint.policy,
      checkpoint,
    }),
  };
}
function approve(group: PreparedApprovalGroup) {
  return group.entries
    .filter((entry) => entry.approvalRequest)
    .map((entry) => ({
      approvalId: entry.approvalRequest!.approvalId,
      actionFingerprint: entry.actionFingerprint,
      decision: { approved: true },
    }));
}

describe("prepared approval snapshots", () => {
  test("hydrates an exact normal call without normalization or allocating a new approval", async () => {
    const f = fixture();
    const source = f.createExecutor();
    const prepared = source.prepare({
      handle: source.operations[0]!.handle,
      controls: { query: "unchanged" },
    });
    if (prepared.status !== "prepared") throw new Error("prepare");
    expect(f.normalize).toHaveBeenCalledOnce();
    const saved = JSON.parse(JSON.stringify(prepared.snapshot));
    f.normalize.mockImplementation(() => {
      throw new Error("normalization must not run");
    });
    const restored = f.createExecutor().restore(saved);
    if (restored.status !== "prepared") throw new Error("restore");
    expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
    restored.applyApprovalDecision({
      approvalId: restored.approvalRequest!.approvalId,
      actionFingerprint: restored.actionFingerprint,
      decision: { approved: false },
    });
    await expect(restored.execute()).resolves.toMatchObject({
      status: "rejected",
      code: "tool_approval_rejected",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  test("parks the entire admitted batch including preparation rejection and settles the same IDs", async () => {
    const f = fixture(true);
    const { ledger, group } = await parked(f, true);
    expect(group.initialDecisions).toHaveLength(1);
    expect(group.entries).toHaveLength(3);
    expect(group.entries[1]!.approvalRequest).toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      f.onEvent.mock.calls.some(
        ([name]) =>
          name === "tool.approval.required" || name === "tool.started",
      ),
    ).toBe(false);
    const normalizationCount = f.normalize.mock.calls.length;
    f.normalize.mockImplementation(() => {
      throw new Error("preparation repeated");
    });
    const hydrated = await restoreCapabilityApprovalGroup({
      context: {},
      ledger,
      adapters: f.adapters(),
      group,
    });
    expect(f.normalize).toHaveBeenCalledTimes(normalizationCount);
    expect(f.execute).not.toHaveBeenCalled();
    await expect(hydrated.execute(approve(group).slice(0, 1))).rejects.toThrow(
      "decisions_incomplete",
    );
    expect(f.execute).not.toHaveBeenCalled();
    const result = await resumeCapabilityApprovalGroup({
      context: {},
      ledger,
      adapters: f.adapters(),
      group,
      decisions: approve(group),
    });
    expect(result.executionIds).toEqual(
      group.entries.map((entry) => entry.executionId),
    );
    expect(f.execute.mock.calls.map(([call]) => call.params.query)).toEqual([
      "first-query",
      "third-query",
    ]);
    expect(
      ledger.current().state.capabilityExecutions.map((entry) => entry.outcome),
    ).toEqual(["succeeded", "failed", "succeeded"]);
    expect(f.normalize).toHaveBeenCalledTimes(normalizationCount);
  });

  test("rejects substituted action identity or changed adapter contract before dispatch", async () => {
    const f = fixture();
    const { ledger, group } = await parked(f);
    const changed = structuredClone(group);
    (changed.entries[0]!.snapshot as any).normal.call.params.query =
      "different";
    await expect(
      restoreCapabilityApprovalGroup({
        context: {},
        ledger,
        adapters: f.adapters(),
        group: changed,
      }),
    ).rejects.toThrow("snapshot_incompatible");
    expect(f.execute).not.toHaveBeenCalled();
    const decisions = approve(group);
    decisions[0]!.actionFingerprint = "sha256:" + "0".repeat(64);
    await expect(
      resumeCapabilityApprovalGroup({
        context: {},
        ledger,
        adapters: f.adapters(),
        group,
        decisions,
      }),
    ).rejects.toThrow("decision_mismatch");
    expect(f.execute).not.toHaveBeenCalled();
  });
});
